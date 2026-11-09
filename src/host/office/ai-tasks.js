// Word-side AI tasks ("自动检索引文" / "AI 修改"): the bridge between a Word
// selection and a dsh 文献助手 conversation.
//
// Flow:
//   1. The Word template captures Selection.Range + its OWN process id and
//      POSTs /office/api/ai-start. Every task carries (docId, pid) so several
//      Word processes can never be mixed up: the apply transaction verifies
//      both, and the polling Word instance is the only one that ever receives
//      "ready".
//   2. The host focuses the dsh window, opens a FRESH 文献助手 conversation and
//      sends the task message (the agent then searches the library and finally
//      calls the library_word_apply agent tool).
//   3. The Word template polls /office/api/ai-poll on Application.OnTime (Word
//      stays usable). When the tool stores the write-back plan the poll flips
//      to "ready" and Word runs the applyAiEdit integration transaction, which
//      writes text + citation fields and finishes with the same inline full
//      refresh as the 刷新 command.
//   4. The agent tool blocks until the apply outcome arrives (or times out),
//   so the model sees the result and can retry / explain.
import { randomString } from './constants.js'
import { PLUGIN_SOURCE_ROOT } from '../plugin-root.js'

function sourceFixHint() {
  return `遇到暂时无法解决的报错（如写回通道、插件服务本身的问题）：先向用户说明原因，并询问是否允许你直接修改 dsh-zot-library 插件源码（${PLUGIN_SOURCE_ROOT}）来修复；用户允许后即可自行查看、修改源码并重载插件（禁用→启用 dsh-zot-library bundle）后重试。`
}

const TASK_TTL = 30 * 60_000
const KEEP_TTL = 2 * 60 * 60_000
const APPLY_WAIT = 150_000
// An apply that has not reported back for this long is treated as dead: Word
// lost the transaction (its instruction loop died, the window was closed), so
// the task must become re-armable instead of staying "applying" forever.
const APPLY_STUCK_AFTER = 2 * 60_000
const MAX_SELECTION = 30_000
const ANNOUNCE_TTL = 90_000
const KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/

/**
 * Validate and normalise a write-back plan produced by the agent.
 * @param {object} task - the stored task (its selection is the `after` corpus).
 * @param {object} plan - {mode:'replace'|'insert', text?, citations:[...]}.
 * @returns {{mode:string, text?:string, citations:Array}} normalised plan.
 */
export function normalizePlan(task, plan) {
  if (!plan || typeof plan !== 'object') throw new Error('缺少写回内容（plan）')
  const mode = plan.mode === 'insert' ? 'insert' : 'replace'
  const raw = Array.isArray(plan.citations) ? plan.citations : []
  if (raw.length === 0) throw new Error('citations 不能为空：至少引用一条文库条目')
  if (raw.length > 20) throw new Error('citations 过多（一次最多 20 条引文）')
  const citations = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw new Error('citations 每项必须是对象')
    const keys = (Array.isArray(entry.keys) ? entry.keys : [])
      .map(key => String(key ?? '').trim().toUpperCase())
      .filter(key => KEY_PATTERN.test(key))
    if (keys.length === 0) {
      throw new Error('每条引文必须给出至少一个有效的 8 位文库条目 key（来自 library_search / library_add）')
    }
    const citation = { keys }
    if (entry.locator !== undefined && String(entry.locator).trim() !== '') {
      citation.locator = String(entry.locator).trim().slice(0, 50)
    }
    if (entry.prefix !== undefined && String(entry.prefix).trim() !== '') {
      citation.prefix = String(entry.prefix).trim().slice(0, 100)
    }
    if (entry.suffix !== undefined && String(entry.suffix).trim() !== '') {
      citation.suffix = String(entry.suffix).trim().slice(0, 100)
    }
    if (mode === 'replace') {
      const id = Number(entry.id)
      if (!Number.isInteger(id) || id < 1 || id > 99) {
        throw new Error('replace 模式下每条引文需要数字 id（与 text 中 [[id]] 占位标记对应）')
      }
      citation.id = id
    } else {
      const after = String(entry.after ?? '')
      if (after.trim().length < 4) {
        throw new Error('insert 模式下每条引文需要 after：选中文本里一段足够独特的文字片段（引文插到它后面）')
      }
      if (!task.selection.includes(after)) {
        throw new Error(`after 片段在选中文本中找不到：「${after.slice(0, 40)}${after.length > 40 ? '…' : ''}」`)
      }
      citation.after = after
    }
    citations.push(citation)
  }
  if (mode === 'replace') {
    const text = String(plan.text ?? '')
    if (text.trim() === '') throw new Error('replace 模式下 text 不能为空')
    if (text.length > 30_000) throw new Error('text 超过 30000 字符，请分段处理')
    const markers = [...text.matchAll(/\[\[(\d{1,2})\]\]/g)].map(match => Number(match[1]))
    if (markers.length === 0) {
      throw new Error('text 中没有任何 [[N]] 引文占位标记：需要引文的位置写 [[1]]、[[2]]…，与 citations 的 id 对应')
    }
    const ids = new Set(citations.map(citation => citation.id))
    if (ids.size !== citations.length) throw new Error('citations 中存在重复的 id')
    for (const marker of markers) {
      if (!ids.has(marker)) throw new Error(`text 中有标记 [[${marker}]]，但 citations 里没有 id=${marker} 的条目`)
    }
    const used = new Set(markers)
    for (const citation of citations) {
      if (!used.has(citation.id)) throw new Error(`citations 中 id=${citation.id} 没有在 text 里使用`)
    }
    return { mode, text, citations }
  }
  return { mode, citations }
}

