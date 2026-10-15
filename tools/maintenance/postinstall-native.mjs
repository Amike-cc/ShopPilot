#!/usr/bin/env node
/**
 * postinstall：① 确保 electron 运行时二进制就绪；② 把原生模块重建到 Electron ABI
 * （2026-10-15 审查 P1-9 / P0-1）
 *
 * 背景（升级到 electron@44 时实测）：
 *   · electron ≥ 某版本起**移除了包内的 postinstall 自动下载**（改为暴露 `install-electron`
 *     bin）——直接 pnpm install 后 node_modules/electron/dist 是空的，dev/打包都用不了；
 *     本脚本在 dist 缺失时调用 electron 自带的 install.js 补齐（尊重 ELECTRON_MIRROR）。
 *   · better-sqlite3 v13 已是跨平台预编译（N-API，Node 与 Electron 同用一份），但为将来
 *     新增的原生依赖保留 @electron/rebuild 步骤——electron-builder 的 install-app-deps
 *     会在有需要时重建，无用时是快速 no-op。
 *   · 直接用 `electron-builder install-app-deps` 写进 package.json 依赖 bin 链接进 PATH——
 *     实测在 pnpm 根 postinstall 时序下出现过 "Command not found"；这里改为 require.resolve
 *     定位包后再用同一个 node 执行 CLI，不依赖 PATH / .bin 软链。
 *
 * 行为约定：
 *   · electron-builder 不在树里（例如 --prod 安装）→ 打印提示并成功退出（不阻断安装）；
 *   · 找到但执行失败 → 以非零退出（宁可装不上，也不要留下静默坏环境）。
 */

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = process.cwd()

/**
 * 确保 electron 运行时二进制就绪（electron@44 起不再自带 postinstall 下载）。
 * 返回说明字符串；失败直接 exit 1（缺运行时属于坏环境）。
 */
function ensureElectronRuntime() {
  const electronDir = path.join(root, 'node_modules', 'electron')
  const distExe = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  if (!existsSync(path.join(electronDir, 'package.json'))) return 'electron 包不在依赖树（跳过）'
  if (existsSync(distExe)) return 'electron 运行时已就绪'
  const installer = path.join(electronDir, 'install.js')
  if (!existsSync(installer)) return 'electron install.js 缺失（跳过）'
  console.log('[postinstall] electron 运行时二进制缺失，调用 electron 自带 install.js 下载…')
  if (process.env.ELECTRON_MIRROR) console.log(`[postinstall] 使用镜像：${process.env.ELECTRON_MIRROR}`)
  const res = spawnSync(process.execPath, [installer], { cwd: electronDir, stdio: 'inherit' })
  if (res.error || res.status !== 0) {
    console.error('[postinstall] electron 运行时下载失败。网络受限时可设置 ELECTRON_MIRROR（如 https://npmmirror.com/mirrors/electron/）后重跑 pnpm install。')
    process.exit(res.status || 1)
  }
  return existsSync(distExe) ? 'electron 运行时已安装' : 'electron 运行时安装后仍缺失（请检查安装输出）'
}

function resolveElectronBuilderCli() {
  const readPkg = (pkgPath) => {
    try {
      return JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf8'))
    } catch {
      return null
    }
  }
  const cliFromPkg = (pkgPath, pkg) => {
    if (!pkg) return null
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin['electron-builder']
    if (!binRel) return null
    const cli = path.join(path.dirname(pkgPath), binRel)
    return existsSync(cli) ? cli : null
  }

  // 1) 最直接：读项目根下的实体（pnpm 布局里是软链，跟随即可）。
  //    注意不能 require.resolve('electron-builder/package.json')：该包 exports 映射
  //    未导出 package.json，会抛 ERR_PACKAGE_PATH_NOT_EXPORTED（实测踩过）。
  const direct = cliFromPkg(
    path.join(root, 'node_modules', 'electron-builder', 'package.json'),
    readPkg(path.join(root, 'node_modules', 'electron-builder', 'package.json'))
  )
  if (direct) return direct

  // 2) 兜底：按 node 解析包入口，再向上找 package.json（应对非标准布局）。
  try {
    let dir = path.dirname(require.resolve('electron-builder', { paths: [root] }))
    for (let i = 0; i < 6; i++) {
      const pkgPath = path.join(dir, 'package.json')
      const cli = cliFromPkg(pkgPath, readPkg(pkgPath))
      if (cli) return cli
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* 树里没有 electron-builder */
  }
  return null
}

console.log(`[postinstall] ① electron 运行时：${ensureElectronRuntime()}`)

const cli = resolveElectronBuilderCli()
if (!cli) {
  console.warn('[postinstall] 未在依赖树中找到 electron-builder，跳过原生模块重建（--prod 安装属预期）')
  process.exit(0)
}

console.log(`[postinstall] 按 Electron ABI 重建原生模块（install-app-deps）…`)
const res = spawnSync(process.execPath, [cli, 'install-app-deps'], {
  cwd: root,
  stdio: 'inherit'
})
if (res.error) {
  console.error(`[postinstall] 无法启动 electron-builder：${res.error.message}`)
  process.exit(1)
}
if (res.status !== 0) {
  console.error(`[postinstall] 原生模块重建失败（exit=${res.status}）。`)
  console.error('[postinstall] 常见原因：本机缺少 VS C++ 生成工具。见 docs/INSTALL.md「原生模块」一节。')
  process.exit(res.status ?? 1)
}
console.log('[postinstall] 原生模块已重建到 Electron ABI')
process.exit(0)
