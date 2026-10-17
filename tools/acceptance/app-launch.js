/**
 * Acceptance app launcher.
 *
 * The source Electron runner is useful during development, but on this Windows
 * host it can fail before Chromium creates its lock/DevToolsActivePort. Acceptance
 * should exercise the same final executable users receive. Set
 * SHOPILOT_ACCEPTANCE_APP to override the executable, or set
 * SHOPILOT_ACCEPTANCE_SOURCE=1 to force the source runner.
 */
const path = require('path')
const fs = require('fs')

function resolveApp(root) {
  const override = process.env.SHOPILOT_ACCEPTANCE_APP
  if (override && fs.existsSync(override)) return { executable: override, packaged: true }
  const packaged = path.join(root, 'release', 'win-unpacked', 'ShopPilot.exe')
  if (process.env.SHOPILOT_ACCEPTANCE_SOURCE !== '1' && fs.existsSync(packaged)) {
    // 打包产物可能落后于 out/：验收会静默地跑旧代码（2026-10-17 实测：out 12:40、
    // app.asar 11:32，m1 的失败项在旧包里根本不存在）。只警告不阻断——CI 上先 build 后打包。
    try {
      const outMain = path.join(root, 'apps', 'desktop', 'out', 'main', 'index.js')
      const asar = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar')
      if (fs.existsSync(outMain) && fs.existsSync(asar) && fs.statSync(outMain).mtimeMs > fs.statSync(asar).mtimeMs + 1000) {
        console.warn('[app-launch] 警告：out/ 比 release/win-unpacked 新，验收可能跑的是旧代码；先 pnpm build && electron-builder --dir')
      }
    } catch { /* 仅提示，不影响启动 */ }
    return { executable: packaged, packaged: true }
  }
  return { executable: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), packaged: false }
}

function appArgs(root, app, { port, userData, extra = [] } = {}) {
  const args = []
  if (!app.packaged) args.push(root)
  args.push('--no-sandbox')
  if (port !== undefined && port !== null) args.push(`--remote-debugging-port=${port}`)
  if (userData) args.push(`--user-data-dir=${userData}`)
  args.push(...extra)
  return args
}

module.exports = { resolveApp, appArgs }
