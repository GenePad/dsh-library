// Item provider for the citation engine: search the local Zotero/standalone
// library, resolve items to CSL-JSON, and keep a per-session registry for
// "embedded" items that live only inside a document's field codes.
import { readItems, readAnnotations, readCollections, plainNote, TOP_LEVEL } from '../read.js'
import { toCslJson } from '../cite.js'
import { objectKey } from '../util.js'

/** CSL locator labels, Zotero's Zotero.Cite.labels equivalent. */
export const LOCATOR_LABELS = [
  { key: 'page', label: '页码', short: ['p.', 'p', '页'] },
  { key: 'book', label: '卷/册（book）', short: ['bk.', 'bk'] },
  { key: 'chapter', label: '章节', short: ['chap.', 'chap', '章'] },
  { key: 'column', label: '栏', short: ['col.', 'col'] },
  { key: 'figure', label: '图', short: ['fig.', 'fig'] },
  { key: 'folio', label: '对开页', short: ['fol.', 'fol'] },
  { key: 'issue', label: '期', short: ['no.', 'no'] },
  { key: 'line', label: '行', short: ['l.', 'l'] },
  { key: 'note', label: '注', short: ['n.', 'n'] },
  { key: 'opus', label: '作品号', short: ['op.', 'op'] },
  { key: 'paragraph', label: '段落', short: ['para.', 'para', '段'] },
  { key: 'part', label: '部分', short: ['pt.', 'pt'] },
  { key: 'section', label: '小节', short: ['sec.', 'sec', '节'] },
  { key: 'sub verbo', label: '词条', short: ['s.v.', 's.v'] },
  { key: 'volume', label: '卷', short: ['vol.', 'vol', '卷'] },
  { key: 'verse', label: '诗节', short: ['v.', 'v'] },
]

/** Zotero 2.x numeric locator type ids, kept for legacy field codes. */
export const LEGACY_LOCATOR_TERMS = ['page', 'book', 'chapter', 'column', 'figure', 'folio',
  'issue', 'line', 'note', 'opus', 'paragraph', 'part', 'section', 'sub verbo', 'volume', 'verse']

function yearOf(value) {
  const match = /(\d{4})/.exec(String(value ?? ''))
  return match ? match[1] : ''
}

function cslFromRow(row) {
  const author = (row.creatorList ?? []).map(creator => {
    if (creator.fieldMode === 1 || !creator.firstName) return { family: creator.lastName || '', literal: creator.lastName || '' }
    return { family: creator.lastName || '', given: creator.firstName || '' }
  }).filter(entry => entry.family || entry.literal)
  const issued = yearOf(row.date)
  const record = {
    id: row.key,
    type: 'document',
    title: row.title || '',
    'container-title': row.publicationTitle || '',
    publisher: row.publisher || '',
    DOI: row.doi || '',
  }
  if (author.length) record.author = author
  if (issued) record.issued = { 'date-parts': [[Number(issued)]] }
  return record
}

/**
 * Create the shared library-facing item provider.
 * @param {{withDb: (fn: (db:any)=>any) => any}} deps
 */
