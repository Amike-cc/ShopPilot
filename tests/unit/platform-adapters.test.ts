import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WebContents } from 'electron'
import { findPlatform } from '@shared/constants/platforms'
import { businessProfileFor } from '@shared/constants/business'
import { hasProductProfile } from '@shared/constants/product'
import { StoreStatus } from '@shared/enums/store-status'
import type { PlatformLoginResult } from '@shared/contracts/platform-adapter'
import type { Store } from '@shared/schemas/store'
import type { PlatformAdapter, PlatformAdapterContext } from '../../apps/desktop/src/main/platform-adapters/platform-adapter'
import {
  createDefaultPlatformAdapterRegistry,
  PlatformAdapterRegistry
} from '../../apps/desktop/src/main/platform-adapters/platform-adapter-registry'
import { PddAdapter } from '../../apps/desktop/src/main/platform-adapters/pdd-adapter'
import { DouDianAdapter } from '../../apps/desktop/src/main/platform-adapters/dou-dian-adapter'
import { KuaishouAdapter } from '../../apps/desktop/src/main/platform-adapters/kuaishou-adapter'
import { WeChatShopAdapter } from '../../apps/desktop/src/main/platform-adapters/wechat-shop-adapter'
import {
  detectStoreLoginStatus,
  resetPlatformLoginCacheForTests,
  storeStatusForLoginResult,
  type PlatformAdapterRuntime
} from '../../apps/desktop/src/main/platform-adapters/platform-login-service'

const pdd = findPlatform('拼多多')!
const douDian = findPlatform('抖店')!
const kuaishou = findPlatform('快手小店')!
const wechat = findPlatform('微信小店')!

function page(overrides: Partial<PlatformAdapterContext> = {}): PlatformAdapterContext {
  return {
    storeId: 'store_a',
    platform: '抖店',
    session: {} as PlatformAdapterContext['session'],
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => false),
      getURL: () => 'https://fxg.jinritemai.com/ffa/mshop/trade/dashboard'
    } as unknown as WebContents,
    currentUrl: 'https://fxg.jinritemai.com/ffa/mshop/trade/dashboard',
    timeoutMs: 1000,
    ...overrides
  }
}

function readyRuntime(
  adapter: PlatformAdapter,
  overrides: Partial<PlatformAdapterRuntime> = {}
): PlatformAdapterRuntime {
  const webContents = page().webContents
  return {
    getStore: vi.fn(() => ({ id: 'store_a', platform: adapter.platform } as unknown as Store)),
    ensureSession: vi.fn(async () => ({}) as unknown as Session),
    getSessionStatus: vi.fn(() => ({
      storeId: 'store_a', status: 'READY', sessionPresent: true, sessionReady: true,
      healthy: true, loginStatus: 'UNKNOWN', platform: adapter.platform,
      lastCheckedAt: Date.now(), loginCheckedAt: null, loginReasonCode: null,
      loginSafeMessage: null, loginEvidenceType: null, errorCode: null
    })),
    getActiveTabId: vi.fn(() => 'tab_a'),
    getTabWebContents: vi.fn(() => webContents),
    getCurrentStoreWebContents: vi.fn(() => webContents),
    recordPlatformLoginResult: vi.fn((result: PlatformLoginResult) => result),
    ...overrides
  }
}

class TestAdapter implements PlatformAdapter {
  readonly adapterName = 'TestAdapter'
  readonly platform: string
  constructor(
    private readonly detector: (context: PlatformAdapterContext) => Promise<PlatformLoginResult>,
    platform = '抖店'
  ) { this.platform = platform }
  supports(platform: string): boolean { return platform === this.platform }
  getCapabilities() {
    return { loginDetection: true, orders: false, products: false, inventory: false, refunds: false, salesData: false }
  }
  detectLoginStatus(context: PlatformAdapterContext): Promise<PlatformLoginResult> { return this.detector(context) }
}

