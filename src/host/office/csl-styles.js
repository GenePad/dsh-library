// CSL style store: Zotero-compatible style IDs, bundled seeds, repository
// search/install (including dependent -> independent-parent chains), locales
// and renamed-style migration.
import fs from 'node:fs'
import path from 'node:path'

const STYLE_PREFIX = 'http://www.zotero.org/styles/'
const STYLE_INDEX_URL = 'https://www.zotero.org/styles-files/styles.json'
const STYLE_DOWNLOAD = 'https://www.zotero.org/styles/'

export function parseStyleMetadata(xml) {
  const source = String(xml ?? '')
  const info = source.slice(0, Math.min(source.length, 200_000))
  const text = (pattern) => {
    const match = pattern.exec(info)
    return match ? decodeEntities(match[1].trim()) : ''
  }
  const styleTag = /<style\b([^>]*)>/.exec(source)?.[1] ?? ''
  const styleClass = /\bclass="([^"]+)"/.exec(styleTag)?.[1] ?? 'in-text'
  const id = text(/<id>\s*([^<]+?)\s*<\/id>/) || ''
  const parentMatch = /<link\b[^>]*\brel="independent-parent"[^>]*\bhref="([^"]+)"/.exec(info)
    || /<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="independent-parent"/.exec(info)
  // The <bibliography> element can sit arbitrarily far into the file (APA's
  // info header alone is >40KB), so scan the whole document, not just the head.
  const hasBibliography = /<bibliography\b[\s\S]*?<\/bibliography>|<bibliography\b[^>]*\/>/.test(source)
  return {
    styleID: id || '',
    title: text(/<title>\s*([^<]+?)\s*<\/title>/) || 'Untitled style',
    titleShort: text(/<title-short>\s*([^<]+?)\s*<\/title-short>/) || '',
    class: styleClass === 'note' ? 'note' : 'in-text',
    hasBibliography,
    independentParent: parentMatch ? parentMatch[1] : '',
    usesAbbreviation: /<category\b[^>]*\bfield="medicine"|journalAbbreviation/.test(source),
    defaultLocale: /\bdefault-locale="([^"]+)"/.exec(styleTag)?.[1] ?? '',
  }
}

