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
  overrides: FpOverrides | null
  /** document-start 注入脚本的 CDP 标识（注销时要撤掉，否则一直跟着这个 WebContents） */
  scriptId?: string | null
  fallbackListenerAttached?: boolean
  active?: boolean
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
  const chromeMatch = ua.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/)
  if (!chromeMatch) return null
  const major = chromeMatch[1]
  const full = `${chromeMatch[1]}.${chromeMatch[2]}.${chromeMatch[3]}.${chromeMatch[4]}`
  let platform = 'Windows'
  if (/Android/i.test(ua)) platform = 'Android'
  else if (/iPhone|iPad/i.test(ua)) platform = 'iOS'
  else if (/Mac OS X/i.test(ua)) platform = 'macOS'
  else if (/Linux/i.test(ua)) platform = 'Linux'
  const greaseBrand = platform === 'Windows' ? 'Not_A Brand' : 'Not)A;Brand'
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: greaseBrand, version: '24' },
    { brand: 'Google Chrome', version: major }
  ]
  return {
    brands,
    fullVersionList: [
      { brand: 'Chromium', version: full },
      { brand: greaseBrand, version: '24.0.0.0' },
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
export function highEntropyConstants(userAgent: string | null | undefined): { architecture: string; bitness: string; platformVersion: string } {
  const ua = String(userAgent || '')
  if (/Macintosh|Mac OS X|iPhone|iPad/i.test(ua)) return { architecture: 'arm', bitness: '64', platformVersion: '15.0.0' }
  if (/Android/i.test(ua)) return { architecture: 'arm', bitness: '64', platformVersion: '15.0.0' }
  if (/CrOS/i.test(ua)) return { architecture: 'x86', bitness: '64', platformVersion: '14500.0.0' }
  if (/Linux/i.test(ua)) return { architecture: 'x86', bitness: '64', platformVersion: '0.0.0' }
  // Windows 的 UA-CH 高熵版本必须和 session-manager 改写的请求头完全一致。
  return { architecture: 'x86', bitness: '64', platformVersion: '10.0.0' }
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
  // 状态只存在本次脚本闭包里，不在 Navigator 上挂 Symbol/自有属性。
  // 真实页面使用 document-start 单次注入；兜底路径由主进程保证监听器幂等。
  const state = { masked: new WeakMap(), canvas: false, canvasGet: null, audio: false, audioSeen: new WeakMap(), analyser: false, webgl: new WeakSet() };
  const P = ${JSON.stringify(payload)};
  // Chromium 只暴露 0.25/0.5/1/2/4/8 这几档，越界的值本身就是特征
  const clampDeviceMemory = (v) => [0.25, 0.5, 1, 2, 4, 8].includes(v) ? v : 8;
  try {
    // ① 改写的 getter 必须伪装成原生：平台只要一句
    //    Object.getOwnPropertyDescriptor(Navigator.prototype,'userAgent').get.toString()
    //    就能看出是不是 [native code]（2026-10-16 审查 P1）。这里统一登记 + 代理 toString。
    const nativeToString = Function.prototype.toString;
    const masked = state.masked;
    const mask = (fn, label) => { try { masked.set(fn, 'function ' + (label || fn.name || '') + '() { [native code] }'); } catch (e) {} return fn; };
    const toStringProxy = new Proxy(nativeToString, {
      apply: (target, thisArg, args) => {
        const m = masked.get(thisArg);
        return m !== undefined ? m : Reflect.apply(target, thisArg, args);
      }
    });
    mask(toStringProxy, 'toString');
    try { Object.defineProperty(Function.prototype, 'toString', { value: toStringProxy, writable: true, configurable: true }); } catch (e) {}
    // 原生 Navigator/Screen 放在 prototype 上；只有测试桩等非原生对象才使用自有 getter。
    // 这样页面无法用 hasOwnProperty/自有 descriptor 识别注入层。
    const navigatorTarget = (typeof Navigator !== 'undefined' && navigator instanceof Navigator) ? Navigator.prototype : navigator;
    const screenTarget = (typeof Screen !== 'undefined' && screen instanceof Screen) ? Screen.prototype : screen;
    const define = (target, prop, getter, label) => {
      try { Object.defineProperty(target, prop, { get: mask(getter, label || prop), configurable: true, enumerable: false }); } catch (e) {}
    };

    if (P.userAgent) define(navigatorTarget, 'userAgent', () => P.userAgent, 'get userAgent');
    // 自动化痕迹：即使没开 --enable-automation 也显式声明为 false
    define(navigatorTarget, 'webdriver', () => false, 'get webdriver');
    if (P.language) {
      define(navigatorTarget, 'language', () => P.language, 'get language');
      define(navigatorTarget, 'languages', () => P.languages || [P.language], 'get languages');
    }
    if (P.hardwareConcurrency) define(navigatorTarget, 'hardwareConcurrency', () => P.hardwareConcurrency, 'get hardwareConcurrency');
    if (P.deviceMemory) define(navigatorTarget, 'deviceMemory', () => clampDeviceMemory(P.deviceMemory), 'get deviceMemory');
    if (P.platform) define(navigatorTarget, 'platform', () => P.platform, 'get platform');
    if (P.screenWidth) {
      define(screenTarget, 'width', () => P.screenWidth, 'get width');
      define(screenTarget, 'availWidth', () => P.screenWidth, 'get availWidth');
    }
    if (P.screenHeight) {
      define(screenTarget, 'height', () => P.screenHeight, 'get height');
      // 任务栏高度不再硬编码 40：按屏幕高度给一档自洽值并 clamp（<40 的屏幕曾算出负数，
      // 一行断言就能检出 —— 2026-10-16 审查 P2），同时补齐 availTop/availLeft
      const taskbar = P.screenHeight >= 900 ? 48 : 40;
      define(screenTarget, 'availHeight', () => Math.max(1, P.screenHeight - taskbar), 'get availHeight');
      define(screenTarget, 'availTop', () => 0, 'get availTop');
      define(screenTarget, 'availLeft', () => 0, 'get availLeft');
    }
    if (P.colorDepth) {
      define(screenTarget, 'colorDepth', () => P.colorDepth, 'get colorDepth');
      define(screenTarget, 'pixelDepth', () => P.colorDepth, 'get pixelDepth');
    }
    // 视口字段必须和实际窗口保持同一套度量：屏幕尺寸是显示器档案，视口尺寸仍取
    // Chromium 当前窗口的真实布局值，避免 screen 与任务引擎看到的 innerWidth 自相矛盾。
    //
    // **必须每次读取都取实时值**：早期实现把 document-start 时的 innerWidth 固化成常量，
    // 用户收起侧栏/缩放窗口后页面仍按旧宽度排版（响应式布局失效），且 innerWidth 与
    // outerWidth/visualViewport 互相矛盾（2026-10-17 真机验收：容器 778→498，innerWidth 不动）。
    // 这里先保存原生 getter，再定义返回实时值的 getter；读不到/为 0 时才回落到启动时快照。
    const nativeGetter = (obj, prop) => {
      try {
        const own = Object.getOwnPropertyDescriptor(obj, prop);
        if (own && typeof own.get === 'function') return own.get;
        let proto = Object.getPrototypeOf(obj);
        while (proto) {
          const d = Object.getOwnPropertyDescriptor(proto, prop);
          if (d && typeof d.get === 'function') return d.get;
          proto = Object.getPrototypeOf(proto);
        }
      } catch (e) {}
      return null;
    };
    const readLive = (obj, prop, fallback) => {
      const get = nativeGetter(obj, prop);
      // 没有原生 getter（测试桩等非常规宿主）时先取快照，绝不能回读 obj[prop]：
      // 那已经是下面 define 出来的本 getter，会无限递归直到栈溢出。
      const snapshot = get ? null : Number(obj[prop]);
      return () => {
        try {
          const v = get ? Number(get.call(obj)) : snapshot;
          if (Number.isFinite(v) && v > 0) return v;
        } catch (e) {}
        return fallback;
      };
    };
    const viewportWidth = Number(window.innerWidth) > 0 ? Number(window.innerWidth) : (P.screenWidth || 1);
    const viewportHeight = Number(window.innerHeight) > 0 ? Number(window.innerHeight) : (P.screenHeight || 1);
    define(window, 'innerWidth', readLive(window, 'innerWidth', viewportWidth), 'get innerWidth');
    define(window, 'innerHeight', readLive(window, 'innerHeight', viewportHeight), 'get innerHeight');
    define(window, 'outerWidth', readLive(window, 'outerWidth', viewportWidth), 'get outerWidth');
    define(window, 'outerHeight', readLive(window, 'outerHeight', viewportHeight), 'get outerHeight');
    define(window, 'devicePixelRatio', readLive(window, 'devicePixelRatio', 1), 'get devicePixelRatio');
    try {
      const vv = window.visualViewport;
      if (vv) {
        define(vv, 'width', readLive(vv, 'width', viewportWidth), 'get width');
        define(vv, 'height', readLive(vv, 'height', viewportHeight), 'get height');
        define(vv, 'scale', readLive(vv, 'scale', 1), 'get scale');
      }
    } catch (e) {}
    try {
      const orientation = screen.orientation;
      if (orientation) {
        // 方向与角度同样按当前视口实时判断：桌面端横屏 angle=0、竖屏 angle=90。
        define(orientation, 'type', () => Number(window.innerWidth) >= Number(window.innerHeight) ? 'landscape-primary' : 'portrait-primary', 'get type');
        define(orientation, 'angle', () => Number(window.innerWidth) >= Number(window.innerHeight) ? 0 : 90, 'get angle');
      }
    } catch (e) {}
    if (P.userAgent && P.clientHints) {
      const parsed = P.clientHints;
      const makeUserAgentData = () => {
        const proto = (typeof NavigatorUAData !== 'undefined' && NavigatorUAData.prototype) ? NavigatorUAData.prototype : Object.prototype;
        const data = Object.create(proto);
        const brands = Object.freeze(parsed.brands.map(item => ({ ...item })));
        const all = {
          architecture: P.highEntropy.architecture,
          bitness: P.highEntropy.bitness,
          brands,
          fullVersionList: Object.freeze(parsed.fullVersionList.map(item => ({ ...item }))),
          mobile: parsed.mobile,
          model: '',
          platform: parsed.platform,
          platformVersion: P.highEntropy.platformVersion,
          wow64: false
        };
        Object.defineProperties(data, {
          brands: { value: brands, enumerable: true },
          mobile: { value: parsed.mobile, enumerable: true },
          platform: { value: parsed.platform, enumerable: true },
          getHighEntropyValues: { value: mask(function (hints) {
          const requested = Array.isArray(hints) ? hints : [];
          const out = {};
          for (const key of requested) { if (key in all) out[key] = all[key] }
          return Promise.resolve(out);
          }, 'getHighEntropyValues'), enumerable: false },
          toJSON: { value: mask(function () { return { brands, mobile: parsed.mobile, platform: parsed.platform }; }, 'toJSON'), enumerable: false }
        });
        return data;
      };
      define(navigatorTarget, 'userAgentData', makeUserAgentData, 'get userAgentData');
    }
    if (P.webglVendor || P.webglRenderer) {
      // 打补丁的标记用**无描述 Symbol**：属性名不能带品牌串（曾用带产品名的属性名，
      // 页面一行 Object.keys 就能看出被本软件改过 —— 2026-10-16 审查；说明写在本函数 JSDoc 里，
      // 这份脚本是要注入页面的字符串，里面不留任何品牌串）
      const patch = (proto) => {
        if (!proto || state.webgl.has(proto)) return;
        const orig = proto.getParameter;
        const patched = mask(function (pname) {
          if (P.webglVendor && (pname === 37445 || pname === 7936)) return P.webglVendor;
          if (P.webglRenderer && (pname === 37446 || pname === 7937)) return P.webglRenderer;
          return orig.call(this, pname);
        }, 'getParameter');
        try { Object.defineProperty(proto, 'getParameter', { value: patched, writable: true, configurable: true }); } catch (e) {}
        try { state.webgl.add(proto); } catch (e) {}
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
        // ⚠️ 不能用"有状态的随机序列"：那样同一份画布读两次结果不同（页面连续调用两次 toDataURL
        // 一对比就知道被改写），而且同一家店换一次加载顺序噪声就变。真机验收抓到的就是这个。
        // 现在噪声**只由 (种子, 位置)** 决定：同内容永远同结果、跨店不同、与调用次数/顺序无关。
        const mix = (a, b) => {
          let h = (a ^ b) >>> 0;
          h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B) >>> 0;
          h = (h ^ (h >>> 13)) >>> 0;
          return Math.imul(h, 0xC2B2AE35) >>> 0;
        };
        const positions = (lengthInPixels) => {
          const out = [];
          for (let k = 0; k < 4; k++) {
            const h = mix(P.noiseSeed | 0, k + 1);
            out.push(((h >>> 8) % lengthInPixels) * 4);
          }
          return out;
        };
        // 幅度只有 ±1：肉眼不可见，但采样哈希不同
        const perturb = (data) => {
          const pixels = Math.floor(data.length / 4);
          if (pixels <= 0) return data;
          for (const idx of positions(pixels)) {
            if (idx + 2 >= data.length) continue;
            const flip = (mix(P.noiseSeed | 0, idx) & 1) === 1 ? 1 : -1;
            data[idx] = (data[idx] + flip + 256) & 255;
          }
          return data;
        };
        if (typeof HTMLCanvasElement !== 'undefined') {
          const CanvasProto = HTMLCanvasElement.prototype;
          const ctxProto = typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype : null;
          if (ctxProto && !state.canvas) {
            const origGet = ctxProto.getImageData;
            try {
              state.canvasGet = origGet;
              Object.defineProperty(ctxProto, 'getImageData', { value: mask(function () {
                const img = origGet.apply(this, arguments);
                try { perturb(img.data) } catch (e) {}
                return img;
              }, 'getImageData'), writable: true, configurable: true });
              state.canvas = true;
            } catch (e) {}
          }
          const origToDataURL = CanvasProto.toDataURL;
          try {
            Object.defineProperty(CanvasProto, 'toDataURL', { value: mask(function () {
              try {
                const ctx = this.getContext && this.getContext('2d');
                if (!ctx || !this.width || !this.height) return origToDataURL.apply(this, arguments);
                // 绕过上面的读出补丁，确保 toDataURL 只扰动一次。
                const img = state.canvasGet
                  ? state.canvasGet.call(ctx, 0, 0, this.width, this.height)
                  : ctx.getImageData(0, 0, this.width, this.height);
                perturb(img.data);
                const copy = document.createElement('canvas');
                copy.width = this.width; copy.height = this.height;
                copy.getContext('2d').putImageData(img, 0, 0);
                return origToDataURL.apply(copy, arguments);
              } catch (e) { return origToDataURL.apply(this, arguments) }
            }, 'toDataURL'), writable: true, configurable: true });
          } catch (e) {}
          const origToBlob = CanvasProto.toBlob;
          if (typeof origToBlob === 'function') try {
            Object.defineProperty(CanvasProto, 'toBlob', { value: mask(function (callback) {
              try {
                const ctx = this.getContext && this.getContext('2d');
                if (!ctx || !this.width || !this.height) return origToBlob.apply(this, arguments);
                const img = state.canvasGet
                  ? state.canvasGet.call(ctx, 0, 0, this.width, this.height)
                  : ctx.getImageData(0, 0, this.width, this.height);
                perturb(img.data);
                const copy = document.createElement('canvas');
                copy.width = this.width; copy.height = this.height;
                copy.getContext('2d').putImageData(img, 0, 0);
                return origToBlob.call(copy, callback, arguments[1], arguments[2]);
              } catch (e) { return origToBlob.apply(this, arguments) }
            }, 'toBlob'), writable: true, configurable: true });
          } catch (e) {}
        }
        // OffscreenCanvas 不经过 HTMLCanvasElement.prototype；风控常用它绕过 toDataURL 补丁。
        if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype) {
          const OffProto = OffscreenCanvas.prototype;
          const makeNoisyOffscreen = (source) => {
            const ctx = source.getContext && source.getContext('2d');
            if (!ctx || !source.width || !source.height) return null;
            const img = state.canvasGet
              ? state.canvasGet.call(ctx, 0, 0, source.width, source.height)
              : ctx.getImageData(0, 0, source.width, source.height);
            perturb(img.data);
            const copy = new OffscreenCanvas(source.width, source.height);
            copy.getContext('2d').putImageData(img, 0, 0);
            return copy;
          };
          const offToDataURL = OffProto.toDataURL;
          if (typeof offToDataURL === 'function') try {
            Object.defineProperty(OffProto, 'toDataURL', { value: mask(function () {
              try { const copy = makeNoisyOffscreen(this); return copy ? offToDataURL.apply(copy, arguments) : offToDataURL.apply(this, arguments); }
              catch (e) { return offToDataURL.apply(this, arguments) }
            }, 'toDataURL'), writable: true, configurable: true });
          } catch (e) {}
          const offToBlob = OffProto.convertToBlob;
          if (typeof offToBlob === 'function') try {
            Object.defineProperty(OffProto, 'convertToBlob', { value: mask(function () {
              try { const copy = makeNoisyOffscreen(this); return copy ? offToBlob.apply(copy, arguments) : offToBlob.apply(this, arguments); }
              catch (e) { return offToBlob.apply(this, arguments) }
            }, 'convertToBlob'), writable: true, configurable: true });
          } catch (e) {}
        }
        if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype && !state.audio) {
          const origChannel = AudioBuffer.prototype.getChannelData;
          try {
            Object.defineProperty(AudioBuffer.prototype, 'getChannelData', { value: mask(function (channel) {
              const data = origChannel.call(this, channel);
              try {
                // 原生 getChannelData 对同一 AudioBuffer 返回同一份可写数组；
                // 只在首次读取时就地扰动，避免返回副本被探针识别。
                let seen = state.audioSeen.get(this);
                if (!seen) { seen = new Set(); state.audioSeen.set(this, seen); }
                if (!seen.has(channel)) {
                  const pixels = data.length;
                  if (pixels > 0) for (let k = 0; k < 8; k++) {
                    const idx = mix(P.noiseSeed | 0, (k + 1) * 7919) % pixels;
                    const sign = (mix(P.noiseSeed | 0, idx) & 1) === 1 ? 1 : -1;
                    data[idx] = data[idx] + sign * 1e-7;
                  }
                  seen.add(channel);
                }
                return data;
              } catch (e) {}
              return data;
            }, 'getChannelData'), writable: true, configurable: true });
            state.audio = true;
          } catch (e) {}
        }
        if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype && !state.analyser) {
          const origFloat = AnalyserNode.prototype.getFloatFrequencyData;
          try {
            Object.defineProperty(AnalyserNode.prototype, 'getFloatFrequencyData', { value: mask(function (array) {
              origFloat.call(this, array);
              try {
                for (let k = 0; k < 4 && array.length; k++) {
                  const idx = mix(P.noiseSeed | 0, (k + 1) * 104729) % array.length;
                  const sign = (mix(P.noiseSeed | 0, idx) & 1) === 1 ? 1 : -1;
                  array[idx] = array[idx] + sign * 1e-4;
                }
              } catch (e) {}
            }, 'getFloatFrequencyData'), writable: true, configurable: true });
            state.analyser = true;
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
  const reg: TabReg = { wc, attached: false, overrides: readOverrides(storeId), fallbackListenerAttached: false, active: false }
  tabs.get(storeId)!.set(tabId, reg)

  const o = reg.overrides
  if (!o) return

  // CDP 时区覆盖（attach 失败 → 字段保持未验证，不影响其余能力）
  const cdpDisabled = process.env.SHOPILOT_DISABLE_CDP_FP === '1'
  const tryTimezone = () => {
    if (cdpDisabled || reg.attached || !o.timezone) return
    try {
      if (wc.isDestroyed()) return
      wc.debugger.attach('1.3')
      reg.attached = true
      wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: o.timezone }).catch((error: unknown) => {
        reg.attached = false
        logMain('warn', `[fingerprint] 时区覆盖失败 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
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
  let injectFallback: (() => void) | null = null
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
            // `runImmediately` is not consistently honored for an already-loaded
            // about:blank guest on Electron 30. The document-start hook protects
            // future navigations, while this explicit execution makes the current
            // document observable immediately after registration as well.
            if (!wc.isDestroyed()) {
              return wc.executeJavaScript(buildInjectScript(o), true).catch((error: unknown) => {
                logMain('warn', `[fingerprint] 当前文档注入失败 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
              })
            }
            return undefined
          })
          .catch((error: unknown) => {
            reg.scriptId = null
            logMain('warn', `[fingerprint] document-start 注入失败 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
            // Promise 异步拒绝不能被同步 true 吞掉：当前文档立即补注入，后续导航挂 dom-ready 兜底。
            if (injectFallback && !reg.fallbackListenerAttached) {
              reg.fallbackListenerAttached = true
              try { wc.on('dom-ready', injectFallback) } catch { /* 页面关闭时幂等 */ }
              injectFallback()
            }
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
      const latest = reg.overrides || readOverrides(storeId)
      if (!latest) return
      wc.executeJavaScript(buildInjectScript(latest), true).catch((error: unknown) => {
        logMain('warn', `[fingerprint] 注入失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
      })
    } catch { /* ignore */ }
  }
  injectFallback = inject

  if (!injectAtDocumentStart()) {
    reg.fallbackListenerAttached = true
    wc.on('dom-ready', inject)
    inject()
  }
  // CDP 的 runImmediately 已覆盖当前文档；只有调试器不可用时才由上面的
  // dom-ready 兜底执行，避免同一文档被重复包裹。
  wc.on('did-navigate', tryTimezone)
}

