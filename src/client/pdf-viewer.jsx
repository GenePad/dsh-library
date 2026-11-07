// 内置 PDF 查看器（pdf.js 引擎）：连续滚动页面列 + 缩放 + 跳页 + 旋转
// 当前页 + 全文查找 + 选择文本后添加高亮/下划线/批注（存 Zotero 批注行，
// 不改 PDF 文件本体）。
//
// pdf.js 以主线程模式运行：把 WorkerMessageHandler 挂到 `globalThis.pdfjsWorker`
// 后 pdf.js 不会创建 Worker（dsh 桌面壳禁 Blob Worker，跨进程 Worker 也没有
// 可靠的加载路径），解析与栅格化都在页面进程内完成，jsdom 冒烟因此也能解析。
//
// 坐标系约定见 pdf-util.js：批注与查找矩形的存储形态是 PDF 用户空间
// （itemAnnotations.position 的原语义），渲染时经页面矩阵（含每页 UI 旋转）
// 投回屏幕。文本层、覆盖层、选区三者共用同一矩阵，旋转后仍然对齐。
import * as React from 'react'
import { Button } from './platform.jsx'
import * as api from './api.js'
import { useDebounced } from './util.js'
import {
  SearchIcon, RotateLeftIcon, RotateRightIcon, HighlightIcon, UnderlineIcon,
  CopyIcon, CloseIcon,
} from './icons.jsx'
import * as pdfjsLib from 'pdfjs-dist'
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs'
import {
  makePageMatrix, rectToView, rectToPdf, mergeLineRects, buildTextSpans,
  createPageIndex, findMatches,
} from './pdf-util.js'

globalThis.pdfjsWorker = { WorkerMessageHandler }

const ZOOM_MIN = 0.25
const ZOOM_MAX = 5
const ZOOM_STEP = 1.1
const PAGE_GAP = 12
const PAGE_PAD = 12
const IO_MARGIN = '700px 0px'
// Zotero highlight palette.
const HIGHLIGHT_COLORS = [
  ['#ffd400', '黄色'], ['#ff6666', '红色'], ['#5fb236', '绿色'], ['#2ea8e5', '蓝色'],
  ['#a28ae5', '紫色'], ['#e56eee', '品红'], ['#f19837', '橙色'], ['#aaaaaa', '灰色'],
]
const ANNOTATION_TYPES = { highlight: 1, note: 2, underline: 5 }
const PAGE_DATA_CACHE = 24 // per-page text content LRU (selection + search share it)
const FIND_MATCH_CAP = 1000

/** Clamp a zoom factor, keeping percentages readable (two decimals). */
function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100))
}

/** Parse failure notes for the common cases, in the UI language. */
function loadErrorMessage(error) {
  const name = error?.name ?? ''
  if (name === 'PasswordException' || name === 'PasswordResponseException') return '该 PDF 已加密，内置查看器无法打开。'
  if (name === 'InvalidPDFException') return '文件不是有效的 PDF。'
  return String(error?.message ?? error)
}

/** Normalize raw PDF page info into unrotated dims + intrinsic rotation. */
function rawDimsOfViewport(viewport, rotate) {
  const rot = (((rotate % 360) + 360) % 360)
  return rot % 180 === 0
    ? { w: viewport.width, h: viewport.height, rot }
    : { w: viewport.height, h: viewport.width, rot }
}

/**
 * One rendered page box: exact-size placeholder; when near the viewport it
 * paints a canvas bitmap, builds the selectable text layer and renders the
 * annotation + find overlays. Each page observes itself, owns its render
 * task and repaints whenever its geometry (scale / rotation) changes.
 */
