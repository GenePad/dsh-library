import io

p = 'src/host/db.js'
s = open(p, encoding='utf-8').read()
s = s.replace("""    } finally {
      this.db = undefined
      this.meta = undefined
    }
""", """    } finally {
      this.db = undefined
      this.meta = undefined
      this.columnCache = undefined
    }
""")
open(p, 'w', encoding='utf-8').write(s)

p = 'src/host/write.js'
s = open(p, encoding='utf-8').read()
s = s.replace("""function hasColumn(db, table, column) {
  return db.all(`PRAGMA table_info(${table})`).some(row => row.name === column)
}

let valueNormalizedColumn
function supportsNormalized(db) {
  if (valueNormalizedColumn === undefined) valueNormalizedColumn = hasColumn(db, 'itemDataValues', 'valueNormalized')
  return valueNormalizedColumn
}

let tagsNormalizedColumn
function tagsNormalized(db) {
  if (tagsNormalizedColumn === undefined) tagsNormalizedColumn = hasColumn(db, 'tags', 'nameNormalized')
  return tagsNormalizedColumn
}
""", """function hasColumn(db, table, column) {
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
""")

s = s.replace("""    const clash = db.get('SELECT 1 AS yes FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)
    if (clash) continue
    const result = db.run(
      `INSERT INTO items (itemTypeID, dateAdded, dateModified, clientDateModified, libraryID, key, version, clientVersion, synced)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`,
      typeID, now, now, now, meta.libraryID, key,
    )
    return { itemID: Number(result.lastInsertRowid), key }
""", """    const clash = db.get('SELECT 1 AS yes FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)
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
""")

s = s.replace("""  const existing = db.get(
    'SELECT creatorID FROM creators WHERE lastName IS ? AND firstName IS ? AND fieldMode IS ?',
    lastName, firstName, fieldMode,
  )
  if (existing) return existing.creatorID
  const result = db.run(
    'INSERT INTO creators (firstName, lastName, fieldMode, firstNameNormalized, lastNameNormalized) VALUES (?, ?, ?, ?, ?)',
    firstName, lastName, fieldMode,
    firstName === null ? null : normalizeText(firstName),
    lastName === null ? null : normalizeText(lastName),
  )
  return Number(result.lastInsertRowid)
""", """  const existing = db.get(
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
""")

s = s.replace("""    const result = db.run(
      `INSERT INTO collections (collectionName, parentCollectionID, clientDateModified, libraryID, key, version, clientVersion, synced)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0)`,
      name, parentID, now, meta.libraryID, key,
    )
    return { collectionID: Number(result.lastInsertRowid), key }
""", """    insertRow(db, 'collections', {
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
""")
open(p, 'w', encoding='utf-8').write(s)

p = 'src/host/ingest.js'
s = open(p, encoding='utf-8').read()
s = s.replace("""      const result = db.run(
        `INSERT INTO items (itemTypeID, dateAdded, dateModified, clientDateModified, libraryID, key, version, clientVersion, synced)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`,
        typeID, now, now, now, meta.libraryID, key,
      )
      const id = Number(result.lastInsertRowid)
      db.run(
        `INSERT INTO itemAnnotations (itemID, parentItemID, type, text, textNormalized, comment, commentNormalized, color, pageLabel, sortIndex, position, isExternal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        id,
        attachmentItemID,
        Number(annotation.type) || 1,
        annotation.text || '',
        String(annotation.text || '').toLowerCase(),
        annotation.comment || '',
        String(annotation.comment || '').toLowerCase(),
        annotation.color || '#ffd400',
        annotation.pageLabel || '',
        annotation.sortIndex || '00000|000000|00000',
        JSON.stringify(annotation.position ?? { pageIndex: annotation.pageIndex ?? 0, rects: annotation.rects ?? [] }),
      )
      return { itemID: id, key }
""", """      const itemColumns = ['itemTypeID', 'dateAdded', 'dateModified', 'clientDateModified', 'libraryID', 'key', 'version', 'clientVersion', 'synced']
        .filter(column => db.columns('items').has(column))
      const itemValues = {
        itemTypeID: typeID, dateAdded: now, dateModified: now, clientDateModified: now,
        libraryID: meta.libraryID, key, version: 0, clientVersion: 0, synced: 0,
      }
      db.run(
        `INSERT INTO items (${itemColumns.join(', ')}) VALUES (${itemColumns.map(() => '?').join(', ')})`,
        ...itemColumns.map(column => itemValues[column]),
      )
      const id = Number(db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key).itemID)
      const annotationColumns = ['itemID', 'parentItemID', 'type', 'text', 'textNormalized', 'comment', 'commentNormalized', 'color', 'pageLabel', 'sortIndex', 'position', 'isExternal']
        .filter(column => db.columns('itemAnnotations').has(column))
      const annotationValues = {
        itemID: id,
        parentItemID: attachmentItemID,
        type: Number(annotation.type) || 1,
        text: annotation.text || '',
        textNormalized: String(annotation.text || '').toLowerCase(),
        comment: annotation.comment || '',
        commentNormalized: String(annotation.comment || '').toLowerCase(),
        color: annotation.color || '#ffd400',
        pageLabel: annotation.pageLabel || '',
        sortIndex: annotation.sortIndex || '00000|000000|00000',
        position: JSON.stringify(annotation.position ?? { pageIndex: annotation.pageIndex ?? 0, rects: annotation.rects ?? [] }),
        isExternal: 1,
      }
      db.run(
        `INSERT INTO itemAnnotations (${annotationColumns.join(', ')}) VALUES (${annotationColumns.map(() => '?').join(', ')})`,
        ...annotationColumns.map(column => annotationValues[column]),
      )
      return { itemID: id, key }
""")
open(p, 'w', encoding='utf-8').write(s)
print('patched')
