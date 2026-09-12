/**
 * 环境指纹注入器 - §4.3 字段实现机制表
 * | User-Agent   → session.setUserAgent（含 acceptLanguages）
 * | UA-CH 头     → webRequest.onBeforeSendHeaders 成对改写（禁止只改 UA 造成矛盾）
 * | 时区         → CDP Emulation.setTimezoneOverride（webContents.debugger；attach 仅限本应用创建的 WebContents）
 * | 语言         → UA acceptLanguages + 主世界注入 navigator.language(s)
 * | 屏幕/色深/CPU→ 主世界注入覆盖 navigator/screen 只读属性
 * | WebGL 展示   → 主世界注入 patch getParameter
 * 任一机制失败 → 该字段如实标记"未验证"，不伪造。
 */

import { WebContents } from 'electron'
import { getDatabase } from '../db/database'
import type { ProfileVerifyItem } from '../stores/profile-manager'

interface FpOverrides {
  userAgent: string | null
  language: string | null
  timezone: string | null
  screenWidth: number | null
  screenHeight: number | null
  colorDepth: number | null
  hardwareConcurrency: number | null
  webglVendor: string | null
  webglRenderer: string | null
}

interface TabReg {
  wc: WebContents
  attached: boolean
}

/** storeId → tabId → 注册表（window-manager 在标签生命周期内调用） */
const tabs = new Map<string, Map<string, TabReg>>()

/** 从 UA 字符串解析 UA-CH 元数据（Chrome 主版本/平台） */
export function parseUaClientHints(ua: string): {
  brands: Array<{ brand: string; version: string }>
  fullVersionList: Array<{ brand: string; version: string }>
  mobile: boolean
  platform: string
} | null {
  const chromeMatch = ua.match(/Chrome\/(\d+)(\.(\d+)(?:\.(\d+))?)/)
  if (!chromeMatch) return null
  const major = chromeMatch[1]
  const full = `${chromeMatch[1]}.${chromeMatch[3] || '0'}.${chromeMatch[4] || '0'}.0`
  let platform = 'Windows'
  if (/Android/i.test(ua)) platform = 'Android'
  else if (/iPhone|iPad/i.test(ua)) platform = 'iOS'
  else if (/Mac OS X/i.test(ua)) platform = 'macOS'
  else if (/Linux/i.test(ua)) platform = 'Linux'
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: platform === 'Windows' ? 'Not_A Brand' : 'Not)A;Brand', version: '24' },
    { brand: 'Google Chrome', version: major }
  ]
  return {
    brands,
    fullVersionList: [
      { brand: 'Chromium', version: full },
      { brand: 'Not_A Brand', version: '24.0.0.0' },
      { brand: 'Google Chrome', version: full }
    ],
    mobile: /Mobile/i.test(ua),
    platform
  }
}

function readOverrides(storeId: string): FpOverrides | null {
  const db = getDatabase()
  const row = db.prepare(`
    SELECT user_agent, language, timezone, screen_width, screen_height,
           color_depth, hardware_concurrency, webgl_vendor, webgl_renderer
    FROM browser_profiles WHERE store_id = ?
  `).get(storeId) as any
  if (!row) return null
  return {
    userAgent: row.user_agent || null,
    language: row.language || null,
    timezone: row.timezone || null,
    screenWidth: row.screen_width ?? null,
    screenHeight: row.screen_height ?? null,
    colorDepth: row.color_depth ?? null,
    hardwareConcurrency: row.hardware_concurrency ?? null,
    webglVendor: row.webgl_vendor ?? null,
    webglRenderer: row.webgl_renderer ?? null
  }
}

/** 注入主世界脚本：覆盖 navigator/screen/WebGL（不暴露任何 Electron/IPC 句柄，§10.1） */
function buildInjectScript(o: FpOverrides): string {
  const payload = {
    ...o,
    clientHints: o.userAgent ? parseUaClientHints(o.userAgent) : null
  }
  return `(() => {
  const P = ${JSON.stringify(payload)};
  try {
    if (P.userAgent) Object.defineProperty(navigator, 'userAgent', { get: () => P.userAgent, configurable: true });
    if (P.language) {
      Object.defineProperty(navigator, 'language', { get: () => P.language, configurable: true });
      Object.defineProperty(navigator, 'languages', { get: () => [P.language], configurable: true });
    }
    if (P.hardwareConcurrency) Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => P.hardwareConcurrency, configurable: true });
    if (P.screenWidth) {
      Object.defineProperty(screen, 'width', { get: () => P.screenWidth, configurable: true });
      Object.defineProperty(screen, 'availWidth', { get: () => P.screenWidth, configurable: true });
    }
    if (P.screenHeight) {
      Object.defineProperty(screen, 'height', { get: () => P.screenHeight, configurable: true });
      Object.defineProperty(screen, 'availHeight', { get: () => P.screenHeight - 40, configurable: true });
    }
    if (P.colorDepth) {
      Object.defineProperty(screen, 'colorDepth', { get: () => P.colorDepth, configurable: true });
      Object.defineProperty(screen, 'pixelDepth', { get: () => P.colorDepth, configurable: true });
    }
    if (P.userAgent && P.clientHints) {
      const parsed = P.clientHints;
      Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => ({
        brands: parsed.brands, mobile: parsed.mobile, platform: parsed.platform,
        getHighEntropyValues: () => Promise.resolve(Object.assign({}, parsed, { platformVersion: '15.0.0', architecture: 'x86', bitness: '64', model: ' ' }))
      })});
    }
    if (P.webglVendor || P.webglRenderer) {
      const patch = (proto) => {
        if (!proto || proto.__shopilotPatched) return;
        proto.__shopilotPatched = true;
        const orig = proto.getParameter;
        proto.getParameter = function (pname) {
          if (P.webglVendor && (pname === 37445 || pname === 7936)) return P.webglVendor;
          if (P.webglRenderer && (pname === 37446 || pname === 7937)) return P.webglRenderer;
          return orig.call(this, pname);
        };
      };
      if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);
      if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
    }
  } catch (e) { /* 注入失败静默，verify 将标记未验证 */ }
})();`
}

