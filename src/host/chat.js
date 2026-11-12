// The library chat: one long-lived dsh session in a dedicated workspace.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_SOURCE_ROOT } from './plugin-root.js'

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

/** Whether the session id is some article's bound reader conversation. */
function isReaderBound(state, sessionId) {
  if (!sessionId) return false
  const bindings = state.itemBindings
  if (!bindings || typeof bindings !== 'object') return false
  return Object.values(bindings).includes(sessionId)
}

/**
 * Reuse the stored chat session, or create a new one in the Library workspace.
 * Opening a fresh conversation NEVER archives the previous one — every dock
 * conversation stays in the workspace (the user keeps the full history).
 * @param {object} ctx - host context.
 * @param {string} home - plugin data directory.
 * @param {object} state - runtime state (mutated with the session id).
 * @param {{fresh?:boolean, logger?:object}} [options]
 */
export async function ensureSession(ctx, home, state, options = {}) {
  if (state.chatSessionId && options.fresh !== true) {
    const resolved = await ctx.sessionController.resolveAgent(state.chatSessionId).catch(() => undefined)
    if (resolved && !('error' in resolved)) return state.chatSessionId
  }
  return createSession(ctx, home, state, { title: options.title, logger: options.logger ?? console })
}

/** Create a fresh session in the Library workspace and set it as current. */
async function createSession(ctx, home, state, { title, logger = console } = {}) {
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
      await ctx.sessionTitle.rename(resolved.agent.session, title ?? 'Library assistant')
    } catch {
      // A title is cosmetic; a renamed failure must not block the chat.
    }
  }
  return sessionId
}

/**
 * Open a session for the dock. Two modes mirror the dock's two entry points:
 * - `bindKey` (an article is open in the reader): the item keeps ONE bound
 *   conversation — it is reused on every open; `fresh` unbinds the old
 *   session (it stays in the workspace) and binds a new one instead.
 * - no `bindKey` (plain list view): every open starts a new conversation,
 *   like the toolbar's 新对话. The current session is only continued when the
 *   dock is already open on it (the AI-task hand-off) — and NEVER when it is
 *   a reader binding: a list open must not inherit the last-read paper's
 *   conversation. No open ever ARCHIVES the previous session — every
 *   conversation (list or reader-bound) stays in the workspace.
 * @param {object} ctx
 * @param {string} home
 * @param {object} state
 * @param {{fresh?:boolean, bindKey?:string, title?:string, logger?:object}} [options]
 */
