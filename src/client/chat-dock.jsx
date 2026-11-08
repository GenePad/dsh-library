import * as React from 'react'
import * as api from './api.js'
import { ChatIcon, ChevronDown, ExpandIcon, PlusIcon } from './icons.jsx'

/**
 * Fixed Chat selection for the embedded Conversation occurrence (same pattern
 * as ui-subagent's sidebar chat): the native conversation body is rendered by
 * the shared `conversation.content` Factory with its View pinned to Chat, so
 * the dock shows dsh's own transcript and composer — nothing self-drawn.
 */
export function FixedChatView(props) {
  return props.renderSlot('conversation.session', { view: 'chat' })
}

/**
 * The Library session's embedded Conversation host. Runs inside the
 * SessionProvider scope of the docked reference, so the Factory occurrence
 * inherits exactly this session; phases follow ui-subagent's embedded host.
 */
export function LibraryChatArea(props) {
  const { sessionId, useSession, useConversation, useSessions, renderSlot, renderFactorySlot } = props
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
    slots: { views: FixedChatView },
  })
}

/**
 * The "文献助手" dock. The bar toggles: clicking it when open collapses the
 * panel; clicking it when closed picks a session by context — a NEW
 * conversation in the plain list view, or the conversation BOUND to the
 * article currently open in the reader (created on first open, rebindable
 * through 新对话). The panel renders the NATIVE dsh conversation (the shared
 * `conversation.content` Factory inside a SessionProvider bound to the Library
 * workspace session) — transcript, tool cards and composer are dsh's own.
 */
