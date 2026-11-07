// Import pipeline: metadata resolution, stored attachment, fulltext cache, PDF annotations.
import fs from 'node:fs'
import path from 'node:path'
import { createItem, createStoredAttachment } from './write.js'
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

  const resolved = Boolean(metadata?.fields?.title)
  const confidence = metadata?.confidence ?? (resolved ? 1 : 0)
  return {
    parentKey: result.parentKey,
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
