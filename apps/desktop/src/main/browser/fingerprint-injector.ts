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
import { logMain } from '../services/logger'
import { hashSeed } from '../stores/profile-seed'
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
  /** canvas/audio 噪声种子：由 storeId 确定性派生（同店稳定、跨店不同），不落库 */
  noiseSeed?: number | null
}

interface TabReg {
  wc: WebContents
  attached: boolean
  /** document-start 注入脚本的 CDP 标识（注销时要撤掉，否则一直跟着这个 WebContents） */
  scriptId?: string | null
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
    // canvas/audio 噪声种子：按 storeId 确定性派生（同店稳定、跨店不同），不占库列
    noiseSeed: hashSeed(`noise:${storeId}`),
    screenWidth: row.screen_width ?? null,
    screenHeight: row.screen_height ?? null,
    colorDepth: row.color_depth ?? null,
    hardwareConcurrency: row.hardware_concurrency ?? null,
    webglVendor: row.webgl_vendor ?? null,
    webglRenderer: row.webgl_renderer ?? null
  }
}

/**
 * 从 UA 推 `navigator.platform`：**必须全平台映射**，不能只认 Windows。
 * 旧实现只处理 `/Windows/`，macOS/Linux 档案下 `navigator.platform` 会保留宿主真实值（如 Win32），
 * 与 `userAgentData.platform`、`sec-ch-ua-platform` 三者互相矛盾（2026-10-16 审查 P1）。
 */
