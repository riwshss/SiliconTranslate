// Renders the toolbar icon (rounded teal square + "original / dashed translation" lines)
// to PNG with signed-distance anti-aliasing. Zero dependencies: node:zlib only.
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

// Shapes in a 0..1 unit square.
const roundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const TEAL_A = [24, 178, 154]
const TEAL_B = [11, 112, 99]

function sample(x, y, size) {
  const small = size <= 16
  if (roundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.23) > 0) return null
  const t = Math.min(Math.max((x + y) / 2, 0), 1)
  let color = mix(TEAL_A, TEAL_B, t)
  // Original text line (solid) and translation line (dashed), plus a short line.
  const lines = small
    ? [[0.5, 0.33, 0.27, 0.075]]
    : [[0.47, 0.33, 0.25, 0.06], [0.37, 0.48, 0.15, 0.06]]
  const isText = lines.some(([cx, cy, hw, hh]) => roundRect(x, y, cx, cy, hw, hh, hh) <= 0)
  const dashY = small ? 0.66 : 0.7
  const dashH = small ? 0.075 : 0.045
  const dashes = small ? [[0.32, 0.12], [0.68, 0.12]] : [[0.3, 0.08], [0.5, 0.08], [0.7, 0.08]]
  const isDash = dashes.some(([cx, hw]) => roundRect(x, y, cx, dashY, hw, dashH, dashH) <= 0)
  if (isText) color = [255, 255, 255]
  else if (isDash) color = mix(color, [255, 255, 255], 0.72)
  return color
}

function render(size) {
  const out = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, size)
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
  writeFileSync(`${OUT_DIR}/icon-${size}.png`, encodePng(size, render(size)))
  console.log(`icon-${size}.png`)
}
