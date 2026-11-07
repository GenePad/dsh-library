// Read models for the library view: collections, tags, item lists, item details.
import fs from 'node:fs'
import path from 'node:path'

const TOP_LEVEL = `NOT EXISTS (SELECT 1 FROM itemAttachments a WHERE a.itemID = i.itemID AND a.parentItemID IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM itemNotes n WHERE n.itemID = i.itemID AND n.parentItemID IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM itemAnnotations an WHERE an.itemID = i.itemID)`

/** Strip tags from Zotero note HTML for summaries. */
export function plainNote(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Resolve an attachment's on-disk path or URL. */
export function attachmentTarget(storageDir, itemKey, rawPath, linkMode) {
  const value = typeof rawPath === 'string' ? rawPath : ''
  if (linkMode === 3) return { kind: 'url', url: value }
  if (linkMode === 2) return { kind: 'file', path: value }
  if (value === '') return { kind: 'none' }
  const name = value.startsWith('storage:') ? value.slice('storage:'.length) : value
  return { kind: 'file', path: path.join(storageDir, itemKey, name) }
}

/** Fill a summary's creator line the way Zotero's item list does. */
function creatorSummary(creators) {
  const names = creators.map(creator => (creator.fieldMode === 1 ? creator.lastName : creator.lastName || creator.firstName)).filter(Boolean)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]} et al.`
}

/** Year from a Zotero date value ("2018-02-00 02/2018", "2018", "2018-02-01"). */
function yearOf(value) {
  const match = /(\d{4})/.exec(String(value ?? ''))
  return match ? Number(match[1]) : null
}

function titleOfRow(row) {
  if (row.title) return String(row.title)
  if (row.noteTitle) return String(row.noteTitle)
  const noteText = plainNote(row.noteHTML)
  if (noteText !== '') return noteText.split('\n')[0]
  if (row.selfPath) return path.basename(String(row.selfPath).replace(/^storage:/, ''))
  return `(${row.itemType})`
}

/** Overall library figures for the status header. */
export function readStats(db) {
  const meta = db.schema()
  const count = (sql, ...params) => Number(db.get(sql, ...params)?.n ?? 0)
  return {
    schemaVersion: meta.schemaVersion,
    libraryID: meta.libraryID,
    items: count(`SELECT COUNT(*) AS n FROM items i WHERE ${TOP_LEVEL}
      AND NOT EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID = i.itemID)`),
    attachments: count('SELECT COUNT(*) AS n FROM itemAttachments'),
    annotations: count('SELECT COUNT(*) AS n FROM itemAnnotations'),
    collections: count('SELECT COUNT(*) AS n FROM collections WHERE libraryID = ?', meta.libraryID),
    tags: count('SELECT COUNT(*) AS n FROM tags'),
    trash: count(`SELECT COUNT(*) AS n FROM deletedItems d JOIN items i ON i.itemID = d.itemID WHERE ${TOP_LEVEL}`),
  }
}

/** All collections with direct and recursive item counts, plus trash and unfiled counts. */
export function readCollections(db) {
  const meta = db.schema()
  const rows = db.all(
    `SELECT c.collectionID, c.collectionName, c.parentCollectionID, c.key,
       (SELECT COUNT(*) FROM collectionItems ci
          JOIN items i ON i.itemID = ci.itemID
          LEFT JOIN deletedItems d ON d.itemID = i.itemID
        WHERE ci.collectionID = c.collectionID AND d.itemID IS NULL AND ${TOP_LEVEL}) AS directCount
     FROM collections c
     WHERE c.libraryID = ? AND NOT EXISTS (SELECT 1 FROM deletedCollections dc WHERE dc.collectionID = c.collectionID)
     ORDER BY c.collectionName COLLATE NOCASE`,
    meta.libraryID,
  )
  const byID = new Map(rows.map(row => [row.collectionID, { ...row, totalCount: row.directCount, children: [] }]))
  const roots = []
  for (const node of byID.values()) {
    const parent = node.parentCollectionID === null ? undefined : byID.get(node.parentCollectionID)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  // Recursive totals roll up child collections, as Zotero's collection tree counts.
  const roll = (node) => {
    for (const child of node.children) node.totalCount += roll(child)
    return node.totalCount
  }
  for (const root of roots) roll(root)
  const trash = Number(db.get('SELECT COUNT(*) AS n FROM deletedItems').n)
  return {
    collections: roots.map(toPlainNode),
    trash,
    unfiled: Number(db.get(
      `SELECT COUNT(*) AS n FROM items i WHERE ${TOP_LEVEL}
        AND NOT EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID = i.itemID)
        AND NOT EXISTS (SELECT 1 FROM collectionItems ci WHERE ci.itemID = i.itemID)`,
    ).n),
  }
}

function toPlainNode(node) {
  return {
    id: node.collectionID,
    key: node.key,
    name: node.collectionName,
    parentID: node.parentCollectionID,
    count: node.directCount,
    totalCount: node.totalCount,
    children: node.children.map(toPlainNode),
  }
}

/** Tags with their live item counts. */
export function readTags(db) {
  const meta = db.schema()
  return db.all(
    `SELECT t.name, COUNT(DISTINCT i.itemID) AS count
     FROM tags t
     JOIN itemTags it ON it.tagID = t.tagID
     JOIN items i ON i.itemID = it.itemID
     LEFT JOIN deletedItems d ON d.itemID = i.itemID
     WHERE d.itemID IS NULL AND i.libraryID = ?
     GROUP BY t.tagID
     ORDER BY t.name COLLATE NOCASE`,
    meta.libraryID,
  ).filter(row => row.count > 0)
}

/**
 * Page through items for one view.
 * @param {import('./db.js').ZoteroDb} db
 * @param {object} filter
 * @param {number} [filter.collectionID] - direct collection membership.
 * @param {boolean} [filter.unfiled] - items in no collection.
 * @param {string} [filter.tag] - tag name.
 * @param {string} [filter.query] - title/abstract/creator/tag/DOI text.
 * @param {boolean} [filter.trash] - deleted items instead of live ones.
 * @param {'title'|'date'|'dateAdded'|'dateModified'} [filter.sort]
 * @param {boolean} [filter.desc]
 * @param {number} [filter.limit]
 * @param {number} [filter.offset]
 */
export function readItems(db, filter = {}) {
  const meta = db.schema()
  const where = []
  const params = []
  where.push('i.libraryID = ?')
  params.push(meta.libraryID)
  if (filter.trash === true) where.push('EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID = i.itemID)')
  else where.push('NOT EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID = i.itemID)')
  where.push(TOP_LEVEL)
  if (Number.isInteger(filter.collectionID)) {
    where.push('i.itemID IN (SELECT itemID FROM collectionItems WHERE collectionID = ?)')
    params.push(filter.collectionID)
  }
  if (filter.unfiled === true) {
    where.push('NOT EXISTS (SELECT 1 FROM collectionItems ci WHERE ci.itemID = i.itemID)')
  }
  if (typeof filter.tag === 'string' && filter.tag !== '') {
    where.push('i.itemID IN (SELECT it.itemID FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE t.name = ?)')
    params.push(filter.tag)
  }
  const base = `SELECT i.itemID, i.key, i.itemTypeID, i.dateAdded, i.dateModified, i.version, ty.typeName AS itemType,
      (SELECT v.value FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID JOIN itemDataValues v ON v.valueID = d.valueID
        WHERE d.itemID = i.itemID AND f.fieldName = 'title' LIMIT 1) AS title,
      (SELECT v.value FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID JOIN itemDataValues v ON v.valueID = d.valueID
        WHERE d.itemID = i.itemID AND f.fieldName = 'date' LIMIT 1) AS date,
      (SELECT v.value FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID JOIN itemDataValues v ON v.valueID = d.valueID
        WHERE d.itemID = i.itemID AND f.fieldName = 'DOI' LIMIT 1) AS doi,
      (SELECT v.value FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID JOIN itemDataValues v ON v.valueID = d.valueID
        WHERE d.itemID = i.itemID AND f.fieldName = 'publicationTitle' LIMIT 1) AS publicationTitle,
      (SELECT v.value FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID JOIN itemDataValues v ON v.valueID = d.valueID
        WHERE d.itemID = i.itemID AND f.fieldName = 'publisher' LIMIT 1) AS publisher,
      (SELECT group_concat(t.name, '|') FROM itemTags it JOIN tags t ON t.tagID = it.tagID
        WHERE it.itemID = i.itemID) AS tagNames,
      (SELECT c.lastName FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
        WHERE ic.itemID = i.itemID ORDER BY ic.orderIndex LIMIT 1) AS firstCreator,
      (SELECT nn.note FROM itemNotes nn WHERE nn.itemID = i.itemID) AS noteHTML,
      (SELECT nn.title FROM itemNotes nn WHERE nn.itemID = i.itemID) AS noteTitle,
      (SELECT a.path FROM itemAttachments a WHERE a.itemID = i.itemID) AS selfPath,
      EXISTS (SELECT 1 FROM itemAttachments a JOIN items ai ON ai.itemID = a.itemID
        LEFT JOIN deletedItems ad ON ad.itemID = a.itemID
        WHERE a.parentItemID = i.itemID AND ad.itemID IS NULL) AS hasAttachment
    FROM items i JOIN itemTypes ty ON ty.itemTypeID = i.itemTypeID
    WHERE ${where.join(' AND ')}`
  let sql = `SELECT * FROM (${base}) AS row0`
  const outer = []
  const query = String(filter.query ?? '').trim()
  if (query !== '') {
    const like = `%${query.replace(/[%_]/g, match => `\\${match}`)}%`
    outer.push(`(title LIKE ? ESCAPE '\\' OR doi LIKE ? ESCAPE '\\' OR noteTitle LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
        WHERE ic.itemID = row0.itemID AND (c.lastName LIKE ? ESCAPE '\\' OR c.firstName LIKE ? ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM itemTags it JOIN tags t ON t.tagID = it.tagID
        WHERE it.itemID = row0.itemID AND t.name LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM itemData d JOIN fieldsCombined f ON f.fieldID = d.fieldID
        JOIN itemDataValues v ON v.valueID = d.valueID
        WHERE d.itemID = row0.itemID AND f.fieldName IN ('abstractNote','publicationTitle','journalAbbreviation','publisher')
          AND v.value LIKE ? ESCAPE '\\'))`)
    for (let i = 0; i < 7; i += 1) params.push(like)
  }
  if (outer.length > 0) sql += ` WHERE ${outer.join(' AND ')}`
  const total = Number(db.get(`SELECT COUNT(*) AS n FROM (${sql})`, ...params).n)
  const sort = filter.sort === 'title' ? 'title COLLATE NOCASE'
    : filter.sort === 'creator' ? 'firstCreator COLLATE NOCASE'
      : filter.sort === 'date' ? 'date'
        : filter.sort === 'dateModified' ? 'dateModified'
          : 'dateAdded'
  const desc = filter.desc !== false
  const limit = Number.isInteger(filter.limit) ? Math.min(Math.max(filter.limit, 1), 500) : 100
  const offset = Number.isInteger(filter.offset) ? Math.max(filter.offset, 0) : 0
  const rows = db.all(`SELECT * FROM (${sql}) ORDER BY ${sort} ${desc ? 'DESC' : 'ASC'}, itemID DESC LIMIT ? OFFSET ?`, ...params, limit, offset)
  return { total, offset, limit, items: summarizeRows(db, rows) }
}

/** Attach creators to raw list rows and shape display values. */
function summarizeRows(db, rows) {
  if (rows.length === 0) return []
  const ids = rows.map(row => row.itemID)
  const placeholders = ids.map(() => '?').join(',')
  const creators = db.all(
    `SELECT ic.itemID, ic.orderIndex, c.firstName, c.lastName, c.fieldMode
     FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
     WHERE ic.itemID IN (${placeholders}) ORDER BY ic.itemID, ic.orderIndex`,
    ...ids,
  )
  const byItem = new Map()
  for (const creator of creators) {
    if (!byItem.has(creator.itemID)) byItem.set(creator.itemID, [])
    byItem.get(creator.itemID).push(creator)
  }
  return rows.map((row) => {
    const own = byItem.get(row.itemID) ?? []
    return {
      key: row.key,
      itemType: row.itemType,
      title: titleOfRow(row),
      date: row.date ?? '',
      year: yearOf(row.date),
      doi: row.doi ?? '',
      publicationTitle: row.publicationTitle ?? '',
      publisher: row.publisher ?? '',
      tags: row.tagNames ? String(row.tagNames).split('|') : [],
      firstCreator: row.firstCreator ?? '',
      creators: creatorSummary(own),
      creatorList: own.map(creator => ({
        firstName: creator.firstName ?? '',
        lastName: creator.lastName ?? '',
        fieldMode: creator.fieldMode,
      })),
      hasAttachment: row.hasAttachment === 1,
      dateAdded: row.dateAdded,
      dateModified: row.dateModified,
    }
  })
}

/**
 * Full detail for one item key.
 * @param {import('./db.js').ZoteroDb} db
 * @param {string} key - 8-character item key.
 * @param {{storageDir:string}} paths - storage root for attachment resolution.
 */
export function readItem(db, key, paths) {
  const meta = db.schema()
  const row = db.get(
    'SELECT itemID, key, itemTypeID, libraryID, dateAdded, dateModified, version, synced FROM items WHERE libraryID = ? AND key = ?',
    meta.libraryID,
    key,
  )
  if (!row) throw Object.assign(new Error(`No item with key ${key}`), { code: 'library/not-found' })
  const typeName = meta.itemTypeNames.get(row.itemTypeID) ?? 'document'
  const fields = db.all(
    `SELECT f.fieldName, v.value FROM itemData d
     JOIN fieldsCombined f ON f.fieldID = d.fieldID
     JOIN itemDataValues v ON v.valueID = d.valueID
     WHERE d.itemID = ?`,
    row.itemID,
  )
  const order = meta.itemTypeFields.get(row.itemTypeID) ?? []
  const fieldMap = new Map(fields.map(field => [field.fieldName, field.value]))
  const ordered = []
  const seen = new Set()
  for (const entry of order) {
    const name = meta.fieldNames.get(entry.fieldID)
    if (!name || entry.hide || seen.has(name) || !fieldMap.has(name)) continue
    seen.add(name)
    ordered.push({ field: name, value: String(fieldMap.get(name) ?? '') })
  }
  for (const field of fields) {
    if (seen.has(field.fieldName)) continue
    ordered.push({ field: field.fieldName, value: String(field.value ?? '') })
  }
  const creators = db.all(
    `SELECT c.firstName, c.lastName, c.fieldMode, ct.creatorType, ic.orderIndex
     FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
     JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
     WHERE ic.itemID = ? ORDER BY ic.orderIndex`,
    row.itemID,
  )
  const tags = db.all(
    'SELECT t.name, it.type FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID = ? ORDER BY t.name COLLATE NOCASE',
    row.itemID,
  )
  const collections = db.all(
    `SELECT c.collectionID, c.collectionName FROM collectionItems ci JOIN collections c ON c.collectionID = ci.collectionID
     WHERE ci.itemID = ? ORDER BY c.collectionName COLLATE NOCASE`,
    row.itemID,
  )
  const attachments = readChildren(db, row.itemID, 'attachment', paths.storageDir)
  const notes = readChildren(db, row.itemID, 'note', paths.storageDir)
  const deleted = db.get('SELECT 1 AS yes FROM deletedItems WHERE itemID = ?', row.itemID) !== undefined
  const noteRow = typeName === 'note' ? db.get('SELECT note, title FROM itemNotes WHERE itemID = ?', row.itemID) : undefined
  const attachmentRow = typeName === 'attachment' ? db.get('SELECT path, linkMode, contentType FROM itemAttachments WHERE itemID = ?', row.itemID) : undefined
  const annotations = []
  // A standalone attachment owns its annotations directly; a parent item's
  // annotations belong to its attachment children.
  const annotationSources = typeName === 'attachment' ? [{ key: row.key }] : attachments
  for (const attachment of annotationSources) {
    const rows = db.all(
      `SELECT i.key, ia.type, ia.text, ia.comment, ia.color, ia.pageLabel, ia.sortIndex, ia.position, i.dateModified
       FROM itemAnnotations ia JOIN items i ON i.itemID = ia.itemID
       WHERE ia.parentItemID = (SELECT itemID FROM items WHERE libraryID = ? AND key = ?)
       ORDER BY ia.sortIndex`,
      meta.libraryID,
      attachment.key,
    )
    for (const annotation of rows) {
      annotations.push({ ...annotation, parentKey: attachment.key, position: safeJson(annotation.position) })
    }
  }
  let title = fieldMap.get('title') ?? ''
  if (!title && noteRow) title = noteRow.title || plainNote(noteRow.note).split('\n')[0] || 'Note'
  if (!title && attachmentRow) title = path.basename(String(attachmentRow.path ?? '').replace(/^storage:/, ''))
  return {
    key: row.key,
    itemType: typeName,
    libraryID: row.libraryID,
    dateAdded: row.dateAdded,
    dateModified: row.dateModified,
    version: row.version,
    synced: row.synced === 1,
    deleted,
    fields: ordered,
    title,
    creators,
    tags,
    collections,
    attachments,
    notes,
    annotations,
    note: noteRow ? { title: noteRow.title ?? '', html: noteRow.note ?? '' } : undefined,
    attachment: attachmentRow ? {
      linkMode: attachmentRow.linkMode,
      contentType: attachmentRow.contentType,
      rawPath: attachmentRow.path,
      target: attachmentTarget(paths.storageDir, row.key, attachmentRow.path, attachmentRow.linkMode),
    } : undefined,
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Child attachments or notes of an item, resolved to display values. */
function readChildren(db, parentItemID, typeName, storageDir) {
  const rows = db.all(
    `SELECT i.itemID, i.key, i.dateAdded, i.dateModified,
       a.linkMode, a.path, a.contentType, a.syncState, a.storageModTime,
       n.note, n.title
     FROM items i
     LEFT JOIN itemAttachments a ON a.itemID = i.itemID
     LEFT JOIN itemNotes n ON n.itemID = i.itemID
     WHERE i.itemTypeID = (SELECT itemTypeID FROM itemTypes WHERE typeName = ?)
       AND (a.parentItemID = ? OR n.parentItemID = ?)
     ORDER BY i.dateAdded`,
    typeName,
    parentItemID,
    parentItemID,
  )
  return rows.map((row) => (typeName === 'attachment'
    ? {
        key: row.key,
        title: path.basename(String(row.path ?? '').replace(/^storage:/, '')),
        rawPath: row.path,
        linkMode: row.linkMode,
        contentType: row.contentType,
        syncState: row.syncState,
        storageModTime: row.storageModTime,
        size: statSize(storageDir, row.key, row.path, row.linkMode),
      }
    : {
        key: row.key,
        title: row.title || plainNote(row.note).split('\n')[0] || 'Note',
        html: row.note ?? '',
        dateAdded: row.dateAdded,
        dateModified: row.dateModified,
      }))
}

function statSize(storageDir, key, rawPath, linkMode) {
  try {
    const target = attachmentTarget(storageDir, key, rawPath, linkMode)
    if (target.kind !== 'file') return undefined
    return fs.statSync(target.path).size
  } catch {
    return undefined
  }
}

/** Annotations of one attachment key. */
export function readAnnotations(db, attachmentKey) {
  const meta = db.schema()
  const attachment = db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, attachmentKey)
  if (!attachment) return []
  return db.all(
    `SELECT i.key, ia.type, ia.text, ia.comment, ia.color, ia.pageLabel, ia.sortIndex, ia.position, i.dateModified
     FROM itemAnnotations ia JOIN items i ON i.itemID = ia.itemID
     WHERE ia.parentItemID = ? ORDER BY ia.sortIndex`,
    attachment.itemID,
  ).map(row => ({ ...row, position: safeJson(row.position) }))
}

/** Every live attachment with its target and sync state. */
export function readAttachmentRows(db) {
  const meta = db.schema()
  return db.all(
    `SELECT i.key, i.itemID, i.dateModified, a.linkMode, a.path, a.contentType, a.syncState, a.storageModTime, a.storageHash,
       parent.key AS parentKey
     FROM itemAttachments a
     JOIN items i ON i.itemID = a.itemID
     LEFT JOIN items parent ON parent.itemID = a.parentItemID
     WHERE i.libraryID = ? AND NOT EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID = i.itemID)`,
    meta.libraryID,
  )
}
