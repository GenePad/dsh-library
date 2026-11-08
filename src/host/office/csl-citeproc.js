// CSL processor: Zotero's packaged citeproc-js, loaded into a plain Node scope.
//
// The vendor file is a verbatim copy of Zotero's
// chrome/content/zotero/xpcom/citeproc.js (CPAL/AGPL dual licence). It declares
// `var CSL = {...}` and only needs a tiny `Zotero` shim for the few debug hooks
// it references. There is no DOM dependency on the string-XML path we use.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const VENDOR = path.resolve(here, '../../../vendor/citeproc.js')

let namespace = null

/** Minimal host shim expected by the vendored processor. */
function zoteroShim() {
  return {
    debug() {},
    logError() {},
    warn() {},
    getString(key) { return key },
    Utilities: {
      htmlSpecialChars(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
      },
    },
    Cite: { getCitationLocale() { return 'en-US' } },
  }
}

/** Load and cache the CSL namespace object. */
export function cslNamespace() {
  if (namespace) return namespace
  const source = fs.readFileSync(VENDOR, 'utf8')
  // `var CSL` is function-scoped: returning it from a Function body gives us the
  // fully populated namespace without leaking anything into globalThis.
  const factory = new Function('Zotero', `${source}\n;return CSL;`)
  namespace = factory(zoteroShim())
  if (!namespace?.Engine) throw new Error('citeproc-js failed to initialise')
  return namespace
}

/**
 * Build a citeproc engine in the same configuration Zotero's
 * Zotero.Style#getCiteProc() uses.
 *
 * @param {object} options
 * @param {string} options.xml - CSL style XML
 * @param {string} [options.locale] - locale tag, e.g. "zh-CN"
 * @param {(tag: string) => string} options.retrieveLocale - locale XML provider
 * @param {(id: string|number) => object} options.retrieveItem - CSL item provider
 * @param {'rtf'|'html'} [options.format] - output format
 */
export function createEngine({ xml, locale = 'en-US', retrieveLocale, retrieveItem, format = 'rtf' }) {
  const CSL = cslNamespace()
  const sys = {
    retrieveLocale(tag) {
      try {
        const text = retrieveLocale?.(tag)
        return typeof text === 'string' && text.startsWith('<') ? text : ''
      } catch {
        return ''
      }
    },
    retrieveItem(id) {
      const item = retrieveItem?.(id)
      if (!item || typeof item !== 'object') throw new Error(`CSL item ${id} not found`)
      return item
    },
  }
  const engine = new CSL.Engine(sys, xml, locale)
  if (typeof engine.setOutputFormat === 'function') engine.setOutputFormat(format)
  // Zotero disables this extension so URLs/DOIs with special characters are not
  // double-encoded when rendered into a field.
  if (engine.opt?.development_extensions) {
    engine.opt.development_extensions.wrap_url_and_doi = false
  }
  return engine
}

/** Strip citeproc's RTF/HTML wrapper down to a plain-text representation. */
export function plainText(formatted, format = 'rtf') {
  const text = String(formatted ?? '')
  if (format === 'html') {
    return text.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
  }
  // RTF: drop control words, groups' braces and escaped characters.
  return text
    // "\\\r\n" separates bibliography entries in citeproc output. In RTF a
    // backslash followed by a line break is a line continuation, not a literal
    // backslash; leaving it in would make the stored plainCitation differ from
    // what Word actually shows.
    .replace(/\\\r?\n/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\line\b|\\par\b/g, '\n')
    .replace(/\\~/g, '\u00a0')
    .replace(/\\uc\d+\s*/g, '')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\s*\{?[^}]*\}?/g, (_m, code) => String.fromCodePoint((Number(code) + 65536) % 65536))
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .trim()
}
