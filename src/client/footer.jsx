import * as React from 'react'
import { useDarkMode, useSource } from './util.js'
import { LibraryIcon } from './icons.jsx'
import * as api from './api.js'

/**
 * The sidebar-foot entry that opens and closes the library main panel.
 *
 * It is always mounted, so it also carries the Word AI task watcher: when the
 * host reports a fresh task (Word's 自动检索引文 / AI修改 button), the library
 * panel is switched to — the dock (mounted with the panel) then adopts the
 * task's conversation on its own poll. The user asked to SEE dsh working.
 */
export function LibraryFooterEntry({ wide, layout }) {
  const dark = useDarkMode()
  const info = useSource(layout?.panelInfo)
  const active = info?.activePanelId === 'library'
  const toggle = () => {
    if (!layout) return
    try {
      layout.selectPanel(active ? null : 'library')
    } catch (error) {
      console.warn('[dsh-zot-library] selectPanel failed', error)
    }
  }
  const seenTaskRef = React.useRef('')

  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return
      api.call('office-ai-announce').then(({ task } = {}) => {
        if (!task?.id || task.id === seenTaskRef.current) return
        seenTaskRef.current = task.id
        try { layout?.selectPanel?.('library') } catch (error) { console.warn('[dsh-zot-library] selectPanel failed', error) }
      }).catch(() => {})
    }, 2500)
    return () => clearInterval(timer)
  }, [layout])

  return (
    <>
      <button
        type="button"
        className={`lib-footer-entry${active ? ' active' : ''}${dark ? ' lib-scope-dark' : ''}`}
        onClick={toggle}
        title={active ? '回到对话模式' : '打开文库'}
        aria-label={active ? '回到对话模式' : '打开文库'}
      >
        <LibraryIcon size={15} />
        {wide ? <span className="lib-footer-label">{active ? '回到对话模式' : '文库'}</span> : null}
      </button>
    </>
  )
}