describe('PlatformAdapterRegistry', () => {
  it('按现有平台目录精确注册四个平台', () => {
    const registry = createDefaultPlatformAdapterRegistry()
    expect(registry.resolveAdapter(pdd.name)).toBeInstanceOf(PddAdapter)
    expect(registry.resolveAdapter(douDian.name)).toBeInstanceOf(DouDianAdapter)
    expect(registry.resolveAdapter(kuaishou.name)).toBeInstanceOf(KuaishouAdapter)
    expect(registry.resolveAdapter(wechat.name)).toBeInstanceOf(WeChatShopAdapter)
    expect(registry.listPlatforms()).toEqual(['拼多多', '抖店', '快手小店', '微信小店'])
  })

  it('未知平台不静默回退到其它适配器', () => {
    const registry = createDefaultPlatformAdapterRegistry()
    expect(registry.resolveAdapter('未知平台')).toBeNull()
    expect(registry.supports('未知平台')).toBe(false)
    expect(() => registry.getAdapter('未知平台')).toThrow('UNSUPPORTED_PLATFORM')
  })

  it('PDD 声明订单采集能力；商品能力位**只跟着实测档案走**', () => {
    const registry = createDefaultPlatformAdapterRegistry()
    for (const platform of registry.listPlatforms()) {
      const capabilities = registry.getAdapter(platform).getCapabilities()
      expect(capabilities).toMatchObject({
        loginDetection: true,
        orders: platform === '拼多多',
        inventory: false,
        refunds: false,
        salesData: false
      })
      // 能力位纪律（方案 §5.2）：`products` 为真 ⟺ 该平台登记了**实测过**的商品档案。
      // 声明了就必须真的能采；没实测过的平台不许点亮（否则界面会给出一个点了没用的"同步"按钮）。
      expect(capabilities.products, platform).toBe(hasProductProfile(platform))
    }
    // 四家平台都已在真实登录态店铺上跑通商品列表（docs/product-profiles.md §7）
    for (const platform of ['微信小店', '抖店', '拼多多', '快手小店']) {
      expect(registry.getAdapter(platform).getCapabilities().products, platform).toBe(true)
    }
  })
})

describe('platform login detection', () => {
  beforeEach(() => resetPlatformLoginCacheForTests())

  it('复用现有抖店明确登录页规则，返回 LOGIN_REQUIRED', async () => {
    const adapter = new DouDianAdapter(douDian)
    const result = await adapter.detectLoginStatus(page({ currentUrl: 'https://fxg.jinritemai.com/login/' }))
    expect(result).toMatchObject({ platform: '抖店', status: 'LOGIN_REQUIRED', evidenceType: 'URL' })
  })

  it('复用现有微信登录超时文案，返回 LOGIN_REQUIRED', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    const result = await adapter.detectLoginStatus(page({
      platform: '微信小店',
      currentUrl: 'https://store.weixin.qq.com/shop/home',
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: vi.fn(async () => true)
      } as unknown as WebContents
    }))
    expect(result).toMatchObject({ platform: '微信小店', status: 'LOGIN_REQUIRED', evidenceType: 'DOM' })
  })

  it('拼多多和快手在没有可靠证据时返回 UNKNOWN', async () => {
    const pddResult = await new PddAdapter(pdd).detectLoginStatus(page({ platform: '拼多多', currentUrl: pdd.adminUrl }))
    const kuaishouResult = await new KuaishouAdapter(kuaishou).detectLoginStatus(page({ platform: '快手小店', currentUrl: kuaishou.adminUrl }))
    expect(pddResult.status).toBe('UNKNOWN')
    expect(kuaishouResult.status).toBe('UNKNOWN')
  })

  it('证据不足不会伪造 LOGGED_IN', async () => {
    const result = await new DouDianAdapter(douDian).detectLoginStatus(page({
      webContents: { isDestroyed: () => false, executeJavaScript: vi.fn(async () => false) } as unknown as WebContents
    }))
    expect(result.status).toBe('UNKNOWN')
  })
})

