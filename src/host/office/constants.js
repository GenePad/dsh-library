// Constants and exceptions from Zotero's word-processor integration layer.
// Values must match the word plugin (dialog icon/button enums, note types).

export const DATA_VERSION = 3

export const FORCE_CITATIONS_FALSE = 0
export const FORCE_CITATIONS_REGENERATE = 1
export const FORCE_CITATIONS_RESET_TEXT = 2

export const DIALOG_ICON_STOP = 0
export const DIALOG_ICON_WARNING = 1
export const DIALOG_ICON_CAUTION = 2

export const DIALOG_BUTTONS_OK = 0
export const DIALOG_BUTTONS_OK_CANCEL = 1
export const DIALOG_BUTTONS_YES_NO = 2
export const DIALOG_BUTTONS_YES_NO_CANCEL = 3

export const NOTE_FOOTNOTE = 1
export const NOTE_ENDNOTE = 2

export const INTEGRATION_TYPE_ITEM = 1
export const INTEGRATION_TYPE_BIBLIOGRAPHY = 2
export const INTEGRATION_TYPE_TEMP = 3

export const NO_ACTION = 0
export const UPDATE = 1
export const DELETE = 2
export const REMOVE_CODE = 3

export const DELAYED_CITATION_RTF_STYLING = '\\uldash'
export const DELAYED_CITATION_RTF_STYLING_CLEAR = '\\ulclear'
export const EXPORTED_DOCUMENT_MARKER = 'ZOTERO_TRANSFER_DOCUMENT'
export const NOTE_CITATION_PLACEHOLDER_LINK = 'https://www.zotero.org/?'
export const CSL_CITATION_SCHEMA = 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json'

export const FIELD_CODE_ITEM_PREFIX = 'ITEM CSL_CITATION '
export const FIELD_CODE_BIBL_PREFIX = 'BIBL '
export const FIELD_CODE_BIBL_SUFFIX = ' CSL_BIBLIOGRAPHY'
export const FIELD_CODE_TEMP = 'TEMP'

export const TEMPLATE_VERSIONS = { MacWord16: 2, WinWord: 1, OpenOffice: 1 }
export const PLUGIN_VERSION = 1

export const commandList = [
  'addCitation', 'editCitation', 'addEditCitation',
  'addBibliography', 'editBibliography', 'addEditBibliography',
  'addNote', 'addAnnotation', 'citationExplorer',
  'refresh', 'removeCodes', 'setDocPrefs', 'exportDocument',
  'applyAiEdit',
]

/** The user dismissed a dialog / aborted a command. Not an error to report. */
export class UserCancelled extends Error {
  constructor(what = 'current operation') {
    super(`User cancelled ${what}.`)
    this.name = 'UserCancelledException'
    this.whatCancelled = what
  }
}

/** An error whose message should be shown to the user in the word processor. */
export class AlertError extends Error {
  constructor(message, options = {}) {
    super(String(message ?? '集成命令失败'))
    this.name = 'AlertError'
    this.dialogIcon = options.dialogIcon ?? DIALOG_ICON_STOP
    this.dialogButtons = options.dialogButtons ?? DIALOG_BUTTONS_OK
    this.supportURL = options.supportURL ?? ''
  }
}

export class MissingItemException extends Error {
  constructor(id) {
    super(`Missing item ${id}`)
    this.name = 'MissingItemException'
    this.itemID = id
  }
}

export function isUserCancelled(error) {
  return error?.name === 'UserCancelledException' || error instanceof UserCancelled
}

export function randomString(length = 8) {
  const alphabet = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

export function unescapeXml(value) {
  return String(value ?? '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}
