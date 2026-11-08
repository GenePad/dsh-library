// Regenerate the Word Ribbon icons:  node tools/generate-word-icons.mjs
//
// Everything is drawn from primitives in a 32x32 design grid, rendered at 8x
// supersampling and box-downsampled to the final PNG size. No image library:
// the PNG writer uses only node:zlib. Large Ribbon buttons use 32px, small
// buttons (and the "?" help buttons) use 16px, matching Zotero's template.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(here, '../assets/word/icons')
const DESIGN = 32
const SS = 8                       // supersample factor -> 256x256 canvas
const CANVAS = DESIGN * SS

const BLUE = [47, 111, 235, 255]
const GREY = [140, 149, 159, 255]
const RED = [207, 34, 46, 255]
const WHITE = [255, 255, 255, 255]
const CLEAR = [0, 0, 0, 0]

function canvas() {
  const buf = new Uint8Array(CANVAS * CANVAS * 4)
  return {
    buf,
    put(px, py, color) {
      if (px < 0 || py < 0 || px >= CANVAS || py >= CANVAS) return
      const i = (py * CANVAS + px) * 4
      buf[i] = color[0]; buf[i + 1] = color[1]
      buf[i + 2] = color[2]; buf[i + 3] = color[3]
    },
    // All shape helpers work in design units and walk the affected pixels.
    fill(x, y, w, h, color) {
      for (let py = Math.floor(y * SS); py < Math.ceil((y + h) * SS); py++) {
        for (let px = Math.floor(x * SS); px < Math.ceil((x + w) * SS); px++) {
          this.put(px, py, color)
        }
      }
    },
    rect(x, y, w, h, t, color, r = 0) {
      const psd = (px, py) => {
        const x0 = x + t / 2, y0 = y + t / 2
        const x1 = x + w - t / 2, y1 = y + h - t / 2
        const cx = Math.min(Math.max(px, x0 + r), x1 - r)
        const cy = Math.min(Math.max(py, y0 + r), y1 - r)
        const dx = px - cx, dy = py - cy
        const inside = px >= x0 - r && px <= x1 + r && py >= y0 - r && py <= y1 + r
        const d = Math.sqrt(dx * dx + dy * dy)
        return inside && d >= r - t / 2 && d <= r + t / 2
      }
      this.pixels(x - t, y - t, w + 2 * t, h + 2 * t, psd, color)
    },
    circle(cx, cy, r, color, inner = 0) {
      this.pixels(cx - r - 1, cy - r - 1, 2 * r + 2, 2 * r + 2, (x, y) => {
        const d = Math.hypot(x - cx, y - cy)
        return d <= r && d >= inner
      }, color)
    },
    line(x1, y1, x2, y2, t, color) {
      const vx = x2 - x1, vy = y2 - y1
      const len2 = vx * vx + vy * vy
      this.pixels(Math.min(x1, x2) - t, Math.min(y1, y2) - t,
        Math.abs(vx) + 2 * t, Math.abs(vy) + 2 * t, (x, y) => {
          const u = len2 ? Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / len2)) : 0
          return Math.hypot(x - (x1 + u * vx), y - (y1 + u * vy)) <= t / 2
        }, color)
    },
    arc(cx, cy, r, t, fromDeg, toDeg, color) {
      this.pixels(cx - r - t, cy - r - t, 2 * (r + t), 2 * (r + t), (x, y) => {
        const d = Math.hypot(x - cx, y - cy)
        if (Math.abs(d - r) > t / 2) return false
        let a = Math.atan2(y - cy, x - cx) * 180 / Math.PI
        if (a < 0) a += 360
        let f = ((fromDeg % 360) + 360) % 360
        let e = ((toDeg % 360) + 360) % 360
        if (e < f) e += 360
        return a >= f && a <= e || a + 360 >= f && a + 360 <= e
      }, color)
    },
    triangle(a, b, c, color) {
      const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
      this.pixels(Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]),
        Math.max(a[0], b[0], c[0]) - Math.min(a[0], b[0], c[0]),
        Math.max(a[1], b[1], c[1]) - Math.min(a[1], b[1], c[1]), (x, y) => {
          const p = [x, y]
          const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a)
          return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
        }, color)
    },
    pixels(x, y, w, h, predicate, color) {
      for (let py = Math.floor(y * SS); py <= Math.ceil((y + h) * SS); py++) {
        for (let px = Math.floor(x * SS); px <= Math.ceil((x + w) * SS); px++) {
          if (predicate(px / SS, py / SS)) this.put(px, py, color)
        }
      }
    },
  }
}

