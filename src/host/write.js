// Write models: items, creators, tags, collections, attachments, trash.
import fs from 'node:fs'
import path from 'node:path'
import { normalizeText, objectKey, safeFileName, sqlNow } from './util.js'
import { planTypeChange } from './schema.js'

/** Field names Zotero stores as base fields on every item type when relevant. */
const BASE_FIELDS = ['title', 'abstractNote', 'date', 'language', 'shortTitle', 'url', 'accessDate', 'DOI', 'rights', 'extra', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber']

function hasColumn(db, table, column) {
  return db.columns(table).has(column)
}

function supportsNormalized(db) {
  return hasColumn(db, 'itemDataValues', 'valueNormalized')
}

function tagsNormalized(db) {
  return hasColumn(db, 'tags', 'nameNormalized')
}

/** Insert a row using only the columns this schema actually has. */
function insertRow(db, table, values) {
  const columns = Object.keys(values).filter(column => db.columns(table).has(column))
  db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ...columns.map(column => values[column]),
  )
}

/** Insert or find an itemDataValues row and return its id. */
function valueID(db, value) {
  const text = String(value ?? '')
  const existing = db.get('SELECT valueID FROM itemDataValues WHERE value = ?', text)
  if (existing) return existing.valueID
  if (supportsNormalized(db)) {
    db.run('INSERT INTO itemDataValues (value, valueNormalized) VALUES (?, ?)', text, normalizeText(text))
  } else {
    db.run('INSERT INTO itemDataValues (value) VALUES (?)', text)
  }
  return db.get('SELECT valueID FROM itemDataValues WHERE value = ?', text).valueID
}

/** Insert the primary items row and return {itemID, key}. */
function insertItem(db, itemTypeName) {
  const meta = db.schema()
  const typeID = db.itemTypeId(itemTypeName)
  const now = sqlNow()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const key = objectKey()
    const clash = db.get('SELECT 1 AS yes FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)
    if (clash) continue
    insertRow(db, 'items', {
      itemTypeID: typeID,
      dateAdded: now,
      dateModified: now,
      clientDateModified: now,
      libraryID: meta.libraryID,
      key,
      version: 0,
      clientVersion: 0,
      synced: 0,
    })
    return { itemID: Number(db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key).itemID), key }
  }
  throw new Error('library: could not allocate a unique item key')
}

/**
 * Create one Zotero annotation item under an attachment. `input` mirrors the
 * annotation shape the client reader produces: {type, text, comment, color,
 * pageLabel, sortIndex, position:{pageIndex, rects}}. The annotation item
 * itself needs no itemData; the parent attachment is touched so Zotero sync
 * and our own revision poll pick the change up.
 */
export function createAnnotationRecord(db, attachmentKey, input = {}) {
  const meta = db.schema()
  const attachment = db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, String(attachmentKey ?? ''))
  if (!attachment) throw Object.assign(new Error(`附件不存在：${attachmentKey}`), { code: 'library/not-found' })
  const typeID = db.itemTypeId('annotation')
  const now = sqlNow()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const key = objectKey()
    if (db.get('SELECT 1 AS yes FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)) continue
    insertRow(db, 'items', {
      itemTypeID: typeID,
      dateAdded: now,
      dateModified: now,
      clientDateModified: now,
      libraryID: meta.libraryID,
      key,
      version: 0,
      clientVersion: 0,
      synced: 0,
    })
    const itemID = Number(db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key).itemID)
    const position = input.position && typeof input.position === 'object'
      ? input.position
      : { pageIndex: Number(input.pageIndex) || 0, rects: Array.isArray(input.rects) ? input.rects : [] }
    const rects = Array.isArray(position.rects) ? position.rects : []
    const pageIndex = Math.max(0, Number(position.pageIndex) || 0)
    const pageHeight = Number(position.pageHeight) || 0
    const firstTop = Array.isArray(rects[0]) ? Number(rects[0][3]) || 0 : 0
    const sortIndex = typeof input.sortIndex === 'string' && input.sortIndex !== ''
      ? input.sortIndex
      : [String(pageIndex).padStart(5, '0'), String(Number(input.offset) || 0).padStart(6, '0'), String(Math.round(pageHeight - firstTop)).padStart(5, '0')].join('|')
    insertRow(db, 'itemAnnotations', {
      itemID,
      parentItemID: attachment.itemID,
      type: Number(input.type) || 1,
      text: String(input.text ?? ''),
      comment: String(input.comment ?? ''),
      color: String(input.color ?? '#ffd400'),
      pageLabel: String(input.pageLabel ?? ''),
      sortIndex,
      position: JSON.stringify({ pageIndex, rects }),
      isExternal: 0,
    })
    touchItem(db, itemID)
    touchItem(db, attachment.itemID)
    return { key, itemID }
  }
  throw new Error('library: could not allocate an annotation key')
}

