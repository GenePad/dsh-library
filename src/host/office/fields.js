// Zotero field-code layer. Field objects wrap the word-processor field proxy
// (an HttpField or a smoke-test double) and translate between the client-layer
// field codes and JSON citation/bibliography objects.
import {
  INTEGRATION_TYPE_ITEM, INTEGRATION_TYPE_BIBLIOGRAPHY, INTEGRATION_TYPE_TEMP,
  FIELD_CODE_ITEM_PREFIX, FIELD_CODE_BIBL_PREFIX, FIELD_CODE_BIBL_SUFFIX,
  FIELD_CODE_TEMP, UserCancelled,
} from './constants.js'
import { LEGACY_LOCATOR_TERMS } from './items.js'
import { plainText } from './csl-citeproc.js'

export const FIELD_INTERFACE = [
  'delete', 'removeCode', 'select', 'setText', 'getText',
  'setCode', 'getCode', 'equals', 'getNoteIndex', 'isAdjacentToNextField',
]

const OLD_CITATION_LOCATOR_MAP = { p: 'page', g: 'paragraph', l: 'line' }
const DOUBLE_BRACE_RE = /{{((?:\s*,?"unsorted":(?:true|false)|\s*,?"custom":"(?:(?:\\")?[^"]*\s*)*")*)}}/

function safeParse(code) {
  try {
    return JSON.parse(code)
  } catch {
    // Zotero 2.1b1 wrote a doubled brace around "unsorted"/"custom".
    return JSON.parse(code.replace(DOUBLE_BRACE_RE, '{$1}'))
  }
}

/** Normalise every historical citation field-code shape Zotero can read. */
export function normalizeCitation(citation, rawCode = '') {
  if (!citation || typeof citation !== 'object') return null
  let out = { ...citation }
  // Zotero 2.x upper-cased every key.
  for (const key of Object.keys(out)) {
    if (key === key.toUpperCase() && key !== key.toLowerCase()) {
      const lower = key.toLowerCase()
      if (!(lower in out)) out[lower] = out[key]
      delete out[key]
    }
  }
  if (out.CITATIONID !== undefined) {
    // Mac Word "All Caps" corruption: rebuild from the pieces that survived.
    const allCaps = {
      citationID: out.CITATIONID,
      properties: {},
      citationItems: Array.isArray(out.CITATIONITEMS) ? out.CITATIONITEMS.map(item => ({ ...item })) : [],
    }
    const props = out.PROPERTIES ?? {}
    if (typeof props.NOTEINDEX === 'number') allCaps.properties.noteIndex = props.NOTEINDEX
    if (typeof props.UNSORTED === 'boolean') allCaps.properties.unsorted = props.UNSORTED
    // Deliberately drop formattedCitation/plainCitation/dontUpdate: the
    // rendered text was mangled along with the code and must be recomputed.
    for (const item of allCaps.citationItems) {
      delete item.URIS; delete item.uris
      delete item.ITEMDATA; delete item.itemData; delete item.itemdata
      for (const key of Object.keys(item)) {
        if (key === key.toUpperCase() && key !== key.toLowerCase()) {
          item[key.toLowerCase()] = item[key]
          delete item[key]
        }
      }
    }
    delete allCaps.SCHEMA
    out = { ...out, ...allCaps }
    for (const key of ['CITATIONID', 'CITATIONITEMS', 'PROPERTIES', 'SCHEMA']) delete out[key]
  }
  if (out.citationItems === undefined && out.CITATIONITEMS !== undefined) out.citationItems = out.CITATIONITEMS
  if (out.itemID !== undefined && out.citationItems === undefined) out.citationItems = [{ id: out.itemID }]
  out.properties = { ...(out.properties ?? {}) }
  out.citationItems = (Array.isArray(out.citationItems) ? out.citationItems : []).map((raw) => {
    const item = { ...raw }
    if (item.locatorType !== undefined) { item.label = item.locatorType; delete item.locatorType }
    if (item.suppressAuthor !== undefined) { item['suppress-author'] = item.suppressAuthor; delete item.suppressAuthor }
    if (typeof item.label === 'number') item.label = LEGACY_LOCATOR_TERMS[item.label] ?? 'page'
    if (item.uri !== undefined && !Array.isArray(item.uris)) {
      item.uris = Array.from(new Set([item.uri]))
      delete item.uri
    }
    if (item.ITEMDATA !== undefined) { item.itemData = item.ITEMDATA; delete item.ITEMDATA }
    return item
  })
  if (out.sort !== undefined) { out.properties.unsorted = !out.sort; delete out.sort }
  if (out.custom !== undefined) { out.properties.custom = out.custom; delete out.custom }
  if (rawCode) out.properties.field = rawCode
  return out
}

function unserializePreZotero1_0(code) {
  const underscore = code.indexOf('_')
  const ids = (underscore === -1 ? code : code.slice(0, underscore)).split('|')
  const locators = underscore === -1 ? [] : code.slice(underscore + 1).split('|')
  const items = ids.filter(Boolean).map((id, index) => {
    const raw = locators[index] ?? ''
    const label = OLD_CITATION_LOCATOR_MAP[raw.charAt(0)]
    return { id, ...(label ? { label, locator: raw.slice(1) } : {}) }
  })
  return { citationItems: items, properties: {} }
}

