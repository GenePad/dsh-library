import * as React from 'react'
import { Button } from './platform.jsx'

/**
 * Zotero-style context menu for the item list. Menu entries are computed from
 * the selection's item kinds; every action funnels through onAction(action,
 * arg) handled by the page. The menu is fixed-positioned (viewport
 * coordinates) and clamped so it never leaves the screen.
 */
export function ItemContextMenu({ menu, rows, collections, view, onAction, onClose }) {
  const rootRef = React.useRef(null)
  const [pos, setPos] = React.useState({ left: menu.x, top: menu.y })
  const [openSub, setOpenSub] = React.useState('')

  React.useEffect(() => {
    const close = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) onClose()
    }
    const keyClose = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', keyClose)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', keyClose)
    }
  }, [onClose])

  // Clamp after first render: the menu must fit the viewport like Zotero's.
  React.useLayoutEffect(() => {
    const node = rootRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const width = rect.width || 220
    const height = rect.height || 300
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 6)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - height - 6)),
    })
  }, [menu.x, menu.y])

  const keys = menu.keys ?? []
  const info = rowInfos(rows, keys)
  const allRegular = info.length > 0 && info.every(row => isRegular(row))
  const standaloneAttachments = info.filter(row => row.itemType === 'attachment' && !row.hasParent)
  const hasCollections = (collections ?? []).length > 0

  const entries = []
  const push = (entry) => { entries.push(entry) }

  if (view.kind === 'trash') {
    push({ label: '还原到文库中', action: 'restore', disabled: keys.length === 0 })
    push({ label: '永久删除…', action: 'delete', danger: true, disabled: keys.length === 0 })
  } else {
    const openTarget = info.find(row => row.itemType === 'attachment' || row.hasAttachment || row.hasFile)
    push({ label: '打开附件', action: 'open', disabled: !openTarget })
    push({ label: '显示文件', action: 'open-native', disabled: !openTarget })
    push({ label: '显示文件所在文件夹', action: 'reveal', disabled: !openTarget })
    if (view.kind !== 'all' && keys.length === 1) {
      push({ sep: true })
      push({ label: '在文献库中显示', action: 'show-in-library' })
    }
    push({ sep: true })
    if (allRegular) {
      push({ label: '新建条目笔记', action: 'add-note' })
    }
    if (allRegular || standaloneAttachments.length === info.length) {
      push({ label: '通过批注添加笔记', action: 'note-from-annotations', disabled: keys.length !== 1 })
    }
    if (allRegular) {
      push({
        label: '添加附件',
        id: 'attach',
        children: [
          { label: '附件文件…', action: 'attach-file' },
          { label: '网页链接…', action: 'attach-url' },
        ],
      })
    }
    push({ sep: true })
    push({
      label: '添加到分类',
      id: 'add-to-collection',
      disabled: !hasCollections,
      children: hasCollections
        ? collections.map(node => ({ label: node.label.trim() || node.name, action: 'add-to-collection', arg: node.id }))
        : [],
    })
    if (view.kind === 'collection') {
      push({ label: '从分类中移除条目…', action: 'remove-from-collection' })
    }
    push({ sep: true })
    if (allRegular) {
      push({ label: '创建条目副本', action: 'duplicate' })
      push({ label: `合并条目…（${keys.length}）`, action: 'merge', disabled: keys.length < 2 })
    }
    if (standaloneAttachments.length > 0 && standaloneAttachments.length === info.length) {
      push({ label: '创建上级条目…', action: 'create-parent' })
      push({ label: '检索元数据', action: 'recognize' })
    }
    if (info.length === 1 && info[0].hasParent && info[0].itemType === 'attachment') {
      push({ label: '转换为独立附件', action: 'detach' })
    }
    push({ sep: true })
    push({ label: '复制 BibTeX 引用', action: 'copy-bibtex', disabled: keys.length === 0 })
    push({ label: '复制为 CSL JSON', action: 'copy-csl', disabled: keys.length === 0 })
    push({ sep: true })
    push({ label: '删除条目…', action: 'trash', danger: true, disabled: keys.length === 0 })
  }

  return (
    <div className="lib-ctxmenu" ref={rootRef} style={{ left: pos.left, top: pos.top }} role="menu">
        {entries.map((entry, index) => (entry.sep
          ? <div className="lib-ctx-sep" key={`sep${index}`} />
          : (
              <div
                key={entry.label}
                role="menuitem"
                className={`lib-ctx-item${entry.disabled ? ' disabled' : ''}${entry.danger ? ' danger' : ''}${openSub === entry.id ? ' open' : ''}`}
                onMouseOver={() => setOpenSub(entry.id ?? '')}
                onClick={(event) => {
                  event.stopPropagation()
                  if (entry.disabled) return
                  if (entry.children) {
                    // Clicking a submenu parent toggles it (hover opens it too,
                    // but a click is the reliable path for keyboard/touch).
                    setOpenSub(previous => (previous === entry.id ? '' : entry.id))
                    return
                  }
                  onAction(entry.action, entry.arg)
                }}
              >
                <span className="lib-ctx-label">{entry.label}</span>
                {entry.children ? <span className="lib-ctx-arrow">›</span> : null}
                {entry.children && openSub === entry.id && entry.children.length > 0 ? (
                  <div className="lib-ctx-sub">
                    {entry.children.map(child => (
                      <div
                        key={`${child.action}-${child.arg ?? ''}`}
                        role="menuitem"
                        className="lib-ctx-item"
                        onClick={(event) => {
                          event.stopPropagation()
                          onAction(child.action, child.arg)
                        }}
                      >
                        <span className="lib-ctx-label">{child.label}</span>
                      </div>
                    ))}
                    {entry.children.length === 0 ? <div className="lib-ctx-item disabled"><span className="lib-ctx-label">（无分类）</span></div> : null}
                  </div>
                ) : null}
              </div>
            )
        ))}
      </div>
  )
}

/** One row's kind info, resolved from the visible rows (parents and children). */
function rowInfos(rows, keys) {
  const byKey = new Map()
  for (const row of rows ?? []) {
    byKey.set(row.key, row)
    for (const child of row.children ?? []) byKey.set(child.key, { ...child, hasParent: true })
  }
  return keys.map(key => byKey.get(key)).filter(Boolean)
}

function isRegular(row) {
  return row.itemType !== 'attachment' && row.itemType !== 'note' && row.itemType !== 'annotation'
}

/**
 * Small input dialog for actions that need a string (添加网页链接). Electron
 * has no window.prompt, so the menu opens this instead.
 */
export function PromptDialog({ title, placeholder, confirmLabel, onConfirm, onClose }) {
  const [value, setValue] = React.useState('')
  const inputRef = React.useRef(null)
  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])
  return (
    <div className="lib-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="lib-modal" style={{ width: 420 }} role="dialog" aria-label={title}>
        <div className="lib-modal-head">{title}</div>
        <div className="lib-modal-body">
          <input
            ref={inputRef}
            className="lib-prompt-input"
            value={value}
            placeholder={placeholder}
            onChange={event => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value.trim() !== '') onConfirm(value.trim())
              if (event.key === 'Escape') onClose()
            }}
          />
        </div>
        <div className="lib-modal-foot">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={value.trim() === ''} onClick={() => onConfirm(value.trim())}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
