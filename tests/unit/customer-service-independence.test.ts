import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CUSTOMER_SERVICE_SESSION_PARTITION_PREFIX, customerServiceSessionPartition } from '../../packages/shared/src/contracts/customer-service'

const read = (path: string) => readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n')
const APP = read('apps/desktop/src/renderer/src/app/App.vue')
const MAIN = read('apps/desktop/src/main/index.ts')
const MONITOR = read('apps/desktop/src/main/services/customer-message-monitor.ts')
const DASHBOARD = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const SERVICE = read('apps/desktop/src/renderer/src/features/customer-service/CustomerServiceWorkspace.vue')
const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')
const SESSION_MANAGER = read('apps/desktop/src/main/browser/session-manager.ts')
const SHOP_SESSION_MANAGER = read('apps/desktop/src/main/browser/shop-session-manager.ts')

describe('经营工作台与电商客服工作区边界', () => {
  it('应用壳只切换可见工作区，两个工作区都保持挂载', () => {
    expect(APP).toContain('<DashboardView :active="!customerServiceOpen"')
    expect(APP).toContain('<CustomerServiceWorkspace')
    expect(APP).toContain(':active="customerServiceOpen"')
    expect(APP).toContain('@back-commerce="customerServiceOpen = false"')
  })

  it('客服工作区不复用经营浏览器组件或经营标签动作', () => {
    expect(SERVICE).not.toContain('DashboardBrowserSurface')
    expect(SERVICE).not.toContain('openCustomerServiceTab')
    expect(SERVICE).not.toContain('browser.display')
    expect(SERVICE).not.toContain('browser.close')
    expect(SERVICE).not.toContain('browser.tab.activate')
    expect(SERVICE).toContain('客服工作区只保存自己的店铺选择')
    expect(SERVICE).toContain('shopilot.customer-service-monitor-store')
  })

  it('经营浏览器只渲染经营标签，不接收客服模式分支', () => {
    expect(SURFACE).not.toContain('customer-service-mode')
    expect(SURFACE).not.toContain('isCustomerServiceTab')
    expect(SURFACE).toContain('v-for="tab in ws.displayedTabs"')
    expect(DASHBOARD).toContain('data-test="workspace-tab-customer-service"')
  })

  it('客服工作区打开时，经营工作台不响应全局快捷键和面板事件', () => {
    expect(DASHBOARD).toContain('if (!props.active) return\n  const panel = String(payload?.panel || \'\')')
    expect(DASHBOARD).toContain('if (!props.active) return\n  if ((event.ctrlKey || event.metaKey)')
    expect(DASHBOARD).toContain('if (!props.active) return\n  if (storeId && source === \'main\'')
  })

  it('没有可靠消息源时界面保持空值和未验证状态', () => {
    expect(SERVICE).toContain('未接入可靠来源')
    expect(SERVICE).toContain('未读取平台会话')
    expect(SERVICE).toContain('不会展示推测数字')
    expect(SERVICE).toContain('能力未接入')
  })

  it('客服标题栏为 Windows 原生窗口按钮预留空间，返回按钮不会被覆盖', () => {
    expect(SERVICE).toContain('padding: 0 148px 0 28px')
    expect(SERVICE).toContain('-webkit-app-region: drag')
    expect(SERVICE).toContain('.customer-service-toolbar-actions { display: flex;')
    expect(SERVICE).toContain('-webkit-app-region: no-drag')
    expect(SERVICE).toContain('data-test="customer-service-back-commerce"')
    expect(SERVICE).toContain('@click.stop.prevent="backToCommerce"')
  })

  it('客服工作区打开时，长期挂载的店铺 WebView 会移出命中区域但不销毁', () => {
    expect(DASHBOARD).toContain(':aria-hidden="!browserHostActive"')
    expect(DASHBOARD).toContain('browserHostActive = computed(() => props.active && activePage.value === \'browser\'')
    expect(DASHBOARD).toMatch(/dashboard-browser-host:not\(\.active\)[\s\S]*?transform:\s*translate3d\(-200vw, 0, 0\)/)
    expect(DASHBOARD).toMatch(/dashboard-browser-host:not\(\.active\)[\s\S]*?opacity:\s*0[\s\S]*?pointer-events:\s*none/)
    expect(DASHBOARD).not.toMatch(/dashboard-browser-host:not\(\.active\)[^{]*\{[^}]*display:\s*none/)
    expect(DASHBOARD).not.toMatch(/dashboard-browser-host:not\(\.active\)[^{]*\{[^}]*visibility:\s*hidden/)
  })

  it('客服 guest 的导航与弹窗由主进程收口，避免远程页面绕过应用窗口边界', () => {
    expect(MAIN).toContain("'did-attach-webview'")
    expect(MAIN).toMatch(/did-attach-webview'[\s\S]*?_event[^,]*, guestWebContents/)
    expect(MAIN).toContain('guestWebContents as any)?.session?.partition')
    expect(MAIN).toContain('customer-service guest: blocked popup outside platform allowlist')
    expect(MAIN).toContain('isAllowedCustomerServiceUrl(store.platform, url)')
    const SESSION_GUARD = read('apps/desktop/src/main/browser/session-manager.ts')
    expect(SESSION_GUARD).toContain("sess.webRequest.onBeforeRequest({ urls: ['*://*/*'] }")
    expect(SESSION_GUARD).toContain("details.resourceType !== 'mainFrame'")
    expect(SESSION_GUARD).toContain('callback({ cancel: true })')
    expect(MAIN).toContain("guestWebContents.on('will-navigate'")
    expect(MAIN).toContain("guestWebContents.on('will-redirect'")
    expect(MAIN).toContain("return { action: 'deny' }")
  })

  it('隐藏客服监控窗口也收口弹窗和远程协议，不能绕过可见客服页边界', () => {
    expect(MONITOR).toContain('setWindowOpenHandler')
    expect(MONITOR).toContain("customer-service monitor: blocked unsafe navigation")
    expect(MONITOR).toContain('isAllowedCustomerServiceUrl(store.platform, url)')
  })

  it('锁定期间暂停客服监控，解锁只恢复锁定前正在运行的实例', () => {
    expect(MAIN).toContain('customerMessageMonitor.pauseForAppLock()')
    const SECURITY = read('apps/desktop/src/main/ipc/session-security-handlers.ts')
    expect(SECURITY).toContain('customerMessageMonitor.resumeAfterAppUnlock()')
    expect(SERVICE).toContain('ws.stores.length, ws.appLocked')
  })

  it('客服视口只挂载当前店铺的 WebView，不把已访问店铺的页面并排或叠放', () => {
    expect([...SERVICE.matchAll(/<webview\b/g)]).toHaveLength(1)
    expect(SERVICE).toContain('<webview v-if="serviceEntry(activeStore)" :key="activeStore.id"')
    expect(SERVICE).toContain(':partition="customerServiceSessionPartition(activeStore.id)"')
    expect(SERVICE).toContain(':data-store-id="activeStore.id"')
    expect(SERVICE).not.toContain('v-for="entry in visitedEntries"')
    expect(SERVICE).not.toContain('customer-browser-tabs')
    expect(SERVICE).not.toContain('.customer-service-webview.active')
  })

  it('客服 Chromium 分区由共享映射按店铺唯一确定，页面、监控和删除流程使用同一分区', () => {
    const storeA = customerServiceSessionPartition('store-a')
    const storeB = customerServiceSessionPartition('store-b')
    expect(storeA).toBe(`${CUSTOMER_SERVICE_SESSION_PARTITION_PREFIX}store-a`)
    expect(storeB).toBe(`${CUSTOMER_SERVICE_SESSION_PARTITION_PREFIX}store-b`)
    expect(storeA).not.toBe(storeB)
    expect(SESSION_MANAGER).toContain('session.fromPartition(customerServiceSessionPartition(storeId), { cache: true })')
    expect(SESSION_MANAGER).toContain('CUSTOMER_SERVICE_SESSION_PARTITION_PREFIX')
    expect(SHOP_SESSION_MANAGER).toContain('electronSession.fromPartition(customerServiceSessionPartition(id), { cache: true })')
    expect(MONITOR).toContain('partition: customerServiceSessionPartition(storeId)')
    expect(MAIN).toContain('params.partition === customerServiceSessionPartition(customerServiceStoreId)')
    expect(MAIN).toContain('partition !== customerServiceSessionPartition(customerServiceStoreId)')
  })

  it('客服工作区未打开时不会自动选店或导航到远程客服页面', () => {
    expect(SERVICE).toContain('if (!props.active) {')
    expect(SERVICE).toContain("selectedStoreId.value = ''")
    expect(SERVICE).toContain('watch(() => props.active, active => { if (active) syncSelectedStore() })')
  })

  it('消息检查中的忙碌和错误状态绑定到对应店铺工作台', () => {
    expect(SERVICE).toContain('createStoreScopedCheckController')
    expect(SERVICE).toContain('checkingStoreIds.has(selectedStoreId)')
    expect(SERVICE).toContain('storeCheckErrors.get(selectedStoreId.value)')
  })

  it('两个独立 partition 的 407 去重键不会互相取消挑战', () => {
    const SESSION = read('apps/desktop/src/main/browser/session-manager.ts')
    expect(SESSION).toContain('isDuplicateChallenge(storeId, sessionKey, details.url)')
    expect(SESSION).toContain('`${storeId}\\u0000${sessionKey}\\u0000${url}`')
  })

  it('Cookie 清理不因客服页面未打开而创建客服 Session，单 Cookie 删除后会重拍快照', () => {
    const SESSION = read('apps/desktop/src/main/browser/session-manager.ts')
    const SECURITY = read('apps/desktop/src/main/ipc/session-security-handlers.ts')
    expect(SESSION).toContain('customerServiceSess = customerServiceSessions.get(storeId)')
    expect(SESSION).toMatch(/if \(customerServiceSess && !origin\) await customerServiceSess\.clearStorageData\(options\)/)
    expect(SESSION).not.toContain('customerServiceSessions.get(storeId)\n      || session.fromPartition')
    expect(SESSION).toContain('else if (!origin)')
    expect(SECURITY).toContain('await SessionPersistence.snapshotStoreSession(storeId)')
  })
})