export class Field {
  constructor(field, rawCode, options = {}) {
    this._field = field
    this._code = String(rawCode ?? '')
    this.type = INTEGRATION_TYPE_TEMP
    this._text = undefined
    this.options = options
    // Expose the underlying field's verbs as our own (Zotero binds them).
    for (const name of FIELD_INTERFACE) {
      if (typeof field?.[name] === 'function' && !(name in this)) {
        this[name] = (...args) => field[name](...args)
      }
    }
  }

  /** Strip the client-layer wrapper, returning the bare `{...}` JSON. */
  getCode() {
    const start = this._code.indexOf('{')
    if (start === -1) return '{}'
    const end = this._code.lastIndexOf('}')
    if (end < start) return '{}'
    return this._code.slice(start, end + 1)
  }

  async setCode(code) {
    const value = String(code ?? '{}')
    if (this.type === INTEGRATION_TYPE_ITEM) await this._field.setCode(FIELD_CODE_ITEM_PREFIX + value)
    else if (this.type === INTEGRATION_TYPE_BIBLIOGRAPHY) await this._field.setCode(FIELD_CODE_BIBL_PREFIX + value + FIELD_CODE_BIBL_SUFFIX)
    else await this._field.setCode(FIELD_CODE_TEMP)
    this._code = value
  }

  async clearCode() { await this.setCode('{}') }

  async getText() {
    if (this._text === undefined) this._text = String(await this._field.getText() ?? '')
    return this._text
  }

  async setText(text, isRich = false) {
    let raw = String(text ?? '')
    let rich = Boolean(isRich)
    // citeproc emits bare RTF *fragments* for citations, e.g.
    // "(B\uc0\u252{}ning & Srivastava, 2019)", while a bibliography already is
    // a full "{\rtf ...}" document. Word's InsertFile only parses a file as
    // RTF when it starts with "{\rtf"; an unwrapped fragment gets inserted as
    // literal "\uc0\u252{}" text (exactly what the user saw in Word).
    // This mirrors Zotero.Integration.Field#setText.
    if (this.options.outputFormat === 'rtf' && raw.includes('\\')) {
      if (!raw.startsWith('{\\rtf')) raw = `{\\rtf ${raw}}`
      rich = true
    } else if (this.options.outputFormat === 'html' && raw.includes('<')) {
      rich = true
    }
    // The document field's getText() returns plain text, which is what Zotero
    // stores as properties.plainCitation for manual-edit detection.
    this._text = rich ? plainText(raw, this.options.outputFormat) : raw
    await this._field.setText(raw, rich)
  }

  /** Load an existing field, choosing the class by its raw code prefix. */
  static async loadExisting(docField, options = {}) {
    const rawCode = String(await docField.getCode() ?? '')
    let field
    if (rawCode.startsWith('ITEM') || rawCode.startsWith('CITATION')) {
      field = new CitationField(docField, rawCode, options)
    } else if (rawCode.startsWith('BIBL')) {
      field = new BibliographyField(docField, rawCode, options)
    } else {
      field = new Field(docField, rawCode, options)
    }
    return field
  }
}

export class CitationField extends Field {
  constructor(field, rawCode, options) {
    super(field, rawCode, options)
    this.type = INTEGRATION_TYPE_ITEM
  }

  async unserialize() {
    const code = this.getCode()
    try {
      if (code.charAt(0) === '{') {
        return normalizeCitation(safeParse(code), this._code)
      }
      return normalizeCitation(unserializePreZotero1_0(code), this._code)
    } catch {
      return this.resolveCorrupt(code)
    }
  }

  async clearCode() {
    await this.setCode(JSON.stringify({ citationItems: [], properties: {} }))
  }

  /** Ask the user whether a damaged field should be reset (Yes/No/Cancel). */
  async resolveCorrupt(code) {
    const alert = this.options.alert
    let choice = 1
    if (typeof alert === 'function') {
      choice = Number(await alert(
        `文档中的引注域代码已损坏，无法读取。是否清除该域的域代码？\n\n${String(code).slice(0, 120)}`,
        1, 3,
      ))
    }
    if (choice === 0) throw new UserCancelled('repairing a corrupted field')
    if (choice === 2) {
      await this.clearCode()
      return this.unserialize()
    }
    return { citationItems: [], properties: { dontUpdate: true }, damaged: true }
  }
}

export class BibliographyField extends Field {
  constructor(field, rawCode, options) {
    super(field, rawCode, options)
    this.type = INTEGRATION_TYPE_BIBLIOGRAPHY
  }

  async unserialize() {
    const code = this.getCode()
    try {
      const value = safeParse(code)
      return {
        uncited: Array.isArray(value?.uncited) ? value.uncited : [],
        omitted: Array.isArray(value?.omitted) ? value.omitted : [],
        custom: Array.isArray(value?.custom) ? value.custom : [],
      }
    } catch {
      return this.resolveCorrupt(code)
    }
  }

  async resolveCorrupt(code) {
    const alert = this.options.alert
    let choice = 1
    if (typeof alert === 'function') {
      choice = Number(await alert(`文档中的参考文献表域代码已损坏，是否清除？\n\n${String(code).slice(0, 120)}`, 1, 1))
    }
    if (choice === 0) return { uncited: [], omitted: [], custom: [] }
    return { uncited: [], omitted: [], custom: [], damaged: true }
  }
}
