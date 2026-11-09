// One-shot translation over dsh's own llm service: no session, no transcript,
// no workspace — a temporary auxiliary model call, streamed to the reader's
// selection popup as NDJSON over the /api channel.
//
// Route: follow dsh's current model (agentDefaultModel.currentSelection) or a
// pinned "provider/model" from the plugin settings. Thinking follows
// settings.translate.thinking (default off); the effort is chosen against the
// resolved model's declared capabilities, so models without reasoning control
// simply run with their normal default instead of failing.

const MAX_INPUT_CHARS = 24_000
const MAX_TOKENS_PLAIN = 4096
const MAX_TOKENS_THINKING = 8192

const SYSTEM_PROMPT = [
  '你是学术论文翻译助手。用户会给你一段从文献中选中的文字。',
  '若原文以外文（英/日/德/法等）为主，翻译成简体中文；若原文以中文为主，翻译成英文。',
  '要求：准确、通顺、符合学术语境；专业术语首次出现时可在括号内保留原文或缩写；',
  '人名、地名、机构名保留原文。只输出译文本身，不要任何解释、前言或引号。',
].join('')

/** Build the plain user message object (no helper imports — the plugin is dependency-free). */
function userMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-zot-library-translate' },
  }
}

/** Resolve the {provider, model} route for one translation. */
function resolveRoute(extensions, translateSettings) {
  const pinned = String(translateSettings?.model ?? '')
  if (translateSettings?.modelSource === 'fixed' && pinned !== '') {
    const slash = pinned.indexOf('/')
    if (slash > 0) return { provider: pinned.slice(0, slash), model: pinned.slice(slash + 1) }
    // A bare model id rides on the provider dsh currently routes to.
    const current = extensions.agentDefaultModel?.currentSelection?.()
    if (current?.provider) return { provider: String(current.provider), model: pinned }
  }
  const current = extensions.agentDefaultModel?.currentSelection?.()
  if (current?.provider && current?.model) {
    return { provider: String(current.provider), model: String(current.model) }
  }
  throw Object.assign(new Error('没有可用模型：dsh 尚未配置默认模型。请先在 dsh 中选择模型，或在「文库设置 → AI 翻译」指定翻译模型。'), { code: 'library/no-model' })
}

/**
 * Pick reasoning controls for one resolved model. Thinking off maps to the
 * model's declared "off" effort when it has one; thinking on prefers "high".
 * Models without reasoning metadata (chat-only) run with their default.
 */
function configureControls(thinking) {
  return (controls, model) => {
    const efforts = model?.reasoning?.efforts ?? []
    if (efforts.length === 0) return controls
    const ids = efforts.map(effort => effort.id)
    if (thinking) {
      const pick = ids.includes('high') ? 'high' : ids[ids.length - 1]
      return { ...controls, reasoningEffort: pick }
    }
    if (ids.includes('off')) return { ...controls, reasoningEffort: 'off' }
    return controls
  }
}

/**
 * The translation service shared by the streaming route and the model listing.
 * @param {object} options
 * @param {object} options.extensions - lazily-filled service bridges (llm, agentDefaultModel).
 * @param {() => object} options.getSettings - current plugin settings.
 * @param {object} options.logger
 */
export function createTranslator({ extensions, getSettings, logger }) {
  /** All configured models, for the settings dropdown. */
  async function listModels() {
    const llm = extensions.llm
    let current = null
    try {
      const selection = extensions.agentDefaultModel?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        current = { provider: String(selection.provider), model: String(selection.model) }
      }
    } catch {
      current = null
    }
    if (!llm || typeof llm.listProviders !== 'function') return { models: [], current }
    const models = []
    try {
      for (const provider of llm.listProviders() ?? []) {
        const rows = await llm.listModels(provider.id).catch(() => [])
        for (const model of rows ?? []) {
          models.push({
            id: `${provider.id}/${model.id}`,
            name: `${model.name}`,
            provider: provider.id,
            model: model.id,
          })
        }
      }
    } catch (error) {
      logger.warn?.(`library: listing models failed: ${error?.message ?? error}`)
    }
    return { models, current }
  }

  /**
   * Run one translation and return an NDJSON Response of
   * {type:'thinking'|'answer'|'done'|'error', ...} lines.
   */
  function stream(text, signal) {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim()
    const fail = (error) => {
      const code = error?.code ?? 'library/translate'
      return new Response(JSON.stringify({ error: { code, message: String(error?.message ?? error) } }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    if (body === '') return fail(Object.assign(new Error('没有可翻译的文字'), { code: 'library/invalid' }))
    if (body.length > MAX_INPUT_CHARS) {
      return fail(Object.assign(new Error(`选中文本过长（${body.length} 字符），请缩小选择范围（上限 ${MAX_INPUT_CHARS}）`), { code: 'library/invalid' }))
    }
    const llm = extensions.llm
    if (!llm || typeof llm.prepareCall !== 'function') {
      return fail(Object.assign(new Error('当前 dsh 宿主没有可用的模型服务，无法翻译'), { code: 'library/no-llm' }))
    }
    const settings = getSettings().translate ?? {}
    const thinking = settings.thinking === true

    let route
    try {
      route = resolveRoute(extensions, settings)
    } catch (error) {
      return fail(error)
    }

    const abort = new AbortController()
    const onAbort = () => abort.abort(new Error('client cancelled'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const encoder = new TextEncoder()
    const readStream = new ReadableStream({
      async start(controller) {
        const send = (event) => {
          try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) } catch { /* already closed */ }
        }
        try {
          const call = await llm.prepareCall(
            { provider: route.provider, model: route.model, maxTokens: thinking ? MAX_TOKENS_THINKING : MAX_TOKENS_PLAIN },
            abort.signal,
            configureControls(thinking),
          )
          const options = {
            ...call.config,
            messages: [userMessage(body)],
            system: SYSTEM_PROMPT,
            signal: abort.signal,
          }
          for await (const chunk of call.stream(options)) {
            if (chunk.type === 'reasoning-delta') send({ type: 'thinking', text: chunk.text })
            else if (chunk.type === 'text-delta') send({ type: 'answer', text: chunk.text })
            else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
              throw new Error(chunk.reason?.failure?.message ?? '模型调用失败')
            }
          }
          send({ type: 'done' })
        } catch (error) {
          if (!abort.signal.aborted) send({ type: 'error', message: String(error?.message ?? error) })
        } finally {
          signal?.removeEventListener('abort', onAbort)
          try { controller.close() } catch { /* already closed */ }
        }
      },
      cancel() {
        abort.abort(new Error('client cancelled'))
        signal?.removeEventListener('abort', onAbort)
      },
    })
    return new Response(readStream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  return { listModels, stream }
}