/** Permanently remove one annotation item (annotation rows are not trashed). */
export function removeAnnotationRecord(db, annotationKey) {
  const meta = db.schema()
  const row = db.get(
    `SELECT i.itemID, a.parentItemID FROM items i
     JOIN itemAnnotations a ON a.itemID = i.itemID
     WHERE i.libraryID = ? AND i.key = ?`,
    meta.libraryID,
    String(annotationKey ?? ''),
  )
  if (!row) throw Object.assign(new Error(`批注不存在：${annotationKey}`), { code: 'library/not-found' })
  db.run('DELETE FROM itemAnnotations WHERE itemID = ?', row.itemID)
  db.run('DELETE FROM items WHERE itemID = ?', row.itemID)
  if (row.parentItemID) touchItem(db, row.parentItemID)
  return { key: String(annotationKey), removed: true }
}

/** Replace an annotation's color / comment (the reader popup edits). */
export function updateAnnotationRecord(db, annotationKey, patch = {}) {
  const meta = db.schema()
  const row = db.get(
    `SELECT i.itemID, a.parentItemID FROM items i
     JOIN itemAnnotations a ON a.itemID = i.itemID
     WHERE i.libraryID = ? AND i.key = ?`,
    meta.libraryID,
    String(annotationKey ?? ''),
  )
  if (!row) throw Object.assign(new Error(`批注不存在：${annotationKey}`), { code: 'library/not-found' })
  const columns = {
    ...(typeof patch.color === 'string' && patch.color !== '' ? { color: patch.color } : {}),
    ...(typeof patch.comment === 'string' ? { comment: patch.comment } : {}),
    ...(typeof patch.text === 'string' ? { text: patch.text } : {}),
  }
  for (const [column, value] of Object.entries(columns)) {
    db.run(`UPDATE itemAnnotations SET ${column} = ? WHERE itemID = ?`, value, row.itemID)
  }
  if (row.parentItemID) touchItem(db, row.parentItemID)
  return { key: String(annotationKey), updated: true }
}

/** Mark an item's metadata as locally changed so Zotero sync picks it up. */
export function touchItem(db, itemID) {
  const now = sqlNow()
  db.run('UPDATE items SET dateModified = ?, clientDateModified = ?, synced = 0 WHERE itemID = ?', now, now, itemID)
}

/** Replace an item's field values; empty strings delete the field like Zotero does. */
function setFieldMap(db, itemID, fields) {
  db.run('DELETE FROM itemData WHERE itemID = ?', itemID)
  for (const [name, raw] of Object.entries(fields ?? {})) {
    if (raw === undefined || raw === null) continue
    const text = String(raw)
    if (text.trim() === '') continue
    let fieldID
    try {
      fieldID = db.fieldId(name)
    } catch {
      // An unknown field name is client input, not a schema error: refuse loudly.
      throw Object.assign(new Error(`Unknown Zotero field "${name}"`), { code: 'library/invalid' })
    }
    db.run('INSERT OR REPLACE INTO itemData (itemID, fieldID, valueID) VALUES (?, ?, ?)', itemID, fieldID, valueID(db, text))
  }
}

/** Find or create a creator row. */
function creatorID(db, creator) {
  const firstName = creator.firstName === undefined || creator.firstName === '' ? null : String(creator.firstName)
  const lastName = creator.lastName === undefined || creator.lastName === '' ? null : String(creator.lastName)
  const fieldMode = creator.fieldMode === 1 ? 1 : 0
  if (lastName === null && firstName === null) return undefined
  const existing = db.get(
    'SELECT creatorID FROM creators WHERE lastName IS ? AND firstName IS ? AND fieldMode IS ?',
    lastName, firstName, fieldMode,
  )
  if (existing) return existing.creatorID
  insertRow(db, 'creators', {
    firstName,
    lastName,
    fieldMode,
    firstNameNormalized: firstName === null ? null : normalizeText(firstName),
    lastNameNormalized: lastName === null ? null : normalizeText(lastName),
  })
  return Number(db.get('SELECT creatorID FROM creators WHERE lastName IS ? AND firstName IS ? AND fieldMode IS ?', lastName, firstName, fieldMode).creatorID)
}

/** Replace an item's creators. */
function setCreators(db, itemID, creators) {
  db.run('DELETE FROM itemCreators WHERE itemID = ?', itemID)
  const list = Array.isArray(creators) ? creators : []
  list.forEach((creator, index) => {
    if (creator === null || typeof creator !== 'object') return
    const id = creatorID(db, creator)
    if (id === undefined) return
    let typeID
    try {
      typeID = db.schema().creatorTypes.get(String(creator.creatorType ?? 'author'))
    } catch {
      typeID = undefined
    }
    if (typeID === undefined) typeID = db.schema().creatorTypes.get('author') ?? 1
    db.run('INSERT OR REPLACE INTO itemCreators (itemID, creatorID, creatorTypeID, orderIndex) VALUES (?, ?, ?, ?)', itemID, id, typeID, index)
  })
}

/** Find or create a tag row and return its id. */
function tagID(db, name) {
  const text = String(name).trim()
  if (text === '') return undefined
  const existing = db.get('SELECT tagID FROM tags WHERE name = ?', text)
  if (existing) return existing.tagID
  if (tagsNormalized(db)) db.run('INSERT INTO tags (name, nameNormalized) VALUES (?, ?)', text, normalizeText(text))
  else db.run('INSERT INTO tags (name) VALUES (?)', text)
  return db.get('SELECT tagID FROM tags WHERE name = ?', text).tagID
}

