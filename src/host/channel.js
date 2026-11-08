// The API channel: one authenticated POST endpoint with named operations.
import { resolveMetadata } from './metadata.js'
import { toBibtex, toCslJson } from './cite.js'

/** Wrap an operation result in the channel envelope. */
function ok(value) {
  return { ok: true, value }
}

function fail(error) {
  const code = typeof error?.code === 'string' ? error.code : 'library/error'
  return { ok: false, error: { code, message: String(error?.message ?? error) } }
}

/** Citation export over the channel: keys or a list query, both formats. */
function withCite(runtime, body, format) {
  const input = {
    ...(Array.isArray(body.keys) ? { keys: body.keys.map(String) } : {}),
    ...(typeof body.query === 'string' ? { query: body.query } : {}),
    ...(Number.isInteger(body.collectionID) ? { collectionID: body.collectionID } : {}),
    ...(typeof body.tag === 'string' && body.tag !== '' ? { tag: body.tag } : {}),
    ...(Number.isInteger(body.limit) ? { limit: body.limit } : {}),
  }
  const db = runtime.db()
  if (format === 'bibtex') return { format, text: toBibtex(db, input) }
  return { format, items: toCslJson(db, input) }
}

/**
 * Build the endpoint dispatcher.
 * @param {ReturnType<import('./runtime.js').createLibraryRuntime>} runtime
 */
