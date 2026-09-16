/**
 * 生成 ShopPilot 应用图标（无第三方依赖：纯 JS 光栅化 + PNG/ICO 编码）
 *
 * 设计对齐 UI 品牌标识（WorkbenchView .brand-logo）：
 *   蓝紫 135° 渐变（#3b82f6 → #8b5cf6）圆角方块 + 白色几何“商”字。
 *
 * 输出：
 *   build/icon.ico                 （electron-builder 默认图标路径，多尺寸）
 *   build/icon.png                 （256×256 预览）
 *   apps/desktop/resources/icon.ico（开发态窗口图标；resources/** 已随包分发）
 *
 * 用法：node make-icon.js
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '../..')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

// ---------- 纯 JS PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

// ---------- 图标光栅化（256 设计空间，SSAA 2×） ----------
function lerp(a, b, t) { return a + (b - a) * t }

/**
 * “商”字形路径：以统一圆头笔画构成，返回 256 空间折线点集。
 * 使用折线而非字体渲染，保证打包机和开发机的图标完全一致。
 */
function shangPathPoints() {
  const pts = []
  const push = (x, y) => pts.push([x, y])
  const line = (x1, y1, x2, y2, count = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 2)) => {
    for (let i = 0; i <= count; i++) {
      const t = i / count
      push(lerp(x1, x2, t), lerp(y1, y2, t))
    }
  }

  // 顶部点、横画与贯穿中轴。
  line(119, 36, 137, 49)
  line(83, 59, 173, 59)
  line(128, 48, 128, 104)
  line(65, 82, 191, 82)

  // 中部“冂”与内框“口”。
  line(79, 101, 177, 101)
  line(79, 101, 79, 166)
  line(177, 101, 177, 166)
  line(101, 117, 155, 117)
  line(101, 117, 101, 149)
  line(155, 117, 155, 149)
  line(101, 149, 155, 149)

  // 底部“八”形收笔，增强小尺寸下的字形辨识度。
  line(88, 163, 66, 194)
  line(168, 163, 190, 194)
  return pts
}

/**
 * 渲染 size×size RGBA Buffer（SSAA：以 2×size 采样后盒式降采样）
 */
function renderIcon(size) {
  const W = size * 2
  const scale = W / 256
  const acc = new Float64Array(W * W * 4) // RGBA 累加（2×2 子采样）

  const path = shangPathPoints().map(([x, y]) => [x * scale, y * scale])
  // 汉字笔画需要留出横竖之间的负空间，较品牌字母更适合 10px 设计笔宽。
  const strokeR = 10 * scale

  // 字形覆盖缓冲（max-blend 圆盘印章）
  const glyph = new Float64Array(W * W)
  const rCeil = Math.ceil(strokeR + 1)
  for (const [px, py] of path) {
    const x0 = Math.max(0, Math.floor(px - rCeil)), x1 = Math.min(W - 1, Math.ceil(px + rCeil))
    const y0 = Math.max(0, Math.floor(py - rCeil)), y1 = Math.min(W - 1, Math.ceil(py + rCeil))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - px, y + 0.5 - py)
        const a = Math.min(1, Math.max(0, strokeR + 0.5 - d))
        if (a > glyph[y * W + x]) glyph[y * W + x] = a
      }
    }
  }

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / scale, v = (y + 0.5) / scale
      // Windows 图标不使用透明角，整张画布保持完全不透明。
      const bgA = 1

      // 135° 渐变 #3b82f6 → #8b5cf6
      const t = Math.min(1, Math.max(0, ((u - 8) + (v - 8)) / 480))
      const gr = lerp(59, 139, t), gg = lerp(130, 92, t), gb = lerp(246, 246, t)

      // 合成：白字覆盖在渐变底上
      const gA = glyph[y * W + x]
      const r = lerp(gr, 255, gA), gcol = lerp(gg, 255, gA), b = lerp(gb, 255, gA)

      const i = (y * W + x) * 4
      acc[i] = r * bgA
      acc[i + 1] = gcol * bgA
      acc[i + 2] = b * bgA
      acc[i + 3] = bgA
    }
  }

  // 2×2 盒式降采样（预乘空间平均后还原）
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y * 2 + dy) * W + (x * 2 + dx)) * 4
          r += acc[i]; g += acc[i + 1]; b += acc[i + 2]; a += acc[i + 3]
        }
      }
      r /= 4; g /= 4; b /= 4; a /= 4
      const o = (y * size + x) * 4
      const al = a > 0 ? a : 1
      out[o] = Math.round(Math.min(255, r / al))
      out[o + 1] = Math.round(Math.min(255, g / al))
      out[o + 2] = Math.round(Math.min(255, b / al))
      // PNG alpha 是 0-255；内部覆盖率使用 0-1，必须转换为不透明字节。
      out[o + 3] = Math.round(Math.min(255, a * 255))
    }
  }
  return out
}

// ---------- ICO 容器（PNG 条目，Vista+ 标准） ----------
function buildICO(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)          // reserved
  header.writeUInt16LE(1, 2)          // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size     // width
    e[1] = size >= 256 ? 0 : size     // height
    e[2] = 0                          // palette
    e[3] = 0                          // reserved
    e.writeUInt16LE(1, 4)             // planes
    e.writeUInt16LE(32, 6)            // bpp
    e.writeUInt32LE(png.length, 8)    // bytes
    e.writeUInt32LE(offset, 12)       // offset
    entries.push(e)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.png)])
}

// ---------- main ----------
function main() {
  const pngs = []
  for (const size of SIZES) {
    console.log(`rendering ${size}x${size} ...`)
    const rgba = renderIcon(size)
    pngs.push({ size, png: encodePNG(size, size, rgba) })
  }
  const ico = buildICO(pngs)
  const png256 = pngs.find(p => p.size === 256).png

  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico)
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png256)
  fs.mkdirSync(path.join(ROOT, 'apps', 'desktop', 'resources'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'apps', 'desktop', 'resources', 'icon.ico'), ico)

  console.log('icon.ico bytes =', ico.length)
  console.log('written: build/icon.ico, build/icon.png, apps/desktop/resources/icon.ico')

  // 自检：ICO 头 + 每个条目指向 PNG 签名
  const n = ico.readUInt16LE(4)
  if (n !== SIZES.length) throw new Error('ICO count mismatch')
  for (let i = 0; i < n; i++) {
    const off = ico.readUInt32LE(6 + 16 * i + 12)
    if (ico.readUInt32BE(off) !== 0x89504e47) throw new Error(`entry ${i} is not PNG @${off}`)
  }
  // 自检：PNG IHDR 尺寸
  if (png256.readUInt32BE(16) !== 256 || png256.readUInt32BE(20) !== 256) throw new Error('PNG256 IHDR bad')
  console.log('self-check OK')
}

main()
