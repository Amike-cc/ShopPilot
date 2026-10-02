/**
 * 「登录检测 → 店铺状态落库」整条链路的回归测试。
 *
 * 存在的理由：`StoreStatus.NEEDS_LOGIN` 曾经**一个生产者都没有**——枚举、状态机
 * （`docs/DEVELOPMENT_SPEC.md` §9.1）、界面文案（"登录失效"）和发布预检的阻断项全都依赖它，
 * 却没有任何代码写它。这里不测纯函数（`platform-adapters.test.ts` 已覆盖映射表），而是走
 * **默认运行时**（`useDedupe === true`，即真正会落库的那条路径），断言：
 *   · 适配器给出明确的否定证据（登录页）→ 店铺状态被写成 `needs_login`，**不是** `offline`；
 *   · 适配器给出正向证据 → 写 `online`；
 *   · 拿不到证据（UNKNOWN）→ **不写**任何状态（保持上一次已确认的结论）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { StoreStatus } from '@shared/enums/store-status'

const STORE_ID = 'store_a'

const mocks = vi.hoisted(() => {
  const session = { id: 'session_a' }
  const webContents = {
    isDestroyed: () => false,
    getURL: () => 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
    // 只认"锚点探测"脚本（pageHasTextDeep）为真；登录/过期文案探测（pageTextMatches）一律为假。
    executeJavaScript: async (code: string) => String(code).includes('const want ='),
    session
  }
  return {
    session,
    webContents,
    updateStoreStatus: vi.fn(() => true),
    getStore: vi.fn(() => ({ id: STORE_ID, name: '11121', platform: '抖店' })),
    ensureSession: vi.fn(async () => session),
    getSessionStatus: vi.fn(() => ({
      storeId: STORE_ID, status: 'READY', sessionPresent: true, sessionReady: true,
      healthy: true, loginStatus: 'UNKNOWN', platform: '抖店',
      lastCheckedAt: Date.now(), loginCheckedAt: null, loginReasonCode: null,
      loginSafeMessage: null, loginEvidenceType: null, errorCode: null
    })),
    getActiveTabId: vi.fn(() => 'tab_a'),
    getTabWebContents: vi.fn(() => webContents),
    getCurrentStoreWebContents: vi.fn(() => webContents),
    recordPlatformLoginResult: vi.fn((result: unknown) => result)
  }
})

vi.mock('../../apps/desktop/src/main/stores/store-manager', () => ({
  getStore: mocks.getStore,
  updateStoreStatus: mocks.updateStoreStatus
}))

vi.mock('../../apps/desktop/src/main/browser/window-manager', () => ({
  getActiveTabId: mocks.getActiveTabId,
  getTabWebContents: mocks.getTabWebContents,
  getCurrentStoreWebContents: mocks.getCurrentStoreWebContents
}))

vi.mock('../../apps/desktop/src/main/browser/shop-session-manager', () => ({
  ensureSession: mocks.ensureSession,
  getSessionStatus: mocks.getSessionStatus,
  recordPlatformLoginResult: mocks.recordPlatformLoginResult
}))

vi.mock('../../apps/desktop/src/main/services/logger', () => ({
  logMain: vi.fn()
}))

import {
  detectStoreLoginStatus,
  resetPlatformLoginCacheForTests
} from '../../apps/desktop/src/main/platform-adapters/platform-login-service'

/** 把当前页面地址换成给定 URL（其余探测行为不变）。 */
function setUrl(url: string): void {
  mocks.webContents.getURL = () => url
}

describe('登录检测 → 店铺状态落库（默认运行时）', () => {
  beforeEach(() => {
    resetPlatformLoginCacheForTests()
    mocks.updateStoreStatus.mockClear()
    setUrl('https://fxg.jinritemai.com/ffa/mshop/homepage/index')
  })

  it('确认跳到登录页 → 落库 needs_login（不是 offline）', async () => {
    // 抖店适配器的 loginPath = /roles-select|\/login\//i：命中即"明确的否定证据"。
    setUrl('https://fxg.jinritemai.com/login/')
    const result = await detectStoreLoginStatus(STORE_ID)
    expect(result.status).toBe('LOGIN_REQUIRED')
    expect(mocks.updateStoreStatus).toHaveBeenCalledTimes(1)
    expect(mocks.updateStoreStatus).toHaveBeenCalledWith(STORE_ID, StoreStatus.NEEDS_LOGIN)
    expect(mocks.updateStoreStatus).not.toHaveBeenCalledWith(STORE_ID, StoreStatus.OFFLINE)
  })

  it('确认选角色页（未登录）→ 同样落库 needs_login', async () => {
    setUrl('https://fxg.jinritemai.com/roles-select')
    const result = await detectStoreLoginStatus(STORE_ID)
    expect(result.status).toBe('LOGIN_REQUIRED')
    expect(mocks.updateStoreStatus).toHaveBeenCalledWith(STORE_ID, StoreStatus.NEEDS_LOGIN)
  })

  it('经营数据锚点渲染出来（正向证据）→ 落库 online', async () => {
    const result = await detectStoreLoginStatus(STORE_ID)
    expect(result.status).toBe('LOGGED_IN')
    expect(mocks.updateStoreStatus).toHaveBeenCalledWith(STORE_ID, StoreStatus.ONLINE)
  })

  it('拿不到证据（UNKNOWN）→ 不写任何状态，保持上一次已确认的结论', async () => {
    // 主机不在白名单 = 这次没有证据（既不是"确认登录"，也不是"确认未登录"）。
    setUrl('https://example.com/')
    const result = await detectStoreLoginStatus(STORE_ID)
    expect(result.status).toBe('UNKNOWN')
    expect(mocks.updateStoreStatus).not.toHaveBeenCalled()
  })
})

describe('窗口开/关不得无证据写 offline（源码级约定）', () => {
  // 与 webview-embedding-boundary.test.ts 同一类断言：这条纪律没有任何运行时类型检查能发现，
  // 删掉守卫代码照样编译通过，但界面会退回"登录着的店铺一直显示离线"。
  const WINDOW_MANAGER = readFileSync(
    resolve('apps/desktop/src/main/browser/window-manager.ts'),
    'utf8'
  )

  it('全文件只有一处 offline 写入，且必须带"从未确认过登录"（incomplete）守卫', () => {
    const writes = WINDOW_MANAGER.match(/updateStoreStatus\(storeId, StoreStatus\.OFFLINE\)/g) || []
    expect(writes).toHaveLength(1)
    // 唯一那处必须紧跟 INCOMPLETE 判断（§9.1 的 incomplete -> offline）
    expect(WINDOW_MANAGER).toMatch(/current === StoreStatus\.INCOMPLETE\)\s*updateStoreStatus\(storeId, StoreStatus\.OFFLINE\)/)
    // 打开浏览器走的是这个受守卫的入口；关闭浏览器**不写**状态
    expect(WINDOW_MANAGER).toContain('markBrowserWindowState(storeId)')
  })

  it('明确说明为什么开/关窗口不算登录证据（否则下一个人会"顺手补回"无条件 offline）', () => {
    expect(WINDOW_MANAGER).toContain('打开/关闭店铺浏览器只说明"窗口开没开"，**不是**登录证据')
  })
})
