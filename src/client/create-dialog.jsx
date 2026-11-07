import * as React from 'react'
import * as api from './api.js'
import { Button } from './platform.jsx'
import { CloseIcon } from './icons.jsx'

const CREATE_TYPES = [
  ['journalArticle', '期刊论文'],
  ['preprint', '预印本'],
  ['book', '图书'],
  ['bookSection', '图书章节'],
  ['conferencePaper', '会议论文'],
  ['thesis', '学位论文'],
  ['report', '报告'],
  ['webpage', '网页'],
  ['document', '文档'],
  ['note', '笔记'],
]

/** Parse one author line: "Last, First" or "First Last". */
function parseCreator(line) {
  const text = line.trim()
  if (text === '') return undefined
  if (text.includes(',')) {
    const [lastName, ...rest] = text.split(',')
    return { lastName: lastName.trim(), firstName: rest.join(',').trim(), creatorType: 'author' }
  }
  const parts = text.split(/\s+/)
  if (parts.length === 1) return { fieldMode: 1, lastName: text, creatorType: 'author' }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1), creatorType: 'author' }
}

/** Create one item by hand, with a metadata lookup shortcut. */
export function CreateItemDialog({ open, collections, defaultCollectionID, onClose, onCreated }) {
  const [form, setForm] = React.useState({
    itemType: 'journalArticle',
    title: '',
    authors: '',
    date: '',
    doi: '',
    abstract: '',
    collectionID: defaultCollectionID ? String(defaultCollectionID) : '',
  })
  const [identifier, setIdentifier] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    if (!open) return
    setForm({
      itemType: 'journalArticle',
      title: '',
      authors: '',
      date: '',
      doi: '',
      abstract: '',
      collectionID: defaultCollectionID ? String(defaultCollectionID) : '',
    })
    setIdentifier('')
    setMessage('')
  }, [open, defaultCollectionID])

  if (!open) return null

  const set = (key) => event => setForm(previous => ({ ...previous, [key]: event.target.value }))

  const lookup = async () => {
    if (identifier.trim() === '') return
    setBusy(true)
    setMessage('')
    try {
      const draft = await api.call('lookup', { identifier })
      if (!draft) {
        setMessage('没有找到匹配的元数据。')
      } else {
        setForm((previous) => ({
          ...previous,
          itemType: draft.itemType ?? previous.itemType,
          title: draft.fields?.title ?? previous.title,
          date: draft.fields?.date ?? previous.date,
          doi: draft.fields?.DOI ?? (identifier.trim().toLowerCase().startsWith('10.') ? identifier.trim() : previous.doi),
          abstract: draft.fields?.abstractNote ?? previous.abstract,
          authors: (draft.creators ?? []).map(creator => (creator.fieldMode === 1 ? creator.lastName : `${creator.lastName}, ${creator.firstName}`)).join('\n'),
        }))
        setMessage(`已补全（来源：${draft.source}）`)
      }
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (form.title.trim() === '') {
      setMessage('请填写标题。')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const creators = form.authors.split(/\r?\n/).map(parseCreator).filter(Boolean)
      const fields = { title: form.title.trim() }
      if (form.date.trim() !== '') fields.date = form.date.trim()
      if (form.doi.trim() !== '') fields.DOI = form.doi.trim()
      if (form.abstract.trim() !== '') fields.abstractNote = form.abstract.trim()
      const created = await api.call('create', {
        itemType: form.itemType,
        fields,
        creators,
        collectionIDs: form.collectionID === '' ? [] : [Number(form.collectionID)],
      })
      onCreated?.(created.key)
    } catch (error) {
      setMessage(error?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lib-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.() }}>
      <div className="lib-modal">
        <div className="lib-modal-head">
          <span>新建条目</span>
          <Button variant="ghost" size="sm" onClick={onClose}><CloseIcon size={14} /></Button>
        </div>
        <div className="lib-modal-body">
          <div className="lib-form-row">
            <label>按标识符补全（DOI / ISBN / arXiv）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1 }}
                value={identifier}
                placeholder="10.1002/glia.23254 或 arXiv:2401.01234"
                onChange={event => setIdentifier(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void lookup() }}
              />
              <Button variant="outline" size="sm" disabled={busy} onClick={lookup}>{busy ? '检索中…' : '检索'}</Button>
            </div>
          </div>
          <div className="lib-form-grid">
            <div className="lib-form-row">
              <label>条目类型</label>
              <select value={form.itemType} onChange={set('itemType')}>
                {CREATE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div className="lib-form-row">
              <label>日期</label>
              <input value={form.date} placeholder="2024 或 2024-05-01" onChange={set('date')} />
            </div>
          </div>
          <div className="lib-form-row">
            <label>标题</label>
            <input value={form.title} onChange={set('title')} />
          </div>
          <div className="lib-form-row">
            <label>作者（每行一个，格式：姓, 名）</label>
            <textarea value={form.authors} onChange={set('authors')} placeholder={'Zhang, San\nLi, Si'} />
          </div>
          <div className="lib-form-grid">
            <div className="lib-form-row">
              <label>DOI</label>
              <input value={form.doi} onChange={set('doi')} />
            </div>
            <div className="lib-form-row">
              <label>分类</label>
              <select value={form.collectionID} onChange={set('collectionID')}>
                <option value="">（不分类）</option>
                {(collections ?? []).map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </div>
          </div>
          <div className="lib-form-row">
            <label>摘要</label>
            <textarea value={form.abstract} onChange={set('abstract')} />
          </div>
          {message ? <div className="lib-form-hint" style={{ color: 'var(--lib-text)' }}>{message}</div> : null}
        </div>
        <div className="lib-modal-foot">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={submit}>{busy ? '创建中…' : '创建'}</Button>
        </div>
      </div>
    </div>
  )
}

/** Create or rename a collection. */
export function CollectionDialog({ open, mode, target, collections, onClose, onDone }) {
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
      setMessage(error?.message ?? String(error))
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
