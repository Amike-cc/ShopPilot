import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 注入器在注册时会读档案库、失败时写主进程日志：这两个依赖在单测里用假实现顶掉
vi.mock('../../apps/desktop/src/main/db/database', () => ({
  getDatabase: () => ({
    prepare: () => ({
      get: () => ({
        user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        language: 'zh-CN',
        timezone: 'Asia/Shanghai',
        screen_width: 1920,
        screen_height: 1080,
        color_depth: 24,
        hardware_concurrency: 8,
        webgl_vendor: 'Google Inc. (NVIDIA)',
        webgl_renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
      })
    })
  })
}))
vi.mock('../../apps/desktop/src/main/services/logger', () => ({ logMain: vi.fn() }))

import { buildInjectScript, platformFromUa, registerFingerprintTarget, unregisterFingerprintTarget } from '../../apps/desktop/src/main/browser/fingerprint-injector'

/**
 * 指纹注入脚本的回归网（2026-10-16 审查）。
 *
 * 这里**真的把生成的脚本跑起来**（喂假 navigator/screen），而不是只断言源码里有某个字符串——
 * 之前那版 `availHeight = height - 40` 就是"看着挺合理、跑起来会出负数"的典型。
 *
 * 已确认并在此钉住的缺陷：
 *   ① 改写的 getter 没有 `toString` 伪装 → 平台一句 `.get.toString()` 就能看出不是原生；
 *   ② `navigator.webdriver` / `platform` / `deviceMemory` 缺失（自动化痕迹与常见字段缺口）；
 *   ③ `screen.availHeight` 硬编码 -40，屏幕很矮时得到负数，与 availWidth 口径也不一致；
 *   ④ 注入失败在页面里静默 —— 至少在**主进程日志**要留痕（页面里绝不能打日志：前缀本身是指纹）。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const INJECTOR = read('apps/desktop/src/main/browser/fingerprint-injector.ts')

const PROFILE = {
  timezone: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  language: 'zh-CN',
  screenWidth: 1920,
  screenHeight: 1080,
  colorDepth: 24,
  hardwareConcurrency: 16,
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
}

/** 把注入脚本跑在一个只有 navigator/screen/window + 可选 DOM 桩的沙箱里 */
function runScript(profile: Record<string, unknown>, extra: Record<string, unknown> = {}): { navigator: any; screen: any; canvas: any } {
  const sandbox = {
    navigator: {} as Record<string, unknown>,
    screen: {} as Record<string, unknown>,
    window: {} as Record<string, unknown>
  }
  const script = buildInjectScript(profile as never)
  const names = ['navigator', 'screen', 'window', ...Object.keys(extra)]
  const fn = new Function(...names, script)
  // 真实环境里每个文档有各自的 globalThis；单测共用 Node 全局，所以要手动复位"只装一次"的守卫
  delete (globalThis as unknown as Record<string, unknown>).__fpReady
  fn(sandbox.navigator, sandbox.screen, sandbox.window, ...Object.values(extra))
  return { navigator: sandbox.navigator, screen: sandbox.screen, canvas: (extra.HTMLCanvasElement as any)?.prototype }
}

/** 极简 canvas 桩：16×4 像素，getImageData 返回给定像素的副本 */
function canvasStub(pixels: number[]) {
  const base = Uint8ClampedArray.from(pixels)
  class FakeCtx {
    getImageData() { return { data: Uint8ClampedArray.from(base) } }
    putImageData() { /* 只用于拷贝画布 */ }
  }
  const contexts = new Map<FakeCanvas, FakeCtx>()
  class FakeCanvas {
    width = 16
    height = 4
    getContext() {
      if (!contexts.has(this)) contexts.set(this, new FakeCtx())
      return contexts.get(this)!
    }
    toDataURL() { return 'data:image/png;base64,ORIGINAL' }
  }
  return { HTMLCanvasElement: FakeCanvas, CanvasRenderingContext2D: FakeCtx, document: { createElement: () => new FakeCanvas() }, base }
}