export function createItemProvider({ withDb }) {
  function safe(fn, fallback) {
    try {
      return withDb(fn)
    } catch {
      return fallback
    }
  }

  /**
   * Search library items for the citation dialog. `collectionIDs` (a collection
   * plus all its descendants) / `unfiled` restrict the "文献库" browser to one
   * category; plain "文献列表" searches the whole library instead.
   */
  function search(query = '', { limit = 50, mode = 'citation', collectionID, collectionIDs, unfiled = false } = {}) {
    const text = String(query ?? '').trim()
    const filter = {
      query: text, limit: Math.min(limit, 500), columns: ['abstractNote'],
      ...(Number.isInteger(collectionID) ? { collectionID } : {}),
      ...(Array.isArray(collectionIDs) && collectionIDs.length ? { collectionIDs } : {}),
      ...(unfiled ? { unfiled: true } : {}),
    }
    const rows = safe(db => readItems(db, filter).items, [])
    return rows.map(row => ({
      id: row.key,
      key: row.key,
      itemType: row.itemType,
      title: row.title || '',
      creator: row.firstCreator || (row.creatorList?.[0]?.lastName ?? ''),
      year: yearOf(row.date),
      date: row.date || '',
      publicationTitle: row.publicationTitle || '',
      doi: row.doi || '',
      hasNotes: Number(row.numNotes ?? 0) > 0,
      hasAttachment: row.hasAttachment === true,
      ...(mode === 'note' ? { note: row.noteHTML ? plainNote(row.noteHTML) : '' } : {}),
    }))
  }

  /**
   * Collection tree for the "文献库" browser. Every node carries `itemCount`:
   * the number of DISTINCT top-level items in that collection **and all its
   * descendants**. This is computed from exactly the same rows that
   * `search({collectionIDs})` shows, so the badge can never disagree with the
   * result list (readCollections' own `totalCount` merely sums child counts
   * and double-counts items present in several collections).
   */
  function collections() {
    return safe(db => {
      const tree = readCollections(db)
      const rows = db.all(
        `SELECT ci.collectionID AS cid, ci.itemID AS itemID
           FROM collectionItems ci
           JOIN collections c ON c.collectionID = ci.collectionID
           JOIN items i ON i.itemID = ci.itemID
           LEFT JOIN deletedItems d ON d.itemID = i.itemID
          WHERE c.libraryID = ? AND d.itemID IS NULL AND ${TOP_LEVEL}`,
        db.schema().libraryID,
      )
      const direct = new Map()
      for (const row of rows) {
        if (!direct.has(row.cid)) direct.set(row.cid, new Set())
        direct.get(row.cid).add(row.itemID)
      }
      const union = new Map()
      const roll = (node) => {
        const set = new Set(direct.get(node.id) ?? [])
        for (const child of node.children ?? []) for (const id of roll(child)) set.add(id)
        union.set(node.id, set)
        return set
      }
      for (const root of tree.collections) roll(root)
      const annotate = nodes => nodes.map(node => ({
        ...node,
        count: (direct.get(node.id) ?? new Set()).size,
        itemCount: (union.get(node.id) ?? new Set()).size,
        children: annotate(node.children ?? []),
      }))
      return { collections: annotate(tree.collections), unfiled: tree.unfiled, trash: tree.trash }
    }, { collections: [], unfiled: 0, trash: 0 })
  }

  /** Annotations of an item's first PDF attachment (for "Add Annotation"). */
  function annotations(key) {
    return safe(db => {
      const rows = db.all(
        `SELECT a.itemID, i.key FROM itemAttachments a JOIN items i ON i.itemID = a.itemID
         WHERE a.parentItemID = (SELECT itemID FROM items WHERE libraryID = ? AND key = ?)
           AND a.linkMode IN (0,1) AND a.contentType = 'application/pdf' LIMIT 1`,
        db.schema().libraryID, key,
      )
      if (!rows.length) return []
      const list = readAnnotations(db, rows[0].key)
      return (list.annotations ?? list ?? []).map(entry => ({
        id: `${key}:${entry.key ?? entry.id ?? objectKey().slice(0, 6)}`,
        parentKey: key,
        text: String(entry.text ?? entry.comment ?? ''),
        comment: String(entry.comment ?? ''),
        type: entry.type ?? 'highlight',
        page: entry.page ?? entry.pageIndex ?? 0,
      }))
    }, [])
  }

  /** CSL-JSON for a library key. */
  function cslItem(id) {
    const key = String(id ?? '').toUpperCase()
    const records = safe(db => toCslJson(db, { keys: [key] }), [])
    if (!records.length) return null
    const record = { ...records[0], id: key }
    // toCslJson uses "zotero:<key>" as its id; citeproc wants the id we address.
    return record
  }

  /** Display information for a library key. */
  function describe(id) {
    const key = String(id ?? '').toUpperCase()
    const rows = safe(db => readItems(db, { query: '', limit: 500, columns: [] }).items, [])
    const row = rows.find(entry => entry.key === key)
    if (row) return { id: key, title: row.title, creator: row.firstCreator || '', year: yearOf(row.date), itemType: row.itemType }
    const csl = cslItem(key)
    if (!csl) return null
    const author = Array.isArray(csl.author) ? csl.author[0] : null
    return {
      id: key,
      title: csl.title || '',
      creator: author ? (author.family || author.literal || '') : '',
      year: yearOf(csl.issued?.['date-parts']?.[0]?.[0]),
      itemType: csl.type || 'document',
    }
  }

  function uriFor(id) {
    return [`http://zotero.org/users/local/items/${String(id).toUpperCase()}`]
  }

  function keyFromURIs(uris) {
    for (const uri of Array.isArray(uris) ? uris : []) {
      const match = /\/items\/([23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8})\b/i.exec(String(uri))
      if (match) return match[1].toUpperCase()
    }
    return null
  }

  return { search, collections, annotations, cslItem, describe, uriFor, keyFromURIs }
}

/**
 * A session-scoped item registry: citeproc's `sys.retrieveItem` reads from here.
 * Library items are fetched lazily; embedded items (from field code itemData)
 * are registered explicitly so documents remain portable.
 */
export function createItemRegistry(provider, sessionID) {
  const items = new Map()
  const byURI = new Map()
  let embeddedCounter = 0

  function register(id, itemData, uris = []) {
    const key = String(id)
    if (!key) return key
    if (itemData && typeof itemData === 'object') {
      items.set(key, { ...itemData, id: key })
    }
    for (const uri of uris) byURI.set(String(uri), key)
    return key
  }

  function newEmbeddedID() {
    return `${sessionID}/${objectKey().slice(0, 8)}${++embeddedCounter}`
  }

  function resolve(id, itemData, uris) {
    const key = String(id ?? '')
    if (!key) return null
    if (items.has(key)) return key
    const fromURI = provider.keyFromURIs(uris)
    const libraryKey = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key) ? key : fromURI
    if (libraryKey) {
      const csl = provider.cslItem(libraryKey)
      if (csl) {
        items.set(libraryKey, csl)
        for (const uri of uris ?? []) byURI.set(String(uri), libraryKey)
        return libraryKey
      }
    }
    if (itemData && typeof itemData === 'object') {
      // Unlinked item: keep it under an embedded id, like Zotero does.
      const embedded = key.includes('/') ? key : newEmbeddedID()
      items.set(embedded, { ...itemData, id: embedded })
      for (const uri of uris ?? []) byURI.set(String(uri), embedded)
      return embedded
    }
    return null
  }

  function retrieve(id) {
    const key = String(id)
    if (items.has(key)) return items.get(key)
    const csl = provider.cslItem(key)
    if (csl) {
      items.set(key, csl)
      return csl
    }
    return { id: key, type: 'document', title: key }
  }

  function urisFor(id) {
    const key = String(id)
    if (key.includes('/')) {
      return [...byURI.entries()].filter(([, value]) => value === key).map(([uri]) => uri)
    }
    return provider.uriFor(key)
  }

  function findByURIs(uris) {
    for (const uri of Array.isArray(uris) ? uris : []) {
      const found = byURI.get(String(uri))
      if (found) return found
    }
    return provider.keyFromURIs(uris)
  }

  return { items, register, resolve, retrieve, urisFor, findByURIs, newEmbeddedID }
}