export function createChannel(runtime) {
  /**
   * Handle one channel call.
   * @param {string} endpoint - operation name.
   * @param {object} payload - operation arguments.
   * @param {AbortSignal} [signal]
   */
  return async function handle(endpoint, payload = {}, signal) {
    const body = payload && typeof payload === 'object' ? payload : {}
    try {
      switch (endpoint) {
        case 'ping': {
          // `available` lets the browser notice Zotero exiting (db unlock)
          // without restarting: the client polls this every few seconds.
          const state = runtime.state()
          return ok({ revision: state.revision, available: state.available === true })
        }
        case 'state':
          return ok(runtime.state())
        case 'collections':
          return ok({ ...runtime.collections(), tags: runtime.tags() })
        case 'items': {
          // Any visible column can drive the sort: 'field:<name>' orders by
          // that itemData field (validated shape-wise in readItems).
          const sortKey = typeof body.sort === 'string' ? body.sort : ''
          const sortOk = ['title', 'creator', 'date', 'dateAdded', 'dateModified', 'itemType', 'hasAttachment', 'numNotes'].includes(sortKey)
            || /^field:[A-Za-z][A-Za-z0-9]*$/.test(sortKey)
          return ok(runtime.items({
            collectionID: Number.isInteger(body.collectionID) ? body.collectionID : undefined,
            unfiled: body.unfiled === true,
            tag: typeof body.tag === 'string' ? body.tag : undefined,
            query: typeof body.query === 'string' ? body.query : '',
            trash: body.trash === true,
            sort: sortOk ? sortKey : undefined,
            desc: body.desc !== false,
            columns: Array.isArray(body.columns) ? body.columns.map(String) : [],
            limit: Number.isInteger(body.limit) ? body.limit : 100,
            offset: Number.isInteger(body.offset) ? body.offset : 0,
          }))
        }
        case 'item':
          return ok(runtime.item(String(body.key ?? '')))
        case 'create':
          return ok(runtime.create({
            itemType: String(body.itemType ?? 'document'),
            fields: body.fields && typeof body.fields === 'object' ? body.fields : {},
            creators: Array.isArray(body.creators) ? body.creators : [],
            tags: Array.isArray(body.tags) ? body.tags : [],
            collectionIDs: Array.isArray(body.collectionIDs) ? body.collectionIDs : [],
          }))
        case 'update':
          return ok(runtime.update(String(body.key ?? ''), body.patch && typeof body.patch === 'object' ? body.patch : {}))
        case 'change-type':
          return ok(runtime.changeType(String(body.key ?? ''), String(body.itemType ?? ''), body.confirm === true))
        case 'note-create':
          return ok(runtime.noteCreate({
            parentKey: typeof body.parentKey === 'string' ? body.parentKey : undefined,
            text: String(body.text ?? ''),
          }))
        case 'note-update':
          return ok(runtime.noteUpdate(String(body.key ?? ''), String(body.text ?? '')))
        case 'attachment-url':
          return ok(runtime.createUrlAttachment({
            parentKey: typeof body.parentKey === 'string' ? body.parentKey : undefined,
            url: String(body.url ?? ''),
            title: typeof body.title === 'string' ? body.title : undefined,
          }))
        case 'schema':
          return ok(runtime.itemSchema())
        case 'trash':
          return ok(runtime.trash(Array.isArray(body.keys) ? body.keys.map(String) : [], body.restore !== true))
        case 'delete':
          return ok(runtime.deleteForever(Array.isArray(body.keys) ? body.keys.map(String) : []))
        case 'collection-create':
          return ok(runtime.createCollection({ name: String(body.name ?? ''), parentID: body.parentID }))
        case 'collection-rename':
          return ok(runtime.renameCollection(Number(body.id), String(body.name ?? '')))
        case 'collection-trash':
          return ok(runtime.trashCollection(Number(body.id), body.restore !== true))
        case 'import': {
          // Zotero-style staged import: register the attachment item first so
          // the list can show and locate it, then resolve metadata separately
          // through import-finalize.
          if (body.deferMetadata === true && body.parentKey === undefined) {
            return ok(await runtime.importStaged({ filePath: String(body.path ?? '') }))
          }
          const result = await runtime.importFile({
            filePath: String(body.path ?? ''),
            parentKey: typeof body.parentKey === 'string' ? body.parentKey : undefined,
            collectionID: Number.isInteger(body.collectionID) ? body.collectionID : undefined,
            lookup: body.lookup !== false,
            metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
          })
          return ok(result)
        }
        case 'import-finalize':
          return ok(await runtime.finalizeImport({
            attachmentKey: String(body.attachmentKey ?? ''),
            collectionID: Number.isInteger(body.collectionID) ? body.collectionID : undefined,
            lookup: body.lookup !== false,
            metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
          }))
        case 'recognize-item':
          return ok(await runtime.recognizeItem({
            key: String(body.key ?? ''),
            lookup: body.lookup !== false,
            metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
          }))
        case 'upload': {
          const saved = runtime.saveUpload(String(body.name ?? 'upload'), String(body.data ?? ''))
          if (body.deferMetadata === true) {
            return ok(await runtime.importStaged({ filePath: saved }))
          }
          const result = await runtime.importFile({
            filePath: saved,
            parentKey: typeof body.parentKey === 'string' ? body.parentKey : undefined,
            collectionID: Number.isInteger(body.collectionID) ? body.collectionID : undefined,
            lookup: body.lookup !== false,
            metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
          })
          return ok(result)
        }
        case 'duplicate':
          return ok(runtime.duplicate(String(body.key ?? '')))
        case 'create-parent':
          return ok(runtime.createParent(String(body.key ?? '')))
        case 'detach-attachment':
          return ok(runtime.detachAttachment(String(body.key ?? '')))
        case 'merge':
          return ok(runtime.merge(Array.isArray(body.keys) ? body.keys.map(String) : []))
        case 'note-from-annotations':
          return ok(runtime.noteFromAnnotations(String(body.key ?? '')))
        case 'lookup': {
          const identifier = String(body.identifier ?? '')
          // Multi-value input (one id per line) resolves each like Zotero's
          // lookup panel; a single id keeps the old single-draft shape.
          if (/[\r\n]/.test(identifier.trim())) {
            const drafts = await runtime.lookupMany(identifier)
            return ok(drafts.filter(Boolean))
          }
          const draft = await resolveMetadata({ identifier })
          return ok(draft ?? null)
        }
        case 'open':
          return ok(runtime.openRecord(String(body.key ?? ''), body.reveal === true))
        case 'open-url':
          return ok(runtime.openUrl(body.url))
        case 'open-apps':
          return ok(await runtime.openApps(String(body.key ?? '')))
        case 'open-with':
          return ok(await runtime.openWith(String(body.key ?? ''), body.application))
        case 'annotations-list':
          return ok({ annotations: runtime.annotations(String(body.key ?? '')) })
        case 'annotation-create':
          return ok(runtime.createAnnotation(String(body.attachmentKey ?? ''), body.annotation && typeof body.annotation === 'object' ? body.annotation : {}))
        case 'annotation-update':
          return ok(runtime.updateAnnotation(String(body.key ?? ''), body.patch && typeof body.patch === 'object' ? body.patch : {}))
        case 'annotation-delete':
          return ok(runtime.removeAnnotation(String(body.key ?? '')))
        case 'settings-set':
          return ok(runtime.refreshSettings(body.patch && typeof body.patch === 'object' ? body.patch : {}))
        case 'sync-verify':
          return ok(await runtime.verifySync())
        case 'sync-run':
          return ok(await runtime.runSync())
        case 'sync-status':
          return ok(runtime.syncStatus())
        case 'chat-open':
          return ok(await runtime.chat.open({
            fresh: body.fresh === true,
            bindKey: typeof body.bindKey === 'string' ? body.bindKey : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
          }))
        case 'chat-page':
          return ok(await runtime.chat.page({
            beforeSeq: Number.isInteger(body.beforeSeq) ? body.beforeSeq : undefined,
            maxMessages: Number.isInteger(body.maxMessages) ? body.maxMessages : undefined,
          }))
        case 'chat-send':
          return ok(await runtime.chat.send(String(body.text ?? ''), body.context && typeof body.context === 'object' ? body.context : undefined))
        case 'chat-context':
          return ok(runtime.setChatContext(body.context && typeof body.context === 'object' ? body.context : undefined))
        case 'chat-stop':
          return ok(await runtime.chat.stop())
        case 'setup':
          return ok(runtime.setupLibrary(body.mode === 'standalone' ? 'standalone' : 'zotero'))
        case 'cite-json':
          return ok(withCite(runtime, body, 'csl-json'))
        case 'cite-bibtex':
          return ok(withCite(runtime, body, 'bibtex'))
        case 'update-status':
          return ok(runtime.updates.status())
        case 'update-check':
          return ok(await runtime.updates.check())
        case 'update-apply':
          return ok(await runtime.updates.apply())
        case 'translate-models':
          return ok(await runtime.translateModels())
        default:
          return fail(Object.assign(new Error(`Unknown endpoint "${endpoint}"`), { code: 'library/not-found' }))
      }
    } catch (error) {
      if (signal?.aborted) return fail(Object.assign(new Error('Request aborted'), { code: 'library/aborted' }))
      runtime.logger.warn?.(`library: ${endpoint} failed: ${error?.message ?? error}`)
      return fail(error)
    }
  }
}
