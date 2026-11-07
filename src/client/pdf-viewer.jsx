// 内置 PDF 查看器（pdf.js 引擎）：连续滚动页面列 + 缩放 + 跳页 + 旋转
// 当前页 + 全文查找 + 选择文本后添加高亮/下划线/批注（存 Zotero 批注行，
// 不改 PDF 文件本体）+ 可点击超链接（网页链接交系统浏览器，文档内链接
// 跳页）+ 上下分屏（同一文档两屏独立滚动/缩放，批注实时同步）。
//
// pdf.js 以主线程模式运行：把 WorkerMessageHandler 挂到 `globalThis.pdfjsWorker`
// 后 pdf.js 不会创建 Worker（dsh 桌面壳禁 Blob Worker，跨进程 Worker 也没有
// 可靠的加载路径），解析与栅格化都在页面进程内完成，jsdom 冒烟因此也能解析。
//
// 坐标系约定见 pdf-util.js：批注与查找矩形的存储形态是 PDF 用户空间
// （itemAnnotations.position 的原语义），渲染时经页面矩阵（含每页 UI 旋转）
// 投回屏幕。文本层、覆盖层、选区三者共用同一矩阵，旋转后仍然对齐。
//
// 选区颜色不依赖原生 ::selection（Chromium 会按 span 逐个绘制，重叠处颜色
// 叠深，且夜间模式下宿主令牌会把混色洗成看不清的淡白）：selectionchange 时
// 把选区矩形换算成页内坐标，用单 path SVG 一次性填充——矩形重叠也只画一次，
// 昼夜同一淡蓝。批注高亮填充同理：整页一个 SVG 组，组级 opacity + multiply，
// 组内不透明叠加保证同色批注重叠依旧同色。
import * as React from 'react'
import {
  Button, Menu, IconChevronDownOutlineRegular, IconCompareSplitOutlineRegular, IconRightUpOutlineRegular,
} from './platform.jsx'
import * as api from './api.js'
import { useDebounced } from './util.js'
import {
  SearchIcon, RotateLeftIcon, RotateRightIcon, HighlightIcon, UnderlineIcon,
  CopyIcon, CloseIcon, ChevronRightIcon,
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
const SPLIT_MIN = 0.18
const SPLIT_MAX = 0.82
// Split direction preference ('h' = 上下横向, 'v' = 左右纵向), remembered across
// sessions like the other view preferences.
const SPLIT_AXIS_STORAGE = 'dsh-library:reader-split'

function restoreSplitAxis() {
  try {
    return localStorage.getItem(SPLIT_AXIS_STORAGE) === 'v' ? 'v' : 'h'
  } catch {
    return 'h'
  }
}
// AnnotationType.LINK in pdf.js.
const LINK_TYPE = 2
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
 * Join view-space rects into ONE SVG path. Filling this path paints every
 * pixel at most once, so overlapping rects never composite into a darker
 * shade — the trick behind both the selection overlay and the highlight fills.
 */
function uniformRectPath(rects) {
  let d = ''
  for (const rect of rects) {
    const left = Math.max(0, rect[0])
    const top = Math.max(0, rect[1])
    const right = rect[2]
    const bottom = rect[3]
    d += `M${left.toFixed(2)} ${top.toFixed(2)}H${right.toFixed(2)}V${bottom.toFixed(2)}H${left.toFixed(2)}Z`
  }
  return d
}

/** Clickable rects (PDF user space) of one link annotation: quads when present, else the bounding rect. */
function linkRectsOf(item) {
  const quads = item.quadPoints
  const rects = []
  if (quads && typeof quads.length === 'number' && quads.length >= 8) {
    // pdf.js packs quads flat: [trX, trY, blX, blY, …] per quad.
    for (let i = 0; i + 3 < quads.length; i += 8) {
      const x0 = Number(quads[i + 2])
      const y0 = Number(quads[i + 3])
      const x1 = Number(quads[i])
      const y1 = Number(quads[i + 1])
      if ([x0, y0, x1, y1].every(Number.isFinite)) {
        rects.push([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)])
      }
    }
  }
  if (rects.length === 0 && Array.isArray(item.rect) && item.rect.length === 4 && item.rect.every(Number.isFinite)) {
    const [x0, y0, x1, y1] = item.rect
    rects.push([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)])
  }
  return rects
}

/** Resolve a link destination (named string or explicit array) to a 1-based page number. */
async function resolveDestPage(doc, dest) {
  let explicit = dest
  if (typeof dest === 'string') explicit = await doc.getDestination(dest)
  if (!Array.isArray(explicit) || explicit.length === 0) return null
  const ref = explicit[0]
  if (ref && typeof ref === 'object' && Number.isInteger(ref.num)) return (await doc.getPageIndex(ref)) + 1
  if (Number.isInteger(ref) && ref >= 0) return ref + 1
  return null
}

/**
 * One rendered page box: exact-size placeholder; when near the viewport it
 * paints a canvas bitmap, builds the selectable text layer and renders the
 * selection / annotation / find / link overlays. Each page observes itself,
 * owns its render task and repaints whenever its geometry changes.
 */
