// Renders the toolbar icon (Silk & Ink: indigo rounded square, a white "original" line and a gold
// silk thread for the translation) to PNG with supersampled anti-aliasing. Zero dependencies:
// node:zlib only.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const SIZES = [16, 32, 48, 128]
const OUT_DIR = 'static/icons'
const SS = 4 // supersampling per axis

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Shapes in a 0..1 unit square (the drawn mark, before any store padding).
const roundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const segmentDistance = (x, y, [ax, ay], [bx, by]) => {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0), 1)
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

// Silk & Ink (docs/DESIGN.md §8): indigo ink, white original line, gold silk thread.
const INK_A = [0x2f, 0x4c, 0x9a]
const INK_B = [0x1f, 0x35, 0x70]
const WHITE = [255, 255, 255]
const SILK = [0xe0, 0xbc, 0x7a]

/** The two lines' heights: further apart at 16 px, where 2 px lines would otherwise merge. */
const layout = (size) => (size <= 16 ? { top: 0.31, bottom: 0.69 } : { top: 0.37, bottom: 0.63 })

/**
 * The original is a short white line across the top half. The translation is a gold thread that
 * leaves its end, bends down on the right and runs back horizontally underneath it (cubic Bézier,
 * then a straight segment).
 */
function shapes({ top, bottom }) {
  const [p0, p1, p2, p3] = [[0.6, top], [0.8, top], [0.8, bottom], [0.6, bottom]]
  const curve = Array.from({ length: 33 }, (_, i) => {
    const t = i / 32
    const u = 1 - t
    const at = (k) => u ** 3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t ** 3 * p3[k]
    return [at(0), at(1)]
  })
  return { original: [[0.26, top], [0.6, top]], silk: [...curve, [0.3, bottom]] }
}
const SHAPES = new Map()
const shapesFor = (size) => {
  const key = size <= 16 ? 'small' : 'large'
  if (!SHAPES.has(key)) SHAPES.set(key, shapes(layout(size)))
  return SHAPES.get(key)
}
const distanceToPath = (x, y, path) => Math.min(...path.slice(1).map((point, i) => segmentDistance(x, y, path[i], point)))

/**
 * Colour at (x, y) of the mark, or null outside it. Small icons (16, 32 px) drop the gradient and
 * draw both lines at least 2 px wide so they stay legible.
 */
function sample(x, y, size) {
  if (roundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return null
  const isSmall = size <= 32
  const half = isSmall ? Math.max(1.1 / size, 0.045) : 0.035
  const { original, silk } = shapesFor(size)
  if (segmentDistance(x, y, ...original) <= half) return WHITE
  if (distanceToPath(x, y, silk) <= half * (isSmall ? 1 : 0.85)) return SILK
  return isSmall ? INK_A : mix(INK_A, INK_B, Math.min(Math.max((x + y) / 2, 0), 1))
}

/**
 * `padding`: transparent margin in px on every side. The Chrome Web Store wants a 96 px mark on a
 * 128 px canvas; toolbar sizes use the whole canvas.
 */
function render(size, padding = 0) {
  const inner = size - padding * 2
  const out = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS - padding) / inner
          const v = (py + (sy + 0.5) / SS - padding) / inner
          const c = u >= 0 && u <= 1 && v >= 0 && v <= 1 ? sample(u, v, inner) : null
          if (!c) continue
          r += c[0]; g += c[1]; b += c[2]; a++
        }
      }
      const i = (py * size + px) * 4
      out[i] = a ? Math.round(r / a) : 0
      out[i + 1] = a ? Math.round(g / a) : 0
      out[i + 2] = a ? Math.round(b / a) : 0
      out[i + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return out
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of SIZES) {
  writeFileSync(`${OUT_DIR}/icon-${size}.png`, encodePng(size, render(size, size === 128 ? 16 : 0)))
  console.log(`icon-${size}.png`)
}
// Popup header logo: 28 px shown, drawn at 2× without store padding.
writeFileSync(`${OUT_DIR}/logo-56.png`, encodePng(56, render(56)))
console.log('logo-56.png')
