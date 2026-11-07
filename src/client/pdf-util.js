// Pure geometry/text helpers for the built-in pdf.js viewer: a small page
// matrix (the PageViewport math for viewBox [0,0,w,h], replicated so overlays,
// the text layer and selections all share ONE pdf-space ↔ screen mapping,
// including per-page UI rotation), selection-line merging, the per-item text
// layer builder and the full-text search index.
//
// All annotation positions and find-mark rects are stored in PDF USER SPACE
// (y up, origin bottom-left) — the same convention the host extractor
// (src/host/pdf.js) and Zotero's itemAnnotations.position use. Conversion to
// screen happens only at render time through the page matrix.

/** 2×3 matrix multiply: returns m1 ∘ m2 (apply m2 first, then m1). */
function mulMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

function applyTransform(point, m) {
  return [m[0] * point[0] + m[2] * point[1] + m[4], m[1] * point[0] + m[3] * point[1] + m[5]]
}

function applyInverseTransform(point, m) {
  const d = m[0] * m[3] - m[1] * m[2]
  const inverse = [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]
  return applyTransform(point, inverse)
}

/**
 * The pdf.js PageViewport for viewBox [0,0,w,h] at `scale` and `rotation`
 * (multiples of 90°). Returns { width, height, matrix } — width/height are
 * the ROTATED viewport dims at the given scale (what the page box shows).
 */
export function makePageMatrix(rawWidth, rawHeight, scale, rotation) {
  const rot = ((rotation % 360) + 360) % 360
  let a, b, c, d
  if (rot === 180) { a = -1; b = 0; c = 0; d = 1 }
  else if (rot === 90) { a = 0; b = 1; c = 1; d = 0 }
  else if (rot === 270) { a = 0; b = -1; c = -1; d = 0 }
  else { a = 1; b = 0; c = 0; d = -1 }
  const cx = rawWidth / 2
  const cy = rawHeight / 2
  let width, height, offsetX, offsetY
  if (a === 0) {
    offsetX = Math.abs(cy) * scale
    offsetY = Math.abs(cx) * scale
    width = rawHeight * scale
    height = rawWidth * scale
  } else {
    offsetX = Math.abs(cx) * scale
    offsetY = Math.abs(cy) * scale
    width = rawWidth * scale
    height = rawHeight * scale
  }
  return {
    width,
    height,
    matrix: [a * scale, b * scale, c * scale, d * scale, offsetX - a * scale * cx - c * scale * cy, offsetY - b * scale * cx - d * scale * cy],
  }
}

/** PDF user-space rect → normalized view-space rect [left, top, right, bottom] (px). */
export function rectToView(matrix, rect) {
  const [ax, ay] = applyTransform([rect[0], rect[1]], matrix.matrix)
  const [bx, by] = applyTransform([rect[2], rect[3]], matrix.matrix)
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

/** View-space rect (page-local px) → normalized PDF user-space rect. */
export function rectToPdf(matrix, rect) {
  const [ax, ay] = applyInverseTransform([rect[0], rect[1]], matrix.matrix)
  const [bx, by] = applyInverseTransform([rect[2], rect[3]], matrix.matrix)
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

/** Sort a rect's corners so x0<=x1 and y0<=y1. */
export function normalizeRect(rect) {
  return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])]
}

/**
 * Merge selection client rects that sit on the same displayed text line into
 * one box (per-glyph spans make getClientRects return hundreds of fragments).
 * Runs in page-local SCREEN px — the text layer spans are laid out through the
 * full matrix (intrinsic + UI rotation), so lines are horizontal here.
 */
export function mergeLineRects(input) {
  const rects = input
    .filter(rect => rect.right - rect.left >= 1 && rect.bottom - rect.top >= 1)
    .sort((a, b) => a.top - b.top || a.left - b.left)
  const out = []
  for (const rect of rects) {
    const last = out[out.length - 1]
    if (last) {
      const overlap = Math.min(last.bottom, rect.bottom) - Math.max(last.top, rect.top)
      if (overlap >= Math.min(last.bottom - last.top, rect.bottom - rect.top) * 0.5) {
        last.left = Math.min(last.left, rect.left)
        last.right = Math.max(last.right, rect.right)
        last.top = Math.min(last.top, rect.top)
        last.bottom = Math.max(last.bottom, rect.bottom)
        continue
      }
    }
    out.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  }
  return out
}

let measureContext
/** Text advance width in px at the given font (0 when canvas is unavailable, e.g. jsdom). */
function measureWidth(text, fontSizePx, fontFamily) {
  try {
    if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d')
    if (!measureContext) return 0
    const font = `${fontSizePx}px ${fontFamily}`
    if (measureContext.font !== font) measureContext.font = font
    return measureContext.measureText(text).width
  } catch {
    return 0
  }
}

const TEXT_ASCENT = 0.8

/**
 * Rebuild the per-item text layer of one page into `host`. Every text item
 * becomes one absolutely-positioned transparent span whose geometry comes
 * from the page matrix (intrinsic + UI rotation included), so selection
 * always matches what is on screen — this mirrors pdf.js' own TextLayer but
 * positions spans directly in CSS px through OUR matrix instead of the
 * --scale-factor/percentage scheme, which cannot follow per-page UI rotation.
 */