/**
 * 重新把最新 Profile 应用到已经存在的 WebContents。
 * Profile 更新不能只改 SQLite：旧 document 的 getter、CDP 时区和后续 document
 * 的 addScript 都会继续捕获旧值。这里在不重复挂业务事件监听的前提下替换脚本，
 * 并可选刷新页面让 session UA/UA-CH 在真实导航中生效。
 */
export async function refreshFingerprintTargets(
  storeId: string,
  options: { reload?: boolean } = {}
): Promise<void> {
  const m = tabs.get(storeId)
  if (!m) return
  const cdpDisabled = process.env.SHOPILOT_DISABLE_CDP_FP === '1'
  for (const reg of m.values()) {
    reg.overrides = readOverrides(storeId)
    const o = reg.overrides
    const wc = reg.wc
    if (!o || wc.isDestroyed()) continue
    try {
      if (reg.attached && reg.scriptId) {
        await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: reg.scriptId }).catch(() => undefined)
        reg.scriptId = null
      }
      if (!cdpDisabled) {
        if (!reg.attached) {
          try { wc.debugger.attach('1.3'); reg.attached = true } catch (error) {
            reg.attached = false
            logMain('warn', `[fingerprint] 刷新时调试器不可用 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
          }
        }
        if (reg.attached) {
          try {
            const result = await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectScript(o), runImmediately: true })
            reg.scriptId = String((result as { identifier?: unknown })?.identifier || '') || null
          } catch (error) {
            reg.scriptId = null
            logMain('warn', `[fingerprint] 刷新 document-start 注入失败 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
            try { wc.on('dom-ready', () => { void wc.executeJavaScript(buildInjectScript(o), true).catch(() => {}) }) } catch { /* 页面关闭时幂等 */ }
          }
          try { await wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: o.timezone }) } catch (error) {
            logMain('warn', `[fingerprint] 刷新时区覆盖失败 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
          }
        }
      }
      await wc.executeJavaScript(buildInjectScript(o), true).catch((error: unknown) => {
        logMain('warn', `[fingerprint] 刷新当前文档注入失败 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
      })
      if (options.reload !== false && typeof (wc as any).reload === 'function' &&
        (typeof (wc as any).isLoading !== 'function' || !(wc as any).isLoading())) {
        try { wc.reload() } catch (error) { logMain('warn', `[fingerprint] 刷新页面失败 store=${storeId}：${String((error as Error)?.message || error).slice(0, 120)}`) }
      }
    } catch (error) {
      logMain('warn', `[fingerprint] 更新运行时指纹失败 store=${storeId}：${String((error as Error)?.message || error).slice(0, 160)}`)
    }
  }
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

