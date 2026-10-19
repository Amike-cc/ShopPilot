import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 发票中心「精简版 UI」（2026-10-15）：概览一行、筛选折叠、默认按主体、方向明细收起、移动端单列。
 *
 * 这是表现层结构（模板 + 少量状态），运行时的端到端断言在
 * tools/acceptance/invoice-license-local-verify.js 第 15 节（真点、真读 DOM）。
 * 这里把"不能被改回去"的纪律钉住：
 *   1. [data-test="invoice-totals"] 内 .dc-num 必须**恰好 3 个**、依次是
 *      待开票条数 / 可开金额 / 有票待开店铺数——验收脚本第 4/5 步按这个顺序取值；
 *   2. 旧的 4 张 KPI 卡 / 独立自动更新行 / 两条说明段落必须保持退场（说明收进 chip title）；
 *   3. 默认视图=「按主体」；「按店铺」的方向明细点开才渲染（v-if 而非常驻）；
 *   4. 异常如实（登录失效 / 未填执照 / 本次没采到 / 未解析）与跳转链路等红线一个都不能少。
 */

const PAGE = [
  'apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue',
  'apps/desktop/src/renderer/src/features/workbench/use-invoice-detail.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-tax-license.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-data-collection.ts',
].map(p => readFileSync(resolve(p), 'utf8')).join('\n')

describe('发票中心精简版 UI（2026-10-15）', () => {
  it('概览合并为一行：invoice-totals 内恰 3 个 .dc-num，且顺序固定（条数/金额/店铺）', () => {
    const start = PAGE.indexOf('data-test="invoice-totals"')
    const end = PAGE.indexOf('data-test="invoice-toolbar"')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const block = PAGE.slice(start, end)
    expect((block.match(/class="dc-num"/g) || []).length).toBe(3)
    const iCount = block.indexOf('invoiceTotal.count')
    const iAmount = block.indexOf('invoiceTotal.amountText')
    const iStores = block.indexOf('invoiceTotal.stores')
    expect(iCount).toBeGreaterThan(0)
    expect(iCount).toBeLessThan(iAmount)
    expect(iAmount).toBeLessThan(iStores)
  })

  it('旧式 KPI 卡 / 独立自动更新行 / 两条说明段落保持退场（样式与模板同删）', () => {
    expect(PAGE).not.toContain('dc-cards inv-kpis')
    expect(PAGE).not.toContain('invoice-pending-note')
    expect(PAGE).not.toContain('invoice-unparsed-note')
    expect(PAGE).not.toContain('.inv-kpis{')
    expect(PAGE).not.toContain('.inv-note{')
    expect(PAGE).not.toContain('class="inv-status"')
  })

  it('自动更新收敛为概览行内联开关（契约 id 与"总开关没开"假状态提示都保留）', () => {
    expect(PAGE).toContain('data-test="invoice-schedule"')
    expect(PAGE).toContain('data-test="invoice-schedule-toggle"')
    expect(PAGE).toMatch(/toggleInvoiceSchedule\(!invoiceSchedule\.active\)/)
    expect(PAGE).toContain('不自动跑')
  })

  it('页头只剩导出 + 采集；「刷新」收进概览行（且只在发票中心换位，其他模式按钮不动）', () => {
    expect(PAGE).toMatch(/v-if="mode !== 'invoices'"/)
    expect(PAGE).toContain('data-test="invoice-refresh"')
    expect(PAGE).toContain('data-test="invoice-export"')
    expect(PAGE).toContain('data-test="invoice-collect"')
  })

  it('筛选默认收起：常态只显示搜索 + 「筛选 · N」，四个下拉在面板里（data-test 原样保留）', () => {
    expect(PAGE).toContain('const filtersOpen = ref(false)')
    expect(PAGE).toContain('activeFilterCount')
    expect(PAGE).toContain('data-test="invoice-filter-toggle"')
    expect(PAGE).toMatch(/v-show="filtersOpen"/)
    for (const t of ['invoice-filter-status', 'invoice-filter-platform', 'invoice-filter-period', 'invoice-sort']) {
      expect(PAGE, t).toContain(t)
    }
  })

  it('默认视图=「按主体」；「按店铺」的方向明细点开才渲染（v-if）', () => {
    expect(PAGE).toMatch(/'stores' \| 'summary'>\('summary'\)/)
    expect(PAGE).toContain('expandedStoreDirs')
    expect(PAGE).toContain("'invoice-dir-toggle-' + row.storeId")
    expect(PAGE).toMatch(/v-if="isStoreDirsOpen\(row\.storeId\)" class="invoice-sections"/)
  })

  it('移动端：<768 单列断点 + 底部常驻操作条（桌面隐藏）', () => {
    expect(PAGE).toContain('inv-mobile-actions')
    expect(PAGE).toMatch(/@media\(max-width:768px\)/)
    expect(PAGE).toMatch(/\.inv-mobile-actions\{display:none\}/)
    expect(PAGE).toMatch(/position:sticky;bottom:0/)
  })

  it('红线保留：异常如实 chip / 去登录与去补录入口 / 未解析与无需操作摘要', () => {
    expect(PAGE).toContain('data-test="invoice-status-login"')
    expect(PAGE).toContain('data-test="invoice-status-license"')
    expect(PAGE).toContain('家本次没采到')
    expect(PAGE).toContain('条金额未解析')
    expect(PAGE).toContain('条无需操作')
  })
})
