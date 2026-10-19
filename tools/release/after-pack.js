/**
 * electron-builder afterPack 钩子 —— 打包目录体积治理（§21 发布工程）
 *
 * 为什么需要它：
 *   Electron 发行目录里带着 `LICENSES.chromium.html`（约 19.5 MB 的第三方许可证汇编），
 *   它会**原样**进到 win-unpacked 与 NSIS 安装包。当前没有为最终用户提供"浏览开源许可"
 *   的入口，继续随包分发只会把安装包撑大；因此打包完成后删掉它。
 *
 * 设计约束（都是硬要求，改这个文件时别破坏）：
 *   1. **失败不阻断构建**：文件不存在、只读、被占用、权限不足……一律只打日志后继续。
 *      打包是发布流程的关键路径，不能因为"少删一个文件"整个构建挂掉。
 *   2. **跨平台安全**：只在 `appOutDir`（electron-builder 传进来的本次打包输出目录）内部操作，
 *      路径拼接后必须校验 `path.resolve` 仍在 `appOutDir` 之内，避免误删仓库/系统文件。
 *   3. **幂等**：重复打包、`--dir` 与 NSIS 目标先后触发钩子，都不会报错。
 *
 * 钩子签名（electron-builder 26，见 app-builder-lib 的 AfterPackContext）：
 *   afterPack(context) => void | Promise<void>
 *   context.appOutDir    本次打包输出目录（如 release/win-unpacked）
 *   context.electronPlatformName  'win32' | 'darwin' | 'linux'
 *   context.packager.platform.name / context.arch  便于日志
 *
 * 日志前缀 `[after-pack]` 便于在构建输出里检索。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 需要从打包目录中删除的文件（相对 appOutDir，位于代码签名之后、封包之前） */
const REMOVE_FILES = ['LICENSES.chromium.html']

/** 删除单个文件；任何失败都只记日志，绝不抛出 */
function removeQuietly(filePath, appOutDir, log) {
  // 安全校验：解析后的绝对路径必须仍在本次打包输出目录内
  const resolved = path.resolve(filePath)
  const root = path.resolve(appOutDir)
  const rel = path.relative(root, resolved)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    log(`skip ${filePath}（超出打包目录，拒绝删除）`)
    return { removed: false, bytes: 0 }
  }

  let stat
  try {
    stat = fs.statSync(resolved)
  } catch {
    log(`skip ${path.basename(resolved)}（不存在）`)
    return { removed: false, bytes: 0 }
  }
  if (!stat.isFile()) {
    log(`skip ${path.basename(resolved)}（不是文件）`)
    return { removed: false, bytes: 0 }
  }

  try {
    fs.rmSync(resolved, { force: true })
    log(`removed ${path.basename(resolved)}（${(stat.size / 1024 / 1024).toFixed(2)} MB）`)
    return { removed: true, bytes: stat.size }
  } catch (error) {
    // 常见原因：文件被占用（还开着上一轮的安装包/解包目录）、权限不足、杀软短暂锁定。
    // 一律降级为 warn：体积没省下来，但构建继续。
    log(`warn 删除 ${path.basename(resolved)} 失败（不阻断构建）：${String(error && error.message ? error.message : error)}`)
    return { removed: false, bytes: 0 }
  }
}

/**
 * @param {import('app-builder-lib').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  const appOutDir = context && context.appOutDir
  const platform = (context && context.electronPlatformName) || 'unknown'
  const arch = context && context.arch !== undefined ? context.arch : 'unknown'
  const log = message => console.log(`[after-pack] ${message}`)

  if (!appOutDir || typeof appOutDir !== 'string') {
    log('warn 未拿到 appOutDir，跳过体积治理（不阻断构建）')
    return
  }

  log(`开始：platform=${platform} arch=${arch} dir=${appOutDir}`)
  let removedCount = 0
  let freedBytes = 0
  for (const name of REMOVE_FILES) {
    const result = removeQuietly(path.join(appOutDir, name), appOutDir, log)
    if (result.removed) {
      removedCount += 1
      freedBytes += result.bytes
    }
  }
  log(`完成：删除 ${removedCount} 个文件，释放 ${(freedBytes / 1024 / 1024).toFixed(2)} MB`)
}

// 兼容 CJS 直接 require 的场景（electron-builder 读 default / 模块本身均可）
exports.REMOVE_FILES = REMOVE_FILES
