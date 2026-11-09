// Import pipeline: metadata resolution, stored attachment, fulltext cache, PDF annotations.
import fs from 'node:fs'
import path from 'node:path'
import { createItem, createStoredAttachment, touchItem, updateItem } from './write.js'
import { attachmentTarget } from './read.js'
import { detectIdentifiers, resolveMetadata } from './metadata.js'
import { annotationSignature, extractPdfAnnotations, extractPdfText } from './pdf.js'
import { sqlNow } from './util.js'

/** Read an existing annotation signature set for an attachment item id. */
function existingSignatures(db, attachmentItemID) {
  const rows = db.all('SELECT type, color, position FROM itemAnnotations WHERE parentItemID = ?', attachmentItemID)
  const signatures = new Set()
  for (const row of rows) {
    let position
    try {
      position = JSON.parse(row.position)
    } catch {
      continue
    }
    signatures.add(annotationSignature({
      type: row.type,
      color: row.color,
      pageIndex: position?.pageIndex,
      position,
    }))
  }
  return signatures
}

/** Insert one extracted annotation as a Zotero annotation item. */
export function insertAnnotation(db, attachmentItemID, annotation) {
  const meta = db.schema()
  const typeID = db.itemTypeId('annotation')
  const now = sqlNow()
  {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const key = Array.from({ length: 8 }, () => '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 32)]).join('')
      if (db.get('SELECT 1 AS yes FROM items WHERE libraryID = ? AND key = ?', meta.libraryID, key)) continue
      const itemColumns = ['itemTypeID', 'dateAdded', 'dateModified', 'clientDateModified', 'libraryID', 'key', 'version', 'clientVersion', 'synced']
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
    }
    throw new Error('library: could not allocate an annotation key')
  }
}

/** Extract annotations from a PDF and add the ones the DB does not have yet. */
export function syncPdfAnnotations(db, attachmentItemID, filePath, logger = console) {
  // Called from the synchronous watcher path too; annotation extraction is async.
  return extractPdfAnnotations(filePath).then((annotations) => {
    const known = existingSignatures(db, attachmentItemID)
    let added = 0
    db.transaction(() => {
      for (const annotation of annotations) {
        const signature = annotationSignature(annotation)
        if (known.has(signature)) continue
        known.add(signature)
        insertAnnotation(db, attachmentItemID, annotation)
        added += 1
      }
    })
    return { extracted: annotations.length, added }
  }).catch((error) => {
    logger.warn?.(`library: annotation sync failed for ${filePath}: ${error?.message ?? error}`)
    return { extracted: 0, added: 0 }
  })
}

/** Write Zotero's fulltext cache file beside the attachment. */
export function writeFulltextCache(attachmentDir, text) {
  try {
    fs.mkdirSync(attachmentDir, { recursive: true })
    fs.writeFileSync(path.join(attachmentDir, '.zotero-ft-cache'), text)
  } catch {
    // The cache is an optimization; a read-only storage folder is not fatal.
  }
}

/**
 * Shared middle stage of an import: extract PDF text/annotations, then resolve
 * metadata (explicit draft, or online lookup from identifiers in the file).
 */
async function extractAndResolve(filePath, fileName, isPdf, input, logger) {
  let text = ''
  let annotations = []
  if (isPdf) {
    try {
      text = await extractPdfText(filePath)
    } catch (error) {
      logger.warn?.(`library: text extraction failed for ${fileName}: ${error?.message ?? error}`)
    }
    try {
      annotations = await extractPdfAnnotations(filePath)
    } catch (error) {
      logger.warn?.(`library: annotation extraction failed for ${fileName}: ${error?.message ?? error}`)
    }
  }
  let metadata = input.metadata
  let lookupSource = 'explicit'
  if (!metadata && input.lookup !== false) {
    try {
      const identifiers = detectIdentifiers(`${fileName}\n${text.slice(0, 8000)}`)
      metadata = await resolveMetadata({ fileName, text, identifier: identifiers.doi ?? identifiers.arxiv ?? identifiers.isbn })
      lookupSource = metadata?.source ?? 'none'
    } catch (error) {
      logger.warn?.(`library: metadata lookup failed for ${fileName}: ${error?.message ?? error}`)
      lookupSource = 'error'
    }
  }
  return { text, annotations, metadata, lookupSource }
}

