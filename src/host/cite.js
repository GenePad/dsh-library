// Citation export: Zotero items → CSL-JSON and BibTeX.
import { readItems } from './read.js'
import { GLOBAL_SCHEMA } from './schema-data.js'

// Reverse maps built once from the bundled global schema (CSL → Zotero there).
const CSL_TYPES = (() => {
  const reverse = new Map()
  for (const [cslType, zoteroTypes] of Object.entries(GLOBAL_SCHEMA.csl.types)) {
    for (const zoteroType of zoteroTypes ?? []) {
      if (!reverse.has(zoteroType)) reverse.set(zoteroType, cslType)
    }
  }
  return reverse
})()
const CSL_TEXT_FIELDS = Object.entries(GLOBAL_SCHEMA.csl.fields.text)
const CSL_DATE_FIELDS = Object.entries(GLOBAL_SCHEMA.csl.fields.date)
const CSL_NAMES = GLOBAL_SCHEMA.csl.names

/** Parse a Zotero date ("2018-02-00 02/2018", "2018", "2021-05-03") into parts. */
function zoteroDateParts(value) {
  const text = String(value ?? '')
  const match = /(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(text)
  if (!match) return undefined
  const parts = [Number(match[1])]
  if (match[2] && match[2] !== '00') parts.push(Number(match[2]))
  if (match[3] && match[3] !== '00') parts.push(Number(match[3]))
  return parts
}

/** Raw rows for citation export: one item's fields, creators and tags. */
function readCslRows(db, keys) {
  const meta = db.schema()
  const rows = []
  for (const key of keys) {
    const item = db.get('SELECT itemID, key, itemTypeID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)
    if (!item) continue
    const fields = {}
    for (const row of db.all(
      `SELECT f.fieldName, v.value FROM itemData d
       JOIN fieldsCombined f ON f.fieldID = d.fieldID
       JOIN itemDataValues v ON v.valueID = d.valueID
       WHERE d.itemID = ?`, item.itemID,
    )) fields[row.fieldName] = String(row.value ?? '')
    const creators = db.all(
      `SELECT c.firstName, c.lastName, c.fieldMode, ct.creatorType
       FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
       JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
       WHERE ic.itemID = ? ORDER BY ic.orderIndex`, item.itemID,
    )
    rows.push({ key: item.key, itemType: meta.itemTypeNames.get(item.itemTypeID) ?? 'document', fields, creators })
  }
  return rows
}

/** Resolve the keys to export: explicit keys, or the current list query. */
function resolveKeys(db, { keys, query, collectionID, tag, limit }) {
  if (Array.isArray(keys) && keys.length > 0) {
    return keys.map(String).map(key => key.toUpperCase()).filter(key => /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key))
  }
  const result = readItems(db, {
    query: typeof query === 'string' ? query : '',
    ...(Number.isInteger(collectionID) ? { collectionID } : {}),
    ...(typeof tag === 'string' && tag !== '' ? { tag } : {}),
    limit: Number.isInteger(limit) ? Math.min(limit, 500) : 200,
  })
  return result.items.map(item => item.key)
}

/** Convert Zotero items into CSL-JSON records. */
export function toCslJson(db, input = {}) {
  const keys = resolveKeys(db, input)
  return readCslRows(db, keys).map((row) => {
    const record = {
      id: `zotero:${row.key}`,
      type: CSL_TYPES.get(row.itemType) ?? 'document',
    }
    for (const [cslField, candidates] of CSL_TEXT_FIELDS) {
      for (const candidate of candidates ?? []) {
        if (row.fields[candidate] !== undefined && row.fields[candidate] !== '') {
          record[cslField] = row.fields[candidate]
          break
        }
      }
    }
    for (const [cslField, zoteroField] of CSL_DATE_FIELDS) {
      const parts = zoteroDateParts(row.fields[zoteroField])
      if (parts) record[cslField] = { 'date-parts': [parts] }
    }
    const names = {}
    for (const creator of row.creators) {
      const cslRole = CSL_NAMES[creator.creatorType] ?? 'author'
      if (!names[cslRole]) names[cslRole] = []
      names[cslRole].push(creator.fieldMode === 1
        ? { literal: creator.lastName }
        : { family: creator.lastName, given: creator.firstName })
    }
    Object.assign(record, names)
    return record
  })
}

const BIBTEX_TYPES = {
  'article-journal': 'article',
  article: 'article',
  'paper-conference': 'inproceedings',
  chapter: 'incollection',
  book: 'book',
  thesis: 'phdthesis',
  report: 'techreport',
  manuscript: 'unpublished',
  webpage: 'misc',
  'post-weblog': 'misc',
  interview: 'misc',
  'graphic': 'misc',
  song: 'misc',
  broadcast: 'misc',
  motion_picture: 'misc',
}

function bibtexKey(record, index) {
  const first = record.author?.[0] ?? record.editor?.[0]
  const name = first?.family ?? first?.literal ?? 'item'
  const ascii = String(name).normalize('NFKD').replace(/[^a-zA-Z]/g, '').toLowerCase() || 'item'
  const year = record.issued?.['date-parts']?.[0]?.[0] ?? ''
  return `${ascii}${year}${year === '' ? index + 1 : ''}`
}

function protectTitle(value) {
  return `{{${value}}}`
}

function escapeBibtex(value) {
  return String(value ?? '')
    .replace(/([\\{}%&$#_~^])/g, '\\$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function creatorLine(creators) {
  return (creators ?? [])
    .map(creator => creator.literal
      ? `{${escapeBibtex(creator.literal)}}`
      : `${escapeBibtex(creator.family ?? '')}, ${escapeBibtex(creator.given ?? '')}`.replace(/, $/, ''))
    .join(' and ')
}

/** Convert CSL-JSON records into one BibTeX string. */
export function cslToBibtex(records) {
  const seen = new Set()
  return records.map((record, index) => {
    const year = record.issued?.['date-parts']?.[0]?.[0] ?? ''
    const lines = []
    if (record.author) lines.push(`  author = {${creatorLine(record.author)}}`)
    if (record.title) lines.push(`  title = {${protectTitle(escapeBibtex(record.title))}}`)
    if (record['container-title'] && ['article', 'inproceedings', 'incollection'].includes(BIBTEX_TYPES[record.type] ?? 'misc')) {
      lines.push(`  ${record.type === 'article-journal' ? 'journal' : 'booktitle'} = {${escapeBibtex(record['container-title'])}}`)
    }
    if (year !== '') lines.push(`  year = {${year}}`)
    if (record.volume) lines.push(`  volume = {${escapeBibtex(record.volume)}}`)
    if (record.issue) lines.push(`  number = {${escapeBibtex(record.issue)}}`)
    if (record.page) lines.push(`  pages = {${String(record.page).replace(/\s*-\s*/g, '--')}}`)
    if (record.publisher) lines.push(`  publisher = {${escapeBibtex(record.publisher)}}`)
    if (record['publisher-place']) lines.push(`  address = {${escapeBibtex(record['publisher-place'])}}`)
    if (record.editor) lines.push(`  editor = {${creatorLine(record.editor)}}`)
    if (record.DOI) lines.push(`  doi = {${escapeBibtex(record.DOI)}}`)
    if (record.URL) lines.push(`  url = {${escapeBibtex(record.URL)}}`)
    if (record.issued?.['date-parts']?.[0]?.length > 1) {
      const [y, m] = record.issued['date-parts'][0]
      lines.push(`  month = {${String(m).padStart(2, '0')}}`)
    }
    if (record.language) lines.push(`  language = {${escapeBibtex(record.language)}}`)
    let key = bibtexKey(record, index)
    let suffix = 'a'
    while (seen.has(key)) {
      key = `${bibtexKey(record, index)}${suffix}`
      suffix = String.fromCharCode(suffix.charCodeAt(0) + 1)
    }
    seen.add(key)
    const type = BIBTEX_TYPES[record.type] ?? 'misc'
    return `@${type}{${key},\n${lines.join(',\n')}\n}`
  }).join('\n\n')
}

/** Full BibTeX export for a set of items (keys or query). */
export function toBibtex(db, input = {}) {
  return cslToBibtex(toCslJson(db, input))
}
