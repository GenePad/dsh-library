// Tools probe: drives all 13 library_* tools against a temporary copy of the
// real zotero.sqlite (writes happen on the copy; the real library and storage
// are only read). Usage: node scripts/tools-probe.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { safeRemoveTree } from '../src/host/util.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-library-probe-'))
const dataDir = path.join(tempRoot, 'zotero-data')
const storageDir = path.join(dataDir, 'storage')
fs.mkdirSync(storageDir, { recursive: true })

const realDb = path.join(process.env.USERPROFILE ?? os.homedir(), 'Zotero', 'zotero.sqlite')
const realStorage = path.join(path.dirname(realDb), 'storage')
assert.ok(fs.existsSync(realDb), 'real zotero.sqlite not found')
fs.copyFileSync(realDb, path.join(dataDir, 'zotero.sqlite'))

const { ZoteroDb } = await import('../src/host/db.js')
const { createTools } = await import('../src/host/tools.js')

const db = new ZoteroDb({ dbPath: path.join(dataDir, 'zotero.sqlite') })
const settings = { webdav: { url: '' } }
const paths = { dataDir, storageDir }
const tools = new Map(createTools({
  getDb: () => db,
  paths,
  getSettings: () => settings,
  logger: { info() {}, warn() {}, error() {} },
}).map(definition => [definition.name, definition]))
assert.equal(tools.size, 13, `expected 13 tools, got ${tools.size}`)

const readonly = async (name, args) => {
  if (!db.readOnly) { db.close(); db.open({ readOnly: true }) }
  return tools.get(name).execute(args)
}
const writable = async (name, args) => {
  if (db.readOnly) { db.close(); db.open({ readOnly: false }) }
  return tools.get(name).execute(args)
}

// Pick a real PDF attachment and copy its storage folder into the temp copy.
const probe = new ZoteroDb({ dbPath: path.join(dataDir, 'zotero.sqlite') }).open({ readOnly: true })
const pdfRow = probe.get(`SELECT i.key, a.parentItemID FROM itemAttachments a JOIN items i ON i.itemID = a.itemID
  WHERE a.contentType = 'application/pdf' AND a.linkMode = 1 AND a.path LIKE 'storage:%' LIMIT 1`)
assert.ok(pdfRow, 'no stored PDF found in the real library')
const annotatedRow = probe.get(`SELECT p.key AS key FROM itemAnnotations ia JOIN items p ON p.itemID = ia.parentItemID LIMIT 1`)
const capxRow = probe.get(`SELECT i.key AS parentKey, ai.key AS attachmentKey FROM items i
  JOIN itemData d ON d.itemID = i.itemID
  JOIN fieldsCombined f ON f.fieldID = d.fieldID JOIN itemDataValues v ON v.valueID = d.valueID
  JOIN itemAttachments a ON a.parentItemID = i.itemID JOIN items ai ON ai.itemID = a.itemID
  WHERE f.fieldName = 'title' AND v.value LIKE '%CapX%' LIMIT 1`)
assert.ok(capxRow, 'CapX article with PDF attachment found in the real library')
for (const key of new Set([pdfRow.key, capxRow.attachmentKey])) {
  const source = path.join(realStorage, key)
  if (fs.existsSync(source)) fs.cpSync(source, path.join(storageDir, key), { recursive: true })
}
const pdfFile = path.join(storageDir, pdfRow.key, fs.readdirSync(path.join(storageDir, pdfRow.key)).find(name => name.toLowerCase().endsWith('.pdf')))
probe.close()

// --- 1 library_status --------------------------------------------------------
const status = await readonly('library_status', {})
assert.equal(status.dataDir, dataDir)
assert.ok(status.counts.items > 0)
console.log('library_status OK', status.counts)

// --- 2 library_search --------------------------------------------------------
const search = async args => readonly('library_search', args)
const capxHit = await search({ query: 'CapX' })
assert.ok(capxHit.items.some(item => item.key === capxRow.parentKey), 'CapX article found')
assert.equal((await search({ query: 'CAPX' })).total, capxHit.total, 'uppercase query matches the same')
assert.equal((await search({ query: 'capx' })).total, capxHit.total, 'lowercase query matches the same')
const zhHit = await search({ query: '病毒' })
assert.ok(Array.isArray(zhHit.items), 'Chinese query returns a list (may be empty)')
const tagHit = await search({ query: '', tag: (await readonly('library_collections', {})).tags[0].name, limit: 10 })
assert.ok(tagHit.items.length > 0, 'tag filter returns items')
const creatorHit = await search({ query: 'Chan', limit: 5 })
assert.ok(creatorHit.items.every(item => item.key), 'creator query works')
console.log('library_search OK', { capx: capxHit.total, zh: zhHit.total, creator: creatorHit.total })

// --- 3 library_item ----------------------------------------------------------
const detail = await readonly('library_item', { key: capxRow.parentKey })
assert.equal(detail.key, capxRow.parentKey)
assert.ok(detail.fields.some(field => field.field === 'title'))
assert.ok(Array.isArray(detail.attachments))
const attachmentKey = detail.attachments[0]?.key ?? capxRow.parentKey
const attachmentDetail = await readonly('library_item', { key: attachmentKey })
assert.equal(attachmentDetail.key, attachmentKey)
assert.ok(attachmentDetail.attachment.target.path, 'attachment target resolved')
console.log('library_item OK')