function importResult(input, parentKey, attachment, metadata, lookupSource, text, annotationResult) {
  const resolved = Boolean(metadata?.fields?.title)
  const confidence = metadata?.confidence ?? (resolved ? 1 : 0)
  return {
    parentKey,
    attachmentKey: attachment.key,
    fileName: attachment.fileName,
    size: attachment.size,
    metadata: metadata
      ? { source: lookupSource, confidence, title: metadata.fields?.title, needsReview: !resolved || confidence < 0.6 }
      : { source: lookupSource, confidence: 0, needsReview: true },
    // The browser offers "let the agent fix the metadata" when this is true.
    needsMetadataHelp: !resolved || confidence < 0.6,
    textChars: text.length,
    annotations: annotationResult,
  }
}

/**
 * Stage an import the way Zotero handles a dragged file: the file becomes a
 * standalone attachment item immediately, so the list can show and locate it
 * right away. Metadata (full text, annotations, parent item) is resolved later
 * by {@link finalizeImportFile}, which may turn the attachment into a proper
 * parented record.
 */
export async function importStagedFile(db, paths, input) {
  const logger = input.logger ?? console
  const filePath = path.resolve(String(input.filePath ?? ''))
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw Object.assign(new Error(`Not a file: ${filePath}`), { code: 'library/invalid' })
  const attachment = createStoredAttachment(db, { filePath, parentItemID: null }, paths)
  logger.info?.(`library: staged import ${attachment.fileName} as ${attachment.key}`)
  return {
    staged: true,
    parentKey: null,
    attachmentKey: attachment.key,
    fileName: attachment.fileName,
    size: attachment.size,
  }
}

/**
 * Finish a staged import on a standalone attachment: extract full text and
 * annotations, resolve metadata and — when found — create the parent item and
 * move the attachment under it. Without metadata the attachment stays
 * standalone (needsMetadataHelp = true, the browser offers the AI fix).
 * @param {import('./db.js').ZoteroDb} db
 * @param {{storageDir:string}} paths
 * @param {object} input
 * @param {string} input.attachmentKey - the staged attachment's item key.
 * @param {number} [input.collectionID] - collection for the created parent item.
 * @param {object} [input.metadata] - explicit metadata draft; skips lookup.
 * @param {boolean} [input.lookup] - allow online metadata lookup (default true).
 * @param {object} [input.logger]
 */
export async function finalizeImportFile(db, paths, input) {
  const logger = input.logger ?? console
  const meta = db.schema()
  const key = String(input.attachmentKey ?? '')
  const row = db.get(
    `SELECT i.itemID, a.parentItemID, a.path, a.linkMode FROM items i
     JOIN itemAttachments a ON a.itemID = i.itemID
     WHERE i.libraryID = ? AND i.key = ?`,
    meta.libraryID,
    key,
  )
  if (!row) throw Object.assign(new Error(`No attachment with key ${key}`), { code: 'library/not-found' })
  if (row.parentItemID) {
    const parent = db.get('SELECT key FROM items WHERE itemID = ?', row.parentItemID)
    return { parentKey: parent?.key ?? null, attachmentKey: key, alreadyParented: true }
  }
  const target = attachmentTarget(paths.storageDir, key, row.path, row.linkMode)
  if (target.kind !== 'file' || !fs.existsSync(target.path)) {
    throw Object.assign(new Error('该附件没有可识别的本地文件'), { code: 'library/invalid' })
  }
  const fileName = path.basename(target.path)
  const isPdf = fileName.toLowerCase().endsWith('.pdf')
  const { text, annotations, metadata, lookupSource } = await extractAndResolve(target.path, fileName, isPdf, input, logger)

  let parentKey = null
  if (metadata && metadata.fields?.title) {
    const created = createItem(db, {
      itemType: metadata.itemType ?? 'document',
      fields: metadata.fields,
      creators: metadata.creators ?? [],
      tags: metadata.tags ?? [],
      collectionIDs: Number.isInteger(input.collectionID) ? [input.collectionID] : [],
    })
    db.run('UPDATE itemAttachments SET parentItemID = ? WHERE itemID = ?', created.itemID, row.itemID)
    touchItem(db, row.itemID)
    parentKey = created.key
  }

  if (text !== '') writeFulltextCache(path.dirname(target.path), text)
  let annotationResult = { extracted: 0, added: 0 }
  if (annotations.length > 0) {
    annotationResult = await syncPdfAnnotations(db, row.itemID, target.path, logger)
  }
  return importResult(input, parentKey, { key, fileName }, metadata, lookupSource, text, annotationResult)
}