/** window-manager 在切换标签页时同步活动目标，verify 只读取用户当前页。 */
export function setFingerprintTargetActive(storeId: string, tabId: string, active: boolean): void {
  const m = tabs.get(storeId)
  const reg = m?.get(tabId)
  if (reg) reg.active = active
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
  let sawTimeout = false
  let sawException = false
  // 注册顺序不等于用户当前页面（客服监控/独立窗口常常更早注册）。
  // 活动标签页优先，随后才按 WebContents id 稳定排序，避免读到后台页。
  const candidates = Array.from(m.values()).sort((a, b) => Number(b.active === true) - Number(a.active === true) || a.wc.id - b.wc.id)
  for (const reg of candidates) {
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
        sawTimeout = true
        logMain('warn', `[fingerprint] 实测超时（4s）：store=${storeId}`)
        continue
      }
      if (result) return { state: 'ok', values: result as Record<string, any> }
      logMain('warn', `[fingerprint] 实测脚本在页面里抛错：store=${storeId}`)
      continue
    } catch (error) {
      sawException = true
      logMain('warn', `[fingerprint] 实测执行失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
      continue
    }
  }
  // 有标签但都没测成时保留真实原因；如果两类都发生，超时通常是页面未就绪的主因。
  return { state: m.size > 0 ? (sawTimeout ? 'timeout' : sawException ? 'exception' : 'exception') : 'no-tab', values: null }
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
      actual: collected.state === 'no-tab'
        ? '没有已注册的标签页'
        : collected.state === 'exception'
          ? '页面脚本执行失败（请重载页面后重试）'
          : '页面 4 秒内未响应（可能正在加载）',
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
