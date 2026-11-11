// SQLite access to a real zotero.sqlite: schema metadata plus read/write primitives.
import { DatabaseSync } from 'node:sqlite'

/** Known userdata schema versions this plugin writes. Newer schemas are refused. */
// 131 (Zotero 10) is additive over 130 — proxy/sync-queue tables and nullable
// columns (itemAttachments.lastRead); all INSERTs go through insertRow(), which
// filters to the columns each database actually has.
export const MAX_SUPPORTED_SCHEMA = 131

/** A zotero.sqlite connection with cached schema metadata. */
export class ZoteroDb {
  /**
   * @param {object} options
   * @param {string} options.dbPath - absolute path of zotero.sqlite.
   * @param {object} [options.logger]
   * @param {number} [options.acceptedSchema] - a newer userdata schema the user
   *   explicitly accepted via 一键修复 (settings); relaxes the version guard.
   */
  constructor({ dbPath, logger = console, acceptedSchema = 0 }) {
    this.dbPath = dbPath
    this.logger = logger
    this.acceptedSchema = Number(acceptedSchema) || 0
    this.db = undefined
    this.readOnly = false
    this.meta = undefined
  }

  /** Open the database (idempotent). Read-only connections cannot write. */
  open({ readOnly = false } = {}) {
    if (this.db) {
      if (this.readOnly !== readOnly) throw new Error('library: database is already open with a different mode')
      return this
    }
    this.db = new DatabaseSync(this.dbPath, { readOnly })
    this.readOnly = readOnly
    this.db.exec('PRAGMA busy_timeout = 4000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.meta = undefined
    this.columnCache = undefined
    return this
  }

  /** Close the connection; safe to call repeatedly. */
  close() {
    if (!this.db) return
    try {
      this.db.close()
    } finally {
      this.db = undefined
      this.meta = undefined
      this.columnCache = undefined
    }
  }

  /** Reconnect after an external process (Zotero) replaced the file. */
  reopen() {
    this.close()
    this.open({ readOnly: this.readOnly })
  }

  /** Run a statement returning all rows. */
  all(sql, ...params) {
    return this.prepare(sql).all(...params)
  }

  /** Run a statement returning the first row. */
  get(sql, ...params) {
    return this.prepare(sql).get(...params)
  }

  /** Run a statement for its side effects. */
  run(sql, ...params) {
    return this.prepare(sql).run(...params)
  }

  /** Prepare a statement, refusing writes on a read-only connection. */
  prepare(sql) {
    if (!this.db) throw new Error('library: database is not open')
    if (this.readOnly && /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) {
      throw new Error('library: database is open read-only')
    }
    return this.db.prepare(sql)
  }

  /** Run a function inside an IMMEDIATE transaction, rolling back on any error. */
  transaction(fn) {
    if (this.readOnly) throw new Error('library: database is open read-only')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // A failed rollback leaves the connection unusable; reopening recovers.
        this.close()
      }
      throw error
    }
  }

  /** Column names of one table, cached per open connection. */
  columns(table) {
    if (this.columnCache === undefined) this.columnCache = new Map()
    if (!this.columnCache.has(table)) {
      this.columnCache.set(table, new Set(this.all(`PRAGMA table_info(${table})`).map(row => row.name)))
    }
    return this.columnCache.get(table)
  }

  /** Schema facts read from the database itself (ids differ between installations). */
  schema() {
    if (this.meta) return this.meta
    const versionRow = this.get("SELECT version FROM version WHERE schema = 'userdata'")
    const schemaVersion = Number(versionRow?.version ?? 0)
    const maxSupported = Math.max(MAX_SUPPORTED_SCHEMA, this.acceptedSchema)
    if (schemaVersion > maxSupported) {
      // 这条 message 会原样出现在各处 toast、Word 引文对话框与 agent 工具输出
      // 里，所以直接写成可操作的中文；文库主页与设置页按 code 渲染专属面板。
      throw Object.assign(new Error(`本机 Zotero 数据库结构（schema ${schemaVersion}）比插件支持的最高版本（${maxSupported}）新：请更新插件，或在文库面板使用「一键修复」。`), {
        code: 'library/schema-too-new',
        schemaVersion,
        supported: maxSupported,
      })
    }
    const library = this.get("SELECT libraryID, version, storageVersion FROM libraries WHERE type = 'user' ORDER BY libraryID LIMIT 1")
    const itemTypes = new Map()
    const itemTypeNames = new Map()
    for (const row of this.all('SELECT itemTypeID, typeName FROM itemTypes')) {
      itemTypes.set(row.typeName, row.itemTypeID)
      itemTypeNames.set(row.itemTypeID, row.typeName)
    }
    const fields = new Map()
    const fieldNames = new Map()
    for (const row of this.all('SELECT fieldID, fieldName FROM fieldsCombined')) {
      fields.set(row.fieldName, row.fieldID)
      fieldNames.set(row.fieldID, row.fieldName)
    }
    const creatorTypes = new Map()
    for (const row of this.all('SELECT creatorTypeID, creatorType FROM creatorTypes')) creatorTypes.set(row.creatorType, row.creatorTypeID)
    const itemTypeFields = new Map()
    for (const row of this.all('SELECT itemTypeID, fieldID, hide, orderIndex FROM itemTypeFieldsCombined ORDER BY itemTypeID, orderIndex')) {
      if (!itemTypeFields.has(row.itemTypeID)) itemTypeFields.set(row.itemTypeID, [])
      itemTypeFields.get(row.itemTypeID).push({ fieldID: row.fieldID, hide: row.hide === 1 })
    }
    this.meta = {
      schemaVersion,
      libraryID: Number(library?.libraryID ?? 1),
      storageVersion: Number(library?.storageVersion ?? 0),
      itemTypes,
      itemTypeNames,
      fields,
      fieldNames,
      creatorTypes,
      itemTypeFields,
    }
    return this.meta
  }

  /** The field id for a field name; throws when the schema has no such field. */
  fieldId(name) {
    const id = this.schema().fields.get(name)
    if (id === undefined) throw new Error(`library: unknown Zotero field "${name}"`)
    return id
  }

  /** The item type id for a type name; throws when the schema has no such type. */
  itemTypeId(name) {
    const id = this.schema().itemTypes.get(name)
    if (id === undefined) throw new Error(`library: unknown Zotero item type "${name}"`)
    return id
  }
}

