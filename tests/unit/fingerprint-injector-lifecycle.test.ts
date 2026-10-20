/**
 * 指纹注入目标生命周期单测（registerFingerprintTarget / unregisterFingerprintTarget）。
 *
 * 为什么能脱离真实 Electron 跑：这两个函数对 WebContents 的依赖面很小——
 * `isDestroyed()` / `debugger.{attach,sendCommand,detach}` / `executeJavaScript` / `on`，
 * 全部可以用最小桩模拟；数据库读档案（readOverrides → getDatabase）与主进程日志
 * （logMain → electron-log）用 vi.mock 替换。注册表本身是模块内 Map，不碰 CDP/窗口。
 *
 * 测不了的（见最终报告）：CDP 协议本身的行为（时区覆盖是否真的生效、document-start
 * 脚本是否真的在每个新文档先执行）只能在真机/Electron 环境验证，单测只覆盖
 * 注册表的状态机与调用序列。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  collectActualValues,
  refreshFingerprintTargets,
  registerFingerprintTarget,
  setFingerprintTargetActive,
  unregisterFingerprintTarget
} from '../../apps/desktop/src/main/browser/fingerprint-injector'

/** vi.mock 工厂里不能引用外部变量，统一走 hoisted 容器。 */
const mocks = vi.hoisted(() => ({
  /** browser_profiles 里该 store 的档案行：null = 没有档案（overrides 为 null 的路径） */
  profileRow: null as Record<string, unknown> | null
}))

vi.mock('../../apps/desktop/src/main/db/database', () => ({
  getDatabase: () => ({
    prepare: () => ({ get: () => mocks.profileRow })
  })
}))

vi.mock('../../apps/desktop/src/main/services/logger', () => ({
  logMain: () => undefined
}))

/** 最小 WebContents 桩：只实现 register/unregister/collect 真正会调用的方法。 */
interface FakeWcState {
  destroyed: boolean
  attachCalls: number
  detachCalls: number
  sentCommands: Array<{ method: string; params: unknown }>
  /** 指纹注入脚本（buildInjectScript 产物）的执行次数 */
  injections: number
  /** collectActualValues 探针脚本的执行次数 */
  probes: number
  domReadyListeners: number
}

function createFakeWebContents(id: number, options: { destroyed?: boolean } = {}): { wc: WebContents; state: FakeWcState } {
  const state: FakeWcState = {
    destroyed: options.destroyed === true,
    attachCalls: 0,
    detachCalls: 0,
    sentCommands: [],
    injections: 0,
    probes: 0,
    domReadyListeners: 0
  }
  const wc = {
    id,
    isDestroyed: () => state.destroyed,
    isCrashed: () => false,
    executeJavaScript: vi.fn((script: string) => {
      // 注入脚本与实测探针都要区分计数：collectActualValues 也会走 executeJavaScript。
      // （注入脚本是整段静态文本，探针独有 Intl.DateTimeFormat，用它区分。）
      if (script.includes('Intl.DateTimeFormat')) state.probes++
      else state.injections++
      // 与 collectActualValues 的探针返回形状对齐：真值即被视为实测成功
      return Promise.resolve({ userAgent: 'UA', language: 'zh-CN', platform: 'Win32' })
    }),
    on: vi.fn((_event: string) => {
      if (_event === 'dom-ready') state.domReadyListeners++
    }),
    debugger: {
      attach: vi.fn(() => { state.attachCalls++ }),
      sendCommand: vi.fn((method: string, params?: unknown) => {
        state.sentCommands.push({ method, params })
        return Promise.resolve(method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: `script-${id}` } : {})
      }),
      detach: vi.fn(() => { state.detachCalls++ }),
      on: undefined
    }
  }
  return { wc: wc as unknown as WebContents, state }
}

