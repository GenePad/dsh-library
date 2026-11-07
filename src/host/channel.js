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
        case 'items':
          return ok(runtime.items({
            collectionID: Number.isInteger(body.collectionID) ? body.collectionID : undefined,
            unfiled: body.unfiled === true,
            tag: typeof body.tag === 'string' ? body.tag : undefined,
            query: typeof body.query === 'string' ? body.query : '',
            trash: body.trash === true,
            sort: ['title', 'creator', 'date', 'dateAdded', 'dateModified'].includes(body.sort) ? body.sort : undefined,
            desc: body.desc !== false,
            limit: Number.isInteger(body.limit) ? body.limit : 100,
            offset: Number.isInteger(body.offset) ? body.offset : 0,
          }))
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
          const result = await runtime.importFile({
            filePath: String(body.path ?? ''),
            parentKey: typeof body.parentKey === 'string' ? body.parentKey : undefined,
            collectionID: Number.isInteger(body.collectionID) ? body.collectionID : undefined,
            lookup: body.lookup !== false,
            metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
          })
          return ok(result)
        }
        case 'upload': {
          const saved = runtime.saveUpload(String(body.name ?? 'upload'), String(body.data ?? ''))
          const result = await runtime.importFile({
            filePath: saved,
            parentKey: typeof body.parentKey === 'string' ? body.parentKey : undefined,
            collectionID: Number.isInteger(body.collectionID) ? body.collectionID : undefined,
            lookup: body.lookup !== false,
            metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
          })
          return ok(result)
        }
        case 'lookup': {
          const draft = await resolveMetadata({ identifier: String(body.identifier ?? '') })
          return ok(draft ?? null)
        }
        case 'open':
          return ok(runtime.openRecord(String(body.key ?? ''), body.reveal === true))
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
          return ok(await runtime.chat.open(body.fresh === true))
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
