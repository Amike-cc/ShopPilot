/**
 * 导出「软件相关文件与代码」到目标文件夹（只增不改：源目录只读，目标目录不删除已有内容）
 * 排除：依赖、构建产物、安装包、缓存、日志、截图、诊断压缩包等与源码无关的东西
 * 用法：node export-copy.js
 * 报告：./artifacts/maintenance/copy-export-report.txt
 */
const fs = require('fs')
const path = require('path')

const SRC = path.resolve(__dirname, '../..')
const DST = 'D:\\code\\电商店铺浏览器'
const REPORT_DIR = path.join(SRC, 'artifacts', 'maintenance')
const REPORT = path.join(REPORT_DIR, 'copy-export-report.txt')

// 目录名（任意层级命中即跳过）
const SKIP_DIRS = new Set([
  'node_modules', 'out', 'dist', 'release', 'Cache', '.vite', '.cache',
  'logs', 'log', '.git', '.svn', 'coverage', '.nyc_output', 'temp', 'tmp',
  '.electron-builder-cache', 'userData', '__pycache__', '.idea', '.vscode-test'
])

// 文件后缀（任意层级命中即跳过）
const SKIP_EXT = new Set(['.log', '.zip', '.7z', '.exe', '.msi', '.dmp', '.bak', '.tmp'])

// 仅顶层排除的（子目录里的同名文件要保留，比如 build/ 下的图标）
const SKIP_ROOT_FILES = [/\.png$/i, /\.jpg$/i, /^copy-export-report\.txt$/i, /^_repair\.js$/i]

const copied = []
const skipped = []
let bytes = 0

function skipRootFile(name) { return SKIP_ROOT_FILES.some(re => re.test(name)) }

function walk(dir, rel = '') {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { skipped.push([path.join(rel, '*'), 'READ_ERROR ' + e.code]); return }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name)
    const r = rel ? path.join(rel, ent.name) : ent.name
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) { skipped.push([r + '\\', '目录排除']); continue }
      walk(abs, r)
      continue
    }
    const ext = path.extname(ent.name).toLowerCase()
    if (SKIP_EXT.has(ext)) { skipped.push([r, '后缀排除' + ext]); continue }
    if (!rel && skipRootFile(ent.name)) { skipped.push([r, '顶层非源码']); continue }
    const out = path.join(DST, r)
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.copyFileSync(abs, out)
      const st = fs.statSync(abs)
      bytes += st.size
      copied.push(r)
    } catch (e) {
      skipped.push([r, 'COPY_ERROR ' + e.code])
    }
  }
}

console.log('源目录 :', SRC)
console.log('目标   :', DST)
const dstExisted = fs.existsSync(DST)
const before = dstExisted ? fs.readdirSync(DST) : []
fs.mkdirSync(DST, { recursive: true })
walk(SRC)

// 按顶层归类统计
const byTop = {}
for (const f of copied) {
  const top = f.includes(path.sep) ? f.split(path.sep)[0] : '(根目录文件)'
  byTop[top] = byTop[top] || { files: 0, bytes: 0 }
  byTop[top].files++
  try { byTop[top].bytes += fs.statSync(path.join(DST, f)).size } catch {}
}

// 关键文件校验
const KEY = [
  'package.json',
  'apps/desktop/src/main/index.ts',
  'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue',
  'packages/shared/src/index.ts',
  'packages/shared/src/constants/platforms.ts',
  'electron-builder.yml'
]
const keyStatus = KEY.map(k => `${fs.existsSync(path.join(DST, k)) ? 'OK  ' : '缺失'} ${k}`)

const lines = []
lines.push('导出报告（软件相关文件与代码）')
lines.push('时间: ' + new Date().toLocaleString())
lines.push('源: ' + SRC)
lines.push('目标: ' + DST)
lines.push('目标目录导出前是否已存在: ' + (dstExisted ? '是，原有条目 ' + before.length + ' 个（未删除任何原有内容）' : '否，本次新建'))
lines.push('复制文件总数: ' + copied.length + '，合计 ' + (bytes / 1048576).toFixed(2) + ' MB')
lines.push('')
lines.push('== 按顶层归类 ==')
for (const [k, v] of Object.entries(byTop).sort((a, b) => b[1].files - a[1].files)) {
  lines.push(`  ${k.padEnd(28)} ${String(v.files).padStart(5)} 文件  ${(v.bytes / 1048576).toFixed(2)} MB`)
}
lines.push('')
lines.push('== 关键文件校验 ==')
keyStatus.forEach(s => lines.push('  ' + s))
lines.push('')
lines.push('== 未复制的条目（排除清单） ==')
const uniqSkip = {}
for (const [f, why] of skipped) {
  const key = why.startsWith('目录排除') ? '目录: ' + f : '文件: ' + f
  uniqSkip[key] = why
}
for (const [k, why] of Object.entries(uniqSkip).sort()) lines.push('  ' + k + '   ← ' + why)
lines.push('')
lines.push('== 未复制的顶层文件清单（非源码/日志/截图/压缩包） ==')
try {
  fs.readdirSync(SRC, { withFileTypes: true })
    .filter(e => e.isFile() && (SKIP_EXT.has(path.extname(e.name).toLowerCase()) || skipRootFile(e.name)))
    .forEach(e => lines.push('  ' + e.name))
} catch {}
fs.mkdirSync(REPORT_DIR, { recursive: true })
fs.writeFileSync(REPORT, lines.join('\n'), 'utf8')
console.log('\n' + lines.join('\n'))
console.log('\n报告已写入: ' + REPORT)
