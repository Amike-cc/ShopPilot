/**
 * 导航 URL 协议白名单（§10.1）
 *
 * 主进程内所有"从外部拿 URL"的入口都收敛到这里：IPC 参数、页面 window.open、
 * DB 恢复的老 URL、任务引擎 navigate 步骤。只放行 http/https/about，
 * `javascript:` / `file:` / `data:` 等一律抛（调用方决定是报错还是忽略）。
 *
 * 纯函数、无 Electron 依赖，方便单测直接锁定。
 */
export function assertNavigableUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Navigation blocked: invalid URL')
  }
  if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
    throw new Error('Navigation blocked: unsafe URL scheme')
  }
  return parsed.toString()
}