describe('platform login service safety and lifecycle gates', () => {
  it('未知店铺平台返回 UNSUPPORTED_PLATFORM，不静默匹配', async () => {
    const runtime = readyRuntime(new TestAdapter(async () => {
      throw new Error('must not run')
    }), {
      getStore: vi.fn(() => ({ id: 'store_a', platform: '未知平台' } as unknown as Store))
    })
    const result = await detectStoreLoginStatus('store_a', {
      runtime,
      registry: createDefaultPlatformAdapterRegistry()
    })
    expect(result).toMatchObject({ status: 'ERROR', reasonCode: 'UNSUPPORTED_PLATFORM' })
  })

  it('Session 不是 READY 时禁止 LOGGED_IN', async () => {
    const adapter = new TestAdapter(async () => ({
      platform: '抖店', storeId: 'store_a', status: 'LOGGED_IN', checkedAt: Date.now(),
      reasonCode: 'TEST_POSITIVE', safeMessage: 'ignored', evidenceType: 'DOM'
    }))
    const runtime = readyRuntime(adapter, {
      getSessionStatus: vi.fn(() => ({
        storeId: 'store_a', status: 'CHECKING', sessionPresent: true, sessionReady: false,
        healthy: null, loginStatus: 'UNKNOWN', platform: '抖店', lastCheckedAt: null,
        loginCheckedAt: null, loginReasonCode: null, loginSafeMessage: null,
        loginEvidenceType: null, errorCode: null
      }))
    })
    const result = await detectStoreLoginStatus('store_a', {
      runtime,
      registry: new PlatformAdapterRegistry([adapter])
    })
    expect(result).toMatchObject({ status: 'UNKNOWN', reasonCode: 'SESSION_NOT_READY' })
    expect(runtime.recordPlatformLoginResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'UNKNOWN' }))
  })

  it('可靠测试证据可以返回 LOGGED_IN，但只回传安全摘要', async () => {
    const adapter = new TestAdapter(async () => ({
      platform: '抖店', storeId: 'store_a', status: 'LOGGED_IN', checkedAt: Date.now(),
      reasonCode: 'TEST_POSITIVE', safeMessage: 'ignored', evidenceType: 'DOM'
    }))
    const runtime = readyRuntime(adapter)
    const result = await detectStoreLoginStatus('store_a', {
      runtime,
      registry: new PlatformAdapterRegistry([adapter])
    })
    expect(result).toMatchObject({ status: 'LOGGED_IN', evidenceType: 'DOM' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/cookie|token|authorization|session/i)
    expect(Object.keys(result)).toEqual(['platform', 'storeId', 'status', 'checkedAt', 'reasonCode', 'safeMessage', 'evidenceType'])
  })

  it('统一契约保留 VERIFY_REQUIRED，不由 Session READY 推断登录成功', async () => {
    const adapter = new TestAdapter(async () => ({
      platform: '抖店', storeId: 'store_a', status: 'VERIFY_REQUIRED', checkedAt: Date.now(),
      reasonCode: 'TEST_VERIFY', safeMessage: 'ignored', evidenceType: 'DOM'
    }))
    const runtime = readyRuntime(adapter)
    const result = await detectStoreLoginStatus('store_a', {
      runtime,
      registry: new PlatformAdapterRegistry([adapter])
    })
    expect(result).toMatchObject({ status: 'VERIFY_REQUIRED', reasonCode: 'TEST_VERIFY' })
  })

  it('Adapter 异常被隔离为 ERROR，不影响服务返回', async () => {
    const adapter = new TestAdapter(async () => { throw new Error('private token should not escape') })
    const runtime = readyRuntime(adapter)
    const result = await detectStoreLoginStatus('store_a', {
      runtime,
      registry: new PlatformAdapterRegistry([adapter])
    })
    expect(result).toMatchObject({ status: 'ERROR', reasonCode: 'ADAPTER_ERROR', safeMessage: '平台登录状态检测失败' })
    expect(JSON.stringify(result)).not.toContain('private token')
  })

  it('一个平台 Adapter 异常不会阻断其它平台检测', async () => {
    const pddAdapter = new TestAdapter(async () => { throw new Error('pdd adapter failed') }, '拼多多')
    const douyinAdapter = new TestAdapter(async context => ({
      platform: context.platform, storeId: context.storeId, status: 'UNKNOWN', checkedAt: Date.now(),
      reasonCode: 'DETECTION_EVIDENCE_INSUFFICIENT', safeMessage: '', evidenceType: 'NONE'
    }))
    const runtime = readyRuntime(douyinAdapter, {
      getStore: vi.fn((storeId: string) => ({ id: storeId, platform: storeId === 'store_a' ? '拼多多' : '抖店' } as unknown as Store))
    })
    const registry = new PlatformAdapterRegistry([pddAdapter, douyinAdapter])
    const failed = await detectStoreLoginStatus('store_a', { runtime, registry })
    const healthy = await detectStoreLoginStatus('store_b', { runtime, registry })
    expect(failed.status).toBe('ERROR')
    expect(healthy.status).toBe('UNKNOWN')
  })

  it('检测超时后返回 UNKNOWN，不永久阻塞', async () => {
    const adapter = new TestAdapter(async () => new Promise<PlatformLoginResult>(() => undefined))
    const runtime = readyRuntime(adapter)
    const result = await detectStoreLoginStatus('store_a', {
      runtime,
      registry: new PlatformAdapterRegistry([adapter]),
      timeoutMs: 5
    })
    expect(result).toMatchObject({ status: 'UNKNOWN', reasonCode: 'DETECTION_TIMEOUT' })
  })

  it('检测只使用目标店铺的 Session 和标签页', async () => {
    const adapter = new TestAdapter(async context => {
      expect(context.storeId).toBe('store_a')
      return {
        platform: context.platform, storeId: context.storeId, status: 'UNKNOWN', checkedAt: Date.now(),
        reasonCode: 'DETECTION_EVIDENCE_INSUFFICIENT', safeMessage: '', evidenceType: 'NONE'
      }
    })
    const ensureSession = vi.fn(async (storeId: string) => {
      expect(storeId).toBe('store_a')
      return {} as unknown as Session
    })
    const runtime = readyRuntime(adapter, { ensureSession })
    const result = await detectStoreLoginStatus('store_a', {
      runtime,
      registry: new PlatformAdapterRegistry([adapter])
    })
    expect(result.storeId).toBe('store_a')
    expect(ensureSession).toHaveBeenCalledWith('store_a')
    expect(runtime.getTabWebContents).toHaveBeenCalledWith('store_a', 'tab_a')
    expect(runtime.getTabWebContents).not.toHaveBeenCalledWith('store_b', expect.anything())
  })

  it('发现 WebContents 属于其它 Session 时拒绝检测', async () => {
    const adapter = new TestAdapter(async () => ({
      platform: '抖店', storeId: 'store_a', status: 'LOGGED_IN', checkedAt: Date.now(),
      reasonCode: 'TEST_POSITIVE', safeMessage: '', evidenceType: 'DOM'
    }))
    const ownSession = {}
    const otherContents = {
      isDestroyed: () => false,
      session: {},
      getURL: () => 'https://fxg.jinritemai.com/ffa/mshop/trade/dashboard'
    } as unknown as WebContents
    const runtime = readyRuntime(adapter, {
      ensureSession: vi.fn(async () => ownSession as unknown as Session),
      getTabWebContents: vi.fn(() => otherContents)
    })
    const result = await detectStoreLoginStatus('store_a', {
      runtime,
      registry: new PlatformAdapterRegistry([adapter])
    })
    expect(result).toMatchObject({ status: 'ERROR', reasonCode: 'SESSION_MISMATCH' })
  })
})

