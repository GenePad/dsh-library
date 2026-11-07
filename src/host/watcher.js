// Watch attachment files for external edits (annotations, replaced PDFs) and record them.
//
// Polling instead of fs.watch: Node on Windows crashes natively when a file
// with a non-ASCII name is deleted inside a recursively watched directory
// (observed on Node 24 / win32), which would take the whole dsh host down the
// first time a user removes such an attachment in Explorer. A stat-based pass
// every few seconds catches the same edits (mtime vs storageModTime) without
// any native watch handles.
import fs from 'node:fs'
import path from 'node:path'
import { markAttachmentChanged } from './write.js'
import { syncPdfAnnotations, writeFulltextCache } from './ingest.js'
import { extractPdfText } from './pdf.js'

const PASS_INTERVAL = 4000

/**
 * Start polling the storage directory. File edits made outside the plugin
 * (a system PDF reader adding annotations) update the attachment's mtime and
 * sync state, refresh its fulltext cache and import any new PDF annotations.
 * @param {object} options
 * @param {string} options.storageDir
 * @param {import('./db.js').ZoteroDb} options.db
 * @param {object} [options.logger]
 * @param {(keys:string[]) => void} [options.onChange] - notification hook.
 * @returns {{dispose:()=>void, scan:()=>Promise<void>}}
 */
export function createStorageWatcher({ storageDir, db, logger = console, onChange }) {
  let timer
  let disposed = false
  let running = Promise.resolve()

  async function scanKeys(keys) {
    const changed = []
    for (const key of keys) {
      if (disposed) return
      if (!/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key)) continue
      const row = db.get(
        `SELECT a.itemID, a.path, a.linkMode, a.storageModTime FROM itemAttachments a
         JOIN items i ON i.itemID = a.itemID WHERE i.key = ?`,
        key,
      )
      if (!row || row.linkMode === 3 || row.linkMode === 2) continue
      const name = String(row.path ?? '').replace(/^storage:/, '')
      if (name === '') continue
      const filePath = path.join(storageDir, key, name)
      let stat
      try {
        stat = fs.statSync(filePath)
      } catch {
        // Deleted or temporarily locked (a reader writing a save); the next
        // pass picks it up if it comes back.
        continue
      }
      const mtime = Math.round(stat.mtimeMs)
      if (Math.abs(mtime - Number(row.storageModTime ?? 0)) < 1500) continue
      db.transaction(() => markAttachmentChanged(db, row.itemID, { mtime }))
      changed.push(key)
      if (filePath.toLowerCase().endsWith('.pdf')) {
        await syncPdfAnnotations(db, row.itemID, filePath, logger)
        try {
          const text = await extractPdfText(filePath)
          if (text !== '') writeFulltextCache(path.dirname(filePath), text)
        } catch (error) {
          logger.warn?.(`library: fulltext refresh failed for ${key}: ${error?.message ?? error}`)
        }
      }
    }
    if (changed.length > 0 && typeof onChange === 'function') {
      try {
        onChange(changed)
      } catch {
        // Notification is observational.
      }
    }
  }

  /** Full pass over every stored attachment, comparing mtimes with the database. */
  async function scan() {
    const rows = db.all(
      `SELECT i.key FROM itemAttachments a JOIN items i ON i.itemID = a.itemID
       WHERE a.linkMode IN (0, 1) AND a.parentItemID IS NOT NULL`,
    )
    await scanKeys(rows.map(row => row.key))
  }

  const pass = () => {
    if (disposed) return
    running = running
      .then(() => scan())
      .catch(error => logger.warn?.(`library: storage scan failed: ${error?.message ?? error}`))
  }

  // The first pass waits a beat so a just-started Zotero cannot race it.
  timer = setInterval(pass, PASS_INTERVAL)
  timer.unref?.()
  setTimeout(pass, 1500).unref?.()

  return {
    dispose() {
      disposed = true
      clearInterval(timer)
    },
    scan,
  }
}