export function platformFromUa(userAgent: string | null | undefined): string | null {
  const ua = String(userAgent || '')
  if (!ua) return null
  if (/Windows/i.test(ua)) return 'Win32'
  if (/iPhone|iPod/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad' // iPadOS 的桌面模式 UA 里会带 Macintosh，先判 iPad
  if (/Android/i.test(ua)) return 'Linux armv8l'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'MacIntel'
  if (/CrOS/i.test(ua)) return 'Linux x86_64'
  if (/Linux/i.test(ua)) return 'Linux x86_64'
  return null // 认不出来就不覆盖（宁可保留真实值，也不给一个自相矛盾的常量）
}

/** 与 UA 平台自洽的高熵常量：macOS 不能报 x86（Apple Silicon 机型下自相矛盾） */
function highEntropyConstants(userAgent: string | null | undefined): { architecture: string; bitness: string; platformVersion: string } {
  const ua = String(userAgent || '')
  if (/Macintosh|Mac OS X|iPhone|iPad/i.test(ua)) return { architecture: 'arm', bitness: '64', platformVersion: '15.0.0' }
  if (/Android|Linux/i.test(ua)) return { architecture: 'x86', bitness: '64', platformVersion: '15.0.0' }
  return { architecture: 'x86', bitness: '64', platformVersion: '15.0.0' }
}

/** 注入主世界脚本：覆盖 navigator/screen/WebGL（不暴露任何 Electron/IPC 句柄，§10.1） */
export function buildInjectScript(o: FpOverrides): string {
  const payload = {
    ...o,
    clientHints: o.userAgent ? parseUaClientHints(o.userAgent) : null,
    // 平台名与高熵常量都从 UA 推，保证 navigator.platform / userAgentData / sec-ch-ua-platform 三者同源
    platform: platformFromUa(o.userAgent),
    highEntropy: highEntropyConstants(o.userAgent),
    // 与 Session 层 Accept-Language 用**同一个列表**（session-manager 发的是 `${language},en-US`）：
    // 界面里 navigator.languages 只有一个元素时，一句比对就能发现环境被改写（2026-10-16 审查 P2）
    languages: o.language ? [o.language, 'en-US'] : null,
    // deviceMemory 没有档案字段：按核心数给一个自洽值（Chromium 只暴露 0.25/0.5/1/2/4/8）
    deviceMemory: o.hardwareConcurrency && o.hardwareConcurrency >= 8 ? 8 : (o.hardwareConcurrency ? 4 : null)
  }
  return `(() => {
  // 装过就不再装：注册时会对"当前文档"补一次注入，和 document-start 钩子可能在同一文档上撞车，
  // 重复执行会把 Function.prototype.toString 一层层包下去
  if (globalThis.__fpReady) return;
  globalThis.__fpReady = true;
  const P = ${JSON.stringify(payload)};
  // Chromium 只暴露 0.25/0.5/1/2/4/8 这几档，越界的值本身就是特征
  const clampDeviceMemory = (v) => [0.25, 0.5, 1, 2, 4, 8].includes(v) ? v : 8;
  try {
    // ① 改写的 getter 必须伪装成原生：平台只要一句
    //    Object.getOwnPropertyDescriptor(Navigator.prototype,'userAgent').get.toString()
    //    就能看出是不是 [native code]（2026-10-16 审查 P1）。这里统一登记 + 代理 toString。
    const nativeToString = Function.prototype.toString;
    const masked = new WeakMap();
    const mask = (fn, label) => { try { masked.set(fn, 'function ' + (label || fn.name || '') + '() { [native code] }'); } catch (e) {} return fn; };
    const toStringProxy = new Proxy(nativeToString, {
      apply: (target, thisArg, args) => {
        const m = masked.get(thisArg);
        return m !== undefined ? m : Reflect.apply(target, thisArg, args);
      }
    });
    mask(toStringProxy, 'toString');
    try { Object.defineProperty(Function.prototype, 'toString', { value: toStringProxy, writable: true, configurable: true }); } catch (e) {}
    const define = (target, prop, getter, label) => {
      try { Object.defineProperty(target, prop, { get: mask(getter, label || prop), configurable: true }); } catch (e) {}
    };

    if (P.userAgent) define(navigator, 'userAgent', () => P.userAgent, 'get userAgent');
    // 自动化痕迹：即使没开 --enable-automation 也显式声明为 false
    define(navigator, 'webdriver', () => false, 'get webdriver');
    if (P.language) {
      define(navigator, 'language', () => P.language, 'get language');
      define(navigator, 'languages', () => P.languages || [P.language], 'get languages');
    }
    if (P.hardwareConcurrency) define(navigator, 'hardwareConcurrency', () => P.hardwareConcurrency, 'get hardwareConcurrency');
    if (P.deviceMemory) define(navigator, 'deviceMemory', () => clampDeviceMemory(P.deviceMemory), 'get deviceMemory');
    if (P.platform) define(navigator, 'platform', () => P.platform, 'get platform');
    if (P.screenWidth) {
      define(screen, 'width', () => P.screenWidth, 'get width');
      define(screen, 'availWidth', () => P.screenWidth, 'get availWidth');
    }
    if (P.screenHeight) {
      define(screen, 'height', () => P.screenHeight, 'get height');
      // 任务栏高度不再硬编码 40：按屏幕高度给一档自洽值并 clamp（<40 的屏幕曾算出负数，
      // 一行断言就能检出 —— 2026-10-16 审查 P2），同时补齐 availTop/availLeft
      const taskbar = P.screenHeight >= 900 ? 48 : 40;
      define(screen, 'availHeight', () => Math.max(1, P.screenHeight - taskbar), 'get availHeight');
      define(screen, 'availTop', () => 0, 'get availTop');
      define(screen, 'availLeft', () => 0, 'get availLeft');
    }
    if (P.colorDepth) {
      define(screen, 'colorDepth', () => P.colorDepth, 'get colorDepth');
      define(screen, 'pixelDepth', () => P.colorDepth, 'get pixelDepth');
    }
    if (P.userAgent && P.clientHints) {
      const parsed = P.clientHints;
      define(navigator, 'userAgentData', () => ({
        brands: parsed.brands, mobile: parsed.mobile, platform: parsed.platform,
        // 只回调用方**请求**的键（真实现就是这样，多回键本身就是特征），
        // 且常量与 UA 平台自洽（macOS 不能报 x86；model 用空串而不是空格 —— 2026-10-16 审查 P1）
        getHighEntropyValues: mask(function (hints) {
          const requested = Array.isArray(hints) ? hints : [];
          const all = {
            architecture: P.highEntropy.architecture,
            bitness: P.highEntropy.bitness,
            brands: parsed.brands,
            fullVersionList: parsed.brands,
            mobile: parsed.mobile,
            model: '',
            platform: parsed.platform,
            platformVersion: P.highEntropy.platformVersion,
            wow64: false
          };
          const out = {};
          for (const key of requested) { if (key in all) out[key] = all[key] }
          return Promise.resolve(out);
        }, 'getHighEntropyValues')
      }), 'get userAgentData');
    }
    if (P.webglVendor || P.webglRenderer) {
      // 打补丁的标记用**无描述 Symbol**：属性名不能带品牌串（曾用带产品名的属性名，
      // 页面一行 Object.keys 就能看出被本软件改过 —— 2026-10-16 审查；说明写在本函数 JSDoc 里，
      // 这份脚本是要注入页面的字符串，里面不留任何品牌串）
      const PATCHED = Symbol();
      const patch = (proto) => {
        if (!proto || proto[PATCHED]) return;
        try { Object.defineProperty(proto, PATCHED, { value: true }); } catch (e) { return }
        const orig = proto.getParameter;
        const patched = mask(function (pname) {
          if (P.webglVendor && (pname === 37445 || pname === 7936)) return P.webglVendor;
          if (P.webglRenderer && (pname === 37446 || pname === 7937)) return P.webglRenderer;
          return orig.call(this, pname);
        }, 'getParameter');
        try { Object.defineProperty(proto, 'getParameter', { value: patched, writable: true, configurable: true }); } catch (e) {}
      };
      // 只用 window.* 取构造器：裸全局在某些上下文里不存在，会让整段补丁静默失效
      // （注意：这段是**要注入页面执行的 JS 字符串**，里面不能出现 TS 语法）
      const gl1 = window.WebGLRenderingContext;
      const gl2 = window.WebGL2RenderingContext;
      if (gl1 && gl1.prototype) patch(gl1.prototype);
      if (gl2 && gl2.prototype) patch(gl2.prototype);
    }
    // ② canvas / audio 噪声（2026-10-16 审查 P0：此前完全没有噪声，画布与音频指纹就是宿主真值）。
    //    种子由主进程按 storeId 派生：**同店每次渲染都一样**（否则页面自己前后对比就能发现），
    //    **跨店不同**（否则多店仍可被并成一个实体）。只扰动"读出来的数据"，
    //    不动渲染结果本身 —— 页面正常显示/我们自己的截图都不受影响。
    if (P.noiseSeed != null) {
      try {
        let seed = (P.noiseSeed >>> 0) || 1;
        const rnd = () => {
          seed = (seed + 0x6D2B79F5) >>> 0;
          let t = seed;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        // 少量像素各偏 ±1：肉眼不可见，但两次采样哈希不同（且同店稳定）
        const perturb = (data) => {
          const times = Math.min(4, Math.max(1, Math.floor(data.length / 4000)));
          for (let i = 0; i < times; i++) {
            const idx = (Math.floor(rnd() * (data.length / 4)) * 4) >>> 0;
            if (idx + 2 >= data.length) continue;
            data[idx] = (data[idx] + (rnd() < 0.5 ? 255 : 1)) & 255;
          }
          return data;
        };
        if (typeof HTMLCanvasElement !== 'undefined') {
          const CanvasProto = HTMLCanvasElement.prototype;
          const ctxProto = typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype : null;
          if (ctxProto && !ctxProto.__noised) {
            const origGet = ctxProto.getImageData;
            try {
              Object.defineProperty(ctxProto, '__noised', { value: true });
              Object.defineProperty(ctxProto, 'getImageData', { value: mask(function () {
                const img = origGet.apply(this, arguments);
                try { perturb(img.data) } catch (e) {}
                return img;
              }, 'getImageData'), writable: true, configurable: true });
            } catch (e) {}
          }
          const origToDataURL = CanvasProto.toDataURL;
          try {
            Object.defineProperty(CanvasProto, 'toDataURL', { value: mask(function () {
              try {
                const ctx = this.getContext && this.getContext('2d');
                if (!ctx || !this.width || !this.height) return origToDataURL.apply(this, arguments);
                const img = ctx.getImageData(0, 0, this.width, this.height);
                perturb(img.data);
                const copy = document.createElement('canvas');
                copy.width = this.width; copy.height = this.height;
                copy.getContext('2d').putImageData(img, 0, 0);
                return origToDataURL.apply(copy, arguments);
              } catch (e) { return origToDataURL.apply(this, arguments) }
            }, 'toDataURL'), writable: true, configurable: true });
          } catch (e) {}
        }
        if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype && !AudioBuffer.prototype.__noised) {
          const origChannel = AudioBuffer.prototype.getChannelData;
          try {
            Object.defineProperty(AudioBuffer.prototype, '__noised', { value: true });
            Object.defineProperty(AudioBuffer.prototype, 'getChannelData', { value: mask(function (channel) {
              const data = origChannel.call(this, channel);
              try {
                for (let i = 0; i < 8 && data.length; i++) {
                  const idx = Math.floor(rnd() * data.length);
                  data[idx] = data[idx] + (rnd() - 0.5) * 1e-7; // 听不出来，但频域指纹变了
                }
              } catch (e) {}
              return data;
            }, 'getChannelData'), writable: true, configurable: true });
          } catch (e) {}
        }
        if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype) {
          const origFloat = AnalyserNode.prototype.getFloatFrequencyData;
          try {
            Object.defineProperty(AnalyserNode.prototype, 'getFloatFrequencyData', { value: mask(function (array) {
              origFloat.call(this, array);
              try {
                for (let i = 0; i < 4 && array.length; i++) array[Math.floor(rnd() * array.length)] += (rnd() - 0.5) * 1e-4;
              } catch (e) {}
            }, 'getFloatFrequencyData'), writable: true, configurable: true });
          } catch (e) {}
        }
      } catch (e) { /* 噪声装不上不影响其它改写 */ }
    }
    // 不往页面 console 打任何东西：日志前缀本身就是指纹（失败由主进程 profile:verify 如实呈现）
  } catch (e) { /* 注入失败不写页面日志，主进程侧 verify 会标记未验证 */ }
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
  // 之前这里每次导航都重新 `setTimezoneOverride`，但 `reg.attached` 门闩让它成为死代码；
  // 同时 attach 失败完全静默。现在：失败写日志、detach 时复位状态（等下一次机会重挂）。
  wc.debugger.on?.('detach', () => { reg.attached = false; reg.scriptId = null })
  tryTimezone()

  /**
   * document-start 注入（2026-10-16 审查 P0）：原来的注入挂在 `dom-ready`，那是**页面脚本早就跑完
   * 之后**——风控 SDK 在解析期读到的 navigator/screen/WebGL 全是真机值，之后再被改写，等于
   * "自相矛盾"，比不伪装更可疑；而且注册时那次 executeJavaScript 打在 about:blank 上，会被首次导航丢弃。
   *
   * 时区本来就要挂调试器，所以这里零额外成本：用 CDP `Page.addScriptToEvaluateOnNewDocument`
   * 在**每个新文档、每个框架**（含 iframe）的页面脚本之前注入。attach 不可用（调试器被别的会话占用/
   * 总开关关闭）时返回 false，由调用方退回 dom-ready 注入。
   */
  const injectAtDocumentStart = (): boolean => {
    if (cdpDisabled || wc.isDestroyed()) return false
    try {
      if (!reg.attached) {
        wc.debugger.attach('1.3')
        reg.attached = true
      }
      if (!reg.scriptId) {
        wc.debugger
          .sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectScript(o), runImmediately: true })
          .then((result: unknown) => {
            reg.scriptId = String((result as { identifier?: unknown })?.identifier || '') || null
          })
          .catch((error: unknown) => {
            logMain('warn', `[fingerprint] document-start 注入失败 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
          })
      }
      return true
    } catch (error) {
      // 已有其他调试会话等 → 交给 dom-ready 兜底，但必须留痕（此前是静默失败）
      logMain('warn', `[fingerprint] 调试器不可用，退回 dom-ready 注入 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
      reg.attached = false
      return false
    }
  }

  // 主世界注入兜底：调试器不可用时，每次导航在 DOM 就绪时应用（覆盖跨文档；iframe 覆盖不到）
  const inject = () => {
    try {
      if (wc.isDestroyed()) return
      wc.executeJavaScript(buildInjectScript(o), true).catch((error: unknown) => {
        logMain('warn', `[fingerprint] 注入失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
      })
    } catch { /* ignore */ }
  }

  if (!injectAtDocumentStart()) {
    wc.on('dom-ready', inject)
  }
  // 无论走哪条腿，都立刻对**当前已存在的文档**注入一次：注册往往发生在页面已经开始加载之后，
  // 只挂"新文档"钩子会让当前这一页留着真机值（真机验收抓到：某店 languages=zh-CN,zh-Hans-CN
  // 就是没被覆盖的宿主真值，而另一家店已被覆盖成 zh-CN,en-US）
  inject()
  wc.on('did-navigate', tryTimezone)
}

