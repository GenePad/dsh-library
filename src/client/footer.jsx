import * as React from 'react'
import { useDarkMode, useSource } from './util.js'
import { LibraryIcon } from './icons.jsx'

/** The sidebar-foot entry that opens and closes the library main panel. */
export function LibraryFooterEntry({ wide, layout }) {
  const dark = useDarkMode()
  const info = useSource(layout?.panelInfo)
  const active = info?.activePanelId === 'library'
  const toggle = () => {
    if (!layout) return
    try {
      layout.selectPanel(active ? null : 'library')
    } catch (error) {
      console.warn('[dsh-library] selectPanel failed', error)
    }
  }
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
