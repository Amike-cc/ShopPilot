/**
 * 「采集任务时不要影响浏览器使用」的回归测试（2026-10-02 用户要求）。
 *
 * 这条要求拆开是三条**源码级约定**，没有任何一条能靠类型检查发现（删掉它们代码照样编译，
 * 但用户的页面会被采集导航走）：
 *   ① 采集用**专用标签页**：不占活动位、不进标签栏、不落库；
 *   ② 渲染层为专用页挂**隐藏 webview**（否则专用页没有 guest，采集根本读不到页面）；
 *   ③ 采集服务只通过 `borrowCollectionPage` 拿页面，绝不退回"用用户的活动标签页"。
 *
 * 与 webview-embedding-boundary.test.ts 同一类断言：钉住"少一处就退化"的关键点。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(p), 'utf8')

const WINDOW_MANAGER = read('apps/desktop/src/main/browser/window-manager.ts')
const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')
const WORKSPACE = read('apps/desktop/src/renderer/src/stores/workspace.ts')
const METRICS_SERVICE = read('apps/desktop/src/main/sales-metrics/sales-metrics-collection-service.ts')
const SYNC_SERVICE = read('apps/desktop/src/main/products/product-sync-service.ts')

describe('采集专用页：不占用户的活动位、不进标签栏', () => {
  it('专用标签页不激活、标记 internal、且不落库（否则下次开店会被当成用户的标签页恢复）', () => {
    expect(WINDOW_MANAGER).toContain("const shouldActivate = opts.activate !== false && opts.internal !== true &&")
    expect(WINDOW_MANAGER).toContain('internal: opts.internal === true')
    expect(WINDOW_MANAGER).toMatch(/function saveTabToDatabase\(tab: Tab\): void \{\s*\n\s*\/\/[^\n]*\n\s*if \(tab\.internal === true\) return/)
  })

  it('专用页发给渲染层时带 internal 标记，渲染层才不会把它画成用户的标签', () => {
    expect(WINDOW_MANAGER).toContain('internal: tab.internal === true')
    // 标签栏过滤掉专用页
    expect(WORKSPACE).toContain('return tabs.filter(tab => tab.internal !== true)')
  })

  it('渲染层为专用页挂隐藏 webview，并把它排除在"页面未就绪"诊断之外', () => {
    expect(SURFACE).toContain('if (tab.internal !== true || tab.id === activeTab?.id) continue')
    expect(SURFACE).toContain('.filter(item => !item.internal)')
  })

  it('采集有独立标签页与归还入口（borrowCollectionPage），关店/关标签页都会清登记', () => {
    expect(WINDOW_MANAGER).toContain('export function borrowCollectionPage(')
    expect(WINDOW_MANAGER).toContain('export function acquireCollectionTab(')
    expect(WINDOW_MANAGER).toContain('collectionTabs.delete(storeId)')
  })
})

describe('采集服务不得使用用户正在用的标签页', () => {
  it('经营数据采集：只借专用页，不退回"该店铺的活动标签页"', () => {
    expect(METRICS_SERVICE).toContain('this.runtime.borrowCollectionPage(input.storeId)')
    // 这条最要紧：`waitForStoreWebContents` 返回的就是用户的活动标签页，采集一旦用它就会导航走用户的页面
    expect(METRICS_SERVICE).not.toContain('waitForStoreWebContents')
  })

  it('商品同步：同样只借专用页，且采完归还（失败路径也要还）', () => {
    expect(SYNC_SERVICE).toContain('runtime.borrowCollectionPage(storeId)')
    expect(SYNC_SERVICE).not.toContain('waitForStoreWebContents')
    expect(SYNC_SERVICE).not.toContain("openStoreBrowser(storeId, { display: true, source: 'main' })")
    // 三条退出路径都要归还：借不到页 / 登录门禁 / 采完或抛错
    expect(SYNC_SERVICE.match(/releasePage\(\)/g)?.length).toBeGreaterThanOrEqual(4)
  })
})
