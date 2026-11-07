import * as React from 'react'
import { Button } from './platform.jsx'
import { CloseIcon, ExternalIcon, PdfIcon, PlusIcon } from './icons.jsx'
import {
  ANNOTATION_TYPE_LABELS, fieldLabel, formatDate, formatDateTime, itemTypeLabel,
} from './util.js'

const COMMON_FIELDS = [
  'title', 'abstractNote', 'date', 'publicationTitle', 'volume', 'issue', 'pages', 'DOI', 'url',
  'ISBN', 'ISSN', 'publisher', 'place', 'language', 'shortTitle', 'extra', 'conferenceName', 'university',
]

const NOTE_TAGS = /<[^>]+>/g
function noteText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(NOTE_TAGS, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function EditableField({ field, value, onSave, autoEdit = false }) {
  const [editing, setEditing] = React.useState(autoEdit)
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  const multiline = field === 'abstractNote' || field === 'extra' || String(value).length > 90
  const commit = () => {
    setEditing(false)
    if (draft !== value) onSave(draft)
  }
  if (editing) {
    return (
      <div className="lib-field">
        <span className="lib-field-label">{fieldLabel(field)}</span>
        {multiline
          ? (
              <textarea
                autoFocus
                value={draft}
                onChange={event => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') { setDraft(value); setEditing(false) }
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commit()
                }}
              />
            )
          : (
              <input
                autoFocus
                value={draft}
                onChange={event => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit()
                  if (event.key === 'Escape') { setDraft(value); setEditing(false) }
                }}
              />
            )}
      </div>
    )
  }
  return (
    <div className="lib-field" onClick={() => setEditing(true)} title="点击编辑" style={{ cursor: 'text' }}>
      <span className="lib-field-label">{fieldLabel(field)}</span>
      <span className={`lib-field-value${String(value ?? '') === '' ? ' empty' : ''}`}>{String(value ?? '') || '—'}</span>
    </div>
  )
}