/**
 * Re-recognize an item that already has metadata (the list's 重新获取元数据 →
 * 重新获取): re-reads the item's attachment file, resolves metadata online and
 * merges the result back into the SAME item — fetched values win, fields the
 * lookup did not return and the user's own tags stay. Child attachment keys
 * resolve to their parent; standalone attachments belong to import-finalize.
 * @param {import('./db.js').ZoteroDb} db
 * @param {{storageDir:string}} paths
 * @param {object} input
 * @param {string} input.key - item (or child attachment) key.
 * @param {object} [input.metadata] - explicit metadata draft; skips lookup.
 * @param {boolean} [input.lookup] - allow online metadata lookup (default true).
 * @param {object} [input.logger]
 */
export async function recognizeItemMetadata(db, paths, input) {
  const logger = input.logger ?? console
  const meta = db.schema()
  const key = String(input.key ?? '')
  const row = db.get(
    `SELECT i.itemID, i.key, ty.typeName AS name, a.parentItemID AS attachmentParent
     FROM items i
     JOIN itemTypes ty ON ty.itemTypeID = i.itemTypeID
     LEFT JOIN itemAttachments a ON a.itemID = i.itemID
     WHERE i.libraryID = ? AND i.key = ?`,
    meta.libraryID,
    key,
  )
  if (!row) throw Object.assign(new Error(`No item with key ${key}`), { code: 'library/not-found' })
  let itemID = row.itemID
  if (row.name === 'attachment') {
    if (!row.attachmentParent) {
      throw Object.assign(new Error('独立附件请用「检索元数据」建立条目'), { code: 'library/invalid' })
    }
    itemID = row.attachmentParent
  } else if (row.name === 'note' || row.name === 'annotation') {
    throw Object.assign(new Error('笔记没有可识别的附件'), { code: 'library/invalid' })
  }
  // An explicit metadata draft (tests / future tools) skips the file read;
  // the real path re-reads the item's attachment and looks the metadata up.
  let metadata = input.metadata ?? null
  if (!metadata) {
    const attachments = db.all(
      `SELECT i.key, a.path, a.linkMode, a.contentType FROM itemAttachments a
       JOIN items i ON i.itemID = a.itemID
       LEFT JOIN deletedItems d ON d.itemID = i.itemID
       WHERE a.parentItemID = ? AND d.itemID IS NULL
       ORDER BY i.dateAdded`,
      itemID,
    )
    const source = attachments.find(entry => entry.contentType === 'application/pdf') ?? attachments[0]
    const target = source ? attachmentTarget(paths.storageDir, source.key, source.path, source.linkMode) : null
    // Records with nothing to read (no attachment, or only a web link):
    // resolve from the record itself — DOI / arXiv archiveID / landing URL,
    // falling back to a title search — so records added by identifier only
    // can fetch (or top up) their metadata too.
    const lookupFromRecord = async () => {
      if (input.lookup === false) return null
      const stored = new Map(db.all(
        `SELECT f.fieldName, v.value FROM itemData d
         JOIN fieldsCombined f ON f.fieldID = d.fieldID
         JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ?`, itemID,
      ).map(entry => [entry.fieldName, entry.value]))
      return resolveMetadata({
        identifier: [stored.get('DOI'), stored.get('archiveID'), stored.get('url')].filter(Boolean).join('\n'),
        fileName: String(stored.get('title') ?? ''),
      })
    }
    if (!target || target.kind !== 'file') {
      try {
        metadata = await lookupFromRecord()
      } catch (error) {
        logger.warn?.(`library: metadata lookup failed for ${key}: ${error?.message ?? error}`)
      }
    } else if (!fs.existsSync(target.path)) {
      throw Object.assign(new Error('附件文件不存在'), { code: 'library/not-found' })
    } else {
      const fileName = path.basename(target.path)
      const isPdf = fileName.toLowerCase().endsWith('.pdf')
      ;({ metadata } = await extractAndResolve(target.path, fileName, isPdf, { lookup: input.lookup !== false }, logger))
    }
  }
  if (!metadata?.fields?.title) {
    return { key, updated: false, needsMetadataHelp: true }
  }
  // Fetched values overwrite; fields the lookup did not return survive.
  const existing = new Map(db.all(
    `SELECT f.fieldName, v.value FROM itemData d
     JOIN fieldsCombined f ON f.fieldID = d.fieldID
     JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ?`, itemID,
  ).map(entry => [entry.fieldName, entry.value]))
  const merged = Object.fromEntries(existing)
  for (const [name, value] of Object.entries(metadata.fields ?? {})) {
    if (String(value ?? '').trim() !== '') merged[name] = String(value)
  }
  const patch = { fields: merged }
  if (Array.isArray(metadata.creators) && metadata.creators.length > 0) patch.creators = metadata.creators
  if (Array.isArray(metadata.tags) && metadata.tags.length > 0) {
    const names = new Set(db.all(
      'SELECT t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID = ?', itemID,
    ).map(entry => entry.name))
    for (const tag of metadata.tags) names.add(typeof tag === 'string' ? tag : tag?.name ?? tag?.tag ?? '')
    names.delete('')
    patch.tags = [...names]
  }
  const itemKey = db.get('SELECT key FROM items WHERE itemID = ?', itemID).key
  updateItem(db, itemKey, patch)
  logger.info?.(`library: re-recognized ${itemKey}`)
  return { key: itemKey, updated: true, title: metadata.fields.title, needsMetadataHelp: false }
}