const PdfPageBox = React.memo(function PdfPageBox({
  doc, pageNumber, raw, scale, uiRotation, boxW, boxH, pageDataOf,
  annotations, findMarks, selRects, activeMark, activeAnnotationKey,
  onAnnoClick, onJumpToPage, onNotify,
}) {
  const hostRef = React.useRef(null)
  const canvasRef = React.useRef(null)
  const textRef = React.useRef(null)
  const proxyRef = React.useRef(null)
  // jsdom has no IntersectionObserver: mount eagerly (tests rely on it).
  const [nearby, setNearby] = React.useState(() => typeof IntersectionObserver !== 'function')
  const [painted, setPainted] = React.useState(false)
  const [proxyReady, setProxyReady] = React.useState(0)
  const [hoverKey, setHoverKey] = React.useState('')
  const [links, setLinks] = React.useState([])
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

  // Hyperlinks: fetched once per page proxy; annotations of the PDF file never
  // change, so this never needs a refresh.
  React.useEffect(() => {
    if (!proxyReady) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const items = await proxyRef.current?.getAnnotations()
        if (cancelled || !items) return
        const list = []
        for (const item of items) {
          if (item?.annotationType !== LINK_TYPE) continue
          const rects = linkRectsOf(item)
          if (rects.length === 0) continue
          // pdf.js resolves absolute URLs into `url`; relative leftovers stay
          // unclickable (the host only opens http(s) anyway).
          const rawUrl = typeof item.url === 'string' && item.url ? item.url : item.unsafeUrl
          const url = typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl) ? rawUrl : ''
          list.push({ url, dest: item.dest ?? null, action: typeof item.action === 'string' ? item.action : '', rects })
        }
        if (!cancelled) setLinks(list)
      } catch {
        // Links are optional decoration; a failed fetch just loses them.
      }
    })()
    return () => { cancelled = true }
  }, [proxyReady])

  const handleLinkClick = React.useCallback((link, event) => {
    event.stopPropagation()
    if (link.url) {
      void (async () => {
        try {
          await api.call('open-url', { url: link.url })
        } catch (error) {
          onNotify?.(`无法打开链接：${error?.message ?? error}`)
        }
      })()
      return
    }
    void (async () => {
      let target = null
      try {
        target = await resolveDestPage(doc, link.dest)
      } catch { /* unresolvable destination */ }
      if (target != null) {
        onJumpToPage?.(target)
        return
      }
      switch (link.action) {
        case 'NextPage': onJumpToPage?.(pageNumber + 1); break
        case 'PrevPage': onJumpToPage?.(pageNumber - 1); break
        case 'FirstPage': onJumpToPage?.(1); break
        case 'LastPage': onJumpToPage?.(Number.MAX_SAFE_INTEGER); break
        default: break
      }
    })()
  }, [doc, onJumpToPage, onNotify, pageNumber])

  const matrix = raw ? makePageMatrix(raw.w, raw.h, scale, totalRotation) : null

  // Highlight fills: one SVG for the whole page — group opacity + multiply
  // apply to the group as a whole, so same-color overlaps stay the same color.
  // Hover/active outlines cover EVERY rect of the annotation (multi-line
  // highlights/underlines light up together — a per-rect CSS :hover can only
  // ever reach one line).
  const highlightGroups = []
  const outlineRects = []
  if (matrix) {
    for (const annotation of annotations ?? []) {
      const viewRects = (annotation.position?.rects ?? []).map(rect => rectToView(matrix, rect))
      if (viewRects.length === 0) continue
      if (annotation.type === ANNOTATION_TYPES.highlight) {
        highlightGroups.push({ key: annotation.key, color: annotation.color, d: uniformRectPath(viewRects) })
      }
      if (annotation.key === activeAnnotationKey || annotation.key === hoverKey) {
        for (const box of viewRects) {
          outlineRects.push({ key: annotation.key, box, active: annotation.key === activeAnnotationKey })
        }
      }
    }
  }

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
      {matrix && selRects?.length ? (
        <svg className="lib-pdf-sel"><path d={uniformRectPath(selRects)} /></svg>
      ) : null}
      <div className="lib-pdf-text" ref={textRef} />
      {highlightGroups.length > 0 || outlineRects.length > 0 ? (
        <svg className="lib-pdf-annos">
          {highlightGroups.map(group => (
            <g key={group.key} data-anno-key={group.key}><path d={group.d} fill={group.color} /></g>
          ))}
          {outlineRects.map((entry, index) => (
            <rect
              key={`${entry.key}:${index}`}
              x={entry.box[0]}
              y={entry.box[1]}
              width={Math.max(1, entry.box[2] - entry.box[0])}
              height={Math.max(1, entry.box[3] - entry.box[1])}
              style={{ fill: 'none', stroke: entry.active ? 'var(--lib-accent)' : 'rgba(0, 0, 0, 0.35)', strokeWidth: entry.active ? 1.5 : 1 }}
            />
          ))}
        </svg>
      ) : null}
      {matrix ? (annotations ?? []).map(annotation => {
        if (annotation.type === ANNOTATION_TYPES.highlight) return null
        return (annotation.position?.rects ?? []).map((rect, index) => {
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
                data-anno-key={annotation.key}
                style={{ left: box[0], top: box[1] + height - hitHeight, width, height: hitHeight }}
                title={annotation.comment || ''}
                onMouseEnter={() => setHoverKey(annotation.key)}
                onMouseLeave={() => setHoverKey(previous => (previous === annotation.key ? '' : previous))}
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
        })
      }) : null}
      {matrix ? (annotations ?? []).map(annotation => {
        if (annotation.type !== ANNOTATION_TYPES.highlight) return null
        return (annotation.position?.rects ?? []).map((rect, index) => {
          const box = rectToView(matrix, rect)
          const width = Math.max(1, box[2] - box[0])
          const height = Math.max(1, box[3] - box[1])
          const hitHeight = Math.min(height, Math.max(8, height * 0.45))
          return (
            <div
              key={`hit-${annotation.key}:${index}`}
              className="lib-pdf-anno-hit"
              data-anno-key={annotation.key}
              style={{ left: box[0], top: box[1] + height - hitHeight, width, height: hitHeight }}
              title={annotation.comment || ''}
              onMouseEnter={() => setHoverKey(annotation.key)}
              onMouseLeave={() => setHoverKey(previous => (previous === annotation.key ? '' : previous))}
              onClick={(event) => {
                event.stopPropagation()
                onAnnoClick?.(annotation, { left: box[0], top: box[1], width, height }, event.currentTarget.closest('.lib-pdf-page'))
              }}
            />
          )
        })
      }) : null}
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
      {matrix ? links.map((link, li) => link.rects.map((rect, ri) => {
        const box = rectToView(matrix, rect)
        return (
          <div
            key={`l${li}:${ri}`}
            className="lib-pdf-link"
            data-external={link.url ? '1' : '0'}
            style={{ left: box[0], top: box[1], width: Math.max(1, box[2] - box[0]), height: Math.max(1, box[3] - box[1]) }}
            title={link.url || '文档内跳转'}
            onClick={(event) => handleLinkClick(link, event)}
          />
        )
      })) : null}
      {!painted ? <span className="lib-pdf-skel">{pageNumber}</span> : null}
    </div>
  )
})