/** Replace an item's tags. `types` preserves Zotero's automatic-tag flag. */
function setTags(db, itemID, tags) {
  const previous = new Map(db.all('SELECT tagID, type FROM itemTags WHERE itemID = ?', itemID).map(row => [row.tagID, row.type]))
  db.run('DELETE FROM itemTags WHERE itemID = ?', itemID)
  for (const entry of Array.isArray(tags) ? tags : []) {
    const name = typeof entry === 'string' ? entry : entry?.name ?? entry?.tag
    const id = tagID(db, name)
    if (id === undefined) continue
    const type = previous.get(id) ?? (typeof entry === 'object' && entry?.type === 1 ? 1 : 0)
    db.run('INSERT OR REPLACE INTO itemTags (itemID, tagID, type) VALUES (?, ?, ?)', itemID, id, type)
  }
}

/** Replace an item's collection membership. */
function setCollections(db, itemID, collectionIDs) {
  db.run('DELETE FROM collectionItems WHERE itemID = ?', itemID)
  for (const rawID of Array.isArray(collectionIDs) ? collectionIDs : []) {
    const id = Number(rawID)
    if (!Number.isInteger(id)) continue
    const exists = db.get('SELECT 1 AS yes FROM collections WHERE collectionID = ?', id)
    if (!exists) continue
    const max = Number(db.get('SELECT COALESCE(MAX(orderIndex), -1) AS n FROM collectionItems WHERE collectionID = ?', id).n)
    db.run('INSERT OR REPLACE INTO collectionItems (collectionID, itemID, orderIndex) VALUES (?, ?, ?)', id, itemID, max + 1)
  }
}

/** Normalize incoming creator input from the UI or tools. */
function normalizeCreators(creators) {
  if (!Array.isArray(creators)) return undefined
  return creators
    .filter(creator => creator !== null && typeof creator === 'object')
    .map((creator) => {
      const fieldMode = creator.fieldMode === 1 ? 1 : 0
      if (fieldMode === 1) return { fieldMode, lastName: String(creator.lastName ?? creator.name ?? ''), creatorType: creator.creatorType ?? 'author' }
      return {
        fieldMode,
        firstName: String(creator.firstName ?? ''),
        lastName: String(creator.lastName ?? ''),
        creatorType: creator.creatorType ?? 'author',
      }
    })
}

/** Create an item with fields, creators, tags and collection memberships. */
export function createItem(db, input = {}) {
  const itemType = String(input.itemType ?? 'document')
  if (!db.schema().itemTypes.has(itemType)) {
    throw Object.assign(new Error(`Unknown Zotero item type "${itemType}"`), { code: 'library/invalid' })
  }
  return db.transaction(() => {
    const { itemID, key } = insertItem(db, itemType)
    setFieldMap(db, itemID, input.fields)
    const creators = normalizeCreators(input.creators)
    if (creators) setCreators(db, itemID, creators)
    if (Array.isArray(input.tags)) setTags(db, itemID, input.tags)
    if (Array.isArray(input.collectionIDs)) setCollections(db, itemID, input.collectionIDs)
    return { itemID, key }
  })
}

/**
 * Change an item's type the way Zotero's setType does: fields that map to the
 * same base field in the new type transfer across, the rest are dropped. The
 * client confirms the dropped list first (change-type with confirm:false).
 */
