// Plugin settings and runtime state under $DSH_HOME/library.
import path from 'node:path'
import { dshHome, readJson, writeJson } from './util.js'

/** Directory holding the plugin's own data. */
export function dataDir() {
  return path.join(dshHome(), 'library')
}

export function settingsFile() {
  return path.join(dataDir(), 'settings.json')
}

export function stateFile() {
  return path.join(dataDir(), 'state.json')
}

/** Load settings with defaults. */
export function loadSettings() {
  const raw = readJson(settingsFile()) ?? {}
  const mode = ['unset', 'zotero', 'standalone'].includes(raw.mode) ? raw.mode
    : typeof raw.zoteroDataDir === 'string' && raw.zoteroDataDir.trim() !== '' ? 'zotero'
      : 'unset'
  return {
    mode,
    zoteroDataDir: typeof raw.zoteroDataDir === 'string' ? raw.zoteroDataDir : '',
    webdav: raw.webdav && typeof raw.webdav === 'object'
      ? {
          url: String(raw.webdav.url ?? ''),
          username: String(raw.webdav.username ?? ''),
          password: String(raw.webdav.password ?? ''),
        }
      : { url: '', username: '', password: '' },
    autoSync: raw.autoSync === true,
    // Where double-click / "open" puts a PDF: the in-app pdf.js viewer tab or
    // the OS reader. (Legacy settings may hold 'dsh' — treated as builtin.)
    pdfOpen: ['native', 'builtin'].includes(raw.pdfOpen) ? raw.pdfOpen : 'builtin',
    updateFeed: typeof raw.updateFeed === 'string' ? raw.updateFeed : '',
  }
}

/** Merge a patch into settings and persist it. */
export function saveSettings(patch = {}) {
  const current = loadSettings()
  const next = {
    ...current,
    ...(['unset', 'zotero', 'standalone'].includes(patch.mode) ? { mode: patch.mode } : {}),
    ...(typeof patch.zoteroDataDir === 'string' ? { zoteroDataDir: patch.zoteroDataDir.trim() } : {}),
    ...(patch.webdav && typeof patch.webdav === 'object'
      ? {
          webdav: {
            url: String(patch.webdav.url ?? current.webdav.url).trim(),
            username: String(patch.webdav.username ?? current.webdav.username),
            password: String(patch.webdav.password ?? current.webdav.password),
          },
        }
      : {}),
    ...(patch.autoSync === undefined ? {} : { autoSync: patch.autoSync === true }),
    ...(['native', 'builtin'].includes(patch.pdfOpen) ? { pdfOpen: patch.pdfOpen } : {}),
    ...(typeof patch.updateFeed === 'string' ? { updateFeed: patch.updateFeed.trim() } : {}),
  }
  if (next.mode === 'standalone') next.zoteroDataDir = ''
  writeJson(settingsFile(), next)
  return next
}

/** Settings as the browser may see them (password only as a presence flag). */
export function publicSettings() {
  const settings = loadSettings()
  return {
    mode: settings.mode,
    zoteroDataDir: settings.zoteroDataDir,
    webdav: {
      url: settings.webdav.url,
      username: settings.webdav.username,
      hasPassword: settings.webdav.password !== '',
    },
    autoSync: settings.autoSync,
    pdfOpen: settings.pdfOpen,
    updateFeed: settings.updateFeed,
  }
}

/** Load runtime state (chat session, notifications). */
export function loadState() {
  return readJson(stateFile()) ?? {}
}

/** Persist runtime state. */
export function saveState(state) {
  writeJson(stateFile(), state)
}
