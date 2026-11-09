// Word agent bridge: agent-initiated commands (read / write / search / mask)
// that a RUNNING Word instance executes through its always-on polling pump
// (DshLibAgent.bas in the installed template). Mirror image of ai-tasks.js:
// there the Word side initiates and the agent writes back; here the agent
// initiates and the Word side claims work from a queue.
//
// Flow:
//   1. An agent tool calls call({type, docId, args}) which enqueues a command.
//   2. Every running Word instance's pump POSTs /office/api/agent-poll with its
//      pid + open document list every ~2s (heartbeat). The first pump whose
//      heartbeat matches the command's docId claims it.
//   3. Word executes the command and POSTs /office/api/agent-result; the
//      waiting tool promise resolves.
//   4. The busy mask is a special long command (maskShow): Word opens a MODAL
//      form ("dsh 正在阅读/编辑文档" + 终止按钮) that blocks the Word UI. While
//      it is up the pump cannot run, so the form's WinAPI timer reenters VBA
//      and POSTs /office/api/agent-mask-state, which both delivers further
//      queued commands (so the agent can keep working "behind" the mask) and
//      carries close/update instructions. The 终止 button POSTs
//      /office/api/agent-mask stop, which fails every pending command for that
//      Word process AND cancels the dsh agent turn (onStop → agent.cancel).
import { randomString } from './constants.js'
import { execFile } from 'node:child_process'

const DEFAULT_OP_TIMEOUT = 30_000
const MASK_MAX_AGE = 10 * 60_000
// Word's tick loop is the only *pull* channel VBA offers (OnTime/WM_TIMER).
// A stalled tick must not instantly look like "document closed": give it a
// full polling period plus slack before declaring the instance gone.
const HEARTBEAT_TTL = 30_000
// COM nudge: when a command is queued but no pump is known to be alive, the
// host can call into Word (PowerShell + GetActiveObject) and run one tick,
// which also re-arms the pump timer. This is the *push* half of the channel;
// it is best-effort and deduped because spawning PowerShell is not free.
const NUDGE_DEDUPE = 3_000
// Safety net: a held mask releases itself after this much silence (no word
// command for its Word process) so a crashed / forgotten agent turn can never
// lock the user out of Word for good. Normal turns keep it alive by simply
// continuing to work; the explicit library_word_busy end closes it earlier.
const MASK_IDLE_RELEASE = 3 * 60_000

/**
 * @param {object} deps
 * @param {() => void} [deps.onStop] - called when the user hits 终止 in the
 *   Word mask: should cancel the dsh agent turn (force stop).
 * @param {object} [deps.logger]
 */