export function changeItemType(db, key, newItemType) {
  const meta = db.schema()
  const row = db.get('SELECT itemID, itemTypeID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)
  if (!row) throw Object.assign(new Error(`No item with key ${key}`), { code: 'library/not-found' })
  const fromType = meta.itemTypeNames.get(row.itemTypeID)
  if (!db.schema().itemTypes.has(newItemType)) {
    throw Object.assign(new Error(`Unknown Zotero item type "${newItemType}"`), { code: 'library/invalid' })
  }
  const stored = db.all(
    `SELECT f.fieldName FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID WHERE d.itemID = ?`,
    row.itemID,
  ).map(entry => entry.fieldName)
  const plan = planTypeChange(fromType, newItemType, stored)
  return db.transaction(() => {
    const merged = new Map(db.all(
      `SELECT f.fieldName, v.value FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID
       JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ?`, row.itemID,
    ).map(entry => [entry.fieldName, entry.value]))
    const next = new Map()
    for (const [name, value] of merged) {
      if (plan.dropped.includes(name)) continue
      const transfer = plan.transfers.find(entry => entry[0] === name)
      const targetName = transfer ? transfer[1] : name
      if (!next.has(targetName) && String(value).trim() !== '') next.set(targetName, String(value))
    }
    setFieldMap(db, row.itemID, Object.fromEntries(next))
    db.run('UPDATE items SET itemTypeID = ? WHERE itemID = ?', db.itemTypeId(newItemType), row.itemID)
    touchItem(db, row.itemID)
    return { key, itemType: newItemType, transferred: plan.transfers, dropped: plan.dropped }
  })
}

/** Create a standalone or child note item; body is plain text shaped into paragraphs. */
export function createNoteItem(db, input = {}) {
  const meta = db.schema()
  let parentItemID = null
  if (input.parentKey) {
    const parent = db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, String(input.parentKey))
    if (!parent) throw Object.assign(new Error(`No item with key ${input.parentKey}`), { code: 'library/not-found' })
    parentItemID = parent.itemID
  }
  const paragraphs = String(input.text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
  const html = paragraphs.length > 0 ? paragraphs.join('') : '<p></p>'
  return db.transaction(() => {
    const { itemID, key } = insertItem(db, 'note')
    insertRow(db, 'itemNotes', { itemID, parentItemID, note: html })
    if (Array.isArray(input.collectionIDs)) setCollections(db, itemID, input.collectionIDs)
    if (parentItemID !== null) touchItem(db, parentItemID)
    return { itemID, key }
  })
}

/** Replace one note's body (plain text from the editor, same shaping as create). */
export function updateNoteItem(db, key, text) {
  const meta = db.schema()
  const row = db.get(
    `SELECT i.itemID FROM items i JOIN itemNotes n ON n.itemID = i.itemID WHERE i.libraryID = ? AND i.key = ?`,
    meta.libraryID, String(key ?? ''),
  )
  if (!row) throw Object.assign(new Error(`No note with key ${key}`), { code: 'library/not-found' })
  const paragraphs = String(text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
  return db.transaction(() => {
    db.run('UPDATE itemNotes SET note = ? WHERE itemID = ?', paragraphs.join('') || '<p></p>', row.itemID)
    touchItem(db, row.itemID)
    return { key, updated: true }
  })
}

/**
 * Create a "web link" attachment (linkMode 3, like Zotero's 添加网页链接):
 * no file is stored; the row only points at the URL.
 */
export function createUrlAttachment(db, input = {}) {
  const meta = db.schema()
  const url = String(input.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error('Only http(s) web links can be attached'), { code: 'library/invalid' })
  }
  let parentItemID = null
  if (input.parentKey) {
    const parent = db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, String(input.parentKey))
    if (!parent) throw Object.assign(new Error(`No item with key ${input.parentKey}`), { code: 'library/not-found' })
    parentItemID = parent.itemID
  }
  return db.transaction(() => {
    const { itemID, key } = insertItem(db, 'attachment')
    const title = String(input.title ?? '').trim() || url
    setFieldMap(db, itemID, { title, url })
    insertRow(db, 'itemAttachments', {
      itemID,
      parentItemID,
      linkMode: 3,
      contentType: 'text/html',
      path: url,
      syncState: 0,
    })
    if (parentItemID !== null) touchItem(db, parentItemID)
    return { itemID, key }
  })
}

/** Update an item's fields/creators/tags/collections. Omitted parts stay as they are. */
export function updateItem(db, key, patch = {}) {
  const meta = db.schema()
  const row = db.get('SELECT itemID, itemTypeID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)
  if (!row) throw Object.assign(new Error(`No item with key ${key}`), { code: 'library/not-found' })
  return db.transaction(() => {
    if (patch.fields !== undefined) {
      const merged = new Map(db.all(
        `SELECT f.fieldName, v.value FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID
         JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ?`, row.itemID,
      ).map(entry => [entry.fieldName, entry.value]))
      for (const [name, value] of Object.entries(patch.fields ?? {})) {
        if (value === null || String(value).trim() === '') merged.delete(name)
        else merged.set(name, String(value))
      }
      setFieldMap(db, row.itemID, Object.fromEntries(merged))
      // An item type change rewrites the type row only; fields are validated on read.
      if (typeof patch.itemType === 'string' && db.schema().itemTypes.has(patch.itemType)) {
        db.run('UPDATE items SET itemTypeID = ? WHERE itemID = ?', db.itemTypeId(patch.itemType), row.itemID)
      }
    }
    if (patch.creators !== undefined) {
      const creators = normalizeCreators(patch.creators)
      if (creators) setCreators(db, row.itemID, creators)
    }
    if (patch.tags !== undefined) setTags(db, row.itemID, patch.tags)
    if (patch.collectionIDs !== undefined) setCollections(db, row.itemID, patch.collectionIDs)
    if (patch.addCollections !== undefined || patch.removeCollections !== undefined) {
      const current = db.all('SELECT collectionID FROM collectionItems WHERE itemID = ?', row.itemID).map(entry => entry.collectionID)
      const next = new Set(current)
      for (const id of Array.isArray(patch.addCollections) ? patch.addCollections : []) next.add(Number(id))
      for (const id of Array.isArray(patch.removeCollections) ? patch.removeCollections : []) next.delete(Number(id))
      setCollections(db, row.itemID, [...next])
    }
    touchItem(db, row.itemID)
    return row.itemID
  })
}

/** Move items to (or out of) the trash without deleting them. */
export function trashItems(db, keys, deleted = true) {
  const meta = db.schema()
  return db.transaction(() => {
    const rows = keys.map(key => db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)).filter(Boolean)
    for (const row of rows) {
      if (deleted) db.run('INSERT OR IGNORE INTO deletedItems (itemID) VALUES (?)', row.itemID)
      else db.run('DELETE FROM deletedItems WHERE itemID = ?', row.itemID)
      touchItem(db, row.itemID)
    }
    return rows.length
  })
}