/** Right pane: the selected item's record. */
export function DetailsPane({ detail, loading, collections, onUpdate, onOpen, onReveal }) {
  const [tab, setTab] = React.useState('info')
  const [tagDraft, setTagDraft] = React.useState('')
  const [addField, setAddField] = React.useState('')
  React.useEffect(() => {
    setTab('info')
    setTagDraft('')
    setAddField('')
  }, [detail?.key])

  if (loading && !detail) return <div className="lib-right"><div className="lib-empty">读取中…</div></div>
  if (!detail) {
    return (
      <div className="lib-right">
        <div className="lib-empty">选择一篇文献查看详情<br /><span className="lib-form-hint">双击列表标题即可打开 PDF</span></div>
      </div>
    )
  }

  const fields = detail.fields ?? []
  const fieldMap = new Map(fields.map(entry => [entry.field, entry.value]))
  const extraFields = COMMON_FIELDS.filter(name => !fieldMap.has(name))

  const saveField = (field, value) => onUpdate(detail.key, { fields: { [field]: value } })
  const addTag = () => {
    const name = tagDraft.trim()
    if (name === '') return
    const existing = detail.tags.map(tag => tag.name)
    if (!existing.includes(name)) onUpdate(detail.key, { tags: [...existing, name] })
    setTagDraft('')
  }
  const removeTag = (name) => onUpdate(detail.key, { tags: detail.tags.map(tag => tag.name).filter(tag => tag !== name) })
  const annotations = detail.annotations ?? []

  return (
    <div className="lib-right">
      <div className="lib-detail-head">
        <div className="lib-detail-title">{detail.title || '(无标题)'}</div>
        <div className="lib-detail-sub">
          <span className="lib-pill">{itemTypeLabel(detail.itemType)}</span>
          {detail.deleted ? <span className="lib-pill" style={{ color: 'var(--lib-danger)' }}>回收站</span> : null}
          <span>{detail.key}</span>
          <span>·</span>
          <span>修改于 {formatDateTime(detail.dateModified)}</span>
        </div>
      </div>

      <div className="lib-tabs">
        {[
          ['info', '信息'],
          ['attachments', `附件${detail.attachments.length ? ` ${detail.attachments.length}` : ''}`],
          ['annotations', `批注${annotations.length ? ` ${annotations.length}` : ''}`],
          ['notes', `笔记${detail.notes.length ? ` ${detail.notes.length}` : ''}`],
        ].map(([id, label]) => (
          <button key={id} className={`lib-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'info' ? (
        <>
          <div className="lib-fields">
            {fields.map(entry => (
              <EditableField key={entry.field} field={entry.field} value={entry.value} onSave={value => saveField(entry.field, value)} />
            ))}
            {extraFields.length > 0 ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 2px' }}>
                <select value={addField} onChange={(event) => setAddField(event.target.value)} style={{ height: 26, padding: '0 6px', fontSize: 12 }}>
                  <option value="">＋ 添加字段…</option>
                  {extraFields.map(name => <option key={name} value={name}>{fieldLabel(name)}</option>)}
                </select>
              </div>
            ) : null}
            {addField ? (
              <EditableField
                key={addField}
                field={addField}
                value=""
                autoEdit
                onSave={(value) => {
                  if (String(value).trim() !== '') saveField(addField, value)
                  setAddField('')
                }}
              />
            ) : null}
          </div>

          <div className="lib-subhead">作者</div>
          <div className="lib-creators">
            {(detail.creators ?? []).map((creator, index) => (
              <div className="lib-creator-row" key={`${creator.lastName}-${index}`}>
                <span>{creator.fieldMode === 1 ? creator.lastName : `${creator.lastName}${creator.firstName ? `, ${creator.firstName}` : ''}`}</span>
                {creator.creatorType && creator.creatorType !== 'author'
                  ? <span className="lib-role">{creator.creatorType}</span>
                  : null}
              </div>
            ))}
            {(detail.creators ?? []).length === 0 ? <span className="lib-form-hint">没有作者</span> : null}
          </div>

          <div className="lib-subhead">标签</div>
          <div className="lib-tag-edit">
            {(detail.tags ?? []).map(tag => (
              <span className="lib-tagchip" key={tag.name}>
                {tag.name}
                <button className="lib-tag-remove" title="移除标签" onClick={() => removeTag(tag.name)}><CloseIcon size={11} /></button>
              </span>
            ))}
            <input
              className="lib-tag-add"
              placeholder="+ 标签"
              value={tagDraft}
              onChange={event => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addTag()
                if (event.key === 'Escape') setTagDraft('')
              }}
            />
          </div>

          <div className="lib-subhead">分类</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
            {(detail.collections ?? []).map(entry => (
              <span className="lib-tagchip" key={entry.collectionID}>{entry.collectionName}</span>
            ))}
            <select
              value=""
              style={{ height: 24, fontSize: 11, padding: '0 4px' }}
              onChange={(event) => {
                const id = Number(event.target.value)
                if (Number.isInteger(id)) onUpdate(detail.key, { addCollections: [id] })
              }}
            >
              <option value="">＋ 加入分类…</option>
              {(collections ?? []).map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </div>
        </>
      ) : null}

      {tab === 'attachments' ? (
        <div>
          {(() => {
            const files = detail.attachment
              ? [{
                  key: detail.key,
                  title: String(detail.attachment.rawPath ?? '').replace(/^storage:/, ''),
                  size: undefined,
                }]
              : (detail.attachments ?? [])
            return (
              <>
                {files.map(attachment => (
                  <div className="lib-attachment" key={attachment.key}>
                    <PdfIcon size={15} />
                    <span className="lib-att-name" title={attachment.title}>{attachment.title}</span>
                    <span className="lib-att-size">{attachment.size ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : ''}</span>
                    <Button variant="ghost" size="sm" title="打开" onClick={() => onOpen(attachment.key)}><ExternalIcon size={13} /></Button>
                    <Button variant="ghost" size="sm" title="在文件夹中显示" onClick={() => onReveal(attachment.key)}>📁</Button>
                  </div>
                ))}
                {files.length === 0 ? <div className="lib-form-hint">没有附件。把 PDF 拖到中间的列表即可作为附件导入。</div> : null}
              </>
            )
          })()}
        </div>
      ) : null}

      {tab === 'annotations' ? (
        <div>
          {annotations.map(annotation => (
            <div className="lib-annotation" key={annotation.key} onDoubleClick={() => onOpen(annotation.parentKey)} title="双击打开 PDF">
              <span className="lib-anno-dot" style={{ background: annotation.color || '#ffd400' }} />
              <div className="lib-anno-body">
                <div className="lib-anno-text">{annotation.text || annotation.comment || '(无文字)'}</div>
                {annotation.comment && annotation.text ? <div className="lib-anno-comment">💬 {annotation.comment}</div> : null}
                <div className="lib-anno-meta">
                  第 {annotation.pageLabel || '?'} 页 · {ANNOTATION_TYPE_LABELS[annotation.type] ?? '批注'}
                  {annotation.parentKey ? ` · 附件 ${annotation.parentKey}` : ''}
                </div>
              </div>
            </div>
          ))}
          {annotations.length === 0 ? <div className="lib-form-hint">还没有批注。在系统阅读器中做的批注会在文件保存后自动导入。</div> : null}
        </div>
      ) : null}

      {tab === 'notes' ? (
        <div>
          {(detail.notes ?? []).map(note => (
            <div className="lib-subhead" key={note.key}>{note.title}</div>
          ))}
          {(detail.notes ?? []).map(note => (
            <div className="lib-note-html" key={`body-${note.key}`} style={{ marginBottom: 12 }}>{noteText(note.html)}</div>
          ))}
          {detail.note ? (
            <>
              <div className="lib-subhead">本条笔记</div>
              <div className="lib-note-html">{noteText(detail.note.html)}</div>
            </>
          ) : null}
          {(detail.notes ?? []).length === 0 && !detail.note ? <div className="lib-form-hint">没有笔记</div> : null}
        </div>
      ) : null}

      <div style={{ marginTop: 16, display: 'flex', gap: 6 }}>
        {(detail.attachment || detail.attachments?.[0]) ? (
          <>
            <Button variant="primary" size="sm" icon={<ExternalIcon size={13} />} onClick={() => onOpen(detail.attachment ? detail.key : detail.attachments[0].key)}>打开 PDF</Button>
            <Button variant="outline" size="sm" onClick={() => onReveal(detail.attachment ? detail.key : detail.attachments[0].key)}>在文件夹中显示</Button>
          </>
        ) : null}
      </div>
      <div className="lib-form-hint" style={{ marginTop: 8 }}>
        加入日期 {formatDate(detail.dateAdded)} · 版本 {detail.version}
      </div>
    </div>
  )
}
