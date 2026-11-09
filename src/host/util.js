// Small host-side helpers shared by the library modules.
import fs from 'node:fs'
import path from 'node:path'

/** Resolve the dsh home directory (DSH_HOME or ~/.dsh). */
export function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
}

/** Read JSON from disk, or undefined when missing/unreadable. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write JSON atomically (same-volume temp file then rename). */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temp, file)
}

/** SQL datetime in UTC ("YYYY-MM-DD HH:MM:SS"), the format Zotero writes. */
export function sqlNow(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** Zotero text normalization: compatibility decomposition, no marks, lowercase. */
export function normalizeText(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

/** Zotero object keys: 8 characters from this alphabet (no 0/1/O/I). */
const KEY_CHARS = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
export function objectKey() {
  let key = ''
  for (let i = 0; i < 8; i += 1) key += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]
  return key
}

/** Whether a string is a well-formed Zotero object key. */
export function isObjectKey(value) {
  return typeof value === 'string' && /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(value)
}

/** Limit a string to a byte budget without splitting surrogate pairs. */
export function clip(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Escape a file name the way Zotero does when importing an attachment. */
export function safeFileName(name) {
  const base = path.basename(String(name ?? 'attachment'))
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim()
  return cleaned === '' ? 'attachment' : cleaned.slice(0, 180)
}

/** Run async work over items with bounded concurrency. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let index = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const at = index
      index += 1
      results[at] = await worker(items[at], at)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Delete one file. fs.rmSync is avoided on purpose: on Node 24/win32 it
 * crashes the process natively for certain non-ASCII file names (Zotero names
 * attachments "作者 等 - 年份 - 标题.pdf"), while unlinkSync handles them.
 */
export function safeUnlink(file) {
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/** Delete a directory tree with unlink/rmdir only (see safeUnlink). */
export function safeRemoveTree(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
    throw error
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) safeRemoveTree(full)
    else safeUnlink(full)
  }
  try {
    fs.rmdirSync(dir)
  } catch {
    // Windows may hold a handle briefly; a leftover directory is harmless.
  }
}

/** Fetch JSON with a timeout and a useful error. */
export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'user-agent': 'dsh-zot-library/0.1 (Zotero-compatible research library)', ...(options.headers ?? {}) },
    signal: options.signal ?? AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return await response.json()
}