function decodeEntities(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/** Normalise any style identifier (URL, short name, legacy id) to a Zotero ID. */
export function normalizeStyleID(input, renamed = {}) {
  let value = String(input ?? '').trim()
  if (!value) return `${STYLE_PREFIX}apa`
  value = value.replace(/^https?:\/\/(?:www\.)?(?:zotero\.org|citationstyles\.org)\/styles\//i, '')
  value = value.replace(/\.csl$/i, '').replace(/\/+$/, '')
  value = value.split('/').pop() || value
  value = value.toLowerCase()
  if (renamed[value]) value = renamed[value]
  return STYLE_PREFIX + value
}

export function styleFileName(styleID) {
  return normalizeStyleID(styleID).slice(STYLE_PREFIX.length)
}

export function createStyleStore({ logger = console, packageDir, home }) {
  const assets = path.join(packageDir, 'assets', 'csl')
  const root = path.join(home, 'csl')
  const stylesDir = path.join(root, 'styles')
  const localesDir = path.join(root, 'locales')
  const indexFile = path.join(root, 'styles-index.json')
  let renamed = {}
  let repository = null
  let repositoryFetchedAt = 0

  function ensureSeeds() {
    fs.mkdirSync(stylesDir, { recursive: true })
    fs.mkdirSync(localesDir, { recursive: true })
    for (const [from, to] of [[path.join(assets, 'styles'), stylesDir], [path.join(assets, 'locales'), localesDir]]) {
      if (!fs.existsSync(from)) continue
      for (const name of fs.readdirSync(from)) {
        const target = path.join(to, name)
        if (!fs.existsSync(target)) fs.copyFileSync(path.join(from, name), target)
      }
    }
    const renamedTarget = path.join(root, 'renamed-styles.json')
    if (!fs.existsSync(renamedTarget) && fs.existsSync(path.join(assets, 'renamed-styles.json'))) {
      fs.copyFileSync(path.join(assets, 'renamed-styles.json'), renamedTarget)
    }
    try {
      renamed = JSON.parse(fs.readFileSync(renamedTarget, 'utf8'))
    } catch {
      renamed = {}
    }
  }

  ensureSeeds()

  function stylePath(styleID) {
    const name = styleFileName(normalizeStyleID(styleID, renamed))
    return path.join(stylesDir, `${name}.csl`)
  }

  function get(styleID) {
    const canonical = normalizeStyleID(styleID, renamed)
    const file = stylePath(canonical)
    if (!fs.existsSync(file)) {
      // A renamed style may already be installed under its new name.
      const alias = renamed[styleFileName(canonical)]
      if (alias) return get(alias)
      throw Object.assign(new Error(`未安装引用样式：${styleFileName(canonical)}`), { code: 'style/missing', styleID: canonical })
    }
    const xml = fs.readFileSync(file, 'utf8')
    const meta = parseStyleMetadata(xml)
    return {
      ...meta,
      styleID: meta.styleID || canonical,
      shortName: styleFileName(canonical),
      xml,
      file,
    }
  }

  function list() {
    const result = []
    for (const name of fs.readdirSync(stylesDir)) {
      if (!name.endsWith('.csl')) continue
      try {
        const meta = parseStyleMetadata(fs.readFileSync(path.join(stylesDir, name), 'utf8'))
        result.push({
          styleID: `${STYLE_PREFIX}${name.slice(0, -4)}`,
          shortName: name.slice(0, -4),
          title: meta.title,
          titleShort: meta.titleShort,
          class: meta.class,
          hasBibliography: meta.hasBibliography,
          installed: true,
        })
      } catch { /* ignore an unreadable seed */ }
    }
    return result.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
  }

  function localesList() {
    try {
      return JSON.parse(fs.readFileSync(path.join(assets, 'locales.json'), 'utf8'))
    } catch {
      return [{ code: 'en-US', name: 'English (US)' }, { code: 'zh-CN', name: '中文（简体）' }]
    }
  }

  /** Return locale XML for a language tag, falling back the same way citeproc does. */
  function localeXml(lang) {
    const tag = String(lang || 'en-US').replace('_', '-')
    const candidates = [tag, tag.split('-')[0] === 'zh' ? 'zh-CN' : '', 'en-US']
    for (const candidate of candidates) {
      if (!candidate) continue
      const file = path.join(localesDir, `locales-${candidate}.xml`)
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    }
    const bundled = path.join(assets, 'locales', 'locales-en-US.xml')
    return fs.existsSync(bundled) ? fs.readFileSync(bundled, 'utf8') : ''
  }

  function resolveLocale(lang) {
    const tag = String(lang || 'en-US').replace('_', '-')
    if (fs.existsSync(path.join(localesDir, `locales-${tag}.xml`))) return tag
    const base = tag.split('-')[0]
    for (const name of fs.readdirSync(localesDir)) {
      const match = /^locales-(.+)\.xml$/.exec(name)
      if (match && match[1].split('-')[0] === base) return match[1]
    }
    return 'en-US'
  }

  async function repositoryIndex() {
    if (repository && Date.now() - repositoryFetchedAt < 24 * 3600_000) return repository
    try {
      if (fs.existsSync(indexFile)) {
        const stat = fs.statSync(indexFile)
        if (Date.now() - stat.mtimeMs < 24 * 3600_000) {
          repository = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
          repositoryFetchedAt = stat.mtimeMs
          return repository
        }
      }
    } catch { /* stale cache: refetch */ }
    const text = await (await fetch(STYLE_INDEX_URL, { signal: AbortSignal.timeout(25_000) })).text()
    repository = JSON.parse(text)
    repositoryFetchedAt = Date.now()
    try {
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(indexFile, text, 'utf8')
    } catch { /* cache is optional */ }
    return repository
  }

  async function search(query = '') {
    const needle = String(query ?? '').trim().toLowerCase()
    if (!needle) return list().slice(0, 60)
    const installed = new Set(list().map(entry => entry.shortName))
    let remote = []
    try {
      const index = await repositoryIndex()
      remote = index
        .filter(entry => `${entry.title} ${entry.titleShort ?? ''} ${entry.name}`.toLowerCase().includes(needle))
        .slice(0, 60)
        .map(entry => ({
          styleID: `${STYLE_PREFIX}${entry.name}`,
          shortName: entry.name,
          title: entry.title,
          titleShort: entry.titleShort ?? '',
          dependent: entry.dependent === 1,
          href: entry.href ?? `${STYLE_DOWNLOAD}${entry.name}`,
          categories: entry.categories ?? {},
          installed: installed.has(entry.name),
        }))
    } catch (error) {
      logger.warn?.(`library: style repository search failed: ${error?.message ?? error}`)
    }
    const local = list().filter(entry => `${entry.title} ${entry.shortName}`.toLowerCase().includes(needle))
    const seen = new Set(local.map(entry => entry.shortName))
    return [...local, ...remote.filter(entry => !seen.has(entry.shortName))]
  }

  /** Install a style and any independent parent it depends on. */
  async function install({ styleID, xml } = {}, seen = new Set()) {
    const canonical = normalizeStyleID(styleID, renamed)
    const short = styleFileName(canonical)
    if (seen.has(short)) return get(canonical)
    seen.add(short)
    let source = typeof xml === 'string' && xml.startsWith('<') ? xml : null
    if (!source) {
      const response = await fetch(`${STYLE_DOWNLOAD}${short}`, {
        headers: { 'user-agent': 'dsh-library/0.1 (Zotero-compatible research library)' },
        signal: AbortSignal.timeout(25_000),
      })
      if (!response.ok) throw new Error(`下载样式失败（HTTP ${response.status}）：${short}`)
      source = await response.text()
    }
    const meta = parseStyleMetadata(source)
    if (!source.includes('<style')) throw new Error(`样式文件无效：${short}`)
    if (meta.independentParent) {
      try {
        await install({ styleID: meta.independentParent }, seen)
      } catch (error) {
        logger.warn?.(`library: independent parent install failed: ${error?.message ?? error}`)
      }
    }
    fs.mkdirSync(stylesDir, { recursive: true })
    fs.writeFileSync(stylePath(canonical), source, 'utf8')
    return get(canonical)
  }

  return {
    get, list, search, install, localeXml, resolveLocale, localesList,
    normalizeStyleID: id => normalizeStyleID(id, renamed),
    styleFileName,
    renamedStyles: () => ({ ...renamed }),
    dirs: { root, stylesDir, localesDir },
  }
}