const PdfPageBox = React.memo(function PdfPageBox({
  doc, pageNumber, raw, scale, uiRotation, boxW, boxH, pageDataOf,
  annotations, findMarks, activeMark, activeAnnotationKey, onAnnoClick, onNotify,
}) {
  const hostRef = React.useRef(null)
  const canvasRef = React.useRef(null)
  const textRef = React.useRef(null)
  const proxyRef = React.useRef(null)
  // jsdom has no IntersectionObserver: mount eagerly (tests rely on it).
  const [nearby, setNearby] = React.useState(() => typeof IntersectionObserver !== 'function')
  const [painted, setPainted] = React.useState(false)
  const [proxyReady, setProxyReady] = React.useState(0)
  const totalRotation = (((((raw?.rot ?? 0) + uiRotation) % 360) + 360) % 360)

  React.useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return undefined
    const element = hostRef.current
    if (!element) return undefined
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) setNearby(entry.isIntersecting)
    }, { root: null, rootMargin: IO_MARGIN })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // A geometry change (zoom / rotation) invalidates the bitmap.
  React.useEffect(() => { setPainted(false) }, [boxW, boxH, totalRotation])

  // Load the page proxy once, on first proximity.
  React.useEffect(() => {
    if (!nearby || proxyRef.current) return undefined
    let cancelled = false
    doc.getPage(pageNumber).then((proxy) => {
      if (cancelled) return
      proxyRef.current = proxy
      setProxyReady(value => value + 1)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [nearby, doc, pageNumber])

  // Rasterize at the box's CSS size × devicePixelRatio (bitmap grows with the
  // box, not just a CSS stretch).
  React.useEffect(() => {
    if (!nearby || !proxyReady) return undefined
    let cancelled = false
    let task = null
    const run = async () => {
      try {
        const canvas = canvasRef.current
        const proxy = proxyRef.current
        if (!canvas || !proxy || cancelled) return
        const vp1 = proxy.getViewport({ scale: 1, rotation: totalRotation })
        const cssScale = boxW / vp1.width
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const viewport = proxy.getViewport({ scale: cssScale * dpr, rotation: totalRotation })
        const context = canvas.getContext('2d')
        if (!context || cancelled) return
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        task = proxy.render({ canvasContext: context, viewport })
        await task.promise
        if (!cancelled) setPainted(true)
      } catch (error) {
        if (error?.name !== 'RenderingCancelledException' && !/cancel/i.test(String(error?.message))) {
          onNotify?.(`第 ${pageNumber} 页渲染失败：${String(error?.message ?? error)}`)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
      try { task?.cancel() } catch { /* already settled */ }
    }
  }, [nearby, proxyReady, boxW, boxH, totalRotation, doc, pageNumber, onNotify])

  // Text layer: per-item transparent spans laid out through the page matrix —
  // rebuilt (from the shared cache) whenever scale or rotation moves. Pages
  // that scroll away release their spans; returning rebuilds them.
  React.useEffect(() => {
    if (!nearby) {
      const host = textRef.current
      if (host && typeof host.replaceChildren === 'function') host.replaceChildren()
      return undefined
    }
    let cancelled = false
    ;(async () => {
      try {
        const entry = await pageDataOf(pageNumber)
        const host = textRef.current
        if (cancelled || !host || !entry) return
        const matrix = makePageMatrix(raw?.w ?? 612, raw?.h ?? 792, scale, totalRotation)
        buildTextSpans(host, entry.items, entry.styles, matrix, scale)
      } catch {
        // A failed text layer only loses selection, not the rendering.
      }
    })()
    return () => { cancelled = true }
  }, [nearby, pageNumber, raw, scale, totalRotation, pageDataOf])

  const matrix = raw ? makePageMatrix(raw.w, raw.h, scale, totalRotation) : null

  return (
    <div
      className="lib-pdf-page"
      data-page={pageNumber}
      style={{ width: boxW, height: boxH }}
      ref={hostRef}
    >
      <canvas
        ref={canvasRef}
        style={{ width: boxW, height: boxH }}
      />
      <div className="lib-pdf-text" ref={textRef} />
      {matrix ? (annotations ?? []).map(annotation => (annotation.position?.rects ?? []).map((rect, index) => {
        const box = rectToView(matrix, rect)
        const width = Math.max(1, box[2] - box[0])
        const height = Math.max(1, box[3] - box[1])
        // Interaction splits from visuals: the full rect keeps the highlight
        // look but is pointer-transparent, and only the bottom strip catches
        // the mouse (hand cursor → popup). Over the upper part the I-beam
        // reaches the text layer, so the highlighted text stays selectable.
        const hitHeight = Math.min(height, Math.max(8, height * 0.45))
        return (
          <React.Fragment key={`${annotation.key}:${index}`}>
            <div
              className="lib-pdf-anno-hit"
              style={{ left: box[0], top: box[1] + height - hitHeight, width, height: hitHeight }}
              title={annotation.comment || ''}
              onClick={(event) => {
                event.stopPropagation()
                onAnnoClick?.(annotation, { left: box[0], top: box[1], width, height }, event.currentTarget.closest('.lib-pdf-page'))
              }}
            />
            <div
              data-anno-key={annotation.key}
              className={`lib-pdf-anno type-${annotation.type}${annotation.key === activeAnnotationKey ? ' active' : ''}`}
              style={{
                left: box[0], top: box[1], width, height,
                ...(annotation.type === 5 ? { borderBottomColor: annotation.color } : { backgroundColor: annotation.color }),
              }}
            />
          </React.Fragment>
        )
      })) : null}
      {matrix ? (findMarks ?? []).map(({ match, idx }) => (match.rects ?? []).map((rect, index) => {
        const box = rectToView(matrix, rect)
        return (
          <div
            key={`m${idx}:${index}`}
            className={`lib-pdf-mark${idx === activeMark ? ' active' : ''}`}
            style={{ left: box[0], top: box[1], width: Math.max(1, box[2] - box[0]), height: Math.max(1, box[3] - box[1]) }}
          />
        )
      })) : null}
      {!painted ? <span className="lib-pdf-skel">{pageNumber}</span> : null}
    </div>
  )
})

/** The find bar: debounced query + match navigation. */
function FindBar({ find, onSearch, onGo, onClose }) {
  const inputRef = React.useRef(null)
  const [value, setValue] = React.useState(find?.query ?? '')
  const debounced = useDebounced(value, 250)
  React.useEffect(() => { inputRef.current?.focus?.() }, [])
  React.useEffect(() => { onSearch(debounced) }, [debounced, onSearch])
  const status = find?.searching && value.trim() !== ''
    ? '正在搜索…'
    : value.trim() === '' ? '' : find && find.matches.length > 0
      ? `${(find.current ?? 0) + 1} / ${find.matches.length}`
      : '无结果'
  return (
    <div className="lib-rdr-findbar">
      <SearchIcon size={13} />
      <input
        ref={inputRef}
        value={value}
        placeholder="在文档中查找…"
        onChange={event => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onGo(event.shiftKey ? -1 : 1)
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <span className="lib-rdr-find-status">{status}</span>
      <button className="lib-rdr-btn" title="上一处" disabled={!find || find.matches.length === 0} onClick={() => onGo(-1)}>▲</button>
      <button className="lib-rdr-btn" title="下一处" disabled={!find || find.matches.length === 0} onClick={() => onGo(1)}>▼</button>
      <button className="lib-rdr-btn" title="关闭查找" onClick={onClose}><CloseIcon size={12} /></button>
    </div>
  )
}

/** Selection popup: highlight colors / underline / note / copy. */
function SelectionPopup({
  popup, noteMode, noteDraft, onNoteDraft, onNoteSubmit, onNoteCancel, onNoteMode,
  color, onColorChange, onHighlight, onUnderline, maxWidth,
}) {
  return (
    <div
      className="lib-sel-popup"
      style={{ left: Math.max(8, Math.min(popup.x, (maxWidth || 800) - 8)), top: Math.max(8, popup.y) }}
      onClick={event => event.stopPropagation()}
      onMouseDown={(event) => {
        // Buttons keep the document selection (so the popup's anchor stays
        // valid); editors must receive the mousedown to take focus.
        const tag = event.target?.tagName
        if (tag !== 'TEXTAREA' && tag !== 'INPUT') event.preventDefault()
        event.stopPropagation()
      }}
    >
      {noteMode ? (
        <div className="lib-sel-note">
          <textarea
            autoFocus
            value={noteDraft}
            placeholder="批注内容，Enter 保存"
            onChange={event => onNoteDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onNoteSubmit(noteDraft)
              }
              if (event.key === 'Escape') onNoteCancel()
            }}
          />
        </div>
      ) : null}
      <div className="lib-sel-actions">
        <button className="lib-sel-btn" title={`高亮（${color}）`} onClick={() => onHighlight(color)}>
          <HighlightIcon size={13} />
          <span className="lib-sel-dot" style={{ backgroundColor: color }} />
        </button>
        <button className="lib-sel-btn" title="下划线" onClick={() => onUnderline(color)}>
          <UnderlineIcon size={13} />
        </button>
        <button className="lib-sel-btn" title="添加批注" onClick={() => onNoteMode(!noteMode)}>
          <span style={{ fontSize: 12 }}>注</span>
        </button>
        <button
          className="lib-sel-btn"
          title="复制"
          onClick={() => { try { navigator.clipboard?.writeText(popup.text) } catch { /* clipboard denied */ } }}
        >
          <CopyIcon size={13} />
        </button>
      </div>
      <div className="lib-sel-colors">
        {HIGHLIGHT_COLORS.map(([value, label]) => (
          <button
            key={value}
            className="lib-sel-color"
            style={{ backgroundColor: value, outline: value === color ? '1px solid var(--lib-text)' : 'none' }}
            title={label}
            onClick={() => { onColorChange(value); onHighlight(value) }}
          />
        ))}
      </div>
    </div>
  )
}

/** Popup on an existing annotation: comment editor + color + delete. */
function AnnotationPopup({ annotation, position, onUpdate, onDelete, onClose }) {
  const [comment, setComment] = React.useState(annotation.comment ?? '')
  React.useEffect(() => setComment(annotation.comment ?? ''), [annotation.key, annotation.comment])
  return (
    <div
      className="lib-anno-pop"
      style={{ left: Math.max(8, position?.x ?? 0), top: Math.max(8, position?.y ?? 0) }}
      onClick={event => event.stopPropagation()}
      onMouseDown={(event) => {
        const tag = event.target?.tagName
        if (tag !== 'TEXTAREA' && tag !== 'INPUT') event.preventDefault()
        event.stopPropagation()
      }}
    >
      {annotation.text ? <div className="lib-anno-quote">{annotation.text}</div> : null}
      <textarea
        className="lib-anno-edit"
        value={comment}
        placeholder="添加评论…"
        onChange={event => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onUpdate({ comment })
            onClose()
          }
          if (event.key === 'Escape') onClose()
        }}
      />
      <div className="lib-sel-colors">
        {HIGHLIGHT_COLORS.map(([value, label]) => (
          <button
            key={value}
            className="lib-sel-color"
            style={{ backgroundColor: value, outline: value === annotation.color ? '1px solid var(--lib-text)' : 'none' }}
            title={label}
            onClick={() => onUpdate({ color: value })}
          />
        ))}
      </div>
      <div className="lib-anno-pop-actions">
        <button className="lib-btn danger" onClick={() => { onDelete(annotation.key); onClose() }}>删除批注</button>
        <button className="lib-btn" onClick={() => { onUpdate({ comment }); onClose() }}>保存评论</button>
        <button className="lib-btn icon" onClick={onClose}><CloseIcon size={12} /></button>
      </div>
    </div>
  )
}

