import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 发票中心「按主体」分组视图（2026-10-15 重制）：主体 → 下属店铺 的层级 + 点店铺行进入店铺详情。
 *
 * 为什么是源码级回归：它是**表现层结构**（模板 + 一个 computed + 一条跳转链），
 * 运行时的端到端断言在 tools/acceptance/invoice-license-local-verify.js 第 14 节（真点、真跳）。
 * 这里把四条"不能被改回去"的纪律钉住：
 *   1. 每行必落一组：归属只用 keyByStore 这一张表，兜底 NO_LICENSE_KEY——不许再出现旧实现那种
 *      `|| ''` + continue 把行无声吞掉（那会让"店里有票、屏上没店"变成无痕迹的假象）；
 *   2. 家数以**列出来的店铺行**为准（屏上"N 家"与下面实际行数必须对得上）；
 *   3. 店铺行点击走 openStoreDetail → open-store（与全应用"点店铺"同一条链：先 await 打开，再 emit 切页）；
 *   4. 未填写组固定最后（排序在 shared/store-license.ts，已有单测）且补录入口齐备。
 */

const PAGE = [
  'apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue',
  'apps/desktop/src/renderer/src/features/workbench/use-invoice-detail.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-tax-license.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-data-collection.ts',
].map(p => readFileSync(resolve(p), 'utf8')).join('\n')

describe('发票中心「按主体」分组视图', () => {
  it('分组模型：每行必落一组（keyByStore 单表 + 兜底 NO_LICENSE_KEY）', () => {
    expect(PAGE).toMatch(/const invoiceSubjectGroups = computed/)
    expect(PAGE).toMatch(/keyByStore\.get\(row\.storeId\) \|\| NO_LICENSE_KEY/)
  })

  it('家数以列出来的店铺行为准；占比文案标明"按金额，不是按条数"', () => {
    expect(PAGE).toMatch(/storeCount: stores\.length/)
    expect(PAGE).toContain('按金额，不是按条数')
  })

  it('模板：主体一块 + 组头"下属店铺 · N 家" + 店铺行带 data-test 与跳转入口', () => {
    expect(PAGE).toMatch(/:data-test="'invoice-subject-group-' \+ group\.key"/)
    expect(PAGE).toMatch(/:data-test="'invoice-subject-store-' \+ row\.storeId"/)
    expect(PAGE).toContain('下属店铺 · {{ group.storeCount }} 家')
    expect(PAGE).toContain('进入店铺 →')
    expect(PAGE).toMatch(/@click="openStoreDetail\(row\)"/)
  })

  it('店铺行点击 = 打开该店并切到店铺详情（先 await 再 emit，与全应用同一条链）', () => {
    const start = PAGE.indexOf('async function openStoreDetail')
    expect(start).toBeGreaterThan(0)
    const body = PAGE.slice(start, PAGE.indexOf('\n}', start))
    expect(body).toContain('await ws.openStore(row.storeId)')
    expect(body).toContain("emit('open-store', row.storeId)")
    // 已打开且正在显示的店不重复打开（openStore 幂等的前提）
    expect(body).toContain('ws.openStoreIds.includes(row.storeId)')
  })

  it('未填写组：单独成组（固定排最后由 shared 保证）+ 两级补录入口（组头去补录 / 行内未填执照）', () => {
    expect(PAGE).toContain("'invoice-subject-needs-license-' + group.key")
    expect(PAGE).toContain('startFillLicense(group)')
    expect(PAGE).toContain("'invoice-subject-store-fill-' + row.storeId")
    expect(PAGE).toContain('不会并入任何真实主体')
  })

  it('收起/展开：默认全部展开，只折叠显示不改数字', () => {
    expect(PAGE).toMatch(/const collapsedSubjects = ref<Set<string>>\(new Set\(\)\)/)
    expect(PAGE).toContain('function isSubjectCollapsed')
    expect(PAGE).toContain('function toggleSubjectGroup')
    expect(PAGE).toMatch(/v-show="!isSubjectCollapsed\(group\.key\)"/)
  })

  it('分组内行内补录：编辑器挂在所属组下，保存走同一套 saveLicense', () => {
    expect(PAGE).toMatch(/licenseEditingGroupKey = computed/)
    expect(PAGE).toMatch(/keyByStore\.get\(licenseEditingId\.value\) \|\| NO_LICENSE_KEY/)
    expect(PAGE).toContain('async function saveLicenseInGroup')
    expect(PAGE).toContain("'invoice-subject-license-edit-' + licenseEditingId")
  })

  it('空态与工具栏口径都走新模型（旧 invoiceSummaryRows 已移除）', () => {
    expect(PAGE).toContain('!invoiceSubjectGroups.length')
    expect(PAGE).toContain('{{ invoiceSubjectGroups.length }}')
    expect(PAGE).not.toContain('invoiceSummaryRows')
    // 平表样式一并退场（列表容器改为分组卡片容器）
    expect(PAGE).not.toContain('inv-summary-table')
  })
})