describe('注入脚本真跑：值改对了，而且不像被改过', () => {
  it('覆盖 navigator 关键字段，并与 UA 自洽', () => {
    const { navigator } = runScript(PROFILE)
    expect(navigator.userAgent).toBe(PROFILE.userAgent)
    expect(navigator.language).toBe('zh-CN')
    expect(navigator.languages).toEqual(['zh-CN', 'en-US']) // 与请求头 `zh-CN,en-US` 同源，不能只有一个
    expect(navigator.hardwareConcurrency).toBe(16)
    expect(navigator.webdriver).toBe(false)
    expect(navigator.platform).toBe('Win32') // 从 UA 推，不能与 UA 矛盾
    expect([0.25, 0.5, 1, 2, 4, 8]).toContain(navigator.deviceMemory)
  })

  it('screen 四项齐全且自洽（availHeight 不许是负数）', () => {
    const normal = runScript(PROFILE)
    expect(normal.screen.width).toBe(1920)
    expect(normal.screen.availWidth).toBe(1920)
    expect(normal.screen.height).toBe(1080)
    expect(normal.screen.availHeight).toBeGreaterThan(0)
    expect(normal.screen.availHeight).toBeLessThanOrEqual(1080)
    expect(normal.screen.availTop).toBe(0)
    expect(normal.screen.availLeft).toBe(0)

    // 回归：屏幕比"任务栏高度"还矮时，旧实现会算出负数
    const tiny = runScript({ ...PROFILE, screenHeight: 30 })
    expect(tiny.screen.availHeight).toBeGreaterThanOrEqual(1)
  })

  it('视口字段跟随窗口实时变化（回归：2026-10-17 收起侧栏后 innerWidth 仍是旧宽度）', () => {
    // 模拟真实 Window：innerWidth 是可变 accessor；注入后必须仍返回实时值，
    // 不能把 document-start 那一刻的宽度固化成常量（否则响应式页面永不回流）。
    let width = 778
    let height = 706
    const win: Record<string, unknown> = {}
    Object.defineProperty(win, 'innerWidth', { configurable: true, get: () => width })
    Object.defineProperty(win, 'innerHeight', { configurable: true, get: () => height })
    Object.defineProperty(win, 'outerWidth', { configurable: true, get: () => 1416 })
    Object.defineProperty(win, 'outerHeight', { configurable: true, get: () => 908 })
    Object.defineProperty(win, 'devicePixelRatio', { configurable: true, get: () => 1.25 })
    const script = buildInjectScript(PROFILE as never)
    delete (globalThis as unknown as Record<string, unknown>).__fpReady
    new Function('navigator', 'screen', 'window', script)({}, {}, win)
    expect(win.innerWidth).toBe(778)
    expect(win.devicePixelRatio).toBe(1.25)
    width = 498
    height = 640
    expect(win.innerWidth).toBe(498)
    expect(win.innerHeight).toBe(640)
    // 宿主窗口宽度不随 webview 容器变化，仍取真实值
    expect(win.outerWidth).toBe(1416)
  })

  it('getter 伪装成原生：toString 不许暴露被改写的事实', () => {
    const { navigator, screen } = runScript(PROFILE)
    const uaGetter = Object.getOwnPropertyDescriptor(navigator, 'userAgent')!.get as () => string
    expect(uaGetter.toString()).toContain('[native code]')
    expect(uaGetter.toString()).not.toContain('P.userAgent')
    const hGetter = Object.getOwnPropertyDescriptor(screen, 'height')!.get as () => number
    expect(hGetter.toString()).toContain('[native code]')
    // 连 Function.prototype.toString 自己也要伪装（否则"toString 被换过"本身就是特征）
    expect(Function.prototype.toString.toString()).toContain('[native code]')
  })

  it('WebGL 供应商/渲染器被改写，且 getParameter 也伪装成原生', () => {
    const sandbox = { navigator: {}, screen: {}, window: { WebGLRenderingContext: function WebGLRenderingContext(this: unknown) {} } as Record<string, unknown> }
    const script = buildInjectScript(PROFILE as never)
    delete (globalThis as unknown as Record<string, unknown>).__fpReady
    new Function('navigator', 'screen', 'window', script)(sandbox.navigator, sandbox.screen, sandbox.window)
    const proto = (sandbox.window.WebGLRenderingContext as any).prototype
    expect(proto.getParameter(37445)).toBe(PROFILE.webglVendor)
    expect(proto.getParameter(37446)).toBe(PROFILE.webglRenderer)
    expect(proto.getParameter.toString()).toContain('[native code]')
  })

  it('不往页面 console 打任何日志（日志前缀本身就是指纹）', () => {
    const script = buildInjectScript(PROFILE as never)
    expect(script).not.toContain('console.log')
    expect(script).not.toContain('console.warn')
    expect(script).not.toContain('shopilot')
  })

  it('platform 全平台映射：macOS/Linux 档案不再保留宿主 Win32', () => {
    const mac = {
      ...PROFILE,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    }
    const macRun = runScript(mac)
    expect(macRun.navigator.platform).toBe('MacIntel')
    expect(platformFromUa(mac.userAgent)).toBe('MacIntel')
    expect(platformFromUa('Mozilla/5.0 (X11; Linux x86_64) Chrome/152.0.0.0')).toBe('Linux x86_64')
    expect(platformFromUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Chrome/152.0.0.0')).toBe('iPhone')
    expect(platformFromUa('')).toBeNull()
  })

  it('高熵值只回请求的键，且与 UA 平台自洽（macOS 不许报 x86、model 用空串）', async () => {
    const mac = runScript({
      ...PROFILE,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    })
    const high = await mac.navigator.userAgentData.getHighEntropyValues(['architecture', 'model'])
    expect(Object.keys(high).sort()).toEqual(['architecture', 'model'])
    expect(high.architecture).toBe('arm') // 不能是 x86
    expect(high.model).toBe('')
    // 未请求的键不许回（真实现的行为）
    expect(high.bitness).toBeUndefined()
  })
})

describe('canvas 噪声：同店稳定、跨店不同（审查 P0 的去匿名化关键）', () => {
  const PIXELS = Array.from({ length: 64 }, (_, i) => (i * 3) % 256)

  function readPixels(noiseSeed: number): number[] {
    const stub = canvasStub(PIXELS)
    runScript({ ...PROFILE, noiseSeed }, {
      HTMLCanvasElement: stub.HTMLCanvasElement,
      CanvasRenderingContext2D: stub.CanvasRenderingContext2D,
      document: stub.document
    } as never)
    const canvas = new (stub.HTMLCanvasElement as any)()
    const data = canvas.getContext('2d').getImageData(0, 0, 16, 4).data as Uint8ClampedArray
    return Array.from(data)
  }

  it('同一个种子两次读到的像素完全一致（同店稳定，页面自己前后对比看不出变化）', () => {
    expect(readPixels(424242)).toEqual(readPixels(424242))
  })

  it('不同种子读到的像素不同（跨店不能被并成一个实体）', () => {
    expect(readPixels(424242)).not.toEqual(readPixels(999999))
  })

  it('同一份画布连续读两次结果一致（有状态的随机序列会让页面一对比就发现被改写）', () => {
    const stub = canvasStub(PIXELS)
    runScript({ ...PROFILE, noiseSeed: 424242 }, {
      HTMLCanvasElement: stub.HTMLCanvasElement,
      CanvasRenderingContext2D: stub.CanvasRenderingContext2D,
      document: stub.document
    } as never)
    const canvas = new (stub.HTMLCanvasElement as any)()
    const first = Array.from(canvas.getContext('2d').getImageData(0, 0, 16, 4).data as Uint8ClampedArray)
    const second = Array.from(canvas.getContext('2d').getImageData(0, 0, 16, 4).data as Uint8ClampedArray)
    expect(second).toEqual(first)
    // 也不能依赖"第几次读"：与新建画布后的首次读取结果一致（真机曾抓到同店两次加载哈希不同）
    expect(second).toEqual(readPixels(424242))
  })

  it('扰动幅度只有 ±1 且只动极少数像素（肉眼不可见，不影响正常显示与截图）', () => {
    const base = Array.from(new Uint8ClampedArray(PIXELS))
    const noised = readPixels(424242)
    const diffs = noised.map((v, i) => v - base[i]).filter(d => d !== 0)
    expect(diffs.length).toBeGreaterThan(0)
    expect(diffs.length).toBeLessThanOrEqual(4)
    for (const d of diffs) expect(Math.abs(d)).toBe(1)
  })

  it('音频同样接上了噪声（getChannelData / getFloatFrequencyData）', () => {
    const script = buildInjectScript({ ...PROFILE, noiseSeed: 7 } as never)
    expect(script).toContain('getChannelData')
    expect(script).toContain('getFloatFrequencyData')
    // 噪声装不上不能影响其它改写：整段有自己的 try/catch
    expect(script).toContain("/* 噪声装不上不影响其它改写 */")
  })

  it('没有噪声种子时不装噪声（没播种的档案行为不变）', () => {
    const script = buildInjectScript({ ...PROFILE } as never)
    expect(script).toContain('if (P.noiseSeed != null)')
  })
})

describe('验证口径：补全易矛盾项 + 失败原因如实呈现', () => {
  const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')

  it('verify 覆盖 platform / languages / deviceMemory / UA-CH（此前完全没验）', () => {
    const fn = INJECTOR.match(/export async function verifyStoreFingerprint[\s\S]*?\n\}/)
    expect(fn).toBeTruthy()
    for (const field of ["item('platform'", "item('languages'", "item('deviceMemory'", "item('uaClientHints'"]) {
      expect(fn![0]).toContain(field)
    }
    // 期望值必须与注入脚本同源（都用 platformFromUa），否则"验的"和"注入的"会各说一套
    expect(fn![0]).toContain('platformFromUa(p.user_agent)')
  })

  it('取不到实测值时先如实说原因，而不是伪装成逐项未验证', () => {
    expect(INJECTOR).toContain("state: 'ok' | 'timeout' | 'exception' | 'no-tab'")
    expect(INJECTOR).toContain("field: '实测取值'")
    expect(INJECTOR).toContain('没有已注册的标签页')
    expect(INJECTOR).toContain('页面 4 秒内未响应（可能正在加载）')
    // 超时/异常都要写主进程日志（此前是 console.log + catch{continue} 静默吞）
    expect(INJECTOR).not.toContain("console.log('[fp] collectActualValues")
    expect(INJECTOR).toContain('实测超时（4s）')
    expect(INJECTOR).toContain('实测脚本在页面里抛错')
  })

  it('界面文案按实际覆盖字段措辞，不再宣称"全部字段一致"', () => {
    expect(SURFACE).not.toContain('环境指纹全部字段实测一致')
    expect(SURFACE).toContain('已实测 ${verifiedCount} 项全部一致')
    expect(SURFACE).toContain("item.field === '实测取值'")
  })
})