function taskBrief(task) {
  const quoted = task.selection.length > 3000
    ? `${task.selection.slice(0, 3000)}\n…（共 ${task.selection.length} 字符，已截断显示，写回时仍以完整原文为准）`
    : task.selection
  return `<selection>\n${quoted}\n</selection>`
}

function citeMessage(task) {
  return [
    `【Word 自动引文任务 ${task.id}】`,
    `来源文档：${task.docName}`,
    '下面是 Word 中选中的一段文本（这是写回目标，不要让用户重新粘贴）：',
    taskBrief(task),
    '',
    '处理步骤：',
    '1. 用 library_search 在本地文库检索能为这段论述提供文献支撑的条目——多用几组关键词变体（主题词、方法名、体系/物种、作者+年份；中英文都试）。',
    '2. 本地找不到合适文献时，先在对话里问用户是否联网检索；用户同意后用 library_lookup 的 query 参数（题名关键词）检索 Crossref，把候选列给用户确认，确认后用 library_add 入库拿到 8 位 key。',
    '3. 确定条目后调用 library_word_apply 写回 Word：',
    `   - taskId：${task.id}`,
    '   - 整段替换：mode="replace"，text 为整理/改写后的完整文本，在需要引注的位置写 [[N]]（N 与本条 citations 的 id 对应，标记先后与数组顺序都无所谓，程序按 id 匹配；同一处引文可放多个 key）；编号与参考文献顺序由 CSL 样式自动生成，正文里不要手写 [1][2] 这类编号；',
    '   - 或只在原文定点插入：mode="insert"，citations 每项的 after 填选中文本里一段足够独特的原文片段，引文将插到该片段之后，其余文字与格式原样保留。',
    '4. 写回成功后，用一两句话告诉用户引用了哪些文献、插在了什么位置；若工具报错，向用户说明原因并按错误提示修正后重试。',
    `5. ${sourceFixHint()}`,
  ].join('\n')
}

function editMessage(task) {
  return [
    `【Word AI 修改任务 ${task.id}】（仅文本修改）`,
    `来源文档：${task.docName}`,
    '下面是 Word 中选中的一段文本（这是修改与写回的目标，不要让用户重新粘贴）：',
    taskBrief(task),
    '',
    '第一步：先回复用户一句话——已收到选中文本，请用户直接在下方输入框写下修改要求（例如：更学术化、压缩到一半、改成英文、补充过渡句…）。在用户给出要求之前不要动笔修改。',
    '第二步：用户给出要求后，按其要求改写这段文本（只改这段；保持语言与学术风格；如需引用文献，先用 library_search 确认条目存在）。',
    `第三步：调用 library_word_apply 写回：taskId=${task.id}，mode="replace"，text 为改写后的完整文本，需要引注的位置用 [[1]]、[[2]] 占位，citations 每项 {id, keys, locator?, prefix?, suffix?}。`,
    `写回成功后向用户简述改动；工具报错则说明原因并修正重试。另外，${sourceFixHint()}`,
  ].join('\n')
}

/**
 * @param {object} deps
 * @param {{open:(options:object)=>Promise<{sessionId:string}>, send:(text:string, context?:object)=>Promise<{sessionId:string}>}} deps.chat
 *   runtime.chat (or a test double): opens a fresh Library session and prompts it.
 * @param {() => void} deps.focus - brings the dsh window to the foreground.
 * @param {{cslItem:(id:string)=>object|null}} [deps.items] - the library item
 *   provider. When present every citation key is verified in the LIBRARY
 *   before a plan is accepted, so unknown keys fail fast in the host instead
 *   of surfacing as an error dialog path inside the Word transaction.
 */
