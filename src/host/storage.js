// Storage-directory operations: reading files, zipping for WebDAV, unzipping downloads.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { unzipSync, zipSync } from '../../vendor/deps.js'
import { safeRemoveTree } from './util.js'

/** Every non-directory file under a directory, relative paths with forward slashes. */
export function walkFiles(dir) {
  const files = []
  const walk = (current, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) files.push({ rel, full })
    }
  }
  walk(dir, '')
  return files
}

/** Zip an attachment directory the way Zotero's WebDAV upload does. */
export function zipDirectory(dir) {
  const entries = {}
  for (const file of walkFiles(dir)) {
    entries[file.rel] = new Uint8Array(fs.readFileSync(file.full))
  }
  return zipSync(entries, { level: 6 })
}

/** Extract a zip into a directory, rejecting entries that escape it. */
export function unzipInto(buffer, dir) {
  const entries = unzipSync(new Uint8Array(buffer))
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, data] of Object.entries(entries)) {
    const target = path.resolve(dir, name)
    if (target !== path.resolve(dir) && !target.startsWith(`${path.resolve(dir)}${path.sep}`)) {
      throw new Error(`library: zip entry escapes its directory: ${name}`)
    }
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
  }
}

/** MD5 of a buffer or file, as Zotero's storage hash. */
export function md5(input) {
  const hash = crypto.createHash('md5')
  if (typeof input === 'string') hash.update(fs.readFileSync(input))
  else hash.update(input)
  return hash.digest('hex')
}

/** Most recent mtime among files in a directory (ms), or 0. */
export function directoryMtime(dir) {
  let newest = 0
  for (const file of walkFiles(dir)) {
    try {
      newest = Math.max(newest, Math.round(fs.statSync(file.full).mtimeMs))
    } catch {
      // A file that vanished mid-walk has no mtime to report.
    }
  }
  return newest
}

/** Remove a directory tree, tolerating absence. */
export function removeTree(dir) {
  try {
    safeRemoveTree(dir)
  } catch {
    // Windows may hold a handle briefly; a leftover directory is harmless.
  }
}
