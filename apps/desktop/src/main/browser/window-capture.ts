/**
 * 标签页截图：优先 DOM <webview> 宿主抓帧，退回 guest capturePage，再退回调试器抓帧。
 * 2026-10-19 P1 重构：由 window-manager.ts 等价搬迁（实现逐字保留）。
 */

import { logMain } from '../services/logger'
import { hostWindow, waitForTabWebContents } from './window-browser-core'

/**
 * DOM <webview> 的 Renderer 专属截图后备。
 *
 * Windows 上 guest WebContents 的 capturePage 可能拿不到 DOM 合成帧；<webview>
 * 元素本身的 capturePage 才知道它在宿主中的真实可见区域。只允许按主进程已知
 * 的 store/tab 属性选目标，并给宿主求值加上限，避免页面卡住时拖死 IPC。
 */
function capturePageWithTimeout(wc: Electron.WebContents, rect?: Electron.Rectangle): Promise<Electron.NativeImage | null> {
  return Promise.race([
    wc.capturePage(rect, { stayHidden: false }).catch(() => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 1800))
  ])
}

async function captureDomWebview(storeId: string, tabId: string, format: string): Promise<Buffer | null> {
  const host = hostWindow
  if (!host || host.isDestroyed() || host.webContents.isDestroyed()) return null
  const storeLiteral = JSON.stringify(storeId)
  const tabLiteral = JSON.stringify(tabId)
  const script = `(async () => {
    const el = Array.from(document.querySelectorAll('webview')).find(node =>
      node.getAttribute('data-store-id') === ${storeLiteral} && node.getAttribute('data-tab-id') === ${tabLiteral}
    );
    if (!el || typeof el.capturePage !== 'function') return null;
    const image = await el.capturePage();
    if (!image || image.isEmpty()) return null;
    if (${JSON.stringify(format)} === 'jpeg') {
      const bytes = image.toJPEG(85);
      return 'data:image/jpeg;base64,' + bytes.toString('base64');
    }
    return image.toDataURL();
  })()`
  try {
    const value = await Promise.race([
      host.webContents.executeJavaScript(script, true),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 5000))
    ])
    if (typeof value !== 'string' || !value) return null
    const base64 = value.replace(/^data:image\/\w+;base64,/, '')
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length < 100) return null
    return bytes
  } catch (error) {
    const message = String((error as Error)?.message || error).slice(0, 180)
    logMain('warn', `[browser:capture] DOM webview 后备失败 store=${storeId} tab=${tabId}: ${message}`)
    return null
  }
}

/**
 * 当 guest 仍在 DOM 中但宿主工作区暂时被移出视口时，Chromium 的
 * WebContents.capturePage 会按“当前可见区域”返回空图。guest 自己的
 * DevTools Page.captureScreenshot 不依赖宿主元素的屏幕坐标，适合做最后的
 * 截图后备。复用已有 fingerprint 调试会话，只有没有会话时才短暂 attach。
 */
async function captureGuestWithDebugger(wc: Electron.WebContents, format: string): Promise<Buffer | null> {
  if (wc.isDestroyed()) return null
  let attachedHere = false
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
      attachedHere = true
    }
    await wc.debugger.sendCommand('Page.enable').catch(() => undefined)
    const variants = format === 'jpeg'
      ? [{ format: 'jpeg', quality: 85, captureBeyondViewport: false, fromSurface: false }, { format: 'jpeg', quality: 85, captureBeyondViewport: false }]
      : [{ format: 'png', captureBeyondViewport: false, fromSurface: false }, { format: 'png', captureBeyondViewport: false }]
    for (const params of variants) {
      const result = await Promise.race([
        wc.debugger.sendCommand('Page.captureScreenshot', params),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2500))
      ]) as { data?: string } | null
      const data = typeof result?.data === 'string' ? result.data : ''
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length >= 100) return bytes
    }
    return null
  } catch (error) {
    const message = String((error as Error)?.message || error).slice(0, 180)
    logMain('warn', `[browser:capture] guest DevTools 后备失败: ${message}`)
    return null
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach() } catch { /* guest 正在销毁 */ }
    }
  }
}

/**
 * 页面截图 - §6.2 browser:capture
 */
export async function captureTab(storeId: string, tabId: string, format: string = 'png'): Promise<string> {
  const wc = await waitForTabWebContents(storeId, tabId)
  const deadline = Date.now() + 5000
  while (wc.isLoadingMainFrame() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // reload 的 loading 标志会在主文档完成前沿很短的窗口内变成 false；对 DOM
  // <webview> 来说这时合成器可能还没有产出第一帧，紧接着 capturePage 会得到空图。
  // 等 readyState + 两个 requestAnimationFrame，把截图请求放到实际绘制之后。
  try {
    const remaining = Math.max(100, Math.min(1500, deadline - Date.now()))
    await Promise.race([
      wc.executeJavaScript(`new Promise(resolve => {
        const ready = () => {
          if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', ready, { once: true }); return }
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }
        ready()
      })`),
      new Promise(resolve => setTimeout(resolve, remaining))
    ])
  } catch { /* 页面正在导航/被销毁时由后面的空图错误如实处理 */ }
  // DOM <webview> 的可见区域大小由 Renderer 的 CSS 决定，主进程看不到；不带 rect 才是
  // Electron 的"整块可见页面"语义。带上一份窗口级 bounds 会把页面坐标之外的大片空白也截进来。
  let image = await capturePageWithTimeout(wc)
  let png = image?.toPNG() || Buffer.alloc(0)
  while ((!image || image.isEmpty() || png.length < 100) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    image = await capturePageWithTimeout(wc)
    png = image?.toPNG() || Buffer.alloc(0)
  }
  if (!image || image.isEmpty() || png.length < 100) {
    // 某些 Windows/WebView 合成路径只接受明确的内容矩形；无 rect 会得到空 NativeImage。
    try {
      const size = await Promise.race([
        wc.executeJavaScript('({ width: window.innerWidth, height: window.innerHeight })') as Promise<{ width?: number, height?: number }>,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 700))
      ])
      const width = Number(size && 'width' in size ? size.width : 0)
      const height = Number(size && 'height' in size ? size.height : 0)
      if (width > 0 && height > 0) {
        image = await capturePageWithTimeout(wc, { x: 0, y: 0, width, height })
        png = image?.toPNG() || Buffer.alloc(0)
      }
    } catch { /* 继续尝试 DevTools 后备 */ }
    if (image && !image.isEmpty() && png.length >= 100) return format === 'jpeg' ? image.toJPEG(85).toString('base64') : png.toString('base64')
    const debuggerFallback = await captureGuestWithDebugger(wc, format)
    if (debuggerFallback) return debuggerFallback.toString('base64')
    const fallback = await captureDomWebview(storeId, tabId, format)
    if (fallback && fallback.length >= 100) return fallback.toString('base64')
    throw new Error('页面当前不可见，无法截图（CAPTURE_EMPTY：该店铺页面被隐藏或未渲染，请先切到该店铺页面）')
  }
  return format === 'jpeg' ? image.toJPEG(85).toString('base64') : png.toString('base64')
}

