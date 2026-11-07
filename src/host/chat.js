// The library chat: one long-lived dsh session in a dedicated workspace.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Directory the library workspace lives in. */
export function workspaceDir(home) {
  return path.join(home, 'workspace')
}

/** Ensure the Library workspace exists and return its id. */
export async function ensureWorkspace(ctx, home) {
  fs.mkdirSync(workspaceDir(home), { recursive: true })
  const registry = ctx.workspaceRegistry
  const known = await registry.resolveByPath(workspaceDir(home))
  if (known) return known.id
  const created = await registry.create(workspaceDir(home), 'Library')
  return created.id
}

/** The standard preset, when the deployment composes one (PTC presets hide native tools). */
async function presetName(ctx) {
  const presets = ctx.get?.('agentPresets')
  if (presets === undefined) return undefined
  try {
    const list = await presets.list()
    return list.some(preset => preset.id === 'standard' && preset.broken === undefined) ? 'standard' : undefined
  } catch {
    return undefined
  }
}

/**
 * Reuse the stored chat session, or create a new one in the Library workspace.
 * @param {object} ctx - host context.
 * @param {string} home - plugin data directory.
 * @param {object} state - runtime state (mutated with the session id).
 * @param {{fresh?:boolean, logger?:object}} [options]
 */
export async function ensureSession(ctx, home, state, options = {}) {
  const logger = options.logger ?? console
  if (state.chatSessionId && options.fresh !== true) {
    const resolved = await ctx.sessionController.resolveAgent(state.chatSessionId).catch(() => undefined)
    if (resolved && !('error' in resolved)) return state.chatSessionId
  }
  if (state.chatSessionId && options.fresh === true) {
    try {
      await ctx.workspaceRegistry.archiveSession(state.chatSessionId)
    } catch (error) {
      logger.warn?.(`library: could not archive the previous chat session: ${error?.message ?? error}`)
    }
  }
  const workspaceId = await ensureWorkspace(ctx, home)
  const preset = await presetName(ctx)
  const { sessionId } = await ctx.sessionController.create({
    workspaceId,
    ...(preset === undefined ? {} : { agentPreset: preset }),
  })
  state.chatSessionId = sessionId
  const resolved = await ctx.sessionController.resolveAgent(sessionId).catch(() => undefined)
  if (resolved && !('error' in resolved)) {
    try {
      await ctx.sessionTitle.rename(resolved.agent.session, 'Library assistant')
    } catch {
      // A title is cosmetic; a renamed failure must not block the chat.
    }
  }
  return sessionId
}

/**
 * Build the library-guidance text injected into the chat session's SYSTEM
 * prompt (never into the user message — the dock user must not see it).
 * The section provider runs on every model step and reads `state.chatContext`
 * (the latest dock context), so the selected/open item stays current.
 * @param {object} [context] - {mode:'list'|'item'|'reader', itemKey, itemTitle}
 *   `list` may still carry itemKey/itemTitle when an item is merely selected in
 *   the list (not opened in a reader); the guidance must then stay neutral.
 * @returns {string} guidance text (may be a neutral list view when no context).
 */
export function chatGuidance(context) {
  if (!context || typeof context !== 'object') context = {}
  const mode = ['list', 'item', 'reader'].includes(context.mode) ? context.mode : 'list'
  const title = String(context.itemTitle ?? '').slice(0, 200).replace(/\s+/g, ' ').trim()
  const key = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(String(context.itemKey ?? '')) ? String(context.itemKey) : ''
  const lines = [
    '「文献助手·上下文」',
    '- 回答文献问题优先使用 library_search / library_item 工具，从标题、摘要（abstractNote）、标签等元数据中提取信息，不要一上来就阅读全文。',
    '- 只有当用户明确要求读原文，或问题明显需要全文细节（具体数值、图表、某页内容、方法细节）时才使用 library_read，并优先用它的 search 参数检索定位，而不是从头通读。',
  ]
  if (mode === 'reader' && (title || key)) {
    lines.push(`- 当前已在内置阅读器中打开文献《${title}》${key ? `（key: ${key}）` : ''}，用户的问题大概率与这篇文献的内容相关。`)
    lines.push('- 但如果问题明显是在找别的文献（例如「找一篇 xx 的文章」），请改用 library_search 检索文库，不要硬套当前文献。')
  } else if (mode === 'item' && (title || key)) {
    lines.push(`- 当前正在查看文献${title ? `《${title}》` : ''}${key ? `（key: ${key}）` : ''}的详情，用户的问题大概率与这篇文献相关；但若问题明显是在找别的文献，请改用 library_search 检索文库。`)
  } else if (mode === 'list' && (title || key)) {
    lines.push(`- 当前处于文库列表界面${title ? `，列表中选中的文献是《${title}》${key ? `（key: ${key}）` : ''}` : ''}。用户可能需要查找文献，也可能询问某篇文献（包括选中的这篇）的相关问题——先根据问题措辞判断意图，不要默认问题与选中的文献相关。`)
  } else {
    lines.push('- 当前处于文库列表界面。用户可能需要查找文献，也可能询问某篇文献的相关问题——先根据问题措辞判断意图。')
  }
  lines.push('- 检索类问题：先用 library_search 查询；若无结果，换关键词变体重试（同义词、英文拼写、单复数、可能的手误，如 capx→capsid），每次失败都换新变体，不要用同一关键词反复重试；各类变体都找不到时如实告知，并列出库里最接近的条目供参考。')
  return `${lines.join('\n')}\n`
}

