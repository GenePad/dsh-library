// Runtime: database lifecycle, storage watcher, import queue, sync, updates.
import fs from 'node:fs'
import path from 'node:path'
import { ZoteroDb } from './db.js'
import { locateZotero } from './locate.js'
import { dataDir, loadSettings, loadState, publicSettings, saveSettings, saveState } from './settings.js'
import { attachmentTarget, readAnnotations, readCollections, readItem, readItems, readStats, readTags } from './read.js'
import { createItem, updateItem, trashItems, deleteForever, createCollection, renameCollection, trashCollection, createAnnotationRecord, updateAnnotationRecord, removeAnnotationRecord } from './write.js'
import { importFile } from './ingest.js'
import { createStorageWatcher } from './watcher.js'
import { WebDavClient, syncStorage } from './webdav.js'
import { openExternal, revealInFolder } from './open.js'
import { PluginUpdater } from './updater.js'
import { createStandaloneLibrary } from './standalone.js'
import { ensureSession, readPage, sendMessage, stopTurn, workspaceDir } from './chat.js'
import { safeFileName, safeUnlink } from './util.js'

/** The library runtime shared by the API channel and tools. */
export function createLibraryRuntime({ ctx, config = {}, logger = console, packageDir }) {
  const home = dataDir()
  let settings = loadSettings()
  let state = loadState()
  let located
  let database
  let watcher
  let revision = 0
  let importChain = Promise.resolve()
  let syncTask
  let syncResult
  let autoSyncTimer

  const bump = () => {
    revision += 1
    return revision
  }

  function getSettings() {
    return settings
  }

  function paths() {
    if (located === undefined) {
      if (settings.mode === 'standalone') {
        located = createStandaloneLibrary(path.join(home, 'data'), logger)
        return located
      }
      const override = settings.zoteroDataDir || config.zoteroDataDir
      // First open: ask before touching the user's Zotero data. An explicit
      // directory (config or settings) counts as the answer "link".
      if (settings.mode !== 'zotero' && !override) {
        throw Object.assign(new Error(
          'The library source is not chosen yet. Open the library panel and link Zotero or create a standalone library.',
        ), { code: 'library/needs-choice' })
      }
      const found = locateZotero({ override })
      if (!found) {
        throw Object.assign(new Error(override
          ? `No zotero.sqlite under ${override}. Point the data directory at the Zotero folder, or switch to a standalone library.`
          : 'No Zotero data directory was found. Link your Zotero library or create a standalone one from the library page.'), { code: 'library/no-library' })
      }
      located = found
    }
    return located
  }

  /** Choose the library source: link Zotero ('zotero') or go standalone. */
  function setupLibrary(mode) {
    if (mode !== 'zotero' && mode !== 'standalone') {
      throw Object.assign(new Error('mode must be "zotero" or "standalone"'), { code: 'library/invalid' })
    }
    settings = saveSettings({ mode })
    located = undefined
    closeDb()
    if (mode === 'standalone') createStandaloneLibrary(path.join(home, 'data'), logger)
    startWatcher()
    bump()
    return stateSnapshot()
  }

  // Zotero is the source of truth; before the first local write of a run, keep
  // a full copy so a bad edit can always be reverted.
  let backupTaken = false
  function ensureBackup() {
    if (backupTaken) return
    const where = paths()
    const dir = path.join(home, 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(dir, `zotero-${stamp}.sqlite`)
    fs.copyFileSync(where.dbPath, target)
    const backups = fs.readdirSync(dir).filter(name => /^zotero-.*\.sqlite$/.test(name)).sort()
    for (const stale of backups.slice(0, Math.max(0, backups.length - 3))) {
      try {
        safeUnlink(path.join(dir, stale))
      } catch {
        // An old backup that cannot be removed is harmless.
      }
    }
    backupTaken = true
  }

  function closeDb() {
    try {
      database?.close()
    } finally {
      database = undefined
    }
  }

  function db() {
    if (database !== undefined) return database
    const where = paths()
    if (!fs.existsSync(where.dbPath)) {
      throw Object.assign(new Error(`zotero.sqlite is missing under ${where.dataDir}`), { code: 'library/no-library' })
    }
    const instance = new ZoteroDb({ dbPath: where.dbPath, logger })
    instance.open()
    // Expose storageDir to read helpers through the instance.
    instance.storageDir = where.storageDir
    database = instance
    try {
      instance.schema()
    } catch (error) {
      closeDb()
      throw error
    }
    return instance
  }

  /** Run a database operation, reopening once if the file was replaced underneath us. */
  function withDb(fn) {
    try {
      return fn(db())
    } catch (error) {
      if (String(error?.code ?? '').startsWith('ERR_SQLITE') && /disk I\/O|malformed|not a database|unable to open/i.test(String(error?.message))) {
        closeDb()
        return fn(db())
      }
      throw error
    }
  }

  function startWatcher() {
    if (watcher !== undefined) {
      watcher.dispose()
      watcher = undefined
    }
    let where
    try {
      where = paths()
    } catch {
      return
    }
    let instance
    try {
      instance = db()
    } catch (error) {
      logger.warn?.(`library: storage watcher not started: ${error?.message ?? error}`)
      return
    }
    watcher = createStorageWatcher({
      storageDir: where.storageDir,
      db: instance,
      logger,
      onChange: (keys) => {
        bump()
        logger.info?.(`library: attachment files changed (${keys.join(', ')})`)
      },
    })
  }

  function refreshSettings(patch) {
    settings = saveSettings(patch)
    located = undefined
    closeDb()
    startWatcher()
    bump()
    return publicSettings()
  }

  /**
   * A running Zotero holds the rollback-journal lock on zotero.sqlite; every
   * direct connection (even read-only) gets SQLITE_BUSY until it exits. Report
   * that case with its own code so the UI can explain and auto-recover.
   */
  function lockedError(error) {
    const text = `${error?.code ?? ''} ${error?.message ?? error}`
    if (/database is locked|ERR_SQLITE_BUSY/i.test(text)) {
      return {
        code: 'library/db-locked',
        message: 'Zotero 正在运行并锁定了数据库（zotero.sqlite）。退出 Zotero 后文库会自动恢复，无需重启 dsh。',
      }
    }
    return { code: error?.code ?? 'library/error', message: String(error?.message ?? error) }
  }

  function stateSnapshot() {
    const base = { settings: publicSettings(), sync: { running: syncTask !== undefined, last: syncResult }, revision, version: config.version }
    try {
      const where = paths()
      const stats = withDb(instance => readStats(instance))
      return {
        ...base,
        available: true,
        dataDir: where.dataDir,
        dbPath: where.dbPath,
        storageDir: where.storageDir,
        source: where.source,
        mode: settings.mode,
        schemaVersion: stats.schemaVersion,
        counts: stats,
      }
    } catch (error) {
      // With no choice made yet, tell the browser whether Zotero exists so the
      // first-open dialog can offer "link" next to "standalone".
      let zoteroFound
      if (settings.mode === 'unset') {
        try {
          zoteroFound = locateZotero({ override: settings.zoteroDataDir || config.zoteroDataDir }) !== undefined
        } catch {
          zoteroFound = false
        }
      }
      return {
        ...base,
        available: false,
        mode: settings.mode,
        needsChoice: settings.mode === 'unset',
        zoteroFound,
        error: lockedError(error),
      }
    }
  }

  function importOne(input) {
    const run = async () => {
      ensureBackup()
      const result = await importFile(db(), paths(), {
        filePath: input.filePath,
        parentKey: input.parentKey,
        collectionID: input.collectionID,
        lookup: input.lookup,
        metadata: input.metadata,
        logger,
      })
      bump()
      return result
    }
    importChain = importChain.then(run, run)
    return importChain
  }

  function saveUpload(name, base64) {
    const buffer = Buffer.from(String(base64 ?? ''), 'base64')
    if (buffer.byteLength === 0) throw Object.assign(new Error('The uploaded file is empty'), { code: 'library/invalid' })
    const uploads = path.join(home, 'uploads')
    fs.mkdirSync(uploads, { recursive: true })
    const target = path.join(uploads, `${Date.now()}-${safeFileName(name)}`)
    fs.writeFileSync(target, buffer)
    return target
  }

  async function runSync() {
    if (syncTask !== undefined) return syncTask
    const settingsNow = getSettings()
    if (settingsNow.webdav.url === '') throw Object.assign(new Error('WebDAV is not configured'), { code: 'library/webdav-missing' })
    const client = new WebDavClient(settingsNow.webdav)
    syncTask = (async () => {
      try {
        const result = await syncStorage({ db: db(), storageDir: paths().storageDir, client, logger })
        syncResult = { at: new Date().toISOString(), ...result }
        bump()
        return syncResult
      } finally {
        syncTask = undefined
      }
    })()
    return syncTask
  }

  const updater = new PluginUpdater({
    packageDir,
    dataDir: home,
    currentVersion: config.version,
    feedUrl: () => getSettings().updateFeed || config.updateFeed || '',
    logger,
  })

  function openRecord(key, reveal = false) {
    const detail = withDb(instance => readItem(instance, key, paths()))
    // Prefer a PDF child, then any child attachment, then the item itself when
    // it is a top-level attachment. Child rows carry rawPath/linkMode; the
    // target is resolved here because readItem only resolves the self target.
    const pdf = detail.attachments.find(entry => entry.contentType === 'application/pdf')
    const attachment = detail.attachment ?? pdf ?? detail.attachments[0]
    if (!attachment) throw Object.assign(new Error('This item has no attachment to open'), { code: 'library/not-found' })
    const target = attachmentTarget(paths().storageDir, attachment.key, attachment.rawPath, attachment.linkMode)
    if (target.kind === 'url') {
      openExternal(target.url)
      return { opened: target.url }
    }
    if (target.kind !== 'file' || !fs.existsSync(target.path)) {
      throw Object.assign(new Error(`Attachment file is missing on disk: ${target.path}`), { code: 'library/not-found' })
    }
    const opened = reveal ? revealInFolder(target.path) : openExternal(target.path)
    return { opened: target.path, ok: opened }
  }

  // Resolve one attachment to its on-disk file for the built-in reader. Accepts
  // either an attachment key or a parent item key (like openRecord).
  function resolveAttachment(key) {
    const detail = withDb(instance => readItem(instance, String(key ?? ''), paths()))
    // A top-level attachment resolves to itself; anything else prefers its PDF child.
    let attachment
    if (detail.itemType === 'attachment' && detail.attachment) {
      attachment = {
        key: detail.key,
        title: detail.title,
        contentType: detail.attachment.contentType,
        rawPath: detail.attachment.rawPath,
        linkMode: detail.attachment.linkMode,
      }
    } else {
      const pdf = (detail.attachments ?? []).find(entry => entry.contentType === 'application/pdf')
      attachment = pdf ?? (detail.attachments ?? [])[0]
    }
    if (!attachment) throw Object.assign(new Error('该条目没有可打开的附件'), { code: 'library/not-found' })
    const target = attachmentTarget(paths().storageDir, attachment.key, attachment.rawPath, attachment.linkMode)
    if (target.kind !== 'file' || !fs.existsSync(target.path)) {
      throw Object.assign(new Error(`附件文件不存在：${target.path}`), { code: 'library/not-found' })
    }
    return {
      detailKey: detail.key,
      detailTitle: detail.title ?? '',
      attachment,
      target,
    }
  }

  // Metadata for the binary reader route (no base64 round trip).
  function attachmentFileInfo(key) {
    const { detailKey, attachment, target } = resolveAttachment(key)
    return {
      key: attachment.key,
      parentKey: detailKey,
      title: attachment.title || '',
      fileName: path.basename(target.path),
      contentType: attachment.contentType || 'application/pdf',
      path: target.path,
      size: fs.statSync(target.path).size,
    }
  }

  const runtime = {
    ctx,
    logger,
    home,
    getSettings,
    paths,
    db,
    withDb,
    bump,
    state: stateSnapshot,
    /** The raw mutable chat state (chatSessionId / chatContext) for the prompt section. */
    chatState: () => state,
    /** The Library workspace directory (session-cwd gate for the guidance section). */
    workspaceDir: () => workspaceDir(home),
    collections: () => withDb(instance => readCollections(instance)),
    tags: () => withDb(instance => readTags(instance)),
    items: filter => withDb(instance => readItems(instance, filter)),
    item: key => withDb(instance => readItem(instance, key, paths())),
    create: input => {
      ensureBackup()
      const created = withDb(instance => createItem(instance, input))
      bump()
      return { key: created.key }
    },
    update: (key, patch) => {
      ensureBackup()
      withDb(instance => updateItem(instance, key, patch))
      bump()
      return { key, updated: true }
    },
    trash: (keys, deleted) => {
      ensureBackup()
      const changed = withDb(instance => trashItems(instance, keys, deleted))
      bump()
      return { changed }
    },
    deleteForever: keys => {
      ensureBackup()
      const deleted = withDb(instance => deleteForever(instance, keys))
      bump()
      return { deleted }
    },
    createCollection: input => {
      ensureBackup()
      const created = withDb(instance => createCollection(instance, input))
      bump()
      return created
    },
    renameCollection: (id, name) => {
      ensureBackup()
      withDb(instance => renameCollection(instance, id, name))
      bump()
      return { ok: true }
    },
    trashCollection: (id, deleted) => {
      ensureBackup()
      const changed = withDb(instance => trashCollection(instance, id, deleted))
      bump()
      return { changed }
    },
    importFile: importOne,
    saveUpload,
    openRecord,
    attachmentFileInfo: key => attachmentFileInfo(key),
    /** Annotations of one attachment, positions parsed (the built-in reader). */
    annotations: key => withDb(instance => readAnnotations(instance, String(key ?? ''))),
    createAnnotation: (attachmentKey, input) => {
      ensureBackup()
      const created = withDb(instance => createAnnotationRecord(instance, attachmentKey, input))
      bump()
      return created
    },
    updateAnnotation: (key, patch) => {
      ensureBackup()
      const updated = withDb(instance => updateAnnotationRecord(instance, key, patch))
      bump()
      return updated
    },
    removeAnnotation: key => {
      ensureBackup()
      const removed = withDb(instance => removeAnnotationRecord(instance, key))
      bump()
      return removed
    },
    runSync,
    verifySync: async () => {
      const settingsNow = getSettings()
      if (settingsNow.webdav.url === '') throw Object.assign(new Error('WebDAV is not configured'), { code: 'library/webdav-missing' })
      return await new WebDavClient(settingsNow.webdav).verify()
    },
    syncStatus: () => ({ running: syncTask !== undefined, last: syncResult }),
    refreshSettings,
    setupLibrary,
    /**
     * Update the dock context (open article / reader selection) without a
     * chat-send. The guidance section reads this on every model step, so the
     * native composer in the dock is grounded too. Not persisted immediately:
     * the next chat send/save writes it along.
     */
    setChatContext: context => {
      state.chatContext = {
        mode: ['list', 'item', 'reader'].includes(context?.mode) ? context.mode : 'list',
        itemKey: typeof context?.itemKey === 'string' ? context.itemKey : undefined,
        itemTitle: typeof context?.itemTitle === 'string' ? context.itemTitle : undefined,
      }
      return { saved: true }
    },
    chat: {
      open: async (fresh) => {
        const sessionId = await ensureSession(ctx, home, state, { fresh, logger })
        saveState(state)
        return { sessionId }
      },
      page: async (options) => {
        const page = await readPage(ctx, home, state, options)
        saveState(state)
        return page
      },
      send: async (text, context) => {
        const result = await sendMessage(ctx, home, state, text, context)
        saveState(state)
        return result
      },
      stop: async () => {
        const result = await stopTurn(ctx, home, state)
        saveState(state)
        return result
      },
    },
    updates: {
      status: () => updater.status(),
      check: () => updater.check(),
      apply: () => updater.apply(),
    },
    dispose() {
      watcher?.dispose()
      clearInterval(autoSyncTimer)
      closeDb()
    },
  }

  startWatcher()
  if (settings.autoSync && settings.webdav.url !== '') {
    autoSyncTimer = setInterval(() => {
      void runSync().catch(error => logger.warn?.(`library: auto sync failed: ${error?.message ?? error}`))
    }, 30 * 60_000)
    autoSyncTimer.unref?.()
    setTimeout(() => {
      void runSync().catch(() => {})
    }, 20_000).unref?.()
  }

  return runtime
}
