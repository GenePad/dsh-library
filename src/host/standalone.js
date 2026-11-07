// Standalone library: a fresh Zotero-schema database under $DSH_HOME/library
// for users without Zotero. The same ZoteroDb engine reads and writes it, and
// the data exports (CSL JSON / BibTeX) so a later Zotero install can import it.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { GLOBAL_SCHEMA } from './schema-data.js'
import { USERDATA_SQL, USERDATA_SCHEMA_VERSION } from './userdata-sql.js'
import { safeUnlink } from './util.js'

/**
 * Create a standalone library under a directory (idempotent).
 * @param {string} dataDir - target folder for zotero.sqlite + storage/.
 * @param {object} [logger]
 * @returns {{dataDir:string, dbPath:string, storageDir:string, source:'standalone'}}
 */
export function createStandaloneLibrary(dataDir, logger = console) {
  const dbPath = path.join(dataDir, 'zotero.sqlite')
  const storageDir = path.join(dataDir, 'storage')
  if (fs.existsSync(dbPath)) {
    return { dataDir, dbPath, storageDir, source: 'standalone' }
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(storageDir, { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    const run = (sql, ...params) => db.prepare(sql).run(...params)
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN')
    db.exec(USERDATA_SQL)
    run('INSERT INTO version (schema, version) VALUES (?, ?)', 'userdata', USERDATA_SCHEMA_VERSION)
    run('INSERT INTO version (schema, version) VALUES (?, ?)', 'globalSchema', GLOBAL_SCHEMA.version)

    // Field ids: one row per distinct field name across every item type.
    let fieldID = 1
    const fieldIds = new Map()
    for (const type of GLOBAL_SCHEMA.itemTypes) {
      for (const field of type.fields) {
        if (!fieldIds.has(field)) {
          fieldIds.set(field, fieldID)
          run('INSERT INTO fields (fieldID, fieldName) VALUES (?, ?)', fieldID, field)
          run('INSERT INTO fieldsCombined (fieldID, fieldName, custom) VALUES (?, ?, 0)', fieldID, field)
          fieldID += 1
        }
      }
    }
    // Creator type ids across every item type.
    let creatorTypeID = 1
    const creatorIds = new Map()
    for (const type of GLOBAL_SCHEMA.itemTypes) {
      for (const creator of type.creatorTypes) {
        if (!creatorIds.has(creator.creatorType)) {
          creatorIds.set(creator.creatorType, creatorTypeID)
          run('INSERT INTO creatorTypes (creatorTypeID, creatorType) VALUES (?, ?)', creatorTypeID, creator.creatorType)
          creatorTypeID += 1
        }
      }
    }
    // Item types with their field order and creator types.
    let itemTypeID = 1
    for (const type of GLOBAL_SCHEMA.itemTypes) {
      run('INSERT INTO itemTypes (itemTypeID, typeName, display) VALUES (?, ?, 1)', itemTypeID, type.itemType)
      run('INSERT INTO itemTypesCombined (itemTypeID, typeName, display, custom) VALUES (?, ?, 1, 0)', itemTypeID, type.itemType)
      type.fields.forEach((field, orderIndex) => {
        run('INSERT INTO itemTypeFields (itemTypeID, fieldID, hide, orderIndex) VALUES (?, ?, 0, ?)', itemTypeID, fieldIds.get(field), orderIndex)
        run('INSERT INTO itemTypeFieldsCombined (itemTypeID, fieldID, hide, orderIndex) VALUES (?, ?, 0, ?)', itemTypeID, fieldIds.get(field), orderIndex)
        const base = type.fieldBases?.[field]
        if (base && fieldIds.has(base)) {
          run('INSERT INTO baseFieldMappings (itemTypeID, baseFieldID, fieldID) VALUES (?, ?, ?)', itemTypeID, fieldIds.get(base), fieldIds.get(field))
          run('INSERT INTO baseFieldMappingsCombined (itemTypeID, baseFieldID, fieldID) VALUES (?, ?, ?)', itemTypeID, fieldIds.get(base), fieldIds.get(field))
        }
      })
      for (const creator of type.creatorTypes) {
        run('INSERT INTO itemTypeCreatorTypes (itemTypeID, creatorTypeID, primaryField) VALUES (?, ?, ?)', itemTypeID, creatorIds.get(creator.creatorType), creator.primary ? 1 : 0)
      }
      itemTypeID += 1
    }
    // The user library every item belongs to.
    run("INSERT INTO libraries (libraryID, type, editable, filesEditable) VALUES (1, 'user', 1, 1)")
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The connection is being discarded either way.
    }
    db.close()
    try {
      safeUnlink(dbPath)
      for (const sidecar of ['-wal', '-shm', '-journal']) safeUnlink(dbPath + sidecar)
    } catch {
      // A leftover half-created file is cleaned by the next attempt.
    }
    throw error
  } finally {
    try {
      db.close()
    } catch {
      // Already closed on the failure path.
    }
  }
  logger.info?.(`library: created standalone library at ${dataDir} (schema ${USERDATA_SCHEMA_VERSION}, global ${GLOBAL_SCHEMA.version})`)
  return { dataDir, dbPath, storageDir, source: 'standalone' }
}