/** Send a user message into the library session. */
export async function sendMessage(ctx, home, state, text, context) {
  const value = String(text ?? '').trim()
  if (value === '') throw Object.assign(new Error('Nothing to send'), { code: 'library/invalid' })
  const sessionId = await ensureSession(ctx, home, state)
  // Record the dock context for the system-prompt guidance section (the
  // section provider reads this on every model step). Never touch the message.
  state.chatContext = {
    mode: context?.mode ?? 'list',
    itemKey: context?.itemKey,
    itemTitle: context?.itemTitle,
  }
  await ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: value }],
  }, AbortSignal.timeout(30_000))
  return { sessionId }
}

/** Stop the running turn, if any. */
export async function stopTurn(ctx, home, state) {
  const sessionId = await ensureSession(ctx, home, state)
  const resolved = await ctx.sessionController.resolveAgent(sessionId).catch(() => undefined)
  if (resolved && !('error' in resolved)) resolved.agent.cancel({ kind: 'user' })
  return { sessionId, stopped: true }
}

/** Extract plain text from message content blocks. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** One-line tool result summary. */
function toolSummary(message) {
  const text = textOf(message?.content)
  if (text !== '') return text.replace(/\s+/g, ' ').slice(0, 400)
  if (message?.isError === true) return 'failed'
  return 'done'
}

/** Convert session events into the dock's message list. */
export function normalizePage(records) {
  const messages = []
  const calls = new Map()
  for (const record of records) {
    const event = record?.event
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'user/message') {
      const text = textOf(event.data?.content)
      if (text === '') continue
      const source = event.data?.source
      if (source?.kind !== undefined && source.kind !== 'user') continue
      messages.push({ role: 'user', text, seq: event.seq, time: event.time })
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text === '') continue
      messages.push({
        role: 'assistant',
        text,
        seq: event.seq,
        time: event.time,
        turn: event.data?.turn,
        interrupted: event.data?.interrupted === true,
      })
    } else if (event.type === 'tool/call') {
      const entry = {
        role: 'tool',
        name: String(event.data?.name ?? 'tool'),
        callId: String(event.data?.callId ?? ''),
        args: String(event.data?.arguments ?? '').slice(0, 600),
        status: 'running',
        seq: event.seq,
        time: event.time,
      }
      calls.set(entry.callId, entry)
      messages.push(entry)
    } else if (event.type === 'tool/result') {
      const callId = String(event.data?.message?.toolCallId ?? '')
      const entry = calls.get(callId)
      if (entry) {
        entry.status = event.data?.message?.isError === true ? 'error' : 'done'
        entry.result = toolSummary(event.data?.message)
        entry.resultSeq = event.seq
      } else {
        messages.push({
          role: 'tool',
          name: 'tool',
          callId,
          status: event.data?.message?.isError === true ? 'error' : 'done',
          result: toolSummary(event.data?.message),
          seq: event.seq,
          time: event.time,
        })
      }
    }
  }
  return messages
}

/**
 * Read the library chat transcript.
 * @param {object} ctx
 * @param {string} home
 * @param {object} state
 * @param {object} [options]
 * @param {number} [options.beforeSeq]
 * @param {number} [options.maxMessages]
 */
export async function readPage(ctx, home, state, options = {}) {
  const sessionId = await ensureSession(ctx, home, state)
  const resolved = await ctx.sessionController.resolveAgent(sessionId).catch(() => undefined)
  const agent = resolved && !('error' in resolved) ? resolved.agent : undefined
  const running = agent?.status === 'running'
  const seq = agent ? Number(agent.session.seq) : undefined
  const page = await ctx.sessionController.page({
    address: { kind: 'session', sessionId },
    ...(agent ? { throughSeq: Number(agent.session.seq) - 1 } : {}),
    ...(Number.isInteger(options.beforeSeq) ? { beforeSeq: options.beforeSeq } : {}),
    maxMessages: Number.isInteger(options.maxMessages) ? Math.min(Math.max(options.maxMessages, 20), 500) : 200,
  }, AbortSignal.timeout(30_000))
  const messages = normalizePage(page.records ?? [])
  const firstSeq = page.records?.[0]?.event?.seq
  return {
    sessionId,
    running,
    seq,
    hasMore: page.hasMore === true,
    beforeSeq: Number.isInteger(firstSeq) ? firstSeq : undefined,
    messages,
  }
}