/**
 * Import one file into the library.
 * @param {import('./db.js').ZoteroDb} db
 * @param {{storageDir:string}} paths
 * @param {object} input
 * @param {string} input.filePath - file to import.
 * @param {string} [input.parentKey] - attach to this item instead of creating one.
 * @param {number} [input.collectionID] - collection for the created parent item.
 * @param {object} [input.metadata] - explicit metadata draft; skips lookup.
 * @param {boolean} [input.lookup] - allow online metadata lookup (default true).
 * @param {object} [input.logger]
 */
export async function importFile(db, paths, input) {
  const logger = input.logger ?? console
  const filePath = path.resolve(String(input.filePath ?? ''))
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw Object.assign(new Error(`Not a file: ${filePath}`), { code: 'library/invalid' })
  const fileName = path.basename(filePath)
  const isPdf = fileName.toLowerCase().endsWith('.pdf')
  const { text, annotations, metadata, lookupSource } = await extractAndResolve(filePath, fileName, isPdf, input, logger)

  const result = (() => {
    let parentItemID = null
    let parentKey = input.parentKey ?? null
    if (parentKey) {
      const parent = db.get('SELECT itemID FROM items WHERE libraryID = ? AND key = ?', db.schema().libraryID, parentKey)
      if (!parent) throw Object.assign(new Error(`No item with key ${parentKey}`), { code: 'library/not-found' })
      parentItemID = parent.itemID
    } else if (metadata && metadata.fields?.title) {
      const created = createItem(db, {
        itemType: metadata.itemType ?? 'document',
        fields: metadata.fields,
        creators: metadata.creators ?? [],
        tags: metadata.tags ?? [],
        collectionIDs: Number.isInteger(input.collectionID) ? [input.collectionID] : [],
      })
      parentItemID = created.itemID
      parentKey = created.key
    }
    return { parentItemID, parentKey }
  })()

  const attachment = createStoredAttachment(db, {
    filePath,
    parentItemID: result.parentItemID,
    contentType: undefined,
  }, paths)

  if (text !== '') writeFulltextCache(path.dirname(attachment.filePath), text)
  let annotationResult = { extracted: 0, added: 0 }
  if (annotations.length > 0) {
    annotationResult = await syncPdfAnnotations(db, attachment.itemID, attachment.filePath, logger)
  }
  return importResult(input, result.parentKey, attachment, metadata, lookupSource, text, annotationResult)
}