/**
 * 标签页注册（window-manager 在 createTab 调用）
 */
export function registerFingerprintTarget(storeId: string, tabId: string, wc: WebContents): void {
  if (!tabs.has(storeId)) tabs.set(storeId, new Map())
  const reg: TabReg = { wc, attached: false }
  tabs.get(storeId)!.set(tabId, reg)

  const o = readOverrides(storeId)
  if (!o) return

  // CDP 时区覆盖（attach 失败 → 字段保持未验证，不影响其余能力）
  const cdpDisabled = process.env.SHOPILOT_DISABLE_CDP_FP === '1'
  const tryTimezone = () => {
    if (cdpDisabled || reg.attached || !o.timezone) return
    try {
      if (wc.isDestroyed()) return
      wc.debugger.attach('1.3')
      reg.attached = true
      wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: o.timezone }).catch(() => {
        reg.attached = false
      })
    } catch {
      // 已有其他调试会话等 → 放弃时区覆盖
      reg.attached = false
    }
  }
  tryTimezone()

  // 主世界注入：每次导航在 DOM 就绪时重新应用（覆盖跨文档）
  const inject = () => {
    try {
      if (!wc.isDestroyed()) wc.executeJavaScript(buildInjectScript(o), true).catch(() => { /* ignore */ })
    } catch { /* ignore */ }
  }
  wc.on('dom-ready', inject)
  wc.on('did-navigate', tryTimezone)
  inject()
}

export function unregisterFingerprintTarget(storeId: string, tabId: string): void {
  const m = tabs.get(storeId)
  if (!m) return
  const reg = m.get(tabId)
  if (reg) {
    try { if (reg.attached && !reg.wc.isDestroyed()) reg.wc.debugger.detach() } catch { /* ignore */ }
    m.delete(tabId)
  }
  if (m.size === 0) tabs.delete(storeId)
}

/**
 * 采集页面内实际值（profile:verify 用）
 */
export async function collectActualValues(storeId: string): Promise<Record<string, any> | null> {
  const m = tabs.get(storeId)
  if (!m) return null
  for (const reg of m.values()) {
    if (reg.wc.isDestroyed() || reg.wc.isCrashed?.()) continue
    try {
      const timeout = new Promise<null>(r => setTimeout(() => r(null), 4000))
      const result = await Promise.race([
        reg.wc.executeJavaScript(`(() => {
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl');
          let wv = null, wr = null;
          if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            wv = gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR);
            wr = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
          }
          return {
            userAgent: navigator.userAgent,
            language: navigator.language,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            screen: screen.width + 'x' + screen.height,
            colorDepth: screen.colorDepth,
            hardwareConcurrency: navigator.hardwareConcurrency,
            webglVendor: wv, webglRenderer: wr
          };
        } catch (e) { return null }
      })()`, true),
        timeout
      ])
      if (result) return result
      console.log('[fp] collectActualValues: executeJavaScript 超时，跳过该 tab')
    } catch { continue }
  }
  return null
}

/**
 * 逐字段 实际值/期望值/已验证|未验证（§6.6；无法验证如实标 unverified，不伪造）
 */
export async function verifyStoreFingerprint(storeId: string): Promise<ProfileVerifyItem[]> {
  const db = getDatabase()
  const p = db.prepare(`
    SELECT user_agent, language, timezone, screen_width, screen_height,
           color_depth, hardware_concurrency, webgl_vendor, webgl_renderer
    FROM browser_profiles WHERE store_id = ?
  `).get(storeId) as any
  if (!p) throw new Error('PROFILE_NOT_FOUND')

  const actual = await collectActualValues(storeId)
  const item = (field: string, expected: any, actualVal: any): ProfileVerifyItem => ({
    field, expected, actual: actualVal ?? null,
    state: (actualVal != null && String(actualVal) === String(expected)) ? 'verified' : 'unverified'
  })

  const items: ProfileVerifyItem[] = [
    item('userAgent', p.user_agent, actual?.userAgent),
    item('language', p.language, actual?.language),
    item('timezone', p.timezone, actual?.timezone),
    item('screen', `${p.screen_width}x${p.screen_height}`, actual?.screen),
    item('hardwareConcurrency', p.hardware_concurrency, actual?.hardwareConcurrency)
  ]
  if (p.color_depth != null) items.push(item('colorDepth', p.color_depth, actual?.colorDepth))
  if (p.webgl_vendor) items.push(item('webglVendor', p.webgl_vendor, actual?.webglVendor))
  if (p.webgl_renderer) items.push(item('webglRenderer', p.webgl_renderer, actual?.webglRenderer))
  return items
}