export function createAiTasks({ chat, focus, items, logger = console }) {
  const tasks = new Map()
  let announcement = null
  // Last time ANY Word instance polled us. Word polls every 2 s while a task is
  // armed; a long gap means the Word-side OnTime chain died (Word was busy,
  // the template got unloaded, ...) and the write-back will never be claimed
  // until the user touches Word again (the VBA watchdog re-arms on the next
  // WindowActivate / selection change). Logging the gap makes that diagnosable
  // instead of looking like a silent 150 s timeout.
  let lastPollAt = 0

  function expireStale() {
    const now = Date.now()
    for (const [id, task] of tasks) {
      if (now - task.createdAt > KEEP_TTL) {
        tasks.delete(id)
        continue
      }
      if ((task.status === 'pending' || task.status === 'ready') && now - task.createdAt > TASK_TTL) {
        task.status = 'expired'
        task.waiter?.({ ok: false, error: '任务超过 30 分钟未被 Word 领取，已过期' })
      }
    }
    if (announcement && now - announcement.at > ANNOUNCE_TTL) announcement = null
  }

  /**
   * Start a task: store it, focus dsh, open a fresh session, send the brief.
   * @returns {Promise<{ok:true, taskId:string, sessionId:string}|{ok:false, error:string}>}
   */
  async function start({ kind, docId, pid, hwnd, docName, text }) {
    expireStale()
    const theKind = kind === 'edit' ? 'edit' : 'cite'
    const selection = String(text ?? '')
    if (selection.trim() === '') return { ok: false, error: '选中的文本为空' }
    if (selection.length > MAX_SELECTION) return { ok: false, error: `选中文本过长（${selection.length} 字符，上限 ${MAX_SELECTION}）` }
    const thePid = Number(pid) || 0
    if (!thePid) return { ok: false, error: '缺少 Word 进程标识' }
    const theDocId = String(docId ?? '')
    if (theDocId === '') return { ok: false, error: '缺少文档标识' }
    // One pending task per Word process + document: a second click supersedes.
    for (const task of tasks.values()) {
      if (task.pid === thePid && task.docId === theDocId && (task.status === 'pending' || task.status === 'ready')) {
        task.status = 'expired'
        task.waiter?.({ ok: false, error: '用户在 Word 中重新发起了任务，旧任务已取消' })
      }
    }
    const task = {
      id: `AI${randomString(10)}`,
      kind: theKind,
      docId: theDocId,
      pid: thePid,
      hwnd: Number(hwnd) || 0,
      docName: String(docName ?? theDocId).slice(0, 200),
      selection,
      status: 'pending',
      plan: null,
      result: null,
      createdAt: Date.now(),
      waiter: null,
    }
    tasks.set(task.id, task)
    try { focus?.() } catch { /* focusing is best effort */ }
    let sessionId = ''
    try {
      const title = theKind === 'edit' ? 'Word AI 修改' : 'Word 自动引文'
      const opened = await chat.open({ fresh: true, title })
      sessionId = opened?.sessionId ?? ''
      announcement = { id: task.id, kind: theKind, docName: task.docName, sessionId, at: Date.now() }
      await chat.send(theKind === 'edit' ? editMessage(task) : citeMessage(task), { mode: 'word' })
    } catch (error) {
      task.status = 'failed'
      task.result = { ok: false, error: String(error?.message ?? error) }
      logger.warn?.(`library: word ai task ${task.id} could not be dispatched: ${task.result.error}`)
      return { ok: false, error: `无法派发任务到 dsh：${task.result.error}` }
    }
    logger.info?.(`library: word ai task ${task.id} (${theKind}) dispatched to session ${sessionId}`)
    return { ok: true, taskId: task.id, sessionId }
  }

  /** Poll from the Word template. */
  function poll({ taskId, pid, docId }) {
    expireStale()
    const now = Date.now()
    const gap = lastPollAt ? now - lastPollAt : 0
    lastPollAt = now
    const task = tasks.get(String(taskId ?? ''))
    if (!task) return { status: 'missing' }
    if (Number(pid) !== task.pid || String(docId ?? '') !== task.docId) return { status: 'mismatch' }
    if (gap > 15_000 && !task.stallLogged) {
      task.stallLogged = true
      logger.warn?.(`library: word ai task ${task.id} poll stalled for ${Math.round(gap / 1000)}s`
        + ' (Word-side OnTime loop stopped; it re-arms when the user touches Word)')
    }
    if (task.status === 'ready' || task.status === 'pending') task.stallLogged = false
    return { status: task.status }
  }

  /** Cancel from the Word side (document closed before the apply). */
  function cancel({ taskId, pid }) {
    const task = tasks.get(String(taskId ?? ''))
    if (!task || Number(pid) !== task.pid) return { ok: false }
    if (task.status === 'pending' || task.status === 'ready' || task.status === 'applying') {
      task.status = 'cancelled'
      task.result = { ok: false, error: 'Word 端已取消（文档可能已关闭）' }
      task.waiter?.(task.result)
    }
    return { ok: true }
  }

  /**
   * The agent tool: validate + store the plan, then WAIT for the Word-side
   * apply so the model sees the outcome. Resolves with {ok, ...}.
   */
  function submit(taskId, plan) {
    expireStale()
    const id = String(taskId ?? '')
    const reopen = plan?.reopen === true
    let task = tasks.get(id)
    if (!task) {
      if (!reopen) throw new Error(`任务 ${id} 不存在（可能已过期或写错 taskId）`)
      // The host restarted (plugin reload / dsh restart) while Word kept
      // waiting on this task: its registry entry is gone but the Word side is
      // still polling with its own (pid, docId). Rebuild the entry from the
      // values the caller read out of Word, so the SAME Word dialog claims it.
      const pid = Number(plan?.pid) || 0
      const docId = String(plan?.docId ?? '')
      if (!pid || docId === '') {
        throw new Error('任务已随插件重载丢失；要接管它需要提供 pid（Word 进程号）与 docId（文档完整路径）')
      }
      task = {
        id,
        kind: plan?.kind === 'edit' ? 'edit' : 'cite',
        docId,
        pid,
        hwnd: 0,
        docName: String(plan?.docName ?? docId).slice(0, 200),
        selection: '',
        status: 'pending',
        plan: null,
        result: null,
        createdAt: Date.now(),
        waiter: null,
      }
      tasks.set(id, task)
      logger.info?.(`library: word ai task ${id} adopted for reopen (pid ${pid})`)
    }
    if (task.status === 'applied' && !reopen) {
      throw new Error(`任务 ${task.id} 已被 Word 端成功写回，不能再重复写回（需要继续补插时传 reopen=true 并提供当前选区文本）`)
    }
    if (task.status === 'applying') {
      const runningFor = Date.now() - (task.applyingAt ?? task.createdAt)
      if (runningFor < APPLY_STUCK_AFTER) {
        throw new Error(`任务 ${task.id} 正在由 Word 端写回（已 ${Math.round(runningFor / 1000)} 秒），请等它结束再重试`)
      }
      task.status = 'failed'
      task.result = { ok: false, error: 'Word 端写回没有回报结果（Word 可能已失去响应）' }
      logger.warn?.(`library: word ai task ${task.id} stuck in applying for ${Math.round(runningFor / 1000)}s; re-arming`)
    }
    if (reopen) {
      const nextSelection = String(plan?.selection ?? '')
      if (nextSelection.trim() === '') {
        throw new Error('reopen 需要提供 selection：Word 中这段文字当前的完整内容（已含上一轮插入的引文）')
      }
      if (nextSelection.length > MAX_SELECTION) {
        throw new Error(`selection 过长（${nextSelection.length} 字符，上限 ${MAX_SELECTION}）`)
      }
      task.selection = nextSelection
      // The user may have restarted Word between rounds: the task must follow
      // the NEW process id, otherwise the Word side's polls no longer match.
      const nextPid = Number(plan?.pid) || 0
      if (nextPid) task.pid = nextPid
      const nextDocId = String(plan?.docId ?? '')
      if (nextDocId) task.docId = nextDocId
    }
    // failed / cancelled tasks are re-armable: the agent may retry after a
    // transient claim timeout (Word window closed, poll hiccup, ...). Each
    // re-submit revalidates the plan and restarts the 150 s claim window.
    if (task.status !== 'pending' && task.status !== 'ready') {
      task.status = 'pending'
      task.plan = null
      task.createdAt = Date.now()
      task.stallLogged = false
      logger.info?.(`library: word ai task ${task.id} re-armed from ${task.status} for retry`)
    }
    task.plan = normalizePlan(task, plan)
    // Fast-fail unknown keys IN THE HOST: with the items provider wired in,
    // a bad key never reaches the Word transaction (whose failure path used
    // to surface as an error the user had to dismiss).
    if (items) {
      for (const citation of task.plan.citations) {
        for (const key of citation.keys) {
          if (!items.cslItem(key)) {
            task.status = 'failed'
            task.result = { ok: false, error: `条目 ${key} 不在文库中，无法插入引文（先用 library_search / library_item 确认条目 key）` }
            throw new Error(task.result.error)
          }
        }
      }
    }
    task.status = 'ready'
    logger.info?.(`library: word ai task ${task.id} plan ready (${task.plan.mode}, ${task.plan.citations.length} citations)`)
    return new Promise(resolve => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        task.waiter = null
        resolve(value ?? { ok: false, error: '写回结果未知（Word 端没有回报状态，请查看文档内容后重试）' })
      }
      const timer = setTimeout(() => {
        if (task.status === 'ready' || task.status === 'pending') {
          // Stay armed on 'pending' instead of failing: the Word poll loop is
          // still waiting for this task, so a plain retry flips it back to
          // 'ready' and the SAME Word dialog applies it — no need to make the
          // user click the ribbon button again. 'failed' would make Word treat
          // the task as over (DshLibAiPoll clears its state) and retries would
          // then be claimed by nobody.
          task.status = 'pending'
          task.plan = null
          task.result = {
            ok: false,
            error: 'Word 端 150 秒内没有领取写回任务（任务仍在等待，可直接重试，无需在 Word 重新发起）。'
              + `若连续两次超时，多半是 Word 的轮询定时器停了：把焦点切回 ${task.docName}（或点一下文档正文）即可让 Word 重新接管。`,
          }
        } else if (task.status === 'applying') {
          // Word claimed the task but never reported an outcome: its apply
          // transaction died (a VBA dispatch error, the document was closed).
          // Never resolve with `undefined` (that surfaced as the useless
          // "任务已取消"); fail it with an actionable message and let the agent
          // re-arm the task, which also revalidates the selection.
          task.status = 'failed'
          task.result = {
            ok: false,
            error: `Word 端已开始写回，但 ${Math.round(APPLY_WAIT / 1000)} 秒内没有回报结果（Word 可能在执行中失去响应）。`
              + '请检查文档里是否已有部分写入（例如出现 {Citation} 占位符）；确认后可直接重试写回，写入前会重新校验选区。',
          }
        }
        finish(task.result)
      }, APPLY_WAIT)
      task.waiter = finish
      // Already applied/failed between validation and now? Impossible (single
      // status flip above), but a stale waiter must never dangle.
      if (task.status === 'applied' || task.status === 'failed' || task.status === 'cancelled') finish(task.result)
    })
  }

  /** Engine side: claim the task for the apply transaction (validates pid+doc). */
  function beginApply({ taskId, pid, docId }) {
    expireStale()
    const task = tasks.get(String(taskId ?? ''))
    if (!task) {
      throw Object.assign(new Error(`AI 任务 ${taskId ?? ''} 不存在或已过期`), { name: 'AlertError' })
    }
    if (task.pid !== Number(pid) || task.docId !== String(docId ?? '')) {
      throw Object.assign(
        new Error('AI 任务与当前 Word 文档/进程不匹配（同一任务只能写回发起它的那个 Word 进程中的文档）'),
        { name: 'AlertError' })
    }
    if (task.status !== 'ready') {
      throw Object.assign(new Error(`AI 任务 ${task.id} 状态是 ${task.status}，无法写回`), { name: 'AlertError' })
    }
    task.status = 'applying'
    task.applyingAt = Date.now()
    return task
  }

  /** Engine side: record the outcome and wake the waiting agent tool. */
  function finishApply(taskId, outcome) {
    const task = tasks.get(String(taskId ?? ''))
    if (!task || task.status !== 'applying') return
    task.status = outcome?.ok ? 'applied' : 'failed'
    task.result = outcome ?? { ok: false, error: 'unknown' }
    task.waiter?.(task.result)
  }

  /**
   * Engine side: the transaction could not even claim the task (unknown id,
   * pid/docId mismatch, ...). Fails a still-"ready" task so the waiting agent
   * tool wakes up instead of running out its own timeout.
   */
  function fail(taskId, error) {
    const task = tasks.get(String(taskId ?? ''))
    if (!task || task.status !== 'ready') return
    task.status = 'failed'
    task.result = { ok: false, error: String(error?.message ?? error) }
    task.waiter?.(task.result)
  }

  /** The client picks this up to open the dock on the task's session. */
  function currentAnnouncement() {
    expireStale()
    return announcement ? { ...announcement } : null
  }

  return { start, poll, cancel, submit, beginApply, finishApply, fail, currentAnnouncement, tasks }
}