/**
 * The in-app viewer tab body.
 *
 * @param {object} props
 * @param {Uint8Array} props.bytes - raw PDF bytes (copied before pdf.js takes them).
 * @param {string} props.title - tab title (also the error dialog context).
 * @param {string} props.attachmentKey - attachment key; annotation CRUD targets it.
 * @param {(message: string) => void} [props.onNotify]
 * @param {() => void} [props.onOpenNative] - hand the file to the OS reader.
 */
export function PdfViewer({ bytes, title, attachmentKey, onNotify, onOpenNative }) {
  const [phase, setPhase] = React.useState('loading') // loading | ready | error
  const [failMessage, setFailMessage] = React.useState('')
  const [numPages, setNumPages] = React.useState(0)
  // null = fit width; otherwise an explicit zoom factor.
  const [zoom, setZoom] = React.useState(null)
  const [page, setPage] = React.useState(1)
  const [containerWidth, setContainerWidth] = React.useState(0)
  const [dimsVersion, setDimsVersion] = React.useState(0)
  const [rotations, setRotations] = React.useState({})
  const [annotations, setAnnotations] = React.useState([])
  const [find, setFind] = React.useState(null)
  const [popup, setPopup] = React.useState(null)
  const [noteMode, setNoteMode] = React.useState(false)
  const [noteDraft, setNoteDraft] = React.useState('')
  const [annoPopup, setAnnoPopup] = React.useState(null)
  const [activeAnnotationKey, setActiveAnnotationKey] = React.useState('')
  const [annoColor, setAnnoColor] = React.useState(HIGHLIGHT_COLORS[0][0])

  const docRef = React.useRef(null)
  const baseRef = React.useRef(null) // page-1 raw dims {w, h, rot}
  const dimsRef = React.useRef([]) // per-page raw dims once measured
  const pageDataRef = React.useRef(new Map()) // pageNumber → {items, styles, index}
  const scrollRef = React.useRef(null)
  const rootRef = React.useRef(null)
  const scrollRafRef = React.useRef(0)
  const searchTokenRef = React.useRef(0)

  const base = baseRef.current
  const fitWidth = containerWidth > 0
  const scale = zoom === null
    ? (fitWidth ? containerWidth : 760) / (base?.w ?? 612)
    : zoom
  const zoomKey = `${zoom === null ? 'fit' : zoom}@${containerWidth}`

  const scaleRef = React.useRef(0)
  scaleRef.current = scale
  const rotationsRef = React.useRef(rotations)
  rotationsRef.current = rotations
  const pageRef = React.useRef(1)
  pageRef.current = page
  const popupRef = React.useRef(null)
  popupRef.current = popup
  const noteModeRef = React.useRef(false)
  noteModeRef.current = noteMode
  const findRef = React.useRef(null)
  findRef.current = find
  const onNotifyRef = React.useRef(onNotify)
  onNotifyRef.current = onNotify

  /** Per-page display box: own aspect, swapped for rotated pages. */
  const pageGeometry = React.useCallback((index) => {
    const raw = dimsRef.current[index - 1] ?? baseRef.current
    const uiRot = rotationsRef.current[index] ?? 0
    const total = (((((raw?.rot ?? 0) + uiRot) % 360) + 360) % 360)
    const w = raw?.w ?? 612
    const h = raw?.h ?? 792
    const rotated = total % 180 !== 0
    return {
      boxW: Math.max(40, Math.round(scale * (rotated ? h : w))),
      boxH: Math.max(40, Math.round(scale * (rotated ? w : h))),
    }
  }, [scale])

  const pageHeight = React.useCallback(index => pageGeometry(index).boxH, [pageGeometry])

  const pageTop = React.useCallback((index) => {
    let top = PAGE_PAD
    for (let i = 1; i < index; i += 1) top += pageHeight(i) + PAGE_GAP
    return top
  }, [pageHeight])

  // Parse the document whenever new bytes arrive.
  React.useEffect(() => {
    if (!bytes) return undefined
    let cancelled = false
    let loaded = null
    setPhase('loading')
    setFailMessage('')
    setNumPages(0)
    setPage(1)
    setAnnotations([])
    setFind(null)
    setPopup(null)
    setAnnoPopup(null)
    setRotations({})
    dimsRef.current = []
    setDimsVersion(value => value + 1)
    pageDataRef.current.clear()
    searchTokenRef.current += 1
    // pdf.js may take ownership of the buffer (structuredClone transfers), so
    // hand it a copy and keep the tab's bytes intact for tab switches.
    const task = pdfjsLib.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      onPassword: (update, reason) => {
        let password = null
        try {
          password = window.prompt(reason === 2 ? '密码不正确，请重新输入：' : '该 PDF 已加密，请输入密码：')
        } catch {
          // No blocking prompt available (test shells); fail into the error state.
        }
        update(password)
      },
    })
    ;(async () => {
      try {
        loaded = await task.promise
        if (cancelled) {
          loaded.destroy()
          return
        }
        const first = await loaded.getPage(1)
        if (cancelled) return
        const viewport = first.getViewport({ scale: 1 })
        baseRef.current = rawDimsOfViewport(viewport, first.rotate)
        dimsRef.current[0] = baseRef.current
        docRef.current = loaded
        setNumPages(loaded.numPages)
        setDimsVersion(value => value + 1)
        setPhase('ready')
      } catch (error) {
        if (!cancelled) {
          setFailMessage(loadErrorMessage(error))
          setPhase('error')
        }
      }
    })()
    return () => {
      cancelled = true
      if (loaded) loaded.destroy()
    }
  }, [bytes])

  // Full teardown when the viewer unmounts (tab closed / switched).
  React.useEffect(() => () => {
    for (const entry of [docRef.current]) {
      try { entry?.destroy() } catch { /* already gone */ }
    }
    docRef.current = null
  }, [])

  // Track the scroll container's CONTENT width (drives fit-width and the zoom
  // label); clientWidth includes the scroll column's 9px side padding, which
  // the page boxes must not occupy.
  React.useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => setContainerWidth(Math.max(80, element.clientWidth - 18))
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [phase])

  // Measure every page's raw dims once (heights fill in for mixed-size docs);
  // getPage also primes pdf.js' cache so later renders start instantly.
  React.useEffect(() => {
    if (phase !== 'ready') return undefined
    const doc = docRef.current
    if (!doc) return undefined
    let cancelled = false
    ;(async () => {
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        if (cancelled || docRef.current !== doc) return
        try {
          const proxy = await doc.getPage(pageNumber)
          if (cancelled || docRef.current !== doc) return
          const viewport = proxy.getViewport({ scale: 1 })
          dimsRef.current[pageNumber - 1] = rawDimsOfViewport(viewport, proxy.rotate)
        } catch {
          return
        }
      }
      if (!cancelled) setDimsVersion(value => value + 1)
    })()
    return () => { cancelled = true }
  }, [phase])

  // Shared per-page text data (text layer + search index), LRU capped.
  const pageDataOf = React.useCallback(async (pageNumber) => {
    const cache = pageDataRef.current
    let entry = cache.get(pageNumber)
    if (entry) {
      cache.delete(pageNumber)
      cache.set(pageNumber, entry)
      return entry
    }
    const doc = docRef.current
    if (!doc) throw new Error('文档已关闭')
    const proxy = await doc.getPage(pageNumber)
    const content = await proxy.getTextContent()
    const items = content.items.filter(item => typeof item.str === 'string')
    entry = { items, styles: content.styles ?? {}, index: createPageIndex(items) }
    cache.set(pageNumber, entry)
    while (cache.size > PAGE_DATA_CACHE) cache.delete(cache.keys().next().value)
    return entry
  }, [])

  // Annotations live as Zotero rows (isExternal = 0) under the attachment —
  // the host endpoints already exist; nothing is written into the PDF file.
  const refreshAnnotations = React.useCallback(async () => {
    const listed = await api.call('annotations-list', { key: attachmentKey })
    setAnnotations(listed.annotations ?? [])
  }, [attachmentKey])

  React.useEffect(() => {
    if (phase !== 'ready') return
    refreshAnnotations().catch(() => setAnnotations([]))
  }, [phase, refreshAnnotations])

  /** Raw dims of one page, measuring on demand (jump targets, popup math). */
  const rawDimsOf = React.useCallback(async (pageNumber) => {
    const cached = dimsRef.current[pageNumber - 1]
    if (cached) return cached
    const doc = docRef.current
    if (!doc) throw new Error('文档已关闭')
    const proxy = await doc.getPage(pageNumber)
    const viewport = proxy.getViewport({ scale: 1 })
    const raw = rawDimsOfViewport(viewport, proxy.rotate)
    dimsRef.current[pageNumber - 1] = raw
    setDimsVersion(value => value + 1)
    return raw
  }, [])

  const captureAnchor = React.useCallback(() => {
    const element = scrollRef.current
    if (!element) return 0
    const total = element.scrollHeight - element.clientHeight
    return total > 0 ? element.scrollTop / total : 0
  }, [])

  const restoreAnchor = React.useCallback((ratio) => {
    const element = scrollRef.current
    if (!element) return
    const total = element.scrollHeight - element.clientHeight
    element.scrollTop = total > 0 ? ratio * total : 0
  }, [])

  const rotationSig = JSON.stringify(rotations)
  // Keep the vertical anchor stable across relayouts (zoom / rotation).
  React.useEffect(() => {
    if (phase !== 'ready') return undefined
    const ratio = captureAnchor()
    const raf = requestAnimationFrame(() => restoreAnchor(ratio))
    return () => cancelAnimationFrame(raf)
  }, [phase, zoomKey, rotationSig, captureAnchor, restoreAnchor])

  const handleScroll = React.useCallback(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const element = scrollRef.current
      if (!element) return
      // Scrolling detaches the popups from their anchors.
      setPopup(previous => (previous ? null : previous))
      setAnnoPopup(previous => (previous ? null : previous))
      const line = element.scrollTop + element.clientHeight * 0.35
      let current = 1
      while (current < numPages && pageTop(current + 1) <= line) current += 1
      setPage(previous => (previous === current ? previous : current))
    })
  }, [numPages, pageTop])
  React.useEffect(() => () => cancelAnimationFrame(scrollRafRef.current), [])

  const jumpToPage = React.useCallback((target) => {
    const index = Math.min(numPages, Math.max(1, Math.round(Number(target) || 1)))
    setPage(index)
    const element = scrollRef.current
    if (element) element.scrollTop = Math.max(0, pageTop(index) - PAGE_PAD)
  }, [numPages, pageTop])

  const stepZoom = React.useCallback((direction) => {
    setZoom(previous => {
      const current = previous ?? clampZoom(scaleRef.current)
      return clampZoom(current * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
    })
  }, [])

  const rotate = React.useCallback((delta) => {
    const current = pageRef.current
    setRotations(previous => ({
      ...previous,
      [current]: ((((previous[current] ?? 0) + delta) % 360) + 360) % 360,
    }))
  }, [])

  // --- find -------------------------------------------------------------------
  /** Scroll so the match sits ~30% from the viewport top — visible even on
   * tall pages where a bare page jump would leave it below the fold. */
  const jumpToMatch = React.useCallback(async (match) => {
    const element = scrollRef.current
    if (!element) return
    try {
      const raw = await rawDimsOf(match.pageIndex + 1)
      const uiRot = rotationsRef.current[match.pageIndex + 1] ?? 0
      const total = (((((raw.rot + uiRot) % 360) + 360) % 360))
      const matrix = makePageMatrix(raw.w, raw.h, scaleRef.current, total)
      let top = Infinity
      for (const rect of match.rects ?? []) {
        const box = rectToView(matrix, rect)
        top = Math.min(top, box[1])
      }
      if (!Number.isFinite(top)) return
      element.scrollTop = Math.max(0, pageTop(match.pageIndex + 1) + top - element.clientHeight * 0.3)
    } catch {
      // Navigation is best-effort.
    }
  }, [rawDimsOf, pageTop])

  const runSearch = React.useCallback(async (rawQuery) => {
    const token = searchTokenRef.current += 1
    const query = String(rawQuery ?? '').trim()
    const total = docRef.current?.numPages ?? 0
    if (!query || total === 0) {
      setFind(previous => (previous ? { ...previous, query, matches: [], current: -1, searching: false } : previous))
      return
    }
    setFind(previous => (previous ? { ...previous, query, searching: true } : previous))
    const matches = []
    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      if (token !== searchTokenRef.current) return
      try {
        const entry = await pageDataOf(pageNumber)
        if (token !== searchTokenRef.current) return
        matches.push(...findMatches(entry.index, query, pageNumber - 1, FIND_MATCH_CAP - matches.length))
      } catch {
        break
      }
      if (matches.length >= FIND_MATCH_CAP) break
    }
    if (token !== searchTokenRef.current) return
    setFind(previous => (previous ? { ...previous, matches, searching: false, current: matches.length > 0 ? 0 : -1 } : previous))
    // Land on the first match right away instead of only coloring it.
    if (matches.length > 0) void jumpToMatch(matches[0])
  }, [pageDataOf, jumpToMatch])

  const goToMatch = React.useCallback((delta) => {
    const current = findRef.current
    if (!current || current.matches.length === 0) return
    const next = (((current.current + delta) % current.matches.length) + current.matches.length) % current.matches.length
    setFind(previous => (previous ? { ...previous, current: next } : previous))
    void jumpToMatch(current.matches[next])
  }, [jumpToMatch])

  const openFind = React.useCallback(() => {
    setFind(previous => (previous ? { ...previous, open: true } : { open: true, query: '', matches: [], current: -1, searching: false }))
  }, [])

  const closeFind = React.useCallback(() => {
    setFind(previous => (previous ? { ...previous, open: false } : previous))
  }, [])

  // --- selection → popup → annotations ----------------------------------------
  const dismissPopup = React.useCallback(() => {
    setPopup(null)
    setNoteMode(false)
    setNoteDraft('')
  }, [])

  const makeAnnotation = React.useCallback(async (type, colorValue, comment = '') => {
    const current = popupRef.current
    if (!current) return
    const matrix = makePageMatrix(current.rawW, current.rawH, current.scale, current.rot)
    const rects = current.lines.map(line => rectToPdf(matrix, [line.left, line.top, line.right, line.bottom]))
    setPopup(null)
    setNoteMode(false)
    setNoteDraft('')
    try {
      await api.call('annotation-create', {
        attachmentKey,
        annotation: {
          type,
          color: colorValue,
          text: current.text,
          comment,
          pageLabel: String(current.pageNumber),
          position: { pageIndex: current.pageNumber - 1, rects, pageHeight: current.rawH },
        },
      })
      await refreshAnnotations()
    } catch (error) {
      onNotifyRef.current?.(`批注创建失败：${error?.message ?? error}`)
    }
    try { window.getSelection()?.removeAllRanges() } catch { /* nothing selected */ }
  }, [attachmentKey, refreshAnnotations])

  const annotationClick = React.useCallback((annotation, box, pageEl) => {
    dismissPopup()
    const rootRect = rootRef.current?.getBoundingClientRect()
    const pageRect = pageEl?.getBoundingClientRect()
    const x = pageRect && rootRect ? pageRect.left - rootRect.left + box.left + 10 : box.left + 10
    const y = pageRect && rootRect ? pageRect.top - rootRect.top + box.top + box.height + 6 : box.top + 6
    setAnnoPopup({
      annotation,
      // Keep the editor inside the viewer even for highlights near the edges.
      x: Math.min(Math.max(8, x), Math.max(8, (rootRect?.width ?? 800) - 276)),
      y: Math.min(Math.max(8, y), Math.max(8, (rootRect?.height ?? 900) - 200)),
    })
    setActiveAnnotationKey(annotation.key)
  }, [dismissPopup])

  const updateAnnotation = React.useCallback(async (key, patch) => {
    try {
      await api.call('annotation-update', { key, patch })
      await refreshAnnotations()
    } catch (error) {
      onNotifyRef.current?.(`批注更新失败：${error?.message ?? error}`)
    }
  }, [refreshAnnotations])

  const deleteAnnotation = React.useCallback(async (key) => {
    try {
      await api.call('annotation-delete', { key })
      await refreshAnnotations()
    } catch (error) {
      onNotifyRef.current?.(`批注删除失败：${error?.message ?? error}`)
    }
  }, [refreshAnnotations])

  // Selection mouseup → popup (or direct creation via the popup buttons).
  React.useEffect(() => {
    const container = scrollRef.current
    if (phase !== 'ready' || !container) return undefined
    const evaluate = (event) => {
      if (event.button !== 0) return
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
      const text = String(selection).replace(/\s+/g, ' ').trim()
      if (text === '') return
      const range = selection.getRangeAt(0)
      const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
      const pageEl = startEl?.closest?.('.lib-pdf-page')
      if (!pageEl || !container.contains(pageEl)) return
      const pageNumber = Number(pageEl.dataset.page)
      if (!pageNumber) return
      const pageRect = pageEl.getBoundingClientRect()
      // A drag that ends outside the page makes the DOM range cover everything
      // in between; only fragments inside the anchor page belong here.
      const fragments = []
      for (const rect of range.getClientRects()) {
        const left = rect.left - pageRect.left
        const top = rect.top - pageRect.top
        if (left < -2 || rect.right - pageRect.left > pageRect.width + 2) continue
        if (top < -2 || rect.bottom - pageRect.top > pageRect.height + 2) continue
        fragments.push({ left, right: rect.right - pageRect.left, top, bottom: rect.bottom - pageRect.top })
      }
      const lines = mergeLineRects(fragments)
      if (lines.length === 0) return
      const raw = dimsRef.current[pageNumber - 1] ?? baseRef.current
      const uiRot = rotationsRef.current[pageNumber] ?? 0
      // Anchor the popup at the mouse RELEASE point: the release is always in
      // the user's viewport, which matters for cross-column selections and
      // upward drags where the selection's text end may sit off-screen. Clamp
      // so the popup never leaves the viewer (it grows to ~150px tall with
      // the note editor).
      const rootRect = rootRef.current?.getBoundingClientRect()
      const rootW = rootRect?.width ?? 800
      const rootH = rootRect?.height ?? 900
      const popupX = rootRect ? event.clientX - rootRect.left + 12 : event.clientX + 12
      const popupY = rootRect ? event.clientY - rootRect.top + 14 : event.clientY + 14
      setPopup({
        pageNumber,
        text,
        lines,
        rawW: raw?.w ?? 612,
        rawH: raw?.h ?? 792,
        rot: (((((raw?.rot ?? 0) + uiRot) % 360) + 360) % 360),
        scale: scaleRef.current,
        x: Math.min(Math.max(popupX, 8), Math.max(8, rootW - 190)),
        y: Math.min(Math.max(popupY, 8), Math.max(8, rootH - 170)),
      })
    }
    const collapse = () => {
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) return
      if (!noteModeRef.current) dismissPopup()
    }
    container.addEventListener('mouseup', evaluate)
    document.addEventListener('selectionchange', collapse)
    return () => {
      container.removeEventListener('mouseup', evaluate)
      document.removeEventListener('selectionchange', collapse)
    }
  }, [phase, dismissPopup])

  // --- keyboard ------------------------------------------------------------------
  React.useEffect(() => {
    const onKey = (event) => {
      const target = event.target
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        openFind()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      switch (event.key) {
        case 'Escape':
          setAnnoPopup(null)
          dismissPopup()
          closeFind()
          break
        case 'ArrowLeft': case 'PageUp':
          event.preventDefault()
          jumpToPage(pageRef.current - 1)
          break
        case 'ArrowRight': case 'PageDown':
          event.preventDefault()
          jumpToPage(pageRef.current + 1)
          break
        case 'Home':
          event.preventDefault()
          jumpToPage(1)
          break
        case 'End':
          event.preventDefault()
          jumpToPage(numPages)
          break
        case '+': case '=':
          event.preventDefault()
          stepZoom(1)
          break
        case '-': case '_':
          event.preventDefault()
          stepZoom(-1)
          break
        case '0':
          event.preventDefault()
          setZoom(null)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissPopup, closeFind, openFind, jumpToPage, stepZoom, numPages])

  // Per-page overlay inputs (stable identities keep PdfPageBox memoized).
  const annotationsByPage = React.useMemo(() => {
    const map = new Map()
    for (const annotation of annotations) {
      const pageNumber = Number(annotation.position?.pageIndex) + 1
      if (!Number.isInteger(pageNumber) || pageNumber < 1) continue
      if (!map.has(pageNumber)) map.set(pageNumber, [])
      map.get(pageNumber).push(annotation)
    }
    return map
  }, [annotations])

  const marksByPage = React.useMemo(() => {
    const map = new Map()
    const matches = find?.matches ?? []
    for (let i = 0; i < matches.length; i += 1) {
      const pageNumber = matches[i].pageIndex + 1
      if (!map.has(pageNumber)) map.set(pageNumber, [])
      map.get(pageNumber).push({ match: matches[i], idx: i })
    }
    return map
  }, [find?.matches])

  if (phase === 'loading') {
    return (
      <div className="lib-pdf-root lib-pv">
        <div className="lib-pv-status">正在解析 {title || 'PDF'}…</div>
      </div>
    )
  }
  if (phase === 'error') {
    return (
      <div className="lib-pdf-root lib-pv">
        <div className="lib-pv-err">
          <div className="lib-pv-err-title">无法在内置查看器中打开该 PDF</div>
          <div className="lib-pv-err-message">{failMessage}</div>
          {onOpenNative ? (
            <Button variant="outline" size="sm" onClick={onOpenNative}>用系统阅读器打开</Button>
          ) : null}
        </div>
      </div>
    )
  }

  const percentLabel = `${Math.round(scale * 100)}%`
  const maxWidth = rootRef.current?.clientWidth
  const pageBoxes = []
  for (let index = 1; index <= numPages; index += 1) {
    const { boxW, boxH } = pageGeometry(index)
    pageBoxes.push(
      <PdfPageBox
        key={index}
        doc={docRef.current}
        pageNumber={index}
        raw={dimsRef.current[index - 1] ?? base}
        scale={scale}
        uiRotation={rotations[index] ?? 0}
        boxW={boxW}
        boxH={boxH}
        pageDataOf={pageDataOf}
        annotations={annotationsByPage.get(index)}
        findMarks={marksByPage.get(index)}
        activeMark={find?.current ?? -1}
        activeAnnotationKey={activeAnnotationKey}
        onAnnoClick={annotationClick}
        onNotify={onNotify}
      />,
    )
  }

  return (
    <div
      className="lib-pdf-root lib-pv"
      ref={rootRef}
      onClick={() => {
        // A finished text drag also fires a click here: keep the popup while a
        // selection is active, otherwise clicks elsewhere dismiss everything.
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed && String(selection).trim() !== '') return
        dismissPopup()
        setAnnoPopup(null)
        setActiveAnnotationKey('')
      }}
    >
      <div className="lib-rdr-toolbar">
        <div className="lib-rdr-tstart">
          <button className="lib-rdr-btn" title="上一页" disabled={page <= 1} onClick={() => jumpToPage(page - 1)}>◀</button>
          <input
            className="lib-rdr-page-input"
            value={page}
            onChange={event => {
              const value = Number(event.target.value)
              if (Number.isFinite(value) && value >= 1 && value <= numPages) setPage(Math.round(value))
            }}
            onKeyDown={event => { if (event.key === 'Enter') jumpToPage(page) }}
            onBlur={() => jumpToPage(page)}
          />
          <span className="lib-rdr-numpages">/ {numPages}</span>
          <button className="lib-rdr-btn" title="下一页" disabled={page >= numPages} onClick={() => jumpToPage(page + 1)}>▶</button>
          <span className="lib-rdr-divider" />
          <button className="lib-rdr-btn" title="缩小" onClick={() => stepZoom(-1)}>−</button>
          <span className="lib-rdr-zoomlabel">{percentLabel}</span>
          <button className="lib-rdr-btn" title="放大" onClick={() => stepZoom(1)}>＋</button>
          <button className="lib-rdr-btn" title="缩放到页宽" disabled={zoom === null} onClick={() => { captureAnchor(); setZoom(null) }}>适应宽度</button>
          <span className="lib-rdr-divider" />
          <button className="lib-rdr-btn" title="逆时针旋转当前页" onClick={() => rotate(-90)}><RotateLeftIcon size={14} /></button>
          <button className="lib-rdr-btn" title="顺时针旋转当前页" onClick={() => rotate(90)}><RotateRightIcon size={14} /></button>
          <span className="lib-rdr-divider" />
          <button className={`lib-rdr-btn${find?.open ? ' active' : ''}`} title="在文档中查找" onClick={openFind}><SearchIcon size={13} /></button>
        </div>
        <div className="lib-rdr-tend">
          {onOpenNative ? (
            <button className="lib-rdr-btn" title="在系统默认阅读器中打开" onClick={onOpenNative}>系统阅读器</button>
          ) : null}
        </div>
      </div>
      {find?.open ? (
        <FindBar find={find} onSearch={runSearch} onGo={goToMatch} onClose={closeFind} />
      ) : null}
      <div className="lib-pdf-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="lib-pdf-pages">{pageBoxes}</div>
      </div>

      {popup ? (
        <SelectionPopup
          popup={popup}
          noteMode={noteMode}
          noteDraft={noteDraft}
          onNoteDraft={setNoteDraft}
          onNoteMode={setNoteMode}
          onNoteSubmit={comment => makeAnnotation(ANNOTATION_TYPES.note, annoColor, comment ?? '')}
          onNoteCancel={() => setNoteMode(false)}
          color={annoColor}
          onColorChange={setAnnoColor}
          onHighlight={value => makeAnnotation(ANNOTATION_TYPES.highlight, value)}
          onUnderline={value => makeAnnotation(ANNOTATION_TYPES.underline, value)}
          maxWidth={maxWidth}
        />
      ) : null}

      {annoPopup ? (
        <AnnotationPopup
          annotation={annoPopup.annotation}
          position={{ x: annoPopup.x, y: annoPopup.y }}
          onUpdate={(patch) => { void updateAnnotation(annoPopup.annotation.key, patch) }}
          onDelete={(key) => { void deleteAnnotation(key) }}
          onClose={() => { setAnnoPopup(null); setActiveAnnotationKey('') }}
        />
      ) : null}
    </div>
  )
}