export function createWordAgent({ onStop, logger = console } = {}) {
  const heartbeats = new Map() // pid -> { docs: string[], at }
  const queue = [] // pending commands, FIFO
  const inflight = new Map() // id -> command (claimed by a pump, no result yet)
  let mask = null // { pid, text, startedAt, lastTouchedAt, stopRequested, closeRequested }
  // The dsh Agent handle of the tool call currently working on Word. The stop
  // button force-cancels that turn.
  let activeAgent = null
  // Outcome of the last closed mask (for status / e2e assertions).
  let lastMaskOutcome = null
  let lastNudgeAt = 0
  // Idle watchdog: releases a held mask whose agent turn went silent, so a
  // crashed / forgotten turn can never lock the user out of Word for good.
  const idleWatchdog = setInterval(() => {
    try {
      if (!mask || mask.stopRequested || mask.closeRequested) return
      if (Date.now() - (mask.lastTouchedAt ?? mask.startedAt) > MASK_IDLE_RELEASE) {
        logger.info?.('library: word mask idle-released (agent turn went silent)')
        endMask({ pid: mask.pid })
      }
    } catch { /* best effort */ }
  }, 15_000)
  idleWatchdog.unref?.()

  /** Reject a claimed command's outcome / helper used by call(). */
  function expire() {
    const now = Date.now()
    for (const [pid, beat] of heartbeats) {
      if (now - beat.at > 5 * 60_000) heartbeats.delete(pid)
    }
  }

  /**
   * Push half of the channel: ask Word (via COM) to run one agent tick, which
   * reports its open documents and re-arms the timer loop. Used when a tool is
   * called but no fresh heartbeat exists yet (Word just started, the tick
   * chain was dropped, or the plugin host was reloaded). Best effort and
   * deduped; GetActiveObject reaches ONE Word process (the most recently
   * registered), so multi-instance setups may need a retry.
   * @returns {Promise<{launched:boolean, wordFound:boolean|null}>} wordFound:
   *   true = Word exists (tick ran or was busy), false = COM found no Word,
   *   null = no probe this time (deduped / probe failed).
   */
  function nudge() {
    const now = Date.now()
    if (now - lastNudgeAt < NUDGE_DEDUPE) return Promise.resolve({ launched: false, wordFound: null })
    lastNudgeAt = now
    // Word rejects COM calls while busy (RPC_E_CALL_REJECTED); retry inside
    // PowerShell so one nudge survives a transient busy state. Exit codes:
    // 0 = tick ran, 3 = no Word.Application in the ROT, 2 = Word exists but
    // stayed busy for the whole retry window.
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$w=$null",
      "try{ $w=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') } catch { exit 3 }",
      "for($i=0;$i -lt 6;$i++){",
      "  try{ $w.Run('DshLibAgentTick'); exit 0 }",
      "  catch{ Start-Sleep -Milliseconds 700 }",
      "}",
      "exit 2",
    ].join('; ')
    return new Promise(resolve => {
      try {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
          { timeout: 25_000, windowsHide: true },
          error => {
            const code = error ? error.code : 0
            if (error && code !== 2 && code !== 3) {
              logger.warn?.(`library: word nudge failed: ${error.message}`)
            }
            resolve({ launched: true, wordFound: code === 3 ? false : code === 2 ? true : error ? null : true })
          })
      } catch (error) {
        logger.warn?.(`library: word nudge failed: ${error?.message ?? error}`)
        resolve({ launched: false, wordFound: null })
      }
    })
  }

  function failCommand(command, error) {
    clearTimeout(command.timer)
    if (command.waiter) {
      const waiter = command.waiter
      command.waiter = null
      waiter({ ok: false, error })
    }
  }

  function resolveCommand(command, value) {
    clearTimeout(command.timer)
    if (command.waiter) {
      const waiter = command.waiter
      command.waiter = null
      waiter(value)
    }
  }

  function matches(command, pid, docs) {
    if (command.pid && Number(command.pid) !== Number(pid)) return false
    if (command.docId) return (docs ?? []).some(doc => String(doc).toLowerCase() === String(command.docId).toLowerCase())
    return true
  }

  function claimCommands(pid, docs, limit = 8, excludeTypes = []) {
    const claimed = []
    for (let index = queue.length - 1; index >= 0 && claimed.length < limit; index -= 1) {
      const command = queue[index]
      if (excludeTypes.includes(command.type)) continue
      if (matches(command, pid, docs)) {
        queue.splice(index, 1)
        command.claimedBy = Number(pid)
        command.claimedAt = Date.now()
        inflight.set(command.id, command)
        // A claimed command proves the agent turn is still working on this
        // Word process: keep the held mask alive.
        if (mask && Number(mask.pid) === Number(pid)) mask.lastTouchedAt = Date.now()
        // The VBA ops read docId from inside args (the command envelope keeps
        // it at the top level for routing); merge it in here once.
        const args = { ...(command.args ?? {}) }
        if (command.docId) args.docId = command.docId
        claimed.unshift({ requestId: command.id, type: command.type, args })
      }
    }
    return claimed
  }

  /** Word pump heartbeat + command claim (unmasked path). */
  function poll({ pid, docs }) {
    const thePid = Number(pid) || 0
    if (!thePid) return { error: '缺少 pid' }
    const docList = Array.isArray(docs) ? docs.map(doc => String(doc)) : []
    heartbeats.set(thePid, { docs: docList, at: Date.now() })
    expire()
    // Always claim: the maskShow command itself arrives through this path
    // (the VBA side routes ticks to the mask-state poll once its popup is up,
    // so nothing double-claims behind the mask).
    return { commands: claimCommands(thePid, docList) }
  }

  /** Word command result (op finished or the held mask closed). */
  function result({ requestId, ok = true, value = null, error = null }) {
    const command = inflight.get(String(requestId ?? ''))
    if (!command) return { ok: false, error: '未知请求' }
    inflight.delete(command.id)
    if (command.type === 'maskShow') {
      if (mask && mask.commandId === command.id) mask = null
      lastMaskOutcome = ok ? { ok: true, value } : { ok: false, error }
    }
    resolveCommand(command, ok ? { ok: true, value } : { ok: false, error: String(error ?? 'Word 端执行失败') })
    return { ok: true }
  }

  /** A claimed command died without a result (Word closed mid-flight). */
  function reapDead() {
    const now = Date.now()
    for (const [id, command] of inflight) {
      if (command.type === 'maskShow') continue
      if (now - (command.claimedAt ?? command.createdAt) > 120_000) {
        inflight.delete(id)
        failCommand(command, 'Word 领取命令后没有回报结果（Word 可能已关闭或失去响应）')
      }
    }
  }

  /**
   * Enqueue one command and wait for the Word-side outcome.
   * @returns {Promise<{ok:true, value:object}|{ok:false, error:string}>}
   */
  function call({ type, docId = '', pid = 0, args = {}, timeoutMs = DEFAULT_OP_TIMEOUT, signal = null } = {}) {
    reapDead()
    const command = {
      id: `WD${randomString(10)}`,
      type: String(type ?? ''),
      docId: String(docId ?? ''),
      pid: Number(pid) || 0,
      args,
      createdAt: Date.now(),
      waiter: null,
      timer: null,
    }
    const promise = new Promise(resolve => {
      const finish = value => {
        clearTimeout(command.timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        command.waiter = null
        resolve(value)
      }
      const onAbort = () => {
        const index = queue.indexOf(command)
        if (index >= 0) queue.splice(index, 1)
        inflight.delete(command.id)
        if (command.type === 'maskShow' && mask && mask.commandId === command.id) mask = null
        finish({ ok: false, error: '任务已被终止' })
      }
      command.waiter = finish
      command.timer = setTimeout(() => {
        const index = queue.indexOf(command)
        if (index >= 0) queue.splice(index, 1)
        inflight.delete(command.id)
        if (command.type === 'maskShow' && mask && mask.commandId === command.id) mask = null
        finish({
          ok: false,
          error: command.type === 'maskShow'
            ? 'Word 端遮罩超时未关闭'
            : `Word 端 ${Math.round(timeoutMs / 1000)} 秒内没有执行该操作（文档可能未打开、模板未安装或 Word 正忙）`,
        })
      }, timeoutMs)
      if (signal) {
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      queue.push(command)
    })
    return promise
  }

  /** Modal mask state, polled by the form's WinAPI timer while Word is blocked. */
  function maskState({ pid }) {
    const thePid = Number(pid) || 0
    // While the popup is up the pump cannot run agent-poll, so THIS call is
    // the only liveness signal: refresh the heartbeat (keeping the known doc
    // list) or every tool would think the document vanished once the 15 s
    // heartbeat TTL expires mid-task.
    const known = heartbeats.get(thePid)
    if (thePid && known) heartbeats.set(thePid, { docs: known.docs, at: Date.now() })
    if (!mask || Number(mask.pid) !== thePid) return { close: true }
    const now = Date.now()
    const close = mask.stopRequested || mask.closeRequested === true || now - mask.startedAt > MASK_MAX_AGE
    const payload = { close, text: mask.text ?? '', stopped: mask.stopRequested === true }
    // While the modal form is up the pump is blocked inside Show, so queued
    // commands are delivered through this reentrant tick instead. maskShow
    // itself is executing the form — never deliver it back.
    payload.commands = claimCommands(thePid, heartbeats.get(thePid)?.docs ?? [], 8, ['maskShow'])
    if (close) {
      const command = inflight.get(mask.commandId)
      if (command) {
        inflight.delete(command.id)
        resolveCommand(command, { ok: true, value: { stopped: mask.stopRequested === true } })
      }
      mask = null
    }
    return payload
  }

  /** The 终止 button: stop everything for that Word process + cancel dsh. */
  function stop({ pid }) {
    const thePid = Number(pid) || 0
    if (mask && Number(mask.pid) === thePid) mask.stopRequested = true
    for (const command of [...queue]) {
      if (Number(command.pid) === thePid || matches(command, thePid, heartbeats.get(thePid)?.docs ?? [])) {
        const index = queue.indexOf(command)
        if (index >= 0) queue.splice(index, 1)
        failCommand(command, '用户已在 Word 中点击「终止」，任务已强制停止')
      }
    }
    for (const [id, command] of [...inflight]) {
      if (command.type !== 'maskShow' && Number(command.claimedBy) === thePid) {
        inflight.delete(id)
        failCommand(command, '用户已在 Word 中点击「终止」，任务已强制停止')
      }
    }
    try { onStop?.() } catch (error) { logger.warn?.(`library: word agent stop handler failed: ${error?.message ?? error}`) }
    return { ok: true }
  }

  /** Register the dsh Agent handle so 终止 can force-cancel the turn. */
  function setAgent(agent) { activeAgent = agent ?? null }
  function cancelActiveAgent() {
    const agent = activeAgent
    activeAgent = null
    if (agent) {
      try { agent.cancel({ kind: 'user' }) } catch (error) { logger.warn?.(`library: word agent cancel failed: ${error?.message ?? error}`) }
      return true
    }
    return false
  }

  function beginMask({ pid, docId = '', text = '', timeoutMs = 10 * 60_000, signal = null }) {
    mask = { pid: Number(pid) || 0, text: String(text ?? ''), startedAt: Date.now(), stopRequested: false, commandId: null }
    const promise = call({ type: 'maskShow', docId, pid, args: { text: String(text ?? '') }, timeoutMs, signal })
    // call() created a NEW command id; bind the mask to it so maskState/stop
    // can resolve the waiting tool when the form closes.
    const command = queue[queue.length - 1]
    if (command && command.type === 'maskShow') mask.commandId = command.id
    return promise
  }

  function updateMaskText(text) {
    if (mask) mask.text = String(text ?? mask.text ?? '')
  }

  /**
   * Session-scoped mask: the FIRST operation of a task opens the blocking
   * popup and it STAYS UP across every later operation (the user must not be
   * able to edit between our reads and writes). It comes down only through
   * library_word_busy end, the stop button, or the idle safety net. Returns
   * {held} — held=false means this call just opened it.
   */
  function ensureMask({ pid, docId = '', text = '', signal = null } = {}) {
    const thePid = Number(pid) || 0
    if (mask && Number(mask.pid) === thePid) {
      mask.lastTouchedAt = Date.now()
      updateMaskText(text)
      return { held: true }
    }
    if (mask) endMask({ pid: mask.pid }) // a different Word process takes over
    const promise = beginMask({ pid: thePid, docId, text, timeoutMs: 10 * 60_000, signal })
    void promise
    if (mask) mask.lastTouchedAt = Date.now()
    return { held: false }
  }

  /**
   * Close the mask held by a tool: if Word has already claimed the maskShow
   * command (form visible) ask the mask tick to close it; if the command is
   * still queued (Word has not polled yet) withdraw it so Word never opens a
   * mask nobody will close.
   */
  function endMask({ pid, signal = null } = {}) {
    const thePid = Number(pid) || 0
    const commandId = mask && Number(mask.pid) === thePid ? mask.commandId : null
    if (commandId) {
      const inflightCommand = inflight.get(commandId)
      if (inflightCommand) {
        mask.closeRequested = true
      } else {
        const index = queue.findIndex(command => command.id === commandId)
        if (index >= 0) {
          const [command] = queue.splice(index, 1)
          mask = null
          resolveCommand(command, { ok: true, value: { stopped: false } })
        }
      }
    }
    void signal
    return { ok: true }
  }

  /** Aggregated open-document view across every live Word instance. */
  function liveInstances() {
    expire()
    const now = Date.now()
    const list = []
    for (const [pid, beat] of heartbeats) {
      if (now - beat.at <= HEARTBEAT_TTL) list.push({ pid, docs: [...beat.docs] })
    }
    return list
  }

  function findPidForDoc(docId) {
    const wanted = String(docId ?? '').toLowerCase()
    for (const instance of liveInstances()) {
      if (instance.docs.some(doc => doc.toLowerCase() === wanted)) return instance.pid
    }
    return 0
  }

  function status() {
    return {
      instances: liveInstances(),
      queued: queue.length,
      inflight: inflight.size,
      mask: mask ? { pid: mask.pid, text: mask.text, ageMs: Date.now() - mask.startedAt, stopRequested: mask.stopRequested } : null,
      maskOutcome: lastMaskOutcome,
    }
  }

  function dispose() {
    clearInterval(idleWatchdog)
    for (const command of [...queue, ...inflight.values()]) {
      failCommand(command, '插件服务已停止')
    }
    queue.length = 0
    inflight.clear()
    heartbeats.clear()
    mask = null
  }

  return {
    call, poll, result, maskState, stop, beginMask, endMask, ensureMask, updateMaskText,
    setAgent, cancelActiveAgent, liveInstances, findPidForDoc, nudge, status, dispose,
  }
}