// --- 4 library_read ----------------------------------------------------------
const read1 = await readonly('library_read', { key: capxRow.parentKey, maxChars: 3000 })
assert.ok(read1.text.length > 100, 'chunked read returns text')
assert.ok(read1.totalChars > 1000)
assert.ok(read1.nextOffset === null || read1.nextOffset > 0)
const read2 = await readonly('library_read', { key: capxRow.parentKey, offset: read1.nextOffset ?? read1.totalChars, maxChars: 3000 })
assert.ok(read2.offset === read1.nextOffset, 'pagination continues at nextOffset')
const found = await readonly('library_read', { key: capxRow.parentKey, search: 'CapX' })
assert.ok(found.matches.length > 0, 'full-text search finds CapX')
assert.ok(Number.isInteger(found.matches[0].offset))
assert.ok(found.matches[0].page >= 1, `search hit carries a page number (page=${found.matches[0].page})`)
const zhSearch = await readonly('library_read', { key: capxRow.parentKey, search: '基因' })
assert.ok(Array.isArray(zhSearch.matches))
console.log('library_read OK', { totalChars: read1.totalChars, page: found.matches[0].page, pageCount: found.matches[0].pageCount })

// --- 5 library_annotations ---------------------------------------------------
if (annotatedRow) {
  const annotations = await readonly('library_annotations', { key: annotatedRow.key })
  assert.ok(Array.isArray(annotations.annotations) && annotations.annotations.length > 0)
  assert.ok(annotations.annotations[0].position.pageIndex !== undefined, 'annotation position carries pageIndex')
  console.log('library_annotations OK', annotations.annotations.length)
} else {
  const none = await readonly('library_annotations', { key: capxRow.parentKey })
  assert.ok(Array.isArray(none.annotations))
  console.log('library_annotations OK (no annotated items in library)')
}

// --- 6 library_collections ---------------------------------------------------
const collections = await readonly('library_collections', {})
assert.ok(Array.isArray(collections.collections))
assert.ok(Array.isArray(collections.tags))
console.log('library_collections OK', { collections: collections.collections.length, tags: collections.tags.length })

// --- 7 library_cite ----------------------------------------------------------
const citeJson = await readonly('library_cite', { keys: [capxRow.parentKey] })
assert.equal(citeJson.format, 'csl-json')
const citeBib = await readonly('library_cite', { keys: [capxRow.parentKey], format: 'bibtex' })
assert.ok(citeBib.text.length > 0)
const citeQuery = await readonly('library_cite', { query: 'CapX' })
assert.ok(citeQuery.items.length >= 1, 'cite by search query')
console.log('library_cite OK')

// --- 8 library_open is exercised in the write phase (avoids spawning a reader) -

// --- write phase: writable temp copy ------------------------------------------
db.close(); db.open({ readOnly: false })

// --- 9 library_add / library_update -------------------------------------------
const added = await writable('library_add', {
  itemType: 'journalArticle',
  fields: { title: 'probe item CapX 复检', date: '2026', DOI: '10.0000/probe' },
  creators: [{ firstName: 'Li', lastName: 'Si', creatorType: 'author' }],
  tags: ['probe'],
})
assert.match(added.key, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/)
const foundAfterAdd = await search({ query: 'CapX 复检' })
assert.ok(foundAfterAdd.items.some(item => item.key === added.key), 'new item searchable')
const updated = await writable('library_update', { key: added.key, fields: { abstractNote: 'probe abstract' }, tags: ['probe', 'probe2'] })
assert.equal(updated.updated, true)
const updatedDetail = await readonly('library_item', { key: added.key })
assert.ok(updatedDetail.fields.some(field => field.field === 'abstractNote'))
assert.deepEqual(updatedDetail.tags.map(tag => tag.name), ['probe', 'probe2'])
console.log('library_add / library_update OK')

// --- 10 library_import ---------------------------------------------------------
const imported = await writable('library_import', {
  path: pdfFile,
  lookup: false,
  metadata: { itemType: 'journalArticle', fields: { title: 'probe imported parent', date: '2025' }, creators: [{ firstName: 'Pro', lastName: 'Be', creatorType: 'author' }] },
})
assert.ok(imported.parentKey, 'import created a parent item')
const importedSearch = await search({ query: 'probe imported parent' })
assert.equal(importedSearch.total, 1)
const importedRead = await readonly('library_read', { key: imported.parentKey, search: 'the' })
assert.ok(importedRead.matches.length > 0, 'imported PDF full text searchable')

// --- 11 library_open: resolve the path, then remove the file and expect a
// graceful error (never spawn a system reader during the probe).
const importedDetail = await readonly('library_item', { key: imported.parentKey })
const childKey = importedDetail.attachments[0].key
const childDetail = await readonly('library_item', { key: childKey })
const importedPath = childDetail.attachment.target.path
assert.ok(importedPath && fs.existsSync(importedPath), 'imported attachment path resolved')
fs.unlinkSync(importedPath)
const openError = await writable('library_open', { key: imported.parentKey }).then(value => ({ value }), error => ({ error }))
assert.ok(openError.error, 'opening a missing file reports a graceful error')
assert.match(String(openError.error.message), /missing/, `resolved path reported: ${openError.error.message}`)
console.log('library_import / library_open OK', openError.error.message)

// --- 12 library_trash ----------------------------------------------------------
const trashed = await writable('library_trash', { keys: [added.key] })
assert.equal(trashed.changed, 1)
const restored = await writable('library_trash', { keys: [added.key], action: 'restore' })
assert.equal(restored.changed, 1)
await writable('library_trash', { keys: [added.key] })
const deleted = await writable('library_trash', { keys: [added.key], action: 'delete' })
assert.equal(deleted.deleted, 1)
console.log('library_trash OK')

// --- 13 library_sync -----------------------------------------------------------
await assert.rejects(() => writable('library_sync', { verify: true }), /WebDAV is not configured/, 'sync without config reports clearly')
console.log('library_sync (unconfigured error path) OK')

db.close()
safeRemoveTree(tempRoot)
console.log('tools-probe: OK')