/** 把微任务队列冲干净：CDP 路径里 sendCommand().then() 异步登记 scriptId。 */
async function flushAsync(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('指纹注入目标生命周期', () => {
  beforeEach(() => {
    mocks.profileRow = null
    delete process.env.SHOPILOT_DISABLE_CDP_FP
  })
  afterEach(() => {
    delete process.env.SHOPILOT_DISABLE_CDP_FP
    vi.restoreAllMocks()
  })

  it('a) 重复注册同一 (storeId, tabId) 幂等：注册表里始终只有一个目标', async () => {
    process.env.SHOPILOT_DISABLE_CDP_FP = '1' // 走 dom-ready 兜底路径，避免 CDP 异步干扰计数
    mocks.profileRow = { user_agent: 'UA', language: 'zh-CN', timezone: 'Asia/Shanghai', screen_width: 1920, screen_height: 1080 }
    const { wc, state } = createFakeWebContents(101)

    registerFingerprintTarget('store-a', 'tab-1', wc)
    expect(state.injections).toBe(1) // 注册时对当前文档注入一次

    registerFingerprintTarget('store-a', 'tab-1', wc) // 重复注册（window-manager 重建/换页会这样调）
    // 重复注册本身也会对当前文档再注入一次（新的 reg 对象），注册表里仍是 1 个条目
    expect(state.injections).toBe(2)
    const beforeRefresh = state.injections

    // refreshFingerprintTargets 会遍历注册表里的每个目标各注入一次；
    // 若重复注册产生了第二个条目，这里会变成 2 —— 以此验证注册表幂等。
    await refreshFingerprintTargets('store-a', { reload: false })
    expect(state.injections - beforeRefresh).toBe(1)

    // 注销一次即彻底清干净（而不是还残留第二个条目）
    unregisterFingerprintTarget('store-a', 'tab-1')
    const result = await collectActualValues('store-a')
    expect(result.state).toBe('no-tab')
  })

  it('b) 已销毁的 WebContents 注销不抛错，也不触发非法的 debugger 调用', async () => {
    // b-1：未挂调试器的目标（overrides 为 null 的注册路径）+ 已销毁
    const plain = createFakeWebContents(201, { destroyed: true })
    registerFingerprintTarget('store-b1', 'tab-1', plain.wc)
    expect(() => unregisterFingerprintTarget('store-b1', 'tab-1')).not.toThrow()
    expect(await collectActualValues('store-b1')).toMatchObject({ state: 'no-tab' })

    // b-2：CDP 已 attach 的目标 + 注册后销毁 → 注销必须跳过清理（对已销毁 wc 调 detach 会抛）
    mocks.profileRow = { user_agent: 'UA', language: 'zh-CN', timezone: 'Asia/Shanghai', screen_width: 1920, screen_height: 1080 }
    const cdp = createFakeWebContents(202)
    registerFingerprintTarget('store-b2', 'tab-1', cdp.wc)
    await flushAsync()
    expect(cdp.state.attachCalls).toBe(1) // 注册时已挂上调试器

    cdp.state.destroyed = true
    expect(() => unregisterFingerprintTarget('store-b2', 'tab-1')).not.toThrow()
    expect(cdp.state.detachCalls).toBe(0) // 守卫生效：绝不对已销毁 wc 做 detach
    expect(await collectActualValues('store-b2')).toMatchObject({ state: 'no-tab' })
  })

  it('b+) 存活的已挂调试器目标注销时：先撤 document-start 脚本，再 detach', async () => {
    mocks.profileRow = { user_agent: 'UA', language: 'zh-CN', timezone: 'Asia/Shanghai', screen_width: 1920, screen_height: 1080 }
    const { wc, state } = createFakeWebContents(203)
    registerFingerprintTarget('store-b3', 'tab-1', wc)
    await flushAsync()
    expect(state.attachCalls).toBe(1)

    unregisterFingerprintTarget('store-b3', 'tab-1')
    await flushAsync()
    expect(state.detachCalls).toBe(1)
    const removeCalls = state.sentCommands.filter(cmd => cmd.method === 'Page.removeScriptToEvaluateOnNewDocument')
    expect(removeCalls).toHaveLength(1)
    expect((removeCalls[0].params as { identifier?: string }).identifier).toBe('script-203')
  })

  it('c) 多注册方（标签页 + 客服 webview + 后台页）共存互不干扰', async () => {
    process.env.SHOPILOT_DISABLE_CDP_FP = '1' // 同步 dom-ready 兜底路径，注入计数确定
    mocks.profileRow = { user_agent: 'UA', language: 'zh-CN', timezone: 'Asia/Shanghai', screen_width: 1920, screen_height: 1080 }
    const tab1 = createFakeWebContents(301)
    const tab2 = createFakeWebContents(302)
    const backgroundPage = createFakeWebContents(303) // 达人邀约 v4 的后台隐藏页（第三类注册方）
    const otherStoreTab = createFakeWebContents(304)

    registerFingerprintTarget('store-c', 'tab-1', tab1.wc)
    registerFingerprintTarget('store-c', 'tab-2', tab2.wc)
    registerFingerprintTarget('store-c', 'bg-1', backgroundPage.wc)
    registerFingerprintTarget('store-d', 'tab-1', otherStoreTab.wc)
    setFingerprintTargetActive('store-c', 'tab-1', true)

    // store-c 三个目标都能被采集（活动标签优先排序不影响结果）
    expect(await collectActualValues('store-c')).toMatchObject({ state: 'ok' })

    // 注销其中一个标签页：其余目标与另一家店都不受影响
    unregisterFingerprintTarget('store-c', 'tab-2')
    expect(await collectActualValues('store-c')).toMatchObject({ state: 'ok' })
    expect(await collectActualValues('store-d')).toMatchObject({ state: 'ok' })

    // 再注销活动标签：后台页顶上，采集仍然成功
    unregisterFingerprintTarget('store-c', 'tab-1')
    expect(await collectActualValues('store-c')).toMatchObject({ state: 'ok' })
    expect(tab1.state.probes).toBe(2) // 已注销的目标不再参与采集（两次 collect 都只数到注销前的那两次探针）
    expect(tab1.state.injections).toBe(1) // 注销后也不再被 refresh 之类重新注入

    // 清空 store-c 的最后一个目标：该店注册表整体移除；store-d 原样
    unregisterFingerprintTarget('store-c', 'bg-1')
    expect(await collectActualValues('store-c')).toMatchObject({ state: 'no-tab' })
    expect(await collectActualValues('store-d')).toMatchObject({ state: 'ok' })

    // 兜底清理，避免模块级注册表跨用例泄漏
    unregisterFingerprintTarget('store-d', 'tab-1')
    expect(await collectActualValues('store-d')).toMatchObject({ state: 'no-tab' })
  })
})
