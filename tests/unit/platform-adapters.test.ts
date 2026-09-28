import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WebContents } from 'electron'
import { findPlatform } from '@shared/constants/platforms'
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

  it('PDD 声明订单采集能力，其它平台业务采集能力保持关闭', () => {
    const registry = createDefaultPlatformAdapterRegistry()
    for (const platform of registry.listPlatforms()) {
      const capabilities = registry.getAdapter(platform).getCapabilities()
      expect(capabilities).toMatchObject({
        loginDetection: true,
        orders: platform === '拼多多',
        products: false,
        inventory: false,
        refunds: false,
        salesData: false
      })
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