/** Permanently delete trashed items (children cascade). Refuses live items. */
export function deleteForever(db, keys) {
  const meta = db.schema()
  return db.transaction(() => {
    const rows = keys.map(key => db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)).filter(Boolean)
    for (const row of rows) {
      const trashed = db.get('SELECT 1 AS yes FROM deletedItems WHERE itemID = ?', row.itemID)
      if (!trashed) throw Object.assign(new Error('Only trashed items can be deleted permanently'), { code: 'library/invalid' })
      db.run('DELETE FROM items WHERE itemID = ?', row.itemID)
    }
    return rows.length
  })
}

/** Create a collection under an optional parent. */
export function createCollection(db, input = {}) {
  const meta = db.schema()
  const name = String(input.name ?? '').trim()
  if (name === '') throw Object.assign(new Error('A collection needs a name'), { code: 'library/invalid' })
  const parentID = input.parentID === null || input.parentID === undefined ? null : Number(input.parentID)
  if (parentID !== null && !db.get('SELECT 1 AS yes FROM collections WHERE collectionID = ?', parentID)) {
    throw Object.assign(new Error('Unknown parent collection'), { code: 'library/not-found' })
  }
  const now = sqlNow()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const key = objectKey()
    if (db.get('SELECT 1 AS yes FROM collections WHERE libraryID = ? AND key = ?', meta.libraryID, key)) continue
    insertRow(db, 'collections', {
      collectionName: name,
      parentCollectionID: parentID,
      clientDateModified: now,
      libraryID: meta.libraryID,
      key,
      version: 0,
      clientVersion: 0,
      synced: 0,
    })
    return { collectionID: Number(db.get('SELECT collectionID FROM collections WHERE libraryID = ? AND key = ?', meta.libraryID, key).collectionID), key }
  }
  throw new Error('library: could not allocate a unique collection key')
}

/** Rename a collection. */
export function renameCollection(db, collectionID, name) {
  const text = String(name ?? '').trim()
  if (text === '') throw Object.assign(new Error('A collection needs a name'), { code: 'library/invalid' })
  const result = db.run(
    'UPDATE collections SET collectionName = ?, clientDateModified = ?, synced = 0 WHERE collectionID = ?',
    text, sqlNow(), Number(collectionID),
  )
  if (Number(result.changes) === 0) throw Object.assign(new Error('Unknown collection'), { code: 'library/not-found' })
}

/** Trash a collection and its descendants; items stay in the library. */
export function trashCollection(db, collectionID, deleted = true) {
  return db.transaction(() => {
    const all = db.all('SELECT collectionID, parentCollectionID FROM collections')
    const ids = new Set([Number(collectionID)])
    let grew = true
    while (grew) {
      grew = false
      for (const row of all) {
        if (row.parentCollectionID !== null && ids.has(row.parentCollectionID) && !ids.has(row.collectionID)) {
          ids.add(row.collectionID)
          grew = true
        }
      }
    }
    for (const id of ids) {
      if (deleted) {
        db.run('INSERT OR IGNORE INTO deletedCollections (collectionID) VALUES (?)', id)
        db.run('DELETE FROM collectionItems WHERE collectionID = ?', id)
      } else {
        db.run('DELETE FROM deletedCollections WHERE collectionID = ?', id)
      }
      db.run('UPDATE collections SET clientDateModified = ?, synced = 0 WHERE collectionID = ?', sqlNow(), id)
    }
    return ids.size
  })
}

/**
 * Create an imported-file attachment item and copy the file into storage.
 * @param {import('./db.js').ZoteroDb} db
 * @param {object} input
 * @param {string} input.filePath - source file on disk.
 * @param {number|null} [input.parentItemID] - parent item row id.
 * @param {string} [input.title] - unused; the file name is the title.
 * @param {{storageDir:string}} paths
 */
export function createStoredAttachment(db, input, paths) {
  const source = String(input.filePath ?? '')
  const stat = fs.statSync(source)
  if (!stat.isFile()) throw new Error(`library: not a file: ${source}`)
  const fileName = safeFileName(input.fileName ?? path.basename(source))
  const { itemID, key } = db.transaction(() => {
    const created = insertItem(db, 'attachment')
    return created
  })
  const folder = path.join(paths.storageDir, key)
  const target = path.join(folder, fileName)
  let mtime
  try {
    fs.mkdirSync(folder, { recursive: true })
    fs.copyFileSync(source, target)
    mtime = Math.round(fs.statSync(target).mtimeMs)
  } catch (error) {
    db.transaction(() => db.run('DELETE FROM items WHERE itemID = ?', itemID))
    throw error
  }
  db.transaction(() => {
    db.run(
      `INSERT INTO itemAttachments (itemID, parentItemID, linkMode, contentType, path, syncState, storageModTime, storageHash)
       VALUES (?, ?, 0, ?, ?, 0, ?, '')`,
      itemID,
      input.parentItemID === null || input.parentItemID === undefined ? null : Number(input.parentItemID),
      String(input.contentType ?? guessContentType(fileName)),
      `storage:${fileName}`,
      mtime,
    )
    touchItem(db, itemID)
  })
  return { itemID, key, fileName, filePath: target, mtime, size: stat.size }
}