export function unregisterFingerprintTarget(storeId: string, tabId: string): void {
  const m = tabs.get(storeId)
  if (!m) return
  const reg = m.get(tabId)
  if (reg) {
    try {
      if (reg.attached && !reg.wc.isDestroyed()) {
        // 先撤掉 document-start 脚本再 detach：不然脚本会一直跟着这个 WebContents
        if (reg.scriptId) {
          reg.wc.debugger
            .sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: reg.scriptId })
            .catch(() => { /* 已经随导航/销毁失效 */ })
        }
        reg.wc.debugger.detach()
      }
    } catch { /* ignore */ }
    m.delete(tabId)
  }
  if (m.size === 0) tabs.delete(storeId)
}

/** 实测结果：**必须区分"没取到"的原因**，否则界面会把"超时"和"注入没生效"混成一句话 */
export interface ActualValuesResult {
  state: 'ok' | 'timeout' | 'exception' | 'no-tab'
  values: Record<string, any> | null
}

/**
 * 采集页面内实际值（profile:verify 用）。
 *
 * 2026-10-16 审查 P1：原来只返回 `Record|null`，超时/异常/没标签页三种情况全被压成 null，
 * 面板只能一律显示"未验证"，用户无从知道是"没生效"还是"没来得及测"；异常还被 `catch { continue }`
 * 静默吞掉。现在返回 state + 原因，并写主进程日志。
 */
