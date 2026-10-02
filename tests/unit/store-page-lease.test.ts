/**
 * 「后台采集借用的店铺页面，什么时候能关」的回归测试。
 *
 * 对应 2026-10-02 用户实报：「采集任务完成后关闭网页，优化占用」。
 * 这里只测**决策**（纯状态机），页面开关的副作用在 window-manager。
 *
 * 每一条都对应一个真实会踩的坑：
 *   · 用户自己开着的页面被采集顺手关掉 → 用户正在登录/操作，页面直接没了；
 *   · 两个采集并发用同一个页面，先结束的把后结束的页面关了 → 后一个采集白跑一轮；
 *   · 用户中途把页面调出来看过，采集结束又被关掉 → 用户刚看的页面消失。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { StorePageLeases } from '../../apps/desktop/src/main/browser/page-lease'

describe('店铺页面租约账本', () => {
  it('我们自己为采集开的页面：归还后可以关', () => {
    const leases = new StorePageLeases()
    leases.borrow('store_a', true)
    expect(leases.release('store_a')).toBe(true)
    expect(leases.isBorrowed('store_a')).toBe(false)
  })

  it('页面本来就开着（多半是用户在用）：归还后**不关**', () => {
    const leases = new StorePageLeases()
    leases.borrow('store_a', false)
    expect(leases.release('store_a')).toBe(false)
  })

  it('用户中途接手（显示过/自己打开过）：归还后不关', () => {
    const leases = new StorePageLeases()
    leases.borrow('store_a', true)
    leases.claimByUser('store_a')
    expect(leases.release('store_a')).toBe(false)
  })

  it('两个借用者并发：先归还的不关，最后一个归还才关（引用计数）', () => {
    const leases = new StorePageLeases()
    leases.borrow('store_a', true)   // 采集 A 开的
    leases.borrow('store_a', false)  // 采集 B 复用同一个页面
    expect(leases.release('store_a')).toBe(false)
    expect(leases.isBorrowed('store_a')).toBe(true)
    expect(leases.release('store_a')).toBe(true)
  })

  it('页面已被别的路径关掉（用户点关闭/删店）→ 归还只清账，不重复触发关闭', () => {
    const leases = new StorePageLeases()
    leases.borrow('store_a', true)
    leases.forget('store_a')
    expect(leases.release('store_a')).toBe(false)
  })

  it('归还次数多于借用次数（防御）：不关，且不留脏状态', () => {
    const leases = new StorePageLeases()
    leases.borrow('store_a', true)
    expect(leases.release('store_a')).toBe(true)
    expect(leases.release('store_a')).toBe(false)
    expect(leases.release('store_a')).toBe(false)
    expect(leases.snapshot()).toEqual([])
  })

  it('可以关的判断只生效一次（避免同一轮里关两次）', () => {
    const leases = new StorePageLeases()
    leases.borrow('store_a', true)
    leases.borrow('store_a', true)
    expect(leases.release('store_a')).toBe(false)
    expect(leases.release('store_a')).toBe(true)
    // 第二次归还后账本已清，"后台开的"标记也一起清掉
    expect(leases.snapshot()).toEqual([])
  })

  it('快照能说清页面为什么还开着（借用中 / 后台开的 / 用户接手）', () => {
    const leases = new StorePageLeases()
    leases.borrow('store_b', true)
    leases.borrow('store_c', false)
    leases.claimByUser('store_c')
    expect(leases.snapshot()).toEqual([
      { storeId: 'store_b', borrowers: 1, backgroundOpened: true, userOwned: false },
      { storeId: 'store_c', borrowers: 1, backgroundOpened: false, userOwned: true }
    ])
  })
})

/**
 * 两条调用链的源码级约定（与 webview-embedding-boundary.test.ts 同一类断言）：
 * 账本再对，只要调用方不归还，页面照样常驻——这种"少一行就退化"的约定靠类型检查发现不了。
 */
describe('借用/归还的调用链', () => {
  const TASK_RUNNER = readFileSync(resolve('apps/desktop/src/main/tasks/task-runner.ts'), 'utf8')
  const COLLECTION_SERVICE = readFileSync(
    resolve('apps/desktop/src/main/sales-metrics/sales-metrics-collection-service.ts'),
    'utf8'
  )

  it('定时任务后台开店：借页面而不是"开完就不管"，并在 run 终态归还', () => {
    expect(TASK_RUNNER).toContain('borrowedPageReleases.set(runId, borrowStorePage(storeId))')
    expect(TASK_RUNNER).toContain("if (to === 'succeeded' || to === 'failed' || to === 'cancelled') releaseBorrowedPage(run.runId)")
    // 不能再退回"直接开店、从不归还"的写法
    expect(TASK_RUNNER).not.toContain('openStoreBrowser(storeId, { display: false, source: \'main\' })')
  })

  it('无人值守采集：无论成功/失败/异常都归还专用页（finally）', () => {
    expect(COLLECTION_SERVICE).toContain('borrowedPage = this.runtime.borrowCollectionPage(input.storeId)')
    expect(COLLECTION_SERVICE).toMatch(/finally\s*\{[\s\S]{0,700}borrowedPage\.release\(\)/)
  })
})
