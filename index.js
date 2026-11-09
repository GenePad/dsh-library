// Host half of dsh-zot-library: serves the library API and the agent tools.
//
// The browser half (client.js) is discovered through package.json's dsh.client
// declaration and binds to the bundle row whose name is this package.
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { createLibraryRuntime } from './src/host/runtime.js'
import { createChannel } from './src/host/channel.js'
import { createTools } from './src/host/tools.js'
import { chatGuidance } from './src/host/chat.js'

export const name = 'library'
export const version = '0.4.2'

// The plugin cannot do anything useful without the authenticated connection
// (the API route) or a session controller (the chat dock).
export const inject = ['connection', 'sessionController', 'sessionTitle', 'workspaceRegistry']

/**
 * Mount the library plugin.
 * @param {object} ctx - cordis context.
 * @param {object} [config] - bundle config from cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const packageDir = fileURLToPath(new URL('./', import.meta.url))
  // Optional service bridges: the translator needs dsh's llm runtime and the
  // current-model selection, but the library must keep working without them.
  const extensions = {}
  ctx.effect(() => ctx.inject(['llm'], (scoped) => {
    extensions.llm = scoped.llm
    return () => { extensions.llm = undefined }
  }), 'library: llm bridge')
  ctx.effect(() => ctx.inject(['agentDefaultModel'], (scoped) => {
    extensions.agentDefaultModel = scoped.agentDefaultModel
    return () => { extensions.agentDefaultModel = undefined }
  }), 'library: default model bridge')
  const runtime = createLibraryRuntime({ ctx, config: { ...config, version, extensions }, logger, packageDir })
  const paths = {
    get dataDir() { return runtime.paths().dataDir },
    get storageDir() { return runtime.paths().storageDir },
  }
  const handle = createChannel(runtime)

  // One authenticated POST endpoint on the shared /api channel; the browser
  // authenticates with its session cookie, so no separate trust fence is needed.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/library',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        body = {}
      }
      const result = await handle(String(body?.endpoint ?? ''), body?.payload ?? {}, request.signal)
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    },
  }), 'library: api route')

  // The tools fiber pends independently: a composition without ctx.tools still
  // serves the library, it just has no agent controls.
  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => {
      const definitions = createTools({
        getDb: () => runtime.db(),
        paths,
        getSettings: runtime.getSettings,
        // The Word AI task service (library_word_apply) — created together with
        // the office integration below; resolved lazily so ordering never matters.
        wordAi: () => runtime.office?.ai,
        // The Word report generator (library_word_report) and the CSL style
        // store (library_cite_styles), same lazy resolution.
        wordReport: () => runtime.office?.report,
        citeStyles: () => runtime.office?.styles,
        logger,
      })
      const disposers = definitions.map(definition => scoped.tools.register(definition))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'library: agent tools')
  })

  // The library assistant's guidance lives in the SYSTEM prompt, not in the
  // user message: a dynamic section evaluated per model step. It only speaks
  // for the chat session this plugin created (the provider gates on the agent
  // id and the Library workspace cwd), so native dsh chats are unaffected.
  const systemPrompt = ctx.get?.('systemPrompt') ?? ctx.systemPrompt
  if (typeof systemPrompt?.section === 'function') {
    const libraryDir = runtime.workspaceDir()
    const samePath = (a, b) => String(a ?? '').replaceAll('/', '\\').toLowerCase() === String(b ?? '').replaceAll('/', '\\').toLowerCase()
    const disposer = systemPrompt.section({
      name: 'library:chat-guidance',
      order: 4800,
      text: (assembly) => {
        const agent = assembly?.agent
        const session = agent?.session
        const cwd = session?.cwd ?? session?.header?.cwd ?? session?.meta?.cwd
        const chatState = runtime.chatState()
        if (agent?.id !== chatState.chatSessionId && !samePath(cwd, libraryDir)) return ''
        return chatGuidance(chatState.chatContext)
      },
    })
    ctx.effect(() => disposer, 'library: chat guidance section')
  } else {
    logger.warn?.('library: ctx.systemPrompt.section unavailable; chat guidance will not be injected')
  }

  // Binary route for the built-in reader: streams the PDF directly (no base64
  // round trip), so large papers open without blocking the UI thread.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/library/file',
    methods: ['GET'],
    // The connection bridge picks a body mode from this field; leaving it
    // undefined makes GET requests stream a phantom body, which throws.
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const info = runtime.attachmentFileInfo(url.searchParams.get('key') ?? '')
        const stat = fs.statSync(info.path)
        const body = Readable.toWeb(fs.createReadStream(info.path))
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': info.contentType || 'application/pdf',
            'content-length': String(stat.size),
            'cache-control': 'no-store',
            'x-library-attachment-key': info.key,
            'x-library-parent-key': info.parentKey,
            'x-library-title': encodeURIComponent(info.title || info.fileName || 'PDF'),
          },
        })
      } catch (error) {
        // `code`/`url` drive the client's browser fallback: records without an
        // openable file arrive as {code:'library/open-url', url} and the client
        // opens that web address instead of showing an error.
        return new Response(JSON.stringify({
          ok: false,
          error: {
            message: String(error?.message ?? error),
            ...(typeof error?.code === 'string' ? { code: error.code } : {}),
            ...(typeof error?.url === 'string' ? { url: error.url } : {}),
          },
        }), {
          status: 404,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
    },
  }), 'library: pdf file route')

  ctx.effect(() => () => runtime.dispose(), 'library: runtime')

  // Reader translations: one NDJSON stream per POST (thinking/answer/done/error
  // events). A separate exact route because the buffered JSON envelope cannot
  // carry a streaming body; the browser aborts by closing the fetch.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/library/translate',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let text = ''
      try {
        const body = await request.json()
        text = body?.text
      } catch {
        text = ''
      }
      return runtime.translateStream(text, request.signal)
    },
  }), 'library: translate route')
}