// The tables and columns the plugin reads and writes on every install. A newer
// schema that keeps all of these is, historically, additive (Zotero 130→131 was
// new tables + nullable columns) and safe to drive blind — INSERTs go through
// insertRow(), which filters to the columns each database actually has. One
// renamed/dropped member here means the schema changed under our feet and
// blind compatibility would corrupt data, so 一键修复 refuses.
const CORE_SHAPE = [
  ['items', ['itemID', 'itemTypeID', 'libraryID', 'key', 'version', 'synced', 'dateAdded', 'dateModified']],
  ['itemData', ['itemID', 'fieldID', 'valueID']],
  ['itemDataValues', ['valueID', 'value']],
  ['fieldsCombined', ['fieldID', 'fieldName']],
  ['itemTypes', ['itemTypeID', 'typeName']],
  ['creatorTypes', ['creatorTypeID', 'creatorType']],
  ['creators', ['creatorID', 'firstName', 'lastName', 'fieldMode']],
  ['itemCreators', ['itemID', 'creatorID', 'creatorTypeID', 'orderIndex']],
  ['tags', ['tagID', 'name']],
  ['itemTags', ['itemID', 'tagID', 'type']],
  ['collections', ['collectionID', 'collectionName', 'libraryID', 'key']],
  ['collectionItems', ['collectionID', 'itemID', 'orderIndex']],
  ['itemNotes', ['itemID', 'parentItemID', 'note']],
  ['itemAttachments', ['itemID', 'parentItemID', 'linkMode', 'contentType', 'path', 'syncState', 'storageModTime', 'storageHash']],
  ['itemAnnotations', ['itemID', 'parentItemID', 'type', 'position', 'sortIndex', 'isExternal']],
  ['deletedItems', ['itemID']],
  ['libraries', ['libraryID', 'type', 'version']],
]

/**
 * Sanity-check a zotero.sqlite's core shape without opening it through the
 * ZoteroDb guard. Returns a list of human-readable problems (empty = fine).
 */
export function inspectCoreShape(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const problems = []
    for (const [table, columns] of CORE_SHAPE) {
      let info
      try {
        info = db.prepare(`PRAGMA table_info(${table})`).all()
      } catch {
        problems.push(`表 ${table} 不存在`)
        continue
      }
      const names = new Set(info.map(row => row.name))
      const missing = columns.filter(name => !names.has(name))
      if (missing.length > 0) problems.push(`表 ${table} 缺少列 ${missing.join('/')}`)
    }
    return problems
  } finally {
    db.close()
  }
}

/** The userdata schema version of a zotero.sqlite (0 when unreadable). */
export function readSchemaVersion(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare("SELECT version FROM version WHERE schema = 'userdata'").get()
    return Number(row?.version ?? 0)
  } finally {
    db.close()
  }
}