// ---------- 正向证据：登录成功后必须能判成 LOGGED_IN ----------
// 2026-09-30 实测事故：`detectLoginStatus` 只有"登录页 / 验证页"这类**否定**证据，
// 正常页面一律落到 UNKNOWN；而全项目唯一把店铺置为 online 的路径就是它返回 LOGGED_IN ——
// 于是"店铺登录成功了，界面还一直显示离线"。下面把缺失的那条正向证据钉住。

/** 页面桩：只对**包含指定锚点文案**的脚本回 true（模拟页面判定，其余判据一律 false）。 */
function pageWithAnchors(anchors: readonly string[]): WebContents {
  return {
    isDestroyed: () => false,
    getURL: () => '',
    executeJavaScript: vi.fn(async (script: string) => anchors.some(text => script.includes(text)))
  } as unknown as WebContents
}

/** 四家平台的真实适配器 + 各自实测档案里的锚点（不手抄锚点文案，避免与档案脱节）。 */
function platformsWithProfiles() {
  return [
    { adapter: new WeChatShopAdapter(wechat), profile: businessProfileFor(wechat.name)! },
    { adapter: new DouDianAdapter(douDian), profile: businessProfileFor(douDian.name)! },
    { adapter: new KuaishouAdapter(kuaishou), profile: businessProfileFor(kuaishou.name)! },
    { adapter: new PddAdapter(pdd), profile: businessProfileFor(pdd.name)! }
  ]
}

