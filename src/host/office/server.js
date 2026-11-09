// Local HTTP integration server: the Zotero connector protocol for Word plus
// the JSON endpoints used by the standalone dialog pages and by the dsh UI.
import http from 'node:http'
import { createTransport } from './http-client.js'
import { renderDialogPage } from './pages.js'
import { raiseDialogWindow } from './window.js'

const DEFAULT_PORT = 23119
const PORT_ATTEMPTS = 12
const IDLE_TIMEOUT = 10 * 60_000
// A transaction whose Word side stopped answering (window closed mid command,
// a VBA error left the instruction loop, ...) must never block the next
// command: every later execCommand would get a 503 and the ribbon would report
// "无法连接文库插件服务". After this much silence a new command takes over.
const STALE_AFTER = 45_000

function json(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value ?? null)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-Zotero-Connector-API-Version',
    'x-zotero-connector-api-version': '3',
    'x-zotero-version': '7.0',
    ...extraHeaders,
  })
  response.end(body)
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    // Older Google Docs / WPS clients double-encode their JSON payload.
    if (typeof value === 'string') {
      // Old Google Docs / WPS clients double-encode their JSON; plain strings
      // (document data XML, field text, field codes) are legitimate values.
      try { return JSON.parse(value) } catch { return value }
    }
    return value
  } catch {
    return { value: raw }
  }
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export function createOfficeServer({ integration, dialogs, styles, ai = null, logger = console, version = '0.2.1' }) {
  let server = null
  let port = 0
  let error = ''
  let active = null

  function status() {
    return {
      running: Boolean(server?.listening),
      port,
      error: error || null,
      busy: Boolean(active),
      pendingDialogs: dialogs.size,
    }
  }

  function baseUrl() { return `http://127.0.0.1:${port}` }
  dialogs.setBaseUrl?.(baseUrl)

  function clearTransaction(txn) {
    if (txn.timer) clearTimeout(txn.timer)
    if (active === txn) active = null
  }

  function touch(txn) {
    if (txn.timer) clearTimeout(txn.timer)
    txn.lastActivity = Date.now()
    txn.timer = setTimeout(() => {
      logger.warn?.('library: integration transaction timed out')
      txn.transport.abort(new Error('集成事务超时'))
      clearTransaction(txn)
    }, IDLE_TIMEOUT)
  }

  function isStale(txn) {
    return Date.now() - (txn.lastActivity ?? txn.startedAt) > STALE_AFTER
  }

  async function handleConnector(request, response, url, body) {
    const path = url.pathname
    if (path === '/connector/ping') {
      return json(response, 200, {
        ok: true, version, processorName: 'Word', active: Boolean(active),
        styles: styles.list().length,
      })
    }
    if (path === '/connector/sendToBack') return json(response, 200, { ok: true })
    if (path === '/connector/document/execCommand') {
      if (active) {
        if (!isStale(active)) {
          return json(response, 503, {
            error: 'Integration transaction is already in progress',
            retryAfterMs: Math.max(0, STALE_AFTER - (Date.now() - (active.lastActivity ?? active.startedAt))),
          })
        }
        // The previous transaction never finished: Word stopped answering it
        // (apply aborted half way, document closed, ...). End it now instead of
        // refusing every later command behind a permanent 503.
        logger.warn?.(`library: aborting stale ${active.command} transaction (idle ${Math.round((Date.now() - (active.lastActivity ?? active.startedAt)) / 1000)}s)`)
        try { active.transport.abort(new Error('上一个集成事务已停止响应，已被新命令接管')) } catch { /* no waiter */ }
        clearTransaction(active)
      }
      const command = String(body?.command ?? '')
      const docId = String(body?.docId ?? body?.documentID ?? '')
      const taskId = String(body?.taskId ?? '')
      const pid = Number(body?.pid) || 0
      const transport = createTransport()
      const txn = { transport, docId, command, startedAt: Date.now(), lastActivity: Date.now(), timer: null, engine: null }
      active = txn
      touch(txn)
      txn.engine = integration.execCommand({ agent: 'Word', command, docId, transport, taskId, pid })
        .catch((failure) => {
          logger.warn?.(`library: integration engine crashed: ${failure?.message ?? failure}`)
          transport.abort(failure)
        })
        .finally(() => {
          clearTimeout(txn.timer)
          txn.timer = null
          // The engine ended without Document.complete (Word vanished mid
          // transaction, a dispatch error broke its instruction loop, ...).
          // Release the slot here, otherwise `active` stays set forever and
          // every following command is refused with a 503 until dsh restarts.
          if (active === txn) {
            logger.warn?.(`library: integration transaction ${txn.command} ended without completion; releasing it`)
            try { txn.transport.abort(new Error('集成事务已结束')) } catch { /* no waiter */ }
            clearTransaction(txn)
          }
        })
      try {
        const next = await withTimeout(transport.nextCommand(), 30_000, '等待首条文档指令超时')
        if (next.command === 'Document.complete') clearTransaction(txn)
        return json(response, 200, next)
      } catch (failure) {
        clearTransaction(txn)
        return json(response, 504, { error: String(failure?.message ?? failure) })
      }
    }
    if (path === '/connector/document/respond') {
      const txn = active
      if (!txn) return json(response, 409, { error: 'No integration transaction in progress' })
      touch(txn)
      if (body && typeof body === 'object' && body.error) {
        const message = String(body.message ?? body.error)
        const failure = new Error(message)
        failure.name = body.error === 'Alert' ? 'AlertError' : 'Error'
        txn.transport.deliverError(failure)
      } else {
        txn.transport.deliver(body)
      }
      try {
        const next = await withTimeout(txn.transport.nextCommand(), IDLE_TIMEOUT, '等待下一条文档指令超时')
        const terminal = next.command === 'Document.complete'
        if (terminal) clearTransaction(txn)
        return json(response, 200, next)
      } catch (failure) {
        clearTransaction(txn)
        return json(response, 504, { error: String(failure?.message ?? failure) })
      }
    }
    return json(response, 404, { error: 'Unknown connector endpoint' })
  }

  async function handleOfficeApi(request, response, url, body) {
    const name = url.pathname.replace(/^\/office\/api\//, '')
    const id = url.searchParams.get('id') ?? ''
    switch (name) {
      case 'status':
        return json(response, 200, { ...status(), dialogs: dialogs.pendingDialogs() })
      case 'pending-dialogs':
        return json(response, 200, { dialogs: dialogs.pendingDialogs(), progress: dialogs.progressState() })
      case 'state': {
        const state = dialogs.state(id)
        return state ? json(response, 200, state) : json(response, 404, { error: '对话框不存在或已关闭' })
      }
      case 'raise':
        // The page calls this as soon as its title (and therefore the Win32
        // marker) is ready. Raising on launch alone is too early: Chromium
        // resets the window style while it finishes loading.
        raiseDialogWindow(id, logger)
        return json(response, 200, { ok: true })
      case 'collections':
        return json(response, 200, dialogs.collections(id))
      case 'search':
        return json(response, 200, dialogs.search(id,
          url.searchParams.get('q') ?? '', url.searchParams.get('mode') ?? 'citation',
          url.searchParams.get('scope') ?? '', url.searchParams.get('layout') ?? 'list',
          url.searchParams.get('collection') ?? ''))
      case 'preview':
        return json(response, 200, dialogs.preview(id, body?.citation ?? body ?? {}))
      case 'styles':
        return json(response, 200, dialogs.stylesList())
      case 'style-search':
        return json(response, 200, { styles: await styles.search(url.searchParams.get('q') ?? '') })
      case 'style-install':
        return json(response, 200, await dialogs.installStyle(String(body?.styleID ?? '')))
      case 'result': {
        const ok = dialogs.answer(id, body)
        return json(response, 200, { ok })
      }
      case 'dialog-result': {
        const target = String(body?.id ?? id)
        const ok = dialogs.answer(target, { ...(body?.value ? { value: body.value } : {}), cancel: body?.cancel === true })
        return json(response, 200, { ok })
      }
      case 'progress':
        return json(response, 200, dialogs.progressState())
      case 'cancel-dialog':
        return json(response, 200, { ok: dialogs.answer(String(body?.id ?? id), { cancel: true }) })
      // --------------------------------------------------- Word AI tasks ---
      // The Word template POSTs ai-start with its OWN process id and the
      // selected text; every later step re-verifies (pid, docId) so several
      // Word processes can never be mixed up.
      case 'ai-start': {
        if (!ai) return json(response, 503, { ok: false, error: 'AI 任务服务不可用' })
        const result = await ai.start({
          kind: body?.kind,
          docId: body?.docId,
          pid: body?.pid,
          hwnd: body?.hwnd,
          docName: body?.docName,
          text: body?.text,
        })
        return json(response, result?.ok ? 200 : 400, result)
      }
      case 'ai-poll': {
        if (!ai) return json(response, 503, { error: 'AI 任务服务不可用' })
        // POST carries docId in a JSON body (document paths need no URL
        // encoding then); GET with query params stays for tests.
        return json(response, 200, ai.poll({
          taskId: body?.taskId ?? url.searchParams.get('taskId') ?? '',
          pid: body?.pid ?? url.searchParams.get('pid') ?? 0,
          docId: body?.docId ?? url.searchParams.get('docId') ?? '',
        }))
      }
      case 'ai-cancel': {
        if (!ai) return json(response, 503, { ok: false })
        return json(response, 200, ai.cancel({ taskId: body?.taskId, pid: body?.pid }))
      }
      default:
        return json(response, 404, { error: `Unknown office API endpoint: ${name}` })
    }
  }

  async function route(request, response) {
    const url = new URL(request.url, `http://127.0.0.1:${port || DEFAULT_PORT}`)
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-Zotero-Connector-API-Version',
      })
      return response.end()
    }
    let body = {}
    if (request.method === 'POST') {
      try { body = await readBody(request) } catch { body = {} }
    }
    try {
      if (url.pathname.startsWith('/connector/')) return await handleConnector(request, response, url, body)
      if (url.pathname.startsWith('/office/api/')) return await handleOfficeApi(request, response, url, body)
      if (url.pathname.startsWith('/office/dialog/')) {
        if (!dialogs.state(url.pathname.slice('/office/dialog/'.length))) {
          response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
          return response.end('<h1>对话框已关闭</h1>')
        }
        const html = renderDialogPage()
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return response.end(html)
      }
      if (url.pathname === '/integration/macWordCommand') {
        // macOS Word integration compatibility (fire-and-forget).
        const command = url.searchParams.get('command') ?? ''
        const document = url.searchParams.get('document') ?? ''
        const transport = createTransport()
        const txn = { transport, docId: document, command, startedAt: Date.now(), timer: null, engine: null }
        active = txn
        touch(txn)
        txn.engine = integration.execCommand({ agent: 'MacWord', command, docId: document, transport })
          .catch(() => {}).finally(() => clearTransaction(txn))
        return json(response, 200, { ok: true })
      }
      if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end() }
      return json(response, 404, { error: 'Not found' })
    } catch (failure) {
      logger.warn?.(`library: office request failed: ${failure?.stack ?? failure}`)
      return json(response, 500, { error: String(failure?.message ?? failure) })
    }
  }

  function listenOn(candidate) {
    return new Promise((resolve, reject) => {
      const instance = http.createServer((request, response) => { void route(request, response) })
      let settled = false
      const settle = (failure, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        instance.removeListener('error', onError)
        if (failure) {
          try { instance.close() } catch { /* never bound */ }
          reject(failure)
        } else {
          // An embedded service must never hold its host process alive:
          // unref'd, the listen handle cannot keep a smoke suite (or an idle
          // shell) running after its work is done.
          instance.unref()
          resolve(value)
        }
      }
      const onError = (failure) => settle(failure)
      instance.once('error', onError)
      instance.listen(candidate, '127.0.0.1', () => settle(null, instance))
      // A bind attempt must always settle. CI runners were observed to never
      // answer the listen on the Zotero connector port, which stalled start()
      // (and with it whole smoke suites) forever; failing the candidate after
      // 3s just moves on to the next port.
      const timer = setTimeout(() => settle(new Error(`端口 ${candidate} 绑定超时`)), 3000)
    })
  }

  // Every start/stop bumps this; a bind that lands after its generation was
  // superseded (stop during an in-flight start) hands the port right back.
  let generation = 0

  async function start(preferredPort = 0) {
    if (server?.listening) return { ...status() }
    const epoch = ++generation
    const candidates = []
    const chosen = Number(preferredPort)
    if (Number.isInteger(chosen) && chosen > 0 && chosen < 65536) candidates.push(chosen)
    for (let i = 0; i < PORT_ATTEMPTS; i += 1) candidates.push(DEFAULT_PORT + i)
    for (const candidate of candidates) {
      let instance
      try {
        instance = await listenOn(candidate)
      } catch (failure) {
        error = String(failure?.message ?? failure)
        continue
      }
      if (epoch !== generation) {
        // stop() (or a newer start) raced this bind: release the port.
        try { instance.close() } catch { /* already closed */ }
        try { instance.closeAllConnections?.() } catch { /* no clients */ }
        return { ...status() }
      }
      generation = epoch
      server = instance
      port = candidate
      error = ''
      logger.info?.(`library: word integration server listening on 127.0.0.1:${port}`)
      return { ...status() }
    }
    server = null
    port = 0
    throw new Error(`无法启动写作插件服务：${error}`)
  }

  function stop() {
    generation += 1
    if (active) {
      active.transport.abort(new Error('服务已停止'))
      clearTransaction(active)
    }
    dialogs.dispose()
    if (server) {
      try { server.close() } catch { /* already closed */ }
      // Keep-alive sockets would otherwise delay the close event and, in the
      // worst case, keep the process' event loop reachable.
      try { server.closeAllConnections?.() } catch { /* no clients */ }
      server = null
    }
    port = 0
  }

  return { start, stop, status, baseUrl, get port() { return port } }
}