export function ChatDock({ onLibraryChanged, openNativeSession, retainSession, SessionProvider, renderSlot, getContext, controller }) {
  const [open, setOpen] = React.useState(false)
  const [sessionId, setSessionId] = React.useState('')
  const [running, setRunning] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [reference, setReference] = React.useState(undefined)
  const runningRef = React.useRef(false)
  // How the displayed session was chosen: 'reader' = bound to the open
  // article, 'list' = a list-view conversation. The AI-task hand-off needs
  // this to tell "continue what the dock shows" from "still showing a reader
  // binding while the user is back on the list tab".
  const sessionModeRef = React.useRef('list')
  const contextRef = React.useRef(getContext)
  contextRef.current = getContext
  const changedRef = React.useRef(onLibraryChanged)
  changedRef.current = onLibraryChanged
  // Word AI tasks (自动检索引文 / AI修改) the dock has already adopted, so the
  // 1.5s poll below never re-adopts the same announcement.
  const seenWordTaskRef = React.useRef('')
  const [wordTask, setWordTask] = React.useState(null)

  const show = (value) => {
    if (value?.sessionId) setSessionId(value.sessionId)
    setRunning(value?.running === true)
    // A turn that just finished may have changed the library.
    if (runningRef.current === true && value?.running !== true) changedRef.current?.()
    runningRef.current = value?.running === true
  }

  // Hold one SessionReference while the dock shows this session; the
  // SessionProvider scope (and therefore the embedded conversation) binds to it.
  // sessions.retain THROWS synchronously while the client catalog has not yet
  // caught up with a session the host just created (and while the controller
  // recycles) — a throw escaping an effect resets the whole shell back to the
  // native conversation, so it is caught and retried here instead.
  React.useEffect(() => {
    if (!open || sessionId === '' || retainSession === undefined) return undefined
    let cancelled = false
    let retryTimer = 0
    let abort = undefined
    let held = undefined
    const acquire = (attempt) => {
      if (cancelled) return
      abort = new AbortController()
      try {
        held = retainSession(sessionId, abort.signal)
      } catch (error) {
        if (attempt < 6) {
          retryTimer = setTimeout(() => acquire(attempt + 1), 350)
          return
        }
        console.warn('[dsh-library] could not retain the dock session', error)
        return
      }
      setReference(held)
    }
    acquire(0)
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
      try { abort?.abort() } catch { /* already gone */ }
      setReference(previous => (previous === held ? undefined : previous))
      try { held?.release() } catch { /* already released */ }
    }
  }, [open, sessionId, retainSession])

  /**
   * Open a session host-side. Options: `{fresh}` starts a new conversation;
   * `{bindKey, title}` opens (or creates) the conversation bound to that
   * article; `{}` reuses the current session (the AI-fix handoff).
   */
  const ensureSession = async (options = {}) => {
    setError('')
    const value = await api.call('chat-open', options)
    show(value)
    sessionModeRef.current = options.bindKey ? 'reader' : 'list'
    return value.sessionId
  }

  const jumpNative = () => {
    if (!sessionId || !openNativeSession) return
    try {
      openNativeSession(sessionId)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }

  /**
   * Toggle the dock. Opening decides the session from the current view:
   * reader tab → the article's bound conversation (create if unbound);
   * plain list → a fresh conversation each time. The bar ONLY ever opens the
   * dock panel — it must never navigate to the native conversation (that is
   * what the dedicated 在原生对话界面中打开 button is for).
   */
  const toggleDock = async () => {
    if (open) {
      setOpen(false)
      return
    }
    if (busy) return
    setBusy(true)
    try {
      const context = contextRef.current?.() ?? { mode: 'list' }
      if (context.mode === 'reader' && context.itemKey) {
        await ensureSession({ bindKey: context.itemKey, title: context.itemTitle })
      } else {
        await ensureSession({ fresh: true })
      }
      setOpen(true)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 新对话: in the list view a fresh conversation; while an article is open
   * the old binding is dropped and a new session is bound to that article.
   */
  const newChat = async () => {
    if (busy || running) return
    setBusy(true)
    try {
      const context = contextRef.current?.() ?? { mode: 'list' }
      if (context.mode === 'reader' && context.itemKey) {
        await ensureSession({ fresh: true, bindKey: context.itemKey, title: context.itemTitle })
      } else {
        await ensureSession({ fresh: true })
      }
      setOpen(true)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  // Imperative handle so the page can hand a task to the assistant (e.g.
  // "complete this import's metadata with the agent"): the context preamble
  // is prepended host-side, then the docked native conversation takes over.
  // The session follows the CURRENT tab, mirroring the bar click: an article
  // on screen → its bound conversation; the list → a NEW conversation, unless
  // the dock is already open on a list conversation (the task then joins the
  // visible one). It must never continue the reader's session from the list.
  React.useImperativeHandle(controller, () => ({
    async open() {
      await toggleDock()
    },
    async openAndSend(text, context) {
      setError('')
      try {
        const chatContext = context ?? contextRef.current?.() ?? { mode: 'list' }
        let options = {}
        if (chatContext.mode === 'reader' && chatContext.itemKey) {
          options = { bindKey: chatContext.itemKey, title: chatContext.itemTitle }
        } else if (!(open && sessionModeRef.current === 'list')) {
          options = { fresh: true }
        }
        const id = await ensureSession(options)
        // The context preamble (list/item + abstract-first guidance) is
        // prepended host-side and only for messages sent from this dock.
        await api.call('chat-send', { text, context: chatContext })
        if (retainSession === undefined) {
          if (openNativeSession) openNativeSession(id)
        } else {
          setOpen(true)
        }
      } catch (failure) {
        setError(failure?.message ?? String(failure))
      }
    },
  }))

  // Light status poll for the running dot only; display is dsh's conversation.
  // The same tick watches for Word AI tasks: a fresh announcement switches the
  // dock to the task's conversation (the footer entry has meanwhile switched
  // the main panel to the library, so the user watches dsh work).
  React.useEffect(() => {
    const poll = () => {
      if (document.hidden) return
      api.call('chat-page', { maxMessages: 1 }).then(show).catch(() => {})
      api.call('office-ai-announce').then(({ task } = {}) => {
        if (!task?.id || task.id === seenWordTaskRef.current) return
        seenWordTaskRef.current = task.id
        if (task.sessionId) {
          sessionModeRef.current = 'list'
          setSessionId(task.sessionId)
          setOpen(true)
        }
        setWordTask(task)
      }).catch(() => {})
    }
    const timer = setInterval(poll, 1500)
    poll()
    return () => clearInterval(timer)
  }, [])

  const docked = retainSession !== undefined && SessionProvider !== undefined && renderSlot !== undefined

  return (
    <div className="lib-chatdock">
      {open && docked ? (
        <div className="lib-chatdock-panel">
          <div className="lib-chatdock-head">
            <ChatIcon size={14} />
            <span className="lib-chat-title">文献助手</span>
            <span className={`lib-dot${running ? ' running' : ''}`} />
            <span className="lib-chat-hint" title={wordTask ? `来自 Word：${wordTask.docName}` : undefined}>
              {wordTask ? `Word 任务 · ${wordTask.docName}` : running ? '正在处理…' : 'Library 工作区 · 可读写当前文库'}
            </span>
            <span className="lib-chatdock-actions">
              <button className="lib-newchat" title="开始一个新对话（阅读器打开文章时：解绑旧对话并绑定新对话）" onClick={() => void newChat()} disabled={running || busy}>
                <PlusIcon size={12} />
                <span>新对话</span>
              </button>
              {sessionId && openNativeSession ? (
                <button className="lib-iconbtn" title="在原生对话界面中打开" onClick={jumpNative}>
                  <ExpandIcon size={13} />
                </button>
              ) : null}
              <button className="lib-iconbtn" title="收起对话" onClick={() => setOpen(false)}><ChevronDown size={13} /></button>
            </span>
          </div>
          <div className="lib-chat-embed">
            {reference ? (
              <SessionProvider session={reference}>
                {renderSlot('library.chat.area', { sessionId })}
              </SessionProvider>
            ) : (
              <div className="lib-chat-empty">正在连接文献助手…</div>
            )}
          </div>
        </div>
      ) : null}
      <div className="lib-chatdock-bar" onClick={() => void toggleDock()} title={open ? '收起文献助手' : '打开文献助手（阅读器中打开文章时自动绑定到该文献）'}>
        <ChatIcon size={15} />
        <span className="lib-chat-title">文献助手</span>
        <span className={`lib-dot${running ? ' running' : ''}`} />
        <span className="lib-chat-hint">
          {busy ? '正在打开…' : running ? '正在处理…' : open ? '' : sessionId ? '点击收起或再开一个对话' : '点击开始新对话；阅读器中的文献会各自绑定一个对话'}
        </span>
        <span className="lib-chatdock-actions" onClick={event => event.stopPropagation()}>
          {open ? (
            <button type="button" className="lib-iconbtn" title="收起对话" onClick={() => setOpen(false)}>
              <ChevronDown size={13} />
            </button>
          ) : null}
        </span>
      </div>
      {error ? <div className="lib-chatdock-error">{error}</div> : null}
    </div>
  )
}
