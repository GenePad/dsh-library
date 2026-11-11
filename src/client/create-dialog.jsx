// Dialogs for the library page.
import * as React from 'react'
import * as api from './api.js'
import { Button } from './platform.jsx'
import { CloseIcon } from './icons.jsx'

/** Create or rename a collection. */
export function CollectionDialog({ open, mode, target, collections, onClose, onDone, onError }) {
  const [name, setName] = React.useState('')
  const [parentID, setParentID] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    if (!open) return
    setName(mode === 'rename' ? (target?.name ?? '') : '')
    setParentID('')
    setMessage('')
  }, [open, mode, target])

  if (!open) return null

  const submit = async () => {
    if (name.trim() === '') {
      setMessage('请输入分类名称。')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      if (mode === 'rename') await api.call('collection-rename', { id: target.id, name: name.trim() })
      else await api.call('collection-create', { name: name.trim(), parentID: parentID === '' ? null : Number(parentID) })
      onDone?.()
    } catch (error) {
      // 本地留一句提示；schema 类错误同时经 onError 让整页切到修复面板。
      setMessage(error?.message ?? String(error))
      onError?.(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lib-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.() }}>
      <div className="lib-modal" style={{ width: 'min(420px, 100%)' }}>
        <div className="lib-modal-head">
          <span>{mode === 'rename' ? '重命名分类' : '新建分类'}</span>
          <Button variant="ghost" size="sm" onClick={onClose}><CloseIcon size={14} /></Button>
        </div>
        <div className="lib-modal-body">
          <div className="lib-form-row">
            <label>名称</label>
            <input
              autoFocus
              value={name}
              onChange={event => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
            />
          </div>
          {mode !== 'rename' ? (
            <div className="lib-form-row">
              <label>父分类</label>
              <select value={parentID} onChange={(event) => setParentID(event.target.value)}>
                <option value="">（顶层）</option>
                {(collections ?? []).map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </div>
          ) : null}
          {message ? <div className="lib-form-hint" style={{ color: 'var(--lib-text)' }}>{message}</div> : null}
        </div>
        <div className="lib-modal-foot">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={submit}>{busy ? '处理中…' : '确定'}</Button>
        </div>
      </div>
    </div>
  )
}
