// Locating the Zotero data directory (zotero.sqlite + storage/).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJson } from './util.js'

/** Default data-directory candidates per platform, most specific first. */
function defaultCandidates() {
  const home = os.homedir()
  const appData = process.env.APPDATA
  const list = []
  if (process.platform === 'win32') {
    if (home) list.push(path.join(home, 'Zotero'))
    if (appData) list.push(path.join(appData, 'Zotero', 'Zotero'), path.join(appData, 'Zotero'))
    if (home) list.push(path.join(home, 'Documents', 'Zotero'), path.join(home, 'OneDrive', 'Zotero'))
  } else {
    list.push(path.join(home, 'Zotero'))
    if (process.platform === 'darwin') {
      list.push(path.join(home, 'Library', 'Application Support', 'Zotero'), path.join(home, 'Documents', 'Zotero'))
    } else {
      list.push(path.join(home, '.zotero', 'zotero'), path.join(home, '.local', 'share', 'zotero'), path.join(home, 'Documents', 'Zotero'))
    }
  }
  return list
}

/** Profile directories that may carry prefs.js pointing at a custom data directory. */
function profileDirs() {
  const home = os.homedir()
  const appData = process.env.APPDATA
  const roots = []
  if (process.platform === 'win32') {
    if (appData) roots.push(path.join(appData, 'Zotero', 'Zotero', 'Profiles'))
    if (home) roots.push(path.join(home, 'AppData', 'Roaming', 'Zotero', 'Zotero', 'Profiles'))
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'Zotero', 'Profiles'))
  } else {
    roots.push(path.join(home, '.zotero', 'zotero', 'Profiles'), path.join(home, '.zotero', 'Profiles'))
  }
  const dirs = []
  for (const root of roots) {
    let names = []
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = path.join(root, name)
      if (fs.existsSync(path.join(dir, 'prefs.js'))) dirs.push(dir)
    }
  }
  return dirs
}

/** Extract a quoted pref value from a Firefox prefs.js line. */
function prefValue(text, name) {
  const match = new RegExp(`user_pref\\("${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",\\s*"((?:[^"\\\\]|\\\\.)*)"\\)`).exec(text)
  if (!match) return undefined
  try {
    return JSON.parse(`"${match[1]}"`)
  } catch {
    return match[1]
  }
}

/** A directory that looks like a Zotero data directory. */
export function isDataDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'zotero.sqlite')).isFile()
  } catch {
    return false
  }
}

/** The Zotero profile that last opened this data directory, best effort. */
function profileFor(dataDir) {
  for (const dir of profileDirs()) {
    try {
      const text = fs.readFileSync(path.join(dir, 'prefs.js'), 'utf8')
      const saved = prefValue(text, 'extensions.zotero.dataDir')
      if (saved && path.resolve(saved) === path.resolve(dataDir)) return { dir, prefs: text }
    } catch {
      // One unreadable profile must not stop the others from answering.
    }
  }
  return undefined
}

/**
 * Resolve the Zotero data directory.
 * @param {object} options
 * @param {string} [options.override] - explicit directory from config or settings.
 * @returns {{dataDir:string, dbPath:string, storageDir:string, profileDir?:string, prefsText?:string, source:string} | undefined}
 */
export function locateZotero(options = {}) {
  const candidates = []
  if (typeof options.override === 'string' && options.override.trim() !== '') {
    candidates.push({ dir: path.resolve(options.override), source: 'override' })
  }
  // A profile pref beats the defaults: it records where the user actually moved the data.
  for (const dir of profileDirs()) {
    try {
      const text = fs.readFileSync(path.join(dir, 'prefs.js'), 'utf8')
      for (const name of ['extensions.zotero.dataDir', 'extensions.zotero.lastDataDir']) {
        const saved = prefValue(text, name)
        if (!saved) continue
        if (path.isAbsolute(saved)) candidates.push({ dir: path.resolve(saved), source: 'prefs' })
      }
    } catch {
      // Ignore an unreadable profile.
    }
  }
  for (const dir of defaultCandidates()) candidates.push({ dir, source: 'default' })

  const seen = new Set()
  for (const candidate of candidates) {
    const dir = path.resolve(candidate.dir)
    if (seen.has(dir)) continue
    seen.add(dir)
    if (!isDataDir(dir)) continue
    const profile = profileFor(dir)
    return {
      dataDir: dir,
      dbPath: path.join(dir, 'zotero.sqlite'),
      storageDir: path.join(dir, 'storage'),
      ...(profile ? { profileDir: profile.dir, prefsText: profile.prefs } : {}),
      source: candidate.source,
    }
  }
  return undefined
}

/** Read the plugin's saved settings (data directory override etc.). */
export function savedDataDir(settingsFile) {
  const settings = readJson(settingsFile)
  return typeof settings?.zoteroDataDir === 'string' && settings.zoteroDataDir.trim() !== ''
    ? settings.zoteroDataDir
    : undefined
}