export async function openSession(ctx, home, state, options = {}) {
  const logger = options.logger ?? console
  const bindKey = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(String(options.bindKey ?? ''))
    ? String(options.bindKey)
    : ''
  if (bindKey) {
    state.itemBindings = state.itemBindings && typeof state.itemBindings === 'object' ? state.itemBindings : {}
    const bound = options.fresh === true ? undefined : state.itemBindings[bindKey]
    if (bound) {
      const resolved = await ctx.sessionController.resolveAgent(bound).catch(() => undefined)
      if (resolved && !('error' in resolved)) {
        state.chatSessionId = bound
        return { sessionId: bound, created: false, bound: true }
      }
      // A dangling binding (session pruned) falls through to a fresh create.
    }
    const sessionId = await createSession(ctx, home, state, { title: options.title, logger })
    state.itemBindings[bindKey] = sessionId
    // Cap the binding map so state.json stays small.
    const keys = Object.keys(state.itemBindings)
    for (const stale of keys.slice(0, Math.max(0, keys.length - 200))) delete state.itemBindings[stale]
    return { sessionId, created: true, bound: true }
  }
  if (state.chatSessionId && options.fresh !== true && !isReaderBound(state, state.chatSessionId)) {
    // Plain open with the dock already on an unbound (list) conversation:
    // keep that conversation running.
    const sessionId = await ensureSession(ctx, home, state, { logger })
    return { sessionId, created: false, bound: false }
  }
  const sessionId = await ensureSession(ctx, home, state, { fresh: true, title: options.title, logger })
  return { sessionId, created: true, bound: false }
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
  const mode = ['list', 'item', 'reader', 'word'].includes(context.mode) ? context.mode : 'list'
  const title = String(context.itemTitle ?? '').slice(0, 200).replace(/\s+/g, ' ').trim()
  const key = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(String(context.itemKey ?? '')) ? String(context.itemKey) : ''
  const lines = [
    '「文献助手·上下文」',
    '- 回答文献问题优先使用 library_search / library_item 工具，从标题、摘要（abstractNote）、标签等元数据中提取信息，不要一上来就阅读全文。',
    '- 只有当用户明确要求读原文，或问题明显需要全文细节（具体数值、图表、某页内容、方法细节）时才使用 library_read，并优先用它的 search 参数检索定位，而不是从头通读。',
    '- 用户要求「入库/收录/添加文献」时：有文件用 library_import；只有 DOI/ISBN/arXiv/PMID 或题名时先用 library_lookup 检索元数据，再把检索结果（含作者/年份/期刊/摘要）报给用户确认后用 library_add 建条目，草稿里的全部字段（尤其摘要 abstractNote）必须原样写入，并把 shortTitle 写成中文 10~20 字的重点概括，再用 library_update 的 addCollections 归入分类。',
    '- 入库或更新元数据时同步维护两个字段（library_add / library_update 都适用）：**shortTitle = 中文 10~20 字概括这篇文章的重点**（写关注点/方法/结论要点，不是标题的中文翻译）；**abstractNote = 忠实的文献摘要**（优先检索/导入自带的原文摘要原样带入；缺失时可用 library_read 读全文提炼一段，拿不到就留空，绝不编造）。发现条目缺这两个字段时主动用 library_update 补上。',
    '- 整理分类时先 library_collections 看现有分类树，再建分类（library_collection 的 create）或把条目移入/移出（library_update）。',
    '- 用户要「写/生成一份 Word 报告/综述/文档」时：先用 library_search / library_read 收集文库资料，问清参考文献样式（未安装的样式用 library_cite_styles 检索安装），然后用 library_word_report 生成带真实引文与参考文献表的 .docx（不需要打开 Word）。引注写 [[N]]：N 对应本段 citations 里同 id 的条目，一个标记 = 一处引文（一段可多个、同一篇也可重复写同一 id）；编号与参考文献顺序由 CSL 样式按正文出现顺序自动算，正文里不要手写编号，citations 也不必按文献顺序排。',
    '- 操作「正在打开的 Word 文档」时（用户说「帮我改一下我打开的文档/在文档里加引注」等）：先用 library_word_list 拿到已打开文档的 docId（未保存的空白文档是文档名，如 文档1），用 library_word_search / library_word_read 定位（段号全局 1 起），用 library_word_write 改文本、library_word_cite 在指定段插入真实引注；写入前先读、写入后复读确认。读写操作会自动弹出并**保持**「DSH 正在工作」遮罩锁住 Word（防止用户中途改动文档），因此**完成全部 Word 操作后必须调用 library_word_busy action="end" 释放遮罩**，否则用户无法使用 Word。用户点终止会强制停止当前任务——用户随后要求继续时，重新执行操作即可（遮罩会重新弹出）。',
    `- 遇到插件本身暂时无法解决的报错（工具缺失、写回通道故障、服务不可用等）：先向用户说明原因，并询问是否允许你直接修改 dsh-zot-library 插件源码（${PLUGIN_SOURCE_ROOT}）来修复；用户允许后即可自行查看、修改源码，并通过插件管理器禁用→启用 dsh-zot-library bundle 重载后重试。`,
  ]
  if (mode === 'word') {
    lines.push('- 当前对话是一个来自 Microsoft Word 的 AI 写作任务（自动检索引文 / AI 修改选中文本）。严格按任务消息里的步骤执行；所有写回 Word 的操作一律通过 library_word_apply 工具完成，绝不要让用户手动复制粘贴回 Word。')
    lines.push('- library_word_apply 会等待 Word 端领取并应用写回；工具返回 ok 才算完成，报错时按错误信息修正参数重试。')
    return `${lines.join('\n')}\n`
  }
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
