import * as React from 'react'
import * as api from './api.js'
import { ChatIcon, ChevronDown, ExternalIcon, PlusIcon } from './icons.jsx'

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
 * The "文献助手" dock. Clicking the bar opens a floating panel that renders the
 * NATIVE dsh conversation (the shared `conversation.content` Factory inside a
 * SessionProvider bound to the Library workspace session) — the transcript,
 * tool cards, and composer are all dsh's own components. A light poll only
 * feeds the running dot and the refresh-on-turn-end hook.
 */
export function ChatDock({ onLibraryChanged, openNativeSession, retainSession, SessionProvider, renderSlot, getContext, controller }) {
  const [open, setOpen] = React.useState(false)
  const [sessionId, setSessionId] = React.useState('')
  const [running, setRunning] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [reference, setReference] = React.useState(undefined)
  const runningRef = React.useRef(false)
  const contextRef = React.useRef(getContext)
  contextRef.current = getContext
  const changedRef = React.useRef(onLibraryChanged)
  changedRef.current = onLibraryChanged

  const show = (value) => {
    if (value?.sessionId) setSessionId(value.sessionId)
    setRunning(value?.running === true)
    // A turn that just finished may have changed the library.
    if (runningRef.current === true && value?.running !== true) changedRef.current?.()
    runningRef.current = value?.running === true
  }

  // Hold one SessionReference while the dock shows this session; the
  // SessionProvider scope (and therefore the embedded conversation) binds to it.
  React.useEffect(() => {
    if (!open || sessionId === '' || retainSession === undefined) return undefined
    const abort = new AbortController()
    const held = retainSession(sessionId, abort.signal)
    setReference(held)
    return () => {
      abort.abort()
      setReference(previous => (previous === held ? undefined : previous))
      held.release()
    }
  }, [open, sessionId, retainSession])

  const ensureSession = async (fresh) => {
    setError('')
    const value = await api.call('chat-open', fresh ? { fresh: true } : {})
    show(value)
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

  const openDock = async () => {
    if (busy) return
    setBusy(true)
    try {
      const id = await ensureSession(false)
      if (retainSession === undefined) {
        // No sessions service: fall back to handing over to the native view.
        if (openNativeSession) openNativeSession(id)
      } else {
        setOpen(true)
      }
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  const newChat = async () => {
    if (busy || running) return
    setBusy(true)
    try {
      await ensureSession(true)
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
  React.useImperativeHandle(controller, () => ({
    async open() {
      await openDock()
    },
    async openAndSend(text, context) {
      setError('')
      try {
        const id = await ensureSession(false)
        // The context preamble (list/item + abstract-first guidance) is
        // prepended host-side and only for messages sent from this dock.
        await api.call('chat-send', { text, context: context ?? contextRef.current?.() })
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
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) {
        api.call('chat-page', { maxMessages: 1 }).then(show).catch(() => {})
      }
    }, 1500)
    api.call('chat-page', { maxMessages: 1 }).then(show).catch(() => {})
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
            <span className="lib-chat-hint">{running ? '正在处理…' : 'Library 工作区 · 可读写当前文库'}</span>
            <span className="lib-chatdock-actions">
              {sessionId && openNativeSession ? (
                <button className="lib-iconbtn" title="在原生对话界面中打开" onClick={jumpNative}>
                  <ExternalIcon size={13} />
                </button>
              ) : null}
              <button className="lib-iconbtn" title="新对话" onClick={() => void newChat()} disabled={running}><PlusIcon size={14} /></button>
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
      <div className="lib-chatdock-bar" onClick={() => void openDock()} title="打开文献助手（原生对话）">
        <ChatIcon size={15} />
        <span className="lib-chat-title">文献助手</span>
        <span className={`lib-dot${running ? ' running' : ''}`} />
        <span className="lib-chat-hint">
          {busy ? '正在打开…' : running ? '正在处理…' : sessionId ? '在 Library 工作区中运行，可读写当前文库' : '可总结文献、检索、整理分类与标签'}
        </span>
        <span className="lib-chatdock-actions" onClick={event => event.stopPropagation()}>
          <button className="lib-iconbtn" title="新对话" onClick={() => void newChat()} disabled={busy || running}><PlusIcon size={14} /></button>
          <span style={{ display: 'inline-flex' }}>{open ? <ChevronDown size={13} /> : null}</span>
        </span>
      </div>
      {error ? <div className="lib-chatdock-error">{error}</div> : null}
    </div>
  )
}
