import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DASHBOARD = readFileSync(resolve('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue'), 'utf8')
const DATA_PAGE = readFileSync(resolve('apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue'), 'utf8')
const APPS_PAGE = readFileSync(resolve('apps/desktop/src/renderer/src/features/workbench/UnifiedAppsPage.vue'), 'utf8')
const ACCEPTANCE = readFileSync(resolve('tools/acceptance/tax-report-real-verify.mjs'), 'utf8')

describe('涉税信息独立页面与功能模块', () => {
  it('侧栏入口、路由映射和页面标题独立于发票中心', () => {
    expect(DASHBOARD).toContain("{ key: 'tax', label: '涉税信息'")
    expect(DASHBOARD).toContain("'涉税信息': 'tax'")
    expect(DASHBOARD).toContain("else if (page === 'tax') activeNav.value = '涉税信息'")
    expect(DASHBOARD).toContain('activePage === \'tax\'')
    expect(DASHBOARD).toContain('mode="tax"')
    expect(DATA_PAGE).toContain("type DataMode = 'analytics' | 'invoices' | 'tax'")
    expect(DATA_PAGE).toContain("props.mode === 'tax' ? '涉税信息'")
  })

  it('发票与涉税页面互斥渲染各自模块', () => {
    expect(DATA_PAGE).toContain("<template v-if=\"mode === 'invoices'\">")
    expect(DATA_PAGE).toContain("<template v-else-if=\"mode === 'tax'\">")
    expect(DATA_PAGE).toContain('data-test="tax-report"')
    expect(DATA_PAGE).toContain('data-test="invoice-coverage"')
  })

  it('应用中心也把涉税信息作为可直达功能模块', () => {
    expect(APPS_PAGE).toContain("key: 'tax', label: '涉税信息'")
    expect(APPS_PAGE).toContain("page: 'tax'")
  })

  it('真机验收走涉税信息侧栏入口', () => {
    expect(ACCEPTANCE).toContain("includes('涉税信息')")
    expect(ACCEPTANCE).toContain('unified-tax-page')
    expect(ACCEPTANCE).not.toContain('发票中心里有「涉税信息报送」分区')
  })
})