describe('登录检测的正向证据（经营数据锚点真的渲染出来）', () => {
  it('四家平台都因「锚点渲染出来」判成 LOGGED_IN —— 此前没有任何适配器能返回 LOGGED_IN', async () => {
    for (const { adapter, profile } of platformsWithProfiles()) {
      expect(profile.metrics.length, profile.platform).toBeGreaterThan(0)
      const result = await adapter.detectLoginStatus(page({
        platform: adapter.platform,
        currentUrl: profile.pageUrl,
        webContents: pageWithAnchors(profile.metrics.map(m => m.anchorText))
      }))
      expect(result.status, adapter.platform).toBe('LOGGED_IN')
      expect(result.reasonCode, adapter.platform).toBe('PROFILE_ANCHOR_RENDERED')
      expect(result.evidenceType, adapter.platform).toBe('DOM')
    }
  })

  it('锚点没渲染出来仍然只给 UNKNOWN —— 绝不拿"主机对得上"当登录证据', async () => {
    for (const { adapter, profile } of platformsWithProfiles()) {
      const result = await adapter.detectLoginStatus(page({
        platform: adapter.platform,
        currentUrl: profile.pageUrl,
        webContents: pageWithAnchors([])
      }))
      expect(result.status, adapter.platform).toBe('UNKNOWN')
      expect(result.reasonCode, adapter.platform).toBe('DETECTION_EVIDENCE_INSUFFICIENT')
    }
  })

  it('当前页不是档案页（如切到发票页）时给 UNKNOWN，而不是"未登录"的结论', async () => {
    const result = await new WeChatShopAdapter(wechat).detectLoginStatus(page({
      platform: '微信小店',
      currentUrl: 'https://store.weixin.qq.com/shop/bill/home',
      webContents: pageWithAnchors([])
    }))
    expect(result.status).toBe('UNKNOWN')
  })

  it('明确的登录页证据优先于锚点（不会被"页面上恰好有同名字样"翻过来）', async () => {
    const result = await new WeChatShopAdapter(wechat).detectLoginStatus(page({
      platform: '微信小店',
      currentUrl: 'https://store.weixin.qq.com/shop/home',
      // 所有判据都回 true：过期文案先命中 → 必须仍是 LOGIN_REQUIRED
      webContents: {
        isDestroyed: () => false,
        getURL: () => '',
        executeJavaScript: vi.fn(async () => true)
      } as unknown as WebContents
    }))
    expect(result.status).toBe('LOGIN_REQUIRED')
    expect(result.reasonCode).toBe('EXPLICIT_LOGIN_PAGE')
  })

  // 2026-09-30 真机截图抓到的回归：商品同步会把店铺标签页导航到**商品列表页**并留在那里，
  // 而登录正向锚点（经营数据：成交金额…）只在后台首页 → 重启后打开该店一直显示离线。
  it('微信小店：店铺停在商品列表页时也算登录（表能渲染出来就说明登录着）', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    // 只在"商品列表页就绪"那段脚本上回 true；基类的经营数据锚点一律 false（模拟"不在首页"）
    const wc = {
      isDestroyed: () => false,
      getURL: () => 'https://store.weixin.qq.com/shop/goods/list',
      executeJavaScript: vi.fn(async (code: string) => /marker = /.test(code) && /__q\('table'\)/.test(code))
    }
    const result = await adapter.detectLoginStatus(page({
      platform: '微信小店',
      currentUrl: 'https://store.weixin.qq.com/shop/goods/list',
      webContents: wc as unknown as WebContents
    }))
    expect(result.status).toBe('LOGGED_IN')
    expect(result.reasonCode).toBe('PROFILE_ANCHOR_RENDERED')
  })

  it('微信小店：不在商品列表页时不拿这条证据（别把任意有表格的页面当登录证据）', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    const wc = {
      isDestroyed: () => false,
      getURL: () => 'https://store.weixin.qq.com/shop/settings',
      executeJavaScript: vi.fn(async (code: string) => /marker = /.test(code) && /__q\('table'\)/.test(code))
    }
    const result = await adapter.detectLoginStatus(page({
      platform: '微信小店',
      currentUrl: 'https://store.weixin.qq.com/shop/settings',
      webContents: wc as unknown as WebContents
    }))
    expect(result.status).toBe('UNKNOWN')
  })

  // 2026-09-30 实测复现：快手店铺重开后一直显示离线，日志里是
  // `快手小店 -> UNKNOWN / PAGE_NOT_RECOGNIZED` —— 因为店铺停在 s.kwaixiaodian.com，
  // 而适配器只认 syt.kwaixiaodian.com。下面把两个域名都钉住。
  it('快手：店铺实际停留的 s.kwaixiaodian.com 也认（该页有「成交金额」「成交订单数」锚点）', async () => {
    const result = await new KuaishouAdapter(kuaishou).detectLoginStatus(page({
      platform: '快手小店',
      currentUrl: 'https://s.kwaixiaodian.com/zone/home',
      webContents: pageWithAnchors(['成交金额', '成交订单数'])
    }))
    expect(result.status).toBe('LOGGED_IN')
    expect(result.reasonCode).toBe('PROFILE_ANCHOR_RENDERED')
  })

  it('快手的两个商家后台域名都认；登录页所在的 login.kwaixiaodian.com 不认（未登录必须判不出来）', async () => {
    const adapter = new KuaishouAdapter(kuaishou)
    for (const url of [
      'https://syt.kwaixiaodian.com/zones/goodsManagement/goods_overview',
      'https://s.kwaixiaodian.com/zone/home'
    ]) {
      const r = await adapter.detectLoginStatus(page({ platform: '快手小店', currentUrl: url, webContents: pageWithAnchors(['成交金额']) }))
      expect(r.status, url).toBe('LOGGED_IN')
    }
    // 实测：未登录访问 s.kwaixiaodian.com 会 302 到这里。即使页面上"恰好"有同名字样也不许判成登录。
    const login = await adapter.detectLoginStatus(page({
      platform: '快手小店',
      currentUrl: 'https://login.kwaixiaodian.com/',
      webContents: pageWithAnchors(['成交金额'])
    }))
    expect(login.status).toBe('UNKNOWN')
    expect(login.reasonCode).toBe('PAGE_NOT_RECOGNIZED')
  })
})