const ICONS = {
  // 32px: large buttons
  dshCitation: { size: 32, draw(c) {
    c.rect(2, 3, 28, 21, 2.4, BLUE, 4)
    c.triangle([9, 23], [9, 30], [16, 23], BLUE)
    c.triangle([11, 23], [11, 27.5], [14.6, 23], CLEAR)
    c.circle(11.5, 11.5, 2.1, BLUE)
    c.line(10.4, 12.4, 8.6, 16.5, 1.8, BLUE)
    c.circle(20.5, 11.5, 2.1, BLUE)
    c.line(19.4, 12.4, 17.6, 16.5, 1.8, BLUE)
    c.line(9, 19.5, 23, 19.5, 1.6, GREY)
  } },
  dshBibliography: { size: 32, draw(c) {
    for (const y of [4, 13, 22]) {
      c.fill(3, y, 4.5, 4.5, BLUE)
      c.line(10, y + 2.2, 29, y + 2.2, 2, GREY)
    }
  } },
  dshBibEdit: { size: 32, draw(c) {
    // Same bibliography list as dshBibliography, compressed to the upper left,
    // overlaid by a red pencil pointing at the entries (edit-in-place).
    for (const y of [3.5, 10, 16.5]) {
      c.fill(3, y, 4, 4, BLUE)
      c.line(9.5, y + 2, 20, y + 2, 1.8, GREY)
    }
    c.line(19, 27, 27.5, 18.5, 4.5, RED)
    c.triangle([14.2, 29.8], [19.8, 28.2], [15.6, 24.0], RED)
    c.line(26.3, 19.7, 28.7, 17.3, 4.5, GREY)
  } },
  // 16px: small buttons
  dshDocPrefs: { size: 16, draw(c) {
    c.circle(16, 16, 9, BLUE, 5.5)
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4
      c.line(16 + Math.cos(a) * 8.5, 16 + Math.sin(a) * 8.5,
        16 + Math.cos(a) * 12.5, 16 + Math.sin(a) * 12.5, 3, BLUE)
    }
    c.circle(16, 16, 3, CLEAR)
  } },
  dshRefresh: { size: 16, draw(c) {
    // Standard "recalculate" glyph: an open ring that ends at 12 o'clock,
    // continued by a solid arrowhead pointing right (clockwise travel).
    c.arc(16, 16.5, 9.5, 3, 330, 630, BLUE)
    c.triangle([24, 7], [16, 2.4], [16, 11.6], BLUE)
  } },
  dshUnlink: { size: 16, draw(c) {
    c.arc(9, 16, 6, 2.6, 100, 260, BLUE)
    c.arc(23, 16, 6, 2.6, -80, 80, BLUE)
    c.line(16, 3, 16, 29, 2, RED)
    c.fill(13, 14, 6, 4, CLEAR)
    c.line(13, 12.5, 19, 19.5, 1.6, RED)
  } },
  dshExplorer: { size: 16, draw(c) {
    c.circle(13, 13, 8, BLUE, 5.5)
    c.line(18.5, 18.5, 28, 28, 3.4, BLUE)
    c.line(9, 11, 16, 11, 1.5, GREY)
    c.line(9, 15, 15, 15, 1.5, GREY)
  } },
  dshHelp: { size: 16, draw(c) {
    c.circle(16, 16, 13, BLUE)
    c.arc(16, 13, 5.2, 2.5, 185, 355, WHITE)
    c.line(20.8, 12.6, 16, 18, 2.5, WHITE)
    c.line(16, 17.5, 16, 19.6, 2.5, WHITE)
    c.circle(16, 23.2, 2.1, WHITE)
  } },
}

// ---- minimal RGBA PNG writer ------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePNG(size, rgba) {
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4)
    raw[row] = 0 // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, row + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
/** Box-downsample the supersampled canvas, alpha-weighted to avoid dark fringes. */
function downsample(buf, size) {
  const out = new Uint8Array(size * size * 4)
  const box = CANVAS / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, r = 0, g = 0, b = 0
      for (let sy = Math.floor(y * box); sy < (y + 1) * box; sy++) {
        for (let sx = Math.floor(x * box); sx < (x + 1) * box; sx++) {
          const i = (sy * CANVAS + sx) * 4
          const pa = buf[i + 3] / 255
          a += pa; r += buf[i] * pa; g += buf[i + 1] * pa; b += buf[i + 2] * pa
        }
      }
      const o = (y * size + x) * 4
      out[o] = a > 0 ? Math.round(r / a) : 0
      out[o + 1] = a > 0 ? Math.round(g / a) : 0
      out[o + 2] = a > 0 ? Math.round(b / a) : 0
      out[o + 3] = Math.round(a / (box * box) * 255)
    }
  }
  return out
}

fs.mkdirSync(OUT, { recursive: true })
for (const [name, spec] of Object.entries(ICONS)) {
  const c = canvas()
  spec.draw(c)
  const png = encodePNG(spec.size, downsample(c.buf, spec.size))
  fs.writeFileSync(path.join(OUT, `${name}.png`), png)
  console.log(`${name}.png  ${spec.size}x${spec.size}  ${png.length} bytes`)
}
