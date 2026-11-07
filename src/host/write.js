// Write models: items, creators, tags, collections, attachments, trash.
import fs from 'node:fs'
import path from 'node:path'
import { normalizeText, objectKey, safeFileName, sqlNow } from './util.js'

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
