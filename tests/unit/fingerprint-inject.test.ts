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

/** 把注入脚本跑在一个只有 navigator/screen/window 的最小沙箱里 */
function runScript(profile: Record<string, unknown>): { navigator: any; screen: any } {
  const sandbox = {
    navigator: {} as Record<string, unknown>,
    screen: {} as Record<string, unknown>,
    window: {} as Record<string, unknown>
  }
  const script = buildInjectScript(profile as never)
  const fn = new Function('navigator', 'screen', 'window', script)
  fn(sandbox.navigator, sandbox.screen, sandbox.window)
  return { navigator: sandbox.navigator, screen: sandbox.screen }
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
