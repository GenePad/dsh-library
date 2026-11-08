// Document-specific data ("document preferences") as stored in the word
// processor document. Portable with Zotero: understands the legacy colon
// format (v1), the XML format (v2/v3) and the JSON format (v4).
import {
  DATA_VERSION, NOTE_ENDNOTE, NOTE_FOOTNOTE, escapeXml, unescapeXml, randomString,
} from './constants.js'

function parseXml(xmlData) {
  const source = String(xmlData ?? '')
  const root = /<data\b([^>]*)>/.exec(source)?.[1] ?? ''
  const attr = (name) => {
    const match = new RegExp(`\\b${name}="([^"]*)"`).exec(root)
    return match ? unescapeXml(match[1]) : ''
  }
  const session = /<session\b[^>]*\bid="([^"]*)"/.exec(source)
  const style = /<style\b([^>]*)\/>/.exec(source)?.[1] ?? ''
  const styleAttr = (name) => {
    const match = new RegExp(`\\b${name}="([^"]*)"`).exec(style)
    return match ? unescapeXml(match[1]) : ''
  }
  const prefs = {}
  for (const match of source.matchAll(/<pref\b([^>]*)\/>/g)) {
    const tag = match[1]
    const name = /\bname="([^"]*)"/.exec(tag)?.[1]
    const value = /\bvalue="([^"]*)"/.exec(tag)?.[1]
    if (name === undefined) continue
    const text = unescapeXml(value ?? '')
    prefs[unescapeXml(name)] = text === 'true' ? true : text === 'false' ? false : text
  }
  return {
    sessionID: session ? unescapeXml(session[1]) : '',
    zoteroVersion: attr('zotero-version') || '2.0',
    dataVersion: Number(attr('data-version')) || 2,
    style: {
      styleID: styleAttr('id'),
      locale: styleAttr('locale'),
      hasBibliography: styleAttr('hasBibliography') === '1',
      bibliographyStyleHasBeenSet: styleAttr('bibliographyStyleHasBeenSet') === '1',
    },
    prefs: {
      ...prefs,
      noteType: Number.parseInt(prefs.noteType, 10) || 0,
      automaticJournalAbbreviations: prefs.automaticJournalAbbreviations === true,
    },
  }
}

function parseLegacy(input) {
  // Zotero 2.0b6 and earlier: colon-delimited, with "::" as an escaped colon.
  const splitRe = /(^|[^:]):(?!:)/
  const parts = input.split(splitRe)
  const values = []
  for (let i = 0; i < parts.length; i += 2) {
    values.push((parts[i] + (parts[i + 1] ?? '')).replace(/::/g, ':'))
  }
  return {
    sessionID: values[0] ?? '',
    zoteroVersion: '2.0b6 or earlier',
    dataVersion: 1,
    style: {
      styleID: values[1] ?? '',
      hasBibliography: values[3] === '1' || values[3] === 'True',
      bibliographyStyleHasBeenSet: false,
    },
    prefs: {
      fieldType: values[5] === '1' || values[5] === 'True' ? 'Bookmark' : 'Field',
      noteType: values[2] === 'note'
        ? (values[4] === '1' || values[4] === 'True' ? NOTE_ENDNOTE : NOTE_FOOTNOTE)
        : 0,
    },
  }
}

export class DocumentData {
  constructor(string, version = '0.2.1') {
    this.version = version
    this.style = {}
    this.prefs = {}
    this.sessionID = null
    this.zoteroVersion = version
    this.dataVersion = DATA_VERSION
    if (string) this.unserialize(string)
  }

  serialize() {
    if (this.dataVersion === 4) {
      const style = {}
      for (const key of ['styleID', 'locale', 'hasBibliography', 'bibliographyStyleHasBeenSet']) {
        style[key] = this.style[key]
      }
      return JSON.stringify({
        style,
        prefs: this.prefs,
        sessionID: this.sessionID,
        zoteroVersion: this.version,
        dataVersion: 4,
      })
    }
    let prefs = ''
    for (const [name, value] of Object.entries(this.prefs)) {
      if (!value) continue
      prefs += `<pref name="${escapeXml(name)}" value="${escapeXml(String(value))}"/>`
    }
    return `<data data-version="${DATA_VERSION}" zotero-version="${escapeXml(this.version)}">`
      + `<session id="${escapeXml(this.sessionID ?? '')}"/>`
      + `<style id="${escapeXml(this.style.styleID ?? '')}" `
      + (this.style.locale ? `locale="${escapeXml(this.style.locale)}" ` : '')
      + `hasBibliography="${this.style.hasBibliography ? '1' : '0'}" `
      + `bibliographyStyleHasBeenSet="${this.style.bibliographyStyleHasBeenSet ? '1' : '0'}" />`
      + (prefs ? `<prefs>${prefs}</prefs>` : '<prefs/>')
      + '</data>'
  }

  unserialize(input) {
    const text = String(input ?? '').trim()
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        Object.assign(this, parsed)
        this.style = { ...(parsed.style ?? {}) }
        this.prefs = { ...(parsed.prefs ?? {}) }
        return this
      }
    } catch { /* not JSON */ }
    if (text.startsWith('<')) {
      Object.assign(this, parseXml(text))
      return this
    }
    Object.assign(this, parseLegacy(text))
    return this
  }

  /** Build a fresh data object for a brand new document. */
  static fresh(version) {
    const data = new DocumentData('', version)
    data.sessionID = randomString(8)
    data.style = {
      styleID: 'http://www.zotero.org/styles/apa',
      locale: '',
      hasBibliography: true,
      bibliographyStyleHasBeenSet: false,
    }
    data.prefs = {
      fieldType: 'Field',
      noteType: 0,
      automaticJournalAbbreviations: false,
      delayCitationUpdates: false,
      dontAskDelayCitationUpdates: false,
    }
    return data
  }
}

export { parseXml as parseDocumentDataXml }