export function buildTextSpans(host, items, styles, matrix, scale) {
  const fragment = document.createDocumentFragment()
  for (const item of items) {
    const str = item.str
    if (!str) continue
    const style = styles?.[item.fontName] ?? {}
    const tx = mulMatrix(matrix.matrix, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    if (!(fontHeight > 0.01)) continue
    let angle = Math.atan2(tx[1], tx[0])
    if (style.vertical) angle += Math.PI / 2
    const straight = Math.abs(angle) < 1e-4
    const ascent = fontHeight * TEXT_ASCENT
    const left = straight ? tx[4] : tx[4] + ascent * Math.sin(angle)
    const top = straight ? tx[5] - ascent : tx[5] - ascent * Math.cos(angle)
    const span = document.createElement('span')
    span.textContent = str
    span.style.left = `${left.toFixed(2)}px`
    span.style.top = `${top.toFixed(2)}px`
    span.style.fontSize = `${fontHeight.toFixed(2)}px`
    span.style.fontFamily = style.fontFamily || 'sans-serif'
    let transform = straight ? '' : `rotate(${(angle * 180 / Math.PI).toFixed(3)}deg)`
    const advance = Number((style.vertical ? item.height : item.width) ?? 0)
    if (advance > 0) {
      const measured = measureWidth(str, fontHeight, span.style.fontFamily)
      if (measured > 0 && Number.isFinite(measured)) {
        const scaleX = (advance * scale / measured).toFixed(4)
        transform = `scaleX(${scaleX})${transform ? ` ${transform}` : ''}`
      }
    }
    if (transform) span.style.transform = transform
    fragment.appendChild(span)
  }
  if (typeof host.replaceChildren === 'function') host.replaceChildren(fragment)
  else {
    host.innerHTML = ''
    host.appendChild(fragment)
  }
}

/**
 * Build the search index of one page: every character of every text item is
 * lower-cased individually (expansion-safe: mapping arrays point each
 * normalized char back to its item + raw offset). Items flagged hasEOL
 * contribute one space so phrases match across line breaks.
 */
export function createPageIndex(items) {
  const chars = []
  const charItem = []
  const charRaw = []
  for (let index = 0; index < items.length; index += 1) {
    const str = items[index].str ?? ''
    for (let offset = 0; offset < str.length; offset += 1) {
      const lowered = str[offset].toLowerCase()
      for (const ch of lowered) {
        chars.push(ch)
        charItem.push(index)
        charRaw.push(offset)
      }
    }
    if (items[index].hasEOL && str.length > 0 && !/\s$/.test(str)) {
      chars.push(' ')
      charItem.push(-1)
      charRaw.push(-1)
    }
  }
  return { items, norm: chars.join(''), charItem, charRaw }
}

/** One matched segment inside a single text item → PDF user-space rect. */
function segmentRect(item, rawStart, rawEnd) {
  const str = item.str ?? ''
  if (rawEnd <= rawStart || rawEnd > str.length || str.length === 0) return null
  const width = Number(item.width ?? 0)
  const height = Math.abs(Number(item.transform?.[3] ?? 0)) || Number(item.height ?? 0) || 12
  if (!(width > 0)) return null
  const [a, b, , , e, f] = item.transform
  const length = Math.hypot(a, b)
  if (!(length > 0)) return null
  const ux = a / length
  const uy = b / length
  const t0 = rawStart / str.length
  const t1 = rawEnd / str.length
  const x0 = e + ux * t0 * width
  const y0 = f + uy * t0 * width
  const x1 = e + ux * t1 * width
  const y1 = f + uy * t1 * width
  // The glyph box extends from the baseline upward (PDF y-up); (-uy, ux) is "up".
  const upx = -uy
  const upy = ux
  const below = -0.2 * height
  const above = 0.85 * height
  const xs = [x0 + upx * below, x0 + upx * above, x1 + upx * below, x1 + upx * above]
  const ys = [y0 + upy * below, y0 + upy * above, y1 + upy * below, y1 + upy * above]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** Rects (PDF user space) of the match covering normalized positions [start, end). */
export function matchRects(index, start, end) {
  const rects = []
  let i = start
  while (i < end) {
    const itemIndex = index.charItem[i]
    if (itemIndex < 0) {
      i += 1
      continue
    }
    const rawStart = index.charRaw[i]
    let j = i + 1
    while (j < end && index.charItem[j] === itemIndex
      && (index.charRaw[j] === index.charRaw[j - 1] || index.charRaw[j] === index.charRaw[j - 1] + 1)) j += 1
    const rect = segmentRect(index.items[itemIndex], rawStart, index.charRaw[j - 1] + 1)
    if (rect) rects.push(rect)
    i = j
  }
  return rects
}

/** Every occurrence of `query` on one page (case-insensitive), oldest first. */
export function findMatches(index, query, pageIndex, limit = Infinity) {
  const needle = [...query.toLowerCase()].join('')
  const out = []
  if (!needle) return out
  const { norm } = index
  let from = 0
  for (;;) {
    const at = norm.indexOf(needle, from)
    if (at === -1 || out.length >= limit) break
    out.push({ pageIndex, start: at, end: at + needle.length, rects: matchRects(index, at, at + needle.length) })
    from = at + 1
  }
  return out
}
