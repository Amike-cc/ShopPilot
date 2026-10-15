/**
 * 打包态原生模块冒烟（审查报告 P0-3）
 *
 * 用 Electron 运行时以纯 Node 模式（ELECTRON_RUN_AS_NODE=1）装载打包产物里的
 * better-sqlite3，真实建库、建表、读写、关库。这个脚本能挡住两类只会在打包态暴露的问题：
 *   1. 原生模块 ABI 不匹配（node ABI vs electron ABI）；
 *   2. electron-builder 依赖收集漏文件（asar 内 MODULE_NOT_FOUND）。
 *
 * 用法（由 tools/ci/package-smoke.ps1 调用）：
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/ci/packaged-native-smoke.js release/win-unpacked
 */
const path = require('node:path')
const fs = require('node:fs')

const unpackedRoot = process.argv[2] || path.join('release', 'win-unpacked')
const resources = path.join(unpackedRoot, 'resources')

const candidates = [
  path.join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3'),
  path.join(resources, 'app', 'node_modules', 'better-sqlite3')
]
const target = candidates.find((p) => fs.existsSync(p))
if (!target) {
  console.error('[native-smoke] 找不到打包后的 better-sqlite3：')
  for (const p of candidates) console.error('  · ' + p)
  process.exit(1)
}

let Database
try {
  Database = require(target)
} catch (error) {
  console.error(`[native-smoke] better-sqlite3 装载失败（ABI 或依赖收集问题）：${error.message}`)
  process.exit(1)
}

try {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY, v TEXT NOT NULL)')
  db.prepare('INSERT INTO smoke (v) VALUES (?)').run('ok')
  const row = db.prepare('SELECT v FROM smoke WHERE id = 1').get()
  db.close()
  if (!row || row.v !== 'ok') {
    console.error('[native-smoke] SQL 读写结果异常：', row)
    process.exit(1)
  }
} catch (error) {
  console.error(`[native-smoke] SQL 读写失败：${error.message}`)
  process.exit(1)
}

console.log(
  `[native-smoke] 打包态 better-sqlite3 装载成功（electron=${process.versions.electron}，ABI=${process.versions.modules}），SQL 读写正常`
)
process.exit(0)
