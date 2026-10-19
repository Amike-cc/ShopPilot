import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DASHBOARD = readFileSync(resolve('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue'), 'utf8')
const DATA_PAGE = [
  'apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue',
  'apps/desktop/src/renderer/src/features/workbench/use-invoice-detail.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-tax-license.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-data-collection.ts',
].map(p => readFileSync(resolve(p), 'utf8')).join('\n')
const ACCEPTANCE = readFileSync(resolve('tools/acceptance/invoice-license-local-verify.js'), 'utf8')

describe('发票中心独立页面入口', () => {
  it('侧栏提供独立入口并映射到 invoices 页面', () => {
    expect(DASHBOARD).toContain("{ key: 'invoices', label: '发票中心'")
    expect(DASHBOARD).toContain("'发票中心': 'invoices'")
    expect(DASHBOARD).toContain("else if (page === 'invoices') activeNav.value = '发票中心'")
    expect(DASHBOARD).toContain(':data-test="`nav-${item.key}`"')
  })

  it('发票页面仍复用完整数据组件，但不再嵌套经营分析页签', () => {
    expect(DASHBOARD).toContain('activePage === \'invoices\'')
    expect(DASHBOARD).toContain('mode="invoices"')
    expect(DATA_PAGE).not.toContain('unified-route-tabs')
    expect(DATA_PAGE).not.toContain("'change-mode'")
  })

  it('本地发票验收走独立侧栏入口', () => {
    expect(ACCEPTANCE).toContain("includes('发票中心')")
    expect(ACCEPTANCE).not.toContain('unified-route-tabs')
    expect(ACCEPTANCE).not.toContain('数据分析 → 发票中心')
  })
})