/**
 * 「打开方式」split control, mirroring dsh's OpenTargetButton: the left half
 * carries the preferred application's icon and opens with it, the chevron
 * opens the native dsh menu of registered applications. Falls back to a plain
 * default-open affordance when the host reports no applications (query failed
 * or non-Windows).
 */
function OpenWithControl({ attachmentKey, apps, onOpenDefault, onNotify }) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const preferred = apps.find(app => app.default) ?? apps[0]
  const openWithApp = React.useCallback(async (application) => {
    setMenuOpen(false)
    try {
      await api.call('open-with', { key: attachmentKey, application })
    } catch (error) {
      onNotify?.(`无法用所选程序打开：${error?.message ?? error}`)
    }
  }, [attachmentKey, onNotify])
  const appIcon = app => app?.icon
    ? <img src={app.icon} width={14} height={14} alt="" draggable={false} />
    : <IconRightUpOutlineRegular size={14} />
  return (
    <Menu
      open={menuOpen && apps.length > 0}
      onClose={() => setMenuOpen(false)}
      autoFocus
      portal
      dense
      align="end"
      items={apps.map(app => ({
        id: app.id,
        icon: appIcon(app),
        label: app.default ? `${app.name}（默认）` : app.name,
      }))}
      onSelect={(id) => { void openWithApp(id) }}
      anchor={(
        <div className="lib-rdr-openwith">
          <button
            type="button"
            className="lib-rdr-openwith-main"
            title={preferred ? `用 ${preferred.name} 打开` : '在系统默认阅读器中打开'}
            aria-label="在系统默认阅读器中打开"
            onClick={onOpenDefault}
          >
            {appIcon(preferred)}
          </button>
          {apps.length > 0 ? (
            <button
              type="button"
              className="lib-rdr-openwith-chev"
              title="选择打开方式"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(value => !value)}
            >
              <IconChevronDownOutlineRegular size={10} />
            </button>
          ) : null}
        </div>
      )}
    />
  )
}