export async function collectActualValues(storeId: string): Promise<ActualValuesResult> {
  const m = tabs.get(storeId)
  if (!m) return { state: 'no-tab', values: null }
  for (const reg of m.values()) {
    if (reg.wc.isDestroyed() || reg.wc.isCrashed?.()) continue
    try {
      const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 4000))
      const result = await Promise.race([
        // 异步探针：UA-CH 的高熵值要 await（真实现就是异步的）
        reg.wc.executeJavaScript(`(async () => {
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl');
          let wv = null, wr = null;
          if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            wv = gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR);
            wr = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
          }
          let uaChPlatform = null, uaChArch = null;
          try {
            const uad = navigator.userAgentData;
            if (uad) {
              uaChPlatform = uad.platform ?? null;
              const high = await uad.getHighEntropyValues(['architecture']);
              uaChArch = high && high.architecture ? high.architecture : null;
            }
          } catch (e) { /* UA-CH 不可用就留 null，交给 verify 如实标记 */ }
          return {
            userAgent: navigator.userAgent,
            language: navigator.language,
            languages: (navigator.languages || []).join(','),
            platform: navigator.platform,
            deviceMemory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
            uaChPlatform, uaChArch,
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
      if (result === 'timeout') {
        logMain('warn', `[fingerprint] 实测超时（4s）：store=${storeId}`)
        continue
      }
      if (result) return { state: 'ok', values: result as Record<string, any> }
      logMain('warn', `[fingerprint] 实测脚本在页面里抛错：store=${storeId}`)
      continue
    } catch (error) {
      logMain('warn', `[fingerprint] 实测执行失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
      continue
    }
  }
  // 有标签但都没测成：区分"超时"还是"异常"无从细分时，如实给 timeout（页面通常只是慢）
  return { state: m.size > 0 ? 'timeout' : 'no-tab', values: null }
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

  const collected = await collectActualValues(storeId)
  const actual = collected.values
  const item = (field: string, expected: any, actualVal: any): ProfileVerifyItem => ({
    field, expected, actual: actualVal ?? null,
    state: (actualVal != null && String(actualVal) === String(expected)) ? 'verified' : 'unverified'
  })

  // 取不到实测值时先把原因如实摆出来：界面不该把"超时/没标签页"伪装成"逐项未验证"
  const items: ProfileVerifyItem[] = []
  if (collected.state !== 'ok') {
    items.push({
      field: '实测取值',
      expected: '打开店铺页面后实测',
      actual: collected.state === 'no-tab' ? '没有已注册的标签页' : '页面 4 秒内未响应（可能正在加载）',
      state: 'unverified'
    })
  }

  items.push(
    item('userAgent', p.user_agent, actual?.userAgent),
    item('language', p.language, actual?.language),
    item('timezone', p.timezone, actual?.timezone),
    item('screen', `${p.screen_width}x${p.screen_height}`, actual?.screen),
    item('hardwareConcurrency', p.hardware_concurrency, actual?.hardwareConcurrency),
    // 2026-10-16 审查 P1：以下四项此前**完全没验**，而它们恰好是最容易互相矛盾的地方
    item('platform', platformFromUa(p.user_agent), actual?.platform),
    item('languages', p.language ? `${p.language},en-US` : null, actual?.languages),
    item('deviceMemory', p.hardware_concurrency ? (p.hardware_concurrency >= 8 ? 8 : 4) : null, actual?.deviceMemory),
    // 期望值必须与注入脚本同源：`navigator.userAgentData.platform` 是 'Windows'，
    // 而 `navigator.platform` 是 'Win32' —— 真机验收抓到这两者被我错配在一起（恒 unverified）
    item('uaClientHints', parseUaClientHints(p.user_agent)?.platform ?? null, actual?.uaChPlatform)
  )
  if (p.color_depth != null) items.push(item('colorDepth', p.color_depth, actual?.colorDepth))
  if (p.webgl_vendor) items.push(item('webglVendor', p.webgl_vendor, actual?.webglVendor))
  if (p.webgl_renderer) items.push(item('webglRenderer', p.webgl_renderer, actual?.webglRenderer))
  return items
}
