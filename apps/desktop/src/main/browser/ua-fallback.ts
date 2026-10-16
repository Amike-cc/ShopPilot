/**
 * 无指纹档案时的兜底 User-Agent（2026-10-16 浏览器审查 N-1）。
 *
 * 为什么必须兜底：session 默认 UA 含 `ShopPilot/x Electron/44`——电商平台风控
 * 对非主流 UA 有标记逻辑，泄漏即增加店铺风控风险。存量店/档案被删时
 * `configureSession` 走这里，保证**任何店铺 session 都不带 Electron 痕迹**。
 *
 * 纯函数、不依赖 Electron：可被单测钉死（不含应用标识、版本对齐本机 Chromium）。
 */
export function buildFallbackUserAgent(chromeVersion: string): string {
  const version = /^\d+(\.\d+)*$/.test(String(chromeVersion || '')) ? chromeVersion : '126.0.0.0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
}