describe('接线：失败要留痕、硬编码要消失', () => {
  it('注入失败写主进程日志（不再只写页面注释）', () => {
    expect(INJECTOR).toContain('logMain')
    expect(INJECTOR).toMatch(/注入失败 store=\$\{storeId\}/)
  })

  it('availHeight 不再硬编码 - 40', () => {
    expect(INJECTOR).not.toContain('P.screenHeight - 40')
    expect(INJECTOR).toContain('Math.max(1, P.screenHeight - taskbar)')
  })
})

/**
 * 关键回归：注入必须在**页面脚本之前**（document-start），而不是 dom-ready。
 * 这里用假 WebContents 走真实注册路径，断言真的下了 CDP 命令、并在注销时撤销。
 */
describe('注入时机：走 CDP document-start，而不是等 dom-ready', () => {
  function fakeWc(options: { attachFails?: boolean } = {}) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const listeners: string[] = []
    const wc = {
      isDestroyed: () => false,
      on: (event: string) => { listeners.push(event) },
      executeJavaScript: vi.fn(async () => undefined),
      debugger: {
        attach: vi.fn(() => { if (options.attachFails) throw new Error('另一个调试会话已占用') }),
        detach: vi.fn(),
        on: vi.fn(),
        sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
          calls.push({ method, params })
          return { identifier: 'script-1' }
        })
      }
    }
    return { wc, calls, listeners }
  }

  it('注册即下 Page.addScriptToEvaluateOnNewDocument（每个新文档、每个框架都覆盖）', async () => {
    const { wc, calls, listeners } = fakeWc()
    registerFingerprintTarget('store-1', 'tab-1', wc as never)
    await Promise.resolve()
    await Promise.resolve()

    const add = calls.find(c => c.method === 'Page.addScriptToEvaluateOnNewDocument')
    expect(add).toBeTruthy()
    // 注入的必须是我们的指纹脚本本体，且要在文档开始时就运行
    expect(String(add!.params?.source)).toContain('webdriver')
    expect(String(add!.params?.source)).toContain('userAgent')
    expect(add!.params?.runImmediately).toBe(true)
    // document-start 成功时不再挂 dom-ready 兜底（避免每次导航重复改写、把 toString 越包越深）
    expect(listeners).not.toContain('dom-ready')
    unregisterFingerprintTarget('store-1', 'tab-1')
  })

  it('注销时先撤脚本再 detach（否则脚本一直跟着这个 WebContents）', async () => {
    const { wc, calls } = fakeWc()
    registerFingerprintTarget('store-2', 'tab-2', wc as never)
    await Promise.resolve()
    await Promise.resolve()
    unregisterFingerprintTarget('store-2', 'tab-2')
    await Promise.resolve()
    const remove = calls.find(c => c.method === 'Page.removeScriptToEvaluateOnNewDocument')
    expect(remove).toBeTruthy()
    expect(remove!.params?.identifier).toBe('script-1')
    expect(wc.debugger.detach).toHaveBeenCalled()
  })

  it('调试器被别的会话占用时退回 dom-ready 兜底（并且留痕，不再静默）', async () => {
    const { wc, listeners } = fakeWc({ attachFails: true })
    registerFingerprintTarget('store-3', 'tab-3', wc as never)
    await Promise.resolve()
    const { logMain } = await import('../../apps/desktop/src/main/services/logger')
    expect(listeners).toContain('dom-ready')
    expect(wc.executeJavaScript).toHaveBeenCalled()
    expect(logMain).toHaveBeenCalled()
    unregisterFingerprintTarget('store-3', 'tab-3')
  })
})
