// Plugin settings and runtime state under $DSH_HOME/library.
import path from 'node:path'
import { dshHome, readJson, writeJson } from './util.js'

/** Directory holding the plugin's own data. */
export function dataDir() {
  return path.join(dshHome(), 'library')
}

/** Official release manifest (GitHub raw); used when no custom feed is set. */
export const DEFAULT_UPDATE_FEED = 'https://raw.githubusercontent.com/GenePad/dsh-zot-library/main/feed/manifest.json'

const FEED_OFF = /^(off|none|disabled|关闭|停用)$/i

/**
 * Effective update feed: the user's settings value wins; `off` (关闭) switches
 * updates off entirely; an empty value falls back to the bundle config and
 * then to the official GitHub source.
 */
export function resolveUpdateFeed(userValue, configValue) {
  const user = String(userValue ?? '').trim()
  if (user !== '') return FEED_OFF.test(user) ? '' : user
  const config = String(configValue ?? '').trim()
  if (config !== '') return FEED_OFF.test(config) ? '' : config
  return DEFAULT_UPDATE_FEED
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
    // Zotero client hand-off (zotero mode): exe path override for a
    // non-standard install (the zotero:// protocol handler is tried first).
    zoteroExePath: typeof raw.zoteroExePath === 'string' ? raw.zoteroExePath : '',
    // 一键修复: a userdata schema newer than MAX_SUPPORTED_SCHEMA that the user
    // explicitly accepted after the core-shape check; relaxes the version guard.
    acceptedSchema: Number.isFinite(raw.acceptedSchema) && raw.acceptedSchema > 0 ? raw.acceptedSchema : 0,
    updateFeed: typeof raw.updateFeed === 'string' ? raw.updateFeed : '',
    // Reader「译」button: one-shot translation. `modelSource` 'follow' uses
    // dsh's current model; 'fixed' pins settings.translate.model. `auto`
    // starts the translation as soon as the selection popup appears.
    translate: normalizeTranslate(raw.translate),
  }
}

function normalizeTranslate(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  return {
    thinking: value.thinking === true,
    // 划词自动翻译：选区浮窗一出现就开始翻译，默认关闭（点「译」才译）。
    auto: value.auto === true,
    modelSource: value.modelSource === 'fixed' ? 'fixed' : 'follow',
    model: typeof value.model === 'string' ? value.model : '',
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
    ...(typeof patch.zoteroExePath === 'string' ? { zoteroExePath: patch.zoteroExePath.trim() } : {}),
    ...(Number.isFinite(patch.acceptedSchema) && patch.acceptedSchema > 0 ? { acceptedSchema: patch.acceptedSchema } : {}),
    ...(typeof patch.updateFeed === 'string' ? { updateFeed: patch.updateFeed.trim() } : {}),
    ...(patch.translate && typeof patch.translate === 'object' ? { translate: normalizeTranslate(patch.translate) } : {}),
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
    translate: settings.translate,
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