describe('登录检测结果 → 店铺状态', () => {
  it('确认登录才置在线；确认是登录页/验证页置 needs_login；没拿到证据不改状态', () => {
    expect(storeStatusForLoginResult('LOGGED_IN')).toBe(StoreStatus.ONLINE)
    // ⚠️ 明确的否定证据必须落到 `needs_login`，**不能**塌成 `offline`（2026-10-02 修）。
    // `offline` 的语义是"窗口没开 / 还没确认登录"（见 product-publish-rules.precheckPublish：
    // offline/launching 只记 warning，needs_login 才阻断发布），两者混为一谈时登录失效的
    // 店铺在界面上和"没开窗口"长得一样，概览的登录失效上报与发布阻断也永不触发。
    expect(storeStatusForLoginResult('LOGIN_REQUIRED')).toBe(StoreStatus.NEEDS_LOGIN)
    expect(storeStatusForLoginResult('VERIFY_REQUIRED')).toBe(StoreStatus.NEEDS_LOGIN)
    // UNKNOWN / ERROR = "这次没拿到证据"：既不能断言在线，也不能断言离线。
    // 以前一律写 offline，于是刚登录好的店一切到没有锚点的页面就被打回离线。
    expect(storeStatusForLoginResult('UNKNOWN')).toBeNull()
    expect(storeStatusForLoginResult('ERROR')).toBeNull()
  })

  it('否定证据绝不返回 offline，且 needs_login 在整条链路上真的可达', () => {
    // 这条断言存在的理由：`needs_login` 曾经**一个生产者都没有**——枚举、状态机（§9.1）、
    // 界面文案（"登录失效"）和发布阻断全都依赖它，却没有任何代码写它。把"否定证据 → 状态"
    // 的全集钉死，任何把否定证据重新塌回 offline 的改动都会在这里失败。
    const negative: Array<'LOGIN_REQUIRED' | 'VERIFY_REQUIRED'> = ['LOGIN_REQUIRED', 'VERIFY_REQUIRED']
    const produced = negative.map(storeStatusForLoginResult)
    expect(produced).toEqual([StoreStatus.NEEDS_LOGIN, StoreStatus.NEEDS_LOGIN])
    expect(produced).not.toContain(StoreStatus.OFFLINE)
  })
})