/** Copy a linked file into storage under a new attachment item (import mode). */
export function guessContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase()
  return ({
    '.pdf': 'application/pdf',
    '.epub': 'application/epub+zip',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.txt': 'text/plain',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  })[ext] ?? 'application/octet-stream'
}

/** Re-point an attachment's stored file metadata after a detected edit. */
export function markAttachmentChanged(db, itemID, { mtime }) {
  db.run(
    'UPDATE itemAttachments SET storageModTime = ?, syncState = 0, storageHash = ? WHERE itemID = ?',
    Math.round(mtime), '', itemID,
  )
  touchItem(db, itemID)
}

/** Item type name of one item row id. */
function typeNameOf(db, itemID) {
  const row = db.get(
    'SELECT ty.typeName AS name FROM items i JOIN itemTypes ty ON ty.itemTypeID = i.itemTypeID WHERE i.itemID = ?',
    itemID,
  )
  return row?.name
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Duplicate an item the way Zotero's 创建条目副本 does: fields, creators,
 * tags, collections and child items are copied; stored attachment files and
 * their annotations come along.
 */
export function duplicateItem(db, key, paths) {
  const meta = db.schema()
  const row = db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, String(key ?? ''))
  if (!row) throw Object.assign(new Error(`No item with key ${key}`), { code: 'library/not-found' })
  const typeName = typeNameOf(db, row.itemID)
  if (typeName === 'note' || typeName === 'attachment' || typeName === 'annotation') {
    throw Object.assign(new Error('只能复制常规条目'), { code: 'library/invalid' })
  }
  return db.transaction(() => {
    const fields = Object.fromEntries(db.all(
      `SELECT f.fieldName, v.value FROM itemData d
       JOIN fieldsCombined f ON f.fieldID = d.fieldID
       JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ?`, row.itemID,
    ).map(entry => [entry.fieldName, entry.value]))
    const creators = db.all(
      `SELECT c.firstName, c.lastName, c.fieldMode, ct.creatorType FROM itemCreators ic
       JOIN creators c ON c.creatorID = ic.creatorID
       JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
       WHERE ic.itemID = ? ORDER BY ic.orderIndex`, row.itemID,
    ).map(creator => ({
      firstName: creator.firstName ?? '',
      lastName: creator.lastName ?? '',
      fieldMode: creator.fieldMode,
      creatorType: creator.creatorType,
    }))
    const tags = db.all('SELECT t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID = ?', row.itemID)
      .map(entry => entry.name)
    const collectionIDs = db.all('SELECT collectionID FROM collectionItems WHERE itemID = ?', row.itemID)
      .map(entry => entry.collectionID)
    // Inline the copy (createItem would open a nested transaction inside ours).
    const { itemID: duplicateItemID, key: duplicateKey } = insertItem(db, typeName)
    setFieldMap(db, duplicateItemID, fields)
    const normalizedCreators = normalizeCreators(creators)
    if (normalizedCreators) setCreators(db, duplicateItemID, normalizedCreators)
    setTags(db, duplicateItemID, tags)
    setCollections(db, duplicateItemID, collectionIDs)

    // Child attachments: same linkMode/path; stored files are copied into the
    // new key's folder. Child notes and annotations follow.
    const attachments = db.all(
      'SELECT itemID, linkMode, contentType, path FROM itemAttachments WHERE parentItemID = ?', row.itemID,
    )
    for (const source of attachments) {
      const child = insertItem(db, 'attachment')
      const name = path.basename(String(source.path ?? '').replace(/^storage:/, ''))
      if (source.linkMode === 0 && paths && String(source.path ?? '').startsWith('storage:')) {
        const sourceDir = path.join(paths.storageDir, db.get('SELECT key FROM items WHERE itemID = ?', source.itemID).key)
        const folder = path.join(paths.storageDir, child.key)
        const target = path.join(folder, name)
        try {
          fs.mkdirSync(folder, { recursive: true })
          fs.copyFileSync(path.join(sourceDir, name), target)
        } catch {
          // A missing source file still leaves a valid (empty) attachment row.
        }
        insertRow(db, 'itemAttachments', {
          itemID: child.itemID,
          parentItemID: duplicateItemID,
          linkMode: 0,
          contentType: source.contentType,
          path: `storage:${name}`,
          syncState: 0,
          storageModTime: Math.round(fs.existsSync(target) ? fs.statSync(target).mtimeMs : Date.now()),
          storageHash: '',
        })
      } else {
        insertRow(db, 'itemAttachments', {
          itemID: child.itemID,
          parentItemID: duplicateItemID,
          linkMode: source.linkMode,
          contentType: source.contentType,
          path: source.path,
          syncState: 0,
        })
      }
      db.run(
        `INSERT INTO itemAnnotations (itemID, parentItemID, type, text, comment, color, pageLabel, sortIndex, position, isExternal)
         SELECT ?, ?, type, text, comment, color, pageLabel, sortIndex, position, isExternal FROM itemAnnotations WHERE parentItemID = ?`,
        child.itemID, child.itemID, source.itemID,
      )
    }
    const notes = db.all('SELECT itemID, note FROM itemNotes WHERE parentItemID = ?', row.itemID)
    for (const source of notes) {
      const child = insertItem(db, 'note')
      insertRow(db, 'itemNotes', { itemID: child.itemID, parentItemID: duplicateItemID, note: source.note })
    }
    return { key: duplicateKey }
  })
}

/**
 * Create an empty parent item for a standalone attachment (Zotero's 创建上级条目);
 * the title is prefilled from the file name so the record is identifiable
 * before the user edits it.
 */
export function createParentAttachment(db, attachmentKey, paths) {
  const meta = db.schema()
  const row = db.get(
    `SELECT i.itemID, a.parentItemID, a.path FROM items i
     JOIN itemAttachments a ON a.itemID = i.itemID
     WHERE i.libraryID = ? AND i.key = ?`,
    meta.libraryID,
    String(attachmentKey ?? ''),
  )
  if (!row) throw Object.assign(new Error(`No attachment with key ${attachmentKey}`), { code: 'library/not-found' })
  if (row.parentItemID) throw Object.assign(new Error('该附件已有上级条目'), { code: 'library/invalid' })
  return db.transaction(() => {
    const baseName = path.basename(String(row.path ?? '').replace(/^storage:/, ''))
    const title = baseName.replace(/\.[^.]+$/, '')
    // Inline creation (createItem would nest a transaction inside ours).
    const { itemID: parentItemID, key: parentKey } = insertItem(db, 'document')
    setFieldMap(db, parentItemID, { title })
    db.run('UPDATE itemAttachments SET parentItemID = ? WHERE itemID = ?', parentItemID, row.itemID)
    touchItem(db, parentItemID)
    touchItem(db, row.itemID)
    return { parentKey }
  })
}

/**
 * Turn a child attachment into a standalone one (Zotero's 转换为独立附件);
 * it inherits the parent's collection memberships.
 */
export function detachAttachment(db, key) {
  const meta = db.schema()
  const row = db.get(
    `SELECT i.itemID, a.parentItemID FROM items i
     JOIN itemAttachments a ON a.itemID = i.itemID
     WHERE i.libraryID = ? AND i.key = ?`,
    meta.libraryID,
    String(key ?? ''),
  )
  if (!row) throw Object.assign(new Error(`No attachment with key ${key}`), { code: 'library/not-found' })
  if (!row.parentItemID) throw Object.assign(new Error('该附件不是子附件'), { code: 'library/invalid' })
  return db.transaction(() => {
    const collectionIDs = db.all('SELECT collectionID FROM collectionItems WHERE itemID = ?', row.parentItemID)
      .map(entry => entry.collectionID)
    db.run('UPDATE itemAttachments SET parentItemID = NULL WHERE itemID = ?', row.itemID)
    for (const id of collectionIDs) {
      const max = Number(db.get('SELECT COALESCE(MAX(orderIndex), -1) AS n FROM collectionItems WHERE collectionID = ?', id).n)
      db.run('INSERT OR REPLACE INTO collectionItems (collectionID, itemID, orderIndex) VALUES (?, ?, ?)', id, row.itemID, max + 1)
    }
    touchItem(db, row.itemID)
    touchItem(db, row.parentItemID)
    return { key: String(key), detached: true }
  })
}

/**
 * Merge several regular items into the first one (Zotero's 合并条目): the
 * master keeps its values, missing fields/creators/tags/collections are
 * filled from the others, children (attachments, notes, annotations) move
 * over, and the sources end up in the trash.
 */
export function mergeItems(db, keys) {
  const meta = db.schema()
  const list = (Array.isArray(keys) ? keys : []).map(key => String(key))
  if (list.length < 2) throw Object.assign(new Error('至少选择两个条目才能合并'), { code: 'library/invalid' })
  const rows = list.map((key) => {
    const row = db.get(
      'SELECT i.itemID, ty.typeName AS name FROM items i JOIN itemTypes ty ON ty.itemTypeID = i.itemTypeID WHERE i.libraryID = ? AND i.key = ?',
      meta.libraryID, key,
    )
    if (!row) throw Object.assign(new Error(`No item with key ${key}`), { code: 'library/not-found' })
    if (row.name === 'note' || row.name === 'attachment' || row.name === 'annotation') {
      throw Object.assign(new Error('只能合并常规条目'), { code: 'library/invalid' })
    }
    return row
  })
  const [master, ...sources] = rows
  return db.transaction(() => {
    const masterFields = new Map(db.all(
      `SELECT f.fieldName, v.value FROM itemData d
       JOIN fieldsCombined f ON f.fieldID = d.fieldID
       JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ?`, master.itemID,
    ).map(entry => [entry.fieldName, entry.value]))
    const masterCreators = db.all('SELECT 1 AS yes FROM itemCreators WHERE itemID = ?', master.itemID).length
    const tagNames = new Set(db.all(
      'SELECT t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID = ?', master.itemID,
    ).map(entry => entry.name))
    const collectionIDs = new Set(db.all('SELECT collectionID FROM collectionItems WHERE itemID = ?', master.itemID)
      .map(entry => entry.collectionID))

    for (const source of sources) {
      for (const entry of db.all(
        `SELECT f.fieldName, v.value FROM itemData d
         JOIN fieldsCombined f ON f.fieldID = d.fieldID
         JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ?`, source.itemID,
      )) {
        const current = masterFields.get(entry.fieldName)
        if (current === undefined || String(current).trim() === '') masterFields.set(entry.fieldName, String(entry.value ?? ''))
      }
      for (const tag of db.all('SELECT t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID = ?', source.itemID)) {
        tagNames.add(tag.name)
      }
      for (const entry of db.all('SELECT collectionID FROM collectionItems WHERE itemID = ?', source.itemID)) {
        collectionIDs.add(entry.collectionID)
      }
      // Children move to the master; their annotations ride along.
      db.run('UPDATE itemAttachments SET parentItemID = ? WHERE parentItemID = ?', master.itemID, source.itemID)
      db.run('UPDATE itemNotes SET parentItemID = ? WHERE parentItemID = ?', master.itemID, source.itemID)
    }

    setFieldMap(db, master.itemID, Object.fromEntries([...masterFields].filter(([, value]) => String(value).trim() !== '')))
    if (masterCreators === 0) {
      const creatorList = []
      for (const source of sources) {
        for (const creator of db.all(
          `SELECT c.firstName, c.lastName, c.fieldMode, ct.creatorType FROM itemCreators ic
           JOIN creators c ON c.creatorID = ic.creatorID
           JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
           WHERE ic.itemID = ? ORDER BY ic.orderIndex`, source.itemID,
        )) {
          creatorList.push({
            firstName: creator.firstName ?? '',
            lastName: creator.lastName ?? '',
            fieldMode: creator.fieldMode,
            creatorType: creator.creatorType,
          })
        }
      }
      if (creatorList.length > 0) setCreators(db, master.itemID, creatorList)
    }
    setTags(db, master.itemID, [...tagNames])
    setCollections(db, master.itemID, [...collectionIDs])
    for (const source of sources) {
      db.run('INSERT OR IGNORE INTO deletedItems (itemID) VALUES (?)', source.itemID)
    }
    touchItem(db, master.itemID)
    return { key: list[0], merged: sources.length }
  })
}

/**
 * Create a child note from an item's annotations (Zotero's 通过批注添加笔记):
 * quoted highlights with their colors, comments and page labels, in reading
 * order. Works on a parent item (uses all its attachments) or an attachment.
 */
export function noteFromAnnotations(db, key) {
  const meta = db.schema()
  const row = db.get(
    `SELECT i.itemID, ty.typeName AS name FROM items i JOIN itemTypes ty ON ty.itemTypeID = i.itemTypeID
     WHERE i.libraryID = ? AND i.key = ?`,
    meta.libraryID,
    String(key ?? ''),
  )
  if (!row) throw Object.assign(new Error(`No item with key ${key}`), { code: 'library/not-found' })
  if (row.name === 'note' || row.name === 'annotation') {
    throw Object.assign(new Error('该条目没有可提取的批注'), { code: 'library/invalid' })
  }
  // A standalone attachment owns its annotations directly; a regular item
  // collects the annotations of all its attachments.
  const annotations = row.name === 'attachment'
    ? db.all(
      `SELECT ia.text, ia.comment, ia.color, ia.type, ia.pageLabel, ia.sortIndex
       FROM itemAnnotations ia
       WHERE ia.parentItemID = ? AND ia.type IN (1, 5, 6)
       ORDER BY ia.sortIndex`,
      row.itemID,
    )
    : db.all(
      `SELECT ia.text, ia.comment, ia.color, ia.type, ia.pageLabel, ia.sortIndex
       FROM itemAnnotations ia
       JOIN itemAttachments a ON a.itemID = ia.parentItemID
       WHERE a.parentItemID = ? AND ia.type IN (1, 5, 6)
       ORDER BY ia.sortIndex`,
      row.itemID,
    )
  if (annotations.length === 0) {
    throw Object.assign(new Error('没有可提取的批注'), { code: 'library/invalid' })
  }
  return db.transaction(() => {
    const parts = annotations.map((annotation) => {
      const color = /^#[0-9a-fA-F]{6}$/.test(String(annotation.color ?? '')) ? annotation.color : '#ffd400'
      const quote = escapeHtml(annotation.text ?? '')
      const label = annotation.pageLabel ? `（第 ${annotation.pageLabel} 页）` : ''
      const quoteHtml = `<p><span style="background-color: ${color};">“${quote}”</span><span style="color: #8a8a90;"> ${escapeHtml(label)}</span></p>`
      const comment = String(annotation.comment ?? '').trim()
      return comment === '' ? quoteHtml : `${quoteHtml}<p>${escapeHtml(comment)}</p>`
    })
    const { itemID, key: noteKey } = insertItem(db, 'note')
    insertRow(db, 'itemNotes', { itemID, parentItemID: row.itemID, note: parts.join('') })
    touchItem(db, itemID)
    touchItem(db, row.itemID)
    return { key: noteKey, added: annotations.length }
  })
}