/** The find bar: debounced query + match navigation. */function FindBar({ find, onSearch, onGo, onClose }) {
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

/** Selection popup: highlight colors / underline / note / translate / copy. */
function SelectionPopup({
  popup, noteMode, noteDraft, onNoteDraft, onNoteSubmit, onNoteCancel, onNoteMode,
  color, onColorChange, onHighlight, onUnderline, maxWidth,
  translateOn, onTranslateMode, onTranslateClose, onTranslateToNote,
}) {
  // Translation streams inside this popup; closing the popup (unmount) aborts.
  const [trans, setTrans] = React.useState(() => ({
    phase: 'connecting', thinking: '', answer: '', error: '',
  }))
  const [thinkOpen, setThinkOpen] = React.useState(true)
  const answerRef = React.useRef(null)
  React.useEffect(() => {
    if (!translateOn) return undefined
    const controller = new AbortController()
    let cancelled = false
    setTrans({ phase: 'connecting', thinking: '', answer: '', error: '' })
    setThinkOpen(true)
    ;(async () => {
      try {
        await api.streamTranslate({ text: popup.text }, controller.signal, (event) => {
          if (cancelled) return
          if (event.type === 'thinking') {
            setTrans(previous => ({ ...previous, phase: 'thinking', thinking: previous.thinking + String(event.text ?? '') }))
            return
          }
          if (event.type === 'answer') {
            // 思考一结束就折叠思考块；翻译正文接着流式输出。
            setThinkOpen(false)
            setTrans(previous => ({ ...previous, phase: 'answering', answer: previous.answer + String(event.text ?? '') }))
            return
          }
          if (event.type === 'error') {
            setTrans(previous => ({ ...previous, phase: 'error', error: String(event.message ?? '翻译失败') }))
          }
        })
        setTrans(previous => (previous.phase === 'error' ? previous : { ...previous, phase: 'done' }))
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        setTrans(previous => ({ ...previous, phase: 'error', error: error?.message ?? String(error) }))
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [translateOn]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the streaming tail visible.
  React.useEffect(() => {
    const element = answerRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [trans?.answer, trans?.thinking])

  const phaseLabel = trans
    ? { connecting: '正在连接…', thinking: '思考中…', answering: '翻译中…' }[trans.phase] ?? ''
    : ''
  const colorName = HIGHLIGHT_COLORS.find(([value]) => value === color)?.[1] ?? color
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
        <button className="lib-sel-btn" title={`高亮（${colorName}）`} onClick={() => onHighlight(color)}>
          <HighlightIcon size={14} />
          <span className="lib-sel-dot" style={{ backgroundColor: color }} />
        </button>
        <button className="lib-sel-btn" title={`下划线（${colorName}）`} onClick={() => onUnderline(color)}>
          <UnderlineIcon size={14} />
        </button>
        <button className="lib-sel-btn" title="添加批注" onClick={() => onNoteMode(!noteMode)}>
          <span style={{ fontSize: 12 }}>注</span>
        </button>
        <button
          className="lib-sel-btn"
          title="复制"
          onClick={() => { try { navigator.clipboard?.writeText(popup.text) } catch { /* clipboard denied */ } }}
        >
          <CopyIcon size={14} />
        </button>
        <button
          className={`lib-sel-btn${translateOn ? ' active' : ''}`}
          title={translateOn ? '关闭翻译' : 'AI 翻译选中文字'}
          onClick={() => onTranslateMode(!translateOn)}
        >
          <span style={{ fontSize: 12 }}>译</span>
        </button>
      </div>
      <div className="lib-sel-colors">
        {HIGHLIGHT_COLORS.map(([value, label]) => (
          <button
            key={value}
            className={`lib-sel-color${value === color ? ' active' : ''}`}
            style={{ backgroundColor: value }}
            title={`设为默认颜色（${label}）`}
            onClick={() => onColorChange(value)}
          />
        ))}
      </div>
      {translateOn ? (
        <div className="lib-sel-trans">
          <div className="lib-sel-trans-head">
            <span className="lib-sel-trans-title">翻译</span>
            {phaseLabel ? <span className="lib-sel-trans-status">{phaseLabel}</span> : null}
            <button className="lib-sel-trans-close" title="关闭翻译" onClick={onTranslateClose}><CloseIcon size={12} /></button>
          </div>
          {trans?.thinking ? (
            <div className="lib-sel-trans-think">
              <button
                className="lib-sel-trans-think-head"
                title={thinkOpen ? '折叠思考内容' : '展开思考内容'}
                onClick={() => setThinkOpen(value => !value)}
              >
                <span className={`lib-sel-trans-caret${thinkOpen ? ' open' : ''}`}><ChevronRightIcon size={10} /></span>
                {trans.phase === 'thinking' ? '深度思考中…' : '已深度思考'}
              </button>
              {thinkOpen ? <div className="lib-sel-trans-think-body">{trans.thinking}</div> : null}
            </div>
          ) : null}
          {trans?.error ? <div className="lib-sel-trans-err">{trans.error}</div> : null}
          {trans?.answer ? <div className="lib-sel-trans-text" ref={answerRef}>{trans.answer}</div> : null}
          {trans?.phase === 'done' && trans.answer ? (
            <button className="lib-btn lib-sel-trans-add" onClick={() => onTranslateToNote(trans.answer)}>添加到备注</button>
          ) : null}
        </div>
      ) : null}
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
      {/* 原文在页面上就在眼前（选中高亮的文字仍可见），备注弹窗不再重复展示。 */}
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
            className={`lib-sel-color${value === annotation.color ? ' active' : ''}`}
            style={{ backgroundColor: value }}
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
 * One reader pane: toolbar + find bar + scrolling page column. Pane state
 * (page, zoom, per-page rotation, find, popups, selection) is fully local, so
 * split panes scroll/zoom independently; the document, page dims, text cache
 * and the annotation list come from the viewer and stay in sync across panes.
 * `initialView` seeds a new split pane from the other pane's current position.
 */
function ReaderPane({
  doc, numPages, base, dimsRef, dimsVersion, pageDataOf, rawDimsOf,
  annotationsByPage, attachmentKey, refreshAnnotations, updateAnnotation, deleteAnnotation,
  onNotify, onOpenNative, openWithApps, split, onToggleSplit, axis, onToggleAxis, isActive,
  onActivate, color, onColorChange, basis, paneIndex, paneViewsRef, initialView, translateAuto,
}) {
  const [page, setPage] = React.useState(() => Math.max(1, Math.round(Number(initialView?.page) || 1)))
  // null = fit width; otherwise an explicit zoom factor.
  const [zoom, setZoom] = React.useState(initialView?.zoom ?? null)
  const [containerWidth, setContainerWidth] = React.useState(0)
  const [rotations, setRotations] = React.useState(() => ({ ...(initialView?.rotations ?? {}) }))
  const [find, setFind] = React.useState(null)
  const [popup, setPopup] = React.useState(null)
  const [noteMode, setNoteMode] = React.useState(false)
  const [noteDraft, setNoteDraft] = React.useState('')
  // 翻译面板：随浮窗出现，浮窗消失（滚动/点击别处/关标签）即中止。
  const [translateMode, setTranslateMode] = React.useState(false)
  const [annoPopup, setAnnoPopup] = React.useState(null)
  const [activeAnnotationKey, setActiveAnnotationKey] = React.useState('')
  // Selection overlay: [{pageNumber, rects}] in page-local view px — painted
  // by us so the color is uniform and identical day/night (see header note).
  const [selMarks, setSelMarks] = React.useState([])

  const paneRef = React.useRef(null)
  const scrollRef = React.useRef(null)
  const scrollRafRef = React.useRef(0)
  const selRafRef = React.useRef(0)
  const searchTokenRef = React.useRef(0)

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
  // 划词自动翻译（设置开关）：mouseup 建浮窗时直接进入翻译，免点「译」。
  const translateAutoRef = React.useRef(false)
  translateAutoRef.current = translateAuto === true
  const findRef = React.useRef(null)
  findRef.current = find
  // Report this pane's view state so a NEW split pane can start from the
  // existing pane's current page/zoom/rotation instead of the beginning.
  if (paneViewsRef) paneViewsRef.current[paneIndex] = { page, zoom, rotations }

  /** Per-page display box: own aspect, swapped for rotated pages. */
  const pageGeometry = React.useCallback((index) => {
    const raw = dimsRef.current[index - 1] ?? base
    const uiRot = rotationsRef.current[index] ?? 0
    const total = (((((raw?.rot ?? 0) + uiRot) % 360) + 360) % 360)
    const w = raw?.w ?? 612
    const h = raw?.h ?? 792
    const rotated = total % 180 !== 0
    return {
      boxW: Math.max(40, Math.round(scale * (rotated ? h : w))),
      boxH: Math.max(40, Math.round(scale * (rotated ? w : h))),
    }
  }, [scale, dimsVersion, base]) // eslint-disable-line react-hooks/exhaustive-deps

  const pageHeight = React.useCallback(index => pageGeometry(index).boxH, [pageGeometry])

  const pageTop = React.useCallback((index) => {
    let top = PAGE_PAD
    for (let i = 1; i < index; i += 1) top += pageHeight(i) + PAGE_GAP
    return top
  }, [pageHeight])

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
    const ratio = captureAnchor()
    const raf = requestAnimationFrame(() => restoreAnchor(ratio))
    return () => cancelAnimationFrame(raf)
  }, [zoomKey, rotationSig, captureAnchor, restoreAnchor])

  const handleScroll = React.useCallback(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const element = scrollRef.current
      if (!element) return
      // Scrolling detaches the popups from their anchors (and aborts an
      // in-flight translation — the panel unmounts with the popup).
      setPopup(previous => (previous ? null : previous))
      setNoteMode(false)
      setTranslateMode(false)
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
    const total = numPages
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
  }, [numPages, pageDataOf, jumpToMatch])

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

  // --- selection → overlay → popup → annotations -------------------------------
  const dismissPopup = React.useCallback(() => {
    setPopup(null)
    setNoteMode(false)
    setNoteDraft('')
    setTranslateMode(false)
  }, [])

  /** 译 button: show the translate block below the colors, keeping it in view. */
  const startTranslateMode = React.useCallback(() => {
    setNoteMode(false)
    setNoteDraft('')
    const paneH = paneRef.current?.clientHeight ?? 900
    setPopup(previous => (previous
      ? { ...previous, y: Math.max(8, Math.min(previous.y, paneH - 500)) }
      : previous))
    setTranslateMode(true)
  }, [])

  /** Page-local view rects of everything the selection covers, per touched page. */
  const computeSelMarks = React.useCallback((range) => {
    const paneEl = paneRef.current
    if (!paneEl) return []
    const pageEls = typeof paneEl.querySelectorAll === 'function' ? paneEl.querySelectorAll('.lib-pdf-page') : []
    if (pageEls.length === 0) return []
    const boxes = []
    for (const el of pageEls) boxes.push({ page: Number(el.dataset.page), rect: el.getBoundingClientRect() })
    const byPage = new Map()
    for (const rect of range.getClientRects()) {
      if (rect.right - rect.left < 1 || rect.bottom - rect.top < 1) continue
      for (const box of boxes) {
        const pr = box.rect
        const left = Math.max(rect.left, pr.left)
        const right = Math.min(rect.right, pr.right)
        const top = Math.max(rect.top, pr.top)
        const bottom = Math.min(rect.bottom, pr.bottom)
        if (right - left < 1 || bottom - top < 1) continue
        if (!byPage.has(box.page)) byPage.set(box.page, [])
        byPage.get(box.page).push({ left: left - pr.left, right: right - pr.left, top: top - pr.top, bottom: bottom - pr.top })
      }
    }
    const marks = []
    for (const [pageNumber, fragments] of byPage) {
      if (!pageNumber) continue
      const lines = mergeLineRects(fragments)
      if (lines.length === 0) continue
      marks.push({ pageNumber, rects: lines.map(line => [line.left, line.top, line.right, line.bottom]) })
    }
    return marks
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
      onNotify?.(`批注创建失败：${error?.message ?? error}`)
    }
    try { window.getSelection()?.removeAllRanges() } catch { /* nothing selected */ }
  }, [attachmentKey, refreshAnnotations, onNotify])

  const annotationClick = React.useCallback((annotation, box, pageEl) => {
    dismissPopup()
    const paneRect = paneRef.current?.getBoundingClientRect()
    const pageRect = pageEl?.getBoundingClientRect()
    const x = pageRect && paneRect ? pageRect.left - paneRect.left + box.left + 10 : box.left + 10
    const y = pageRect && paneRect ? pageRect.top - paneRect.top + box.top + box.height + 6 : box.top + 6
    setAnnoPopup({
      annotation,
      // Keep the editor inside the pane even for highlights near the edges.
      x: Math.min(Math.max(8, x), Math.max(8, (paneRect?.width ?? 800) - 276)),
      y: Math.min(Math.max(8, y), Math.max(8, (paneRect?.height ?? 900) - 200)),
    })
    setActiveAnnotationKey(annotation.key)
  }, [dismissPopup])

  // Selection mouseup → popup; selectionchange → uniform overlay repaint.
  React.useEffect(() => {
    const container = scrollRef.current
    if (!container) return undefined
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
      const raw = dimsRef.current[pageNumber - 1] ?? base
      const uiRot = rotationsRef.current[pageNumber] ?? 0
      // Anchor the popup at the mouse RELEASE point: the release is always in
      // the user's viewport, which matters for cross-column selections and
      // upward drags where the selection's text end may sit off-screen. Clamp
      // so the popup never leaves this pane (it grows to ~150px with the note
      // editor).
      const paneRect = paneRef.current?.getBoundingClientRect()
      const paneW = paneRect?.width ?? 800
      const paneH = paneRect?.height ?? 900
      const popupX = paneRect ? event.clientX - paneRect.left + 12 : event.clientX + 12
      const popupY = paneRect ? event.clientY - paneRect.top + 14 : event.clientY + 14
      // 划词自动翻译时翻译面板随浮窗直接出现，按更高的面板预留底部空间。
      const auto = translateAutoRef.current
      setPopup({
        pageNumber,
        text,
        lines,
        rawW: raw?.w ?? 612,
        rawH: raw?.h ?? 792,
        rot: (((((raw?.rot ?? 0) + uiRot) % 360) + 360) % 360),
        scale: scaleRef.current,
        x: Math.min(Math.max(popupX, 8), Math.max(8, paneW - 190)),
        y: Math.min(Math.max(popupY, 8), Math.max(8, paneH - (auto ? 500 : 170))),
      })
      if (auto) {
        setNoteMode(false)
        setNoteDraft('')
        setTranslateMode(true)
      }
    }
    const onSelectionChange = () => {
      // Repaint the selection overlay on the next frame (selectionchange
      // bursts while dragging).
      if (!selRafRef.current) {
        selRafRef.current = requestAnimationFrame(() => {
          selRafRef.current = 0
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            setSelMarks(previous => (previous.length ? [] : previous))
            return
          }
          const range = selection.getRangeAt(0)
          const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
          const paneEl = startEl?.closest?.('.lib-rdr-pane')
          if (!paneEl || paneEl !== paneRef.current) {
            // The live selection lives in another pane (or outside) — nothing
            // to paint here, and stale marks must go.
            setSelMarks(previous => (previous.length ? [] : previous))
            return
          }
          setSelMarks(computeSelMarks(range))
        })
      }
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) return
      if (!noteModeRef.current) dismissPopup()
    }
    container.addEventListener('mouseup', evaluate)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      container.removeEventListener('mouseup', evaluate)
      document.removeEventListener('selectionchange', onSelectionChange)
      if (selRafRef.current) cancelAnimationFrame(selRafRef.current)
    }
  }, [base, dismissPopup, computeSelMarks])

  // A geometry change invalidates page-local overlay rects; the text layer
  // rebuild also collapses the DOM selection, which clears them again.
  React.useEffect(() => { setSelMarks(previous => (previous.length ? [] : previous)) }, [zoomKey, rotationSig])

  // --- keyboard (active pane only) ---------------------------------------------
  React.useEffect(() => {
    if (!isActive) return undefined
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
  }, [isActive, dismissPopup, closeFind, openFind, jumpToPage, stepZoom, numPages])

  // Per-page overlay inputs (stable identities keep PdfPageBox memoized).
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

  const selByPage = React.useMemo(() => {
    const map = new Map()
    for (const mark of selMarks) map.set(mark.pageNumber, mark.rects)
    return map
  }, [selMarks])

  const percentLabel = `${Math.round(scale * 100)}%`
  const pageBoxes = []
  for (let index = 1; index <= numPages; index += 1) {
    const { boxW, boxH } = pageGeometry(index)
    pageBoxes.push(
      <PdfPageBox
        key={index}
        doc={doc}
        pageNumber={index}
        raw={dimsRef.current[index - 1] ?? base}
        scale={scale}
        uiRotation={rotations[index] ?? 0}
        boxW={boxW}
        boxH={boxH}
        pageDataOf={pageDataOf}
        annotations={annotationsByPage.get(index)}
        findMarks={marksByPage.get(index)}
        selRects={selByPage.get(index)}
        activeMark={find?.current ?? -1}
        activeAnnotationKey={activeAnnotationKey}
        onAnnoClick={annotationClick}
        onJumpToPage={jumpToPage}
        onNotify={onNotify}
      />,
    )
  }

  return (
    <div
      className="lib-rdr-pane"
      ref={paneRef}
      style={basis ? { flex: `0 0 ${basis}` } : undefined}
      onMouseDownCapture={onActivate}
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
          {split ? (
            <button
              className="lib-rdr-btn lib-rdr-btn-labeled"
              title={axis === 'h' ? '当前为上下分屏，点击改为左右（纵向）' : '当前为左右分屏，点击改为上下（横向）'}
              onClick={onToggleAxis}
            >
              {axis === 'h' ? '横向' : '纵向'}
            </button>
          ) : null}
          <button
            className={`lib-rdr-btn lib-rdr-btn-labeled${split ? ' active' : ''}`}
            title={split ? '退出分屏' : '分屏阅读（同一文档两屏独立查看）'}
            onClick={onToggleSplit}
          >
            <IconCompareSplitOutlineRegular size={13} />
            <span>{split ? '退出分屏' : '分屏'}</span>
          </button>
          {onOpenNative ? (
            <OpenWithControl
              attachmentKey={attachmentKey}
              apps={openWithApps}
              onOpenDefault={onOpenNative}
              onNotify={onNotify}
            />
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
          onNoteMode={value => { setTranslateMode(false); setNoteMode(value) }}
          onNoteSubmit={comment => makeAnnotation(ANNOTATION_TYPES.note, color, comment ?? '')}
          onNoteCancel={() => setNoteMode(false)}
          color={color}
          onColorChange={onColorChange}
          onHighlight={value => makeAnnotation(ANNOTATION_TYPES.highlight, value)}
          onUnderline={value => makeAnnotation(ANNOTATION_TYPES.underline, value)}
          maxWidth={paneRef.current?.clientWidth}
          translateOn={translateMode}
          onTranslateMode={value => { if (value) startTranslateMode(); else setTranslateMode(false) }}
          onTranslateClose={() => setTranslateMode(false)}
          // 翻译结果落在下划线批注上（高亮盖住正文影响阅读，下划线 + 评论既能
          // 定位原文又保留译文）。
          onTranslateToNote={text => makeAnnotation(ANNOTATION_TYPES.underline, color, text ?? '')}
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

/**
 * The in-app viewer tab body: owns the parsed document, page dims, the shared
 * text cache and the annotation list (so edits sync across split panes), and
 * stacks one or two ReaderPanes.
 *
 * @param {object} props
 * @param {Uint8Array} props.bytes - raw PDF bytes (copied before pdf.js takes them).
 * @param {string} props.title - tab title (also the error dialog context).
 * @param {string} props.attachmentKey - attachment key; annotation CRUD targets it.
 * @param {(message: string) => void} [props.onNotify]
 * @param {boolean} [props.translateAuto] - 划词自动翻译（设置开关）。
 * @param {() => void} [props.onOpenNative] - hand the file to the OS reader.
 */
export function PdfViewer({ bytes, title, attachmentKey, onNotify, onOpenNative, translateAuto }) {
  const [phase, setPhase] = React.useState('loading') // loading | ready | error
  const [failMessage, setFailMessage] = React.useState('')
  const [numPages, setNumPages] = React.useState(0)
  const [dimsVersion, setDimsVersion] = React.useState(0)
  const [annotations, setAnnotations] = React.useState([])
  const [split, setSplit] = React.useState(false)
  const [splitRatio, setSplitRatio] = React.useState(0.5)
  // 'h' = 上下（横向分隔线），'v' = 左右（纵向分隔线）；默认横向并记住选择。
  const [axis, setAxis] = React.useState(restoreSplitAxis)
  const [activePane, setActivePane] = React.useState(0)
  const [annoColor, setAnnoColor] = React.useState(HIGHLIGHT_COLORS[0][0])
  // Registered applications for the attachment's file type (打开方式 control).
  const [openWithApps, setApps] = React.useState([])

  const docRef = React.useRef(null)
  const baseRef = React.useRef(null) // page-1 raw dims {w, h, rot}
  const dimsRef = React.useRef([]) // per-page raw dims once measured
  const pageDataRef = React.useRef(new Map()) // pageNumber → {items, styles, index}
  // Each pane reports {page, zoom, rotations} here every render; entering
  // split snapshots pane 0's state so pane 1 starts from the current page.
  const paneViewsRef = React.useRef([null, null])
  const splitRef = React.useRef(false)
  splitRef.current = split
  const splitInitialStateRef = React.useRef(null)

  const base = baseRef.current

  // Parse the document whenever new bytes arrive.
  React.useEffect(() => {
    if (!bytes) return undefined
    let cancelled = false
    let loaded = null
    setPhase('loading')
    setFailMessage('')
    setNumPages(0)
    setAnnotations([])
    dimsRef.current = []
    setDimsVersion(value => value + 1)
    pageDataRef.current.clear()
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

  // Shared per-page text data (text layer + search index), LRU capped — both
  // panes read through the same cache.
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
  // One shared list here is what keeps both panes in sync.
  const refreshAnnotations = React.useCallback(async () => {
    const listed = await api.call('annotations-list', { key: attachmentKey })
    setAnnotations(listed.annotations ?? [])
  }, [attachmentKey])

  React.useEffect(() => {
    if (phase !== 'ready') return
    refreshAnnotations().catch(() => setAnnotations([]))
  }, [phase, refreshAnnotations])

  // 「打开方式」applications: queried once per tab; a failure just keeps the
  // plain default-open affordance.
  React.useEffect(() => {
    if (phase !== 'ready') return undefined
    let cancelled = false
    api.call('open-apps', { key: attachmentKey }).then(value => {
      if (!cancelled) setApps(Array.isArray(value?.apps) ? value.apps : [])
    }).catch(() => {
      if (!cancelled) setApps([])
    })
    return () => { cancelled = true }
  }, [phase, attachmentKey])

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

  const updateAnnotation = React.useCallback(async (key, patch) => {
    try {
      await api.call('annotation-update', { key, patch })
      await refreshAnnotations()
    } catch (error) {
      onNotify?.(`批注更新失败：${error?.message ?? error}`)
    }
  }, [refreshAnnotations, onNotify])

  const deleteAnnotation = React.useCallback(async (key) => {
    try {
      await api.call('annotation-delete', { key })
      await refreshAnnotations()
    } catch (error) {
      onNotify?.(`批注删除失败：${error?.message ?? error}`)
    }
  }, [refreshAnnotations, onNotify])

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

  const toggleSplit = React.useCallback(() => {
    if (!splitRef.current) {
      // Entering split: the second pane starts from the FIRST pane's current
      // position, not from page 1.
      splitInitialStateRef.current = paneViewsRef.current[0]
    }
    setSplit(previous => !previous)
    setActivePane(0)
  }, [])

  const toggleAxis = React.useCallback(() => {
    setAxis(previous => {
      const next = previous === 'h' ? 'v' : 'h'
      try { localStorage.setItem(SPLIT_AXIS_STORAGE, next) } catch { /* preference optional */ }
      return next
    })
  }, [])

  const startDividerDrag = React.useCallback((event) => {
    event.preventDefault()
    const root = event.currentTarget.parentElement
    if (!root) return
    const rootRect = root.getBoundingClientRect()
    const onMove = (moveEvent) => {
      const ratio = axis === 'v'
        ? (moveEvent.clientX - rootRect.left) / Math.max(1, rootRect.width)
        : (moveEvent.clientY - rootRect.top) / Math.max(1, rootRect.height)
      setSplitRatio(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [axis])

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

  const paneProps = {
    doc: docRef.current,
    numPages,
    base,
    dimsRef,
    dimsVersion,
    pageDataOf,
    rawDimsOf,
    annotationsByPage,
    attachmentKey,
    refreshAnnotations,
    updateAnnotation,
    deleteAnnotation,
    onNotify,
    onOpenNative,
    openWithApps,
    split,
    onToggleSplit: toggleSplit,
    axis,
    onToggleAxis: toggleAxis,
    color: annoColor,
    onColorChange: setAnnoColor,
    paneViewsRef,
    translateAuto,
  }

  return (
    <div className="lib-pdf-root lib-pv">
      {/* Always mounted so pane 0 keeps its state across split toggles; the
          axis class only flips the flex direction (panes keep theirs). */}
      <div className={`lib-pdf-split ${axis === 'v' ? 'axis-v' : 'axis-h'}`}>
        <ReaderPane
          key="pane-0"
          {...paneProps}
          paneIndex={0}
          isActive={activePane === 0}
          onActivate={() => setActivePane(0)}
          basis={split ? `${(splitRatio * 100).toFixed(1)}%` : null}
          initialView={null}
        />
        {split ? (
          <>
            <div
              className="lib-pdf-divider"
              onMouseDown={startDividerDrag}
              onDoubleClick={() => setSplitRatio(0.5)}
              title="拖动调整分屏比例，双击恢复对半"
            />
            <ReaderPane
              key="pane-1"
              {...paneProps}
              paneIndex={1}
              isActive={activePane === 1}
              onActivate={() => setActivePane(1)}
              basis={null}
              initialView={splitInitialStateRef.current}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}
