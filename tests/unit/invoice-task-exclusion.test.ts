import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INVOICE_TASK_PREFIX, isInvoiceCollectTask } from '@shared/constants/invoice'
import { TAX_TASK_PREFIX } from '@shared/constants/tax'
import { isBackgroundCollectTask } from '@shared/constants/collection'

/**
 * 用户口径：**后台自动采集任务不计入任务**（发票采集「每 3 小时」+ 涉税报送采集「按季度」）。
 *
 * 背景：发票中心/涉税分区会在库里建「发票采集 ·<店铺>」「涉税报送采集 ·<店铺>」任务。
 * 那是**后台刷新**，不是用户要管理的活儿——任务中心的列表与统计、概览「待办任务」卡、
 * 任务总数与工具栏任务红点都不该把它们算成一项任务。
 *
 * 为什么要有这份源码级回归：这类"某个统计口径漏排除一处"的问题运行时不会报错、
 * 类型检查也看不出来，只会让用户看到"数字比列表多"或"待办里混进后台刷新"——
 * 与仓库里已经修过的「恒错数字」是同一类。所以把每个口径都钉在这里。
 * 2026-10-15 审查 M5：概览任务总数曾只排发票、漏了涉税；渲染层四处也已统一到
 * shared 的 isBackgroundCollectTask（两个前缀的单一事实来源）。
 *
 * 同时钉住**反面**：不能把过滤下沉到 `ws.tasks` 数据源。发票/涉税中心自己的
 * 「自动更新」开关要靠 `ws.tasks` 找到那个任务改周期，采集也要靠它复用同一个任务；
 * 在 store 层摘掉就等于把这个功能弄坏。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')

const TASK_PAGE = read('apps/desktop/src/renderer/src/features/workbench/UnifiedTaskPage.vue')
const DASHBOARD = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')
const DATA_PAGE = read('apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue')
const OVERVIEW_SERVICE = read('apps/desktop/src/main/services/overview-service.ts')
const WORKSPACE = read('apps/desktop/src/renderer/src/stores/workspace.ts')

describe('发票采集任务的识别', () => {
  it('前缀就是实际生成的任务名开头（改前缀会让库里已有的任务认不出来）', () => {
    expect(INVOICE_TASK_PREFIX).toBe('发票采集 ·')
    // 实际生成的名字形如 `发票采集 ·<店铺名>`（历史写法：中间没有空格），必须认得出来
    expect(isInvoiceCollectTask(`${INVOICE_TASK_PREFIX}微信小店`)).toBe(true)
    expect(isInvoiceCollectTask({ name: `${INVOICE_TASK_PREFIX}抖店` })).toBe(true)
  })

  it('只认前缀，不误伤别的任务（尤其名字里带「发票」的普通任务）', () => {
    for (const name of [
      '经营指标采集 · 抖店',
      '订单明细采集 · 抖店',
      '达人邀约 · 抖店 · 智能体',
      '自定义任务 · 2026/9/30',
      '发票整理',      // 含「发票」但不是自动采集任务
      '给平台开票',    // 开票方向名，不是任务名
      ''
    ]) expect(isInvoiceCollectTask(name), name).toBe(false)
    expect(isInvoiceCollectTask(null)).toBe(false)
    expect(isInvoiceCollectTask(undefined)).toBe(false)
    expect(isInvoiceCollectTask({} as unknown as { name?: unknown })).toBe(false)
  })
})

describe('后台采集任务的统一判定（isBackgroundCollectTask）', () => {
  it('两个前缀都认（字符串与任务对象两种传法）', () => {
    expect(isBackgroundCollectTask(`${INVOICE_TASK_PREFIX}微信小店`)).toBe(true)
    expect(isBackgroundCollectTask({ name: `${TAX_TASK_PREFIX}福气满满` })).toBe(true)
    expect(isBackgroundCollectTask(`${TAX_TASK_PREFIX}11121`)).toBe(true)
    expect(isBackgroundCollectTask({ name: `${INVOICE_TASK_PREFIX}11121` })).toBe(true)
  })

  it('不误伤别的任务；空值一律 false', () => {
    for (const name of [
      '经营指标采集 · 抖店',
      '订单明细采集 · 抖店',
      '达人邀约 · 抖店 · 智能体',
      '自定义任务 · 2026/9/30',
      '涉税整理',      // 含「涉税」但不是自动采集任务
      ''
    ]) expect(isBackgroundCollectTask(name), name).toBe(false)
    expect(isBackgroundCollectTask(null)).toBe(false)
    expect(isBackgroundCollectTask(undefined)).toBe(false)
    expect(isBackgroundCollectTask({} as unknown as { name?: unknown })).toBe(false)
  })
})

describe('后台采集不计入任务的各个口径', () => {
  it('任务中心：列表与四个统计数都走同一份「可见任务」', () => {
    expect(TASK_PAGE).toMatch(/visibleTasks = computed\([\s\S]{0,240}?isBackgroundCollectTask/)
    for (const name of ['filteredTasks', 'activeTasks', 'waitingTasks', 'completedTasks']) {
      expect(TASK_PAGE, name).toMatch(new RegExp(`${name} = computed\\(\\(\\) => visibleTasks\\.value`))
    }
    expect(TASK_PAGE).toContain('<span>全部任务</span><strong>{{ visibleTasks.length }}</strong>')
    // 统计只能经由 visibleTasks 取数：允许直接读 ws.tasks 的 computed **只有它自己这一处**，
    // 多出一处就是漏排除（数字会比列表多）
    const directReads = TASK_PAGE.match(/computed\(\(\) => ws\.tasks/g) || []
    expect(directReads.length, '只有 visibleTasks 可以直接读 ws.tasks').toBe(1)
    expect(TASK_PAGE).toMatch(/visibleTasks = computed\(\(\) => ws\.tasks/)
  })

  it('概览：待办任务卡与工具栏通知红点都不含后台采集任务', () => {
    expect(DASHBOARD).toMatch(/pendingTasks = computed\([\s\S]{0,240}?isBackgroundCollectTask/)
    // 2026-10-17：工具栏红点改由通知中心统一驱动（进行中/待确认/失败/客服未读）。
    // 通知数据同样必须排除后台采集任务，否则发票/涉税采集会把红点一直点亮。
    expect(DASHBOARD).toMatch(/notificationTasks = computed\([\s\S]{0,400}?isBackgroundCollectTask/)
  })

  it('浏览器右栏「任务中心 → 任务列表」同样排除（只取 6 条，不排就被挤出去）', () => {
    expect(SURFACE).toMatch(/taskRows = computed\([\s\S]{0,240}?isBackgroundCollectTask/)
  })

  it('主进程的任务总数用它排除，且前缀不再有第二处硬编码', () => {
    expect(OVERVIEW_SERVICE).toContain('INVOICE_TASK_PREFIX')
    expect(OVERVIEW_SERVICE).toContain('TAX_TASK_PREFIX')
    expect(OVERVIEW_SERVICE).toContain('NOT LIKE ?')
    // 硬编码前缀正是口径漂移的源头（认领任务 / 查最近失败 / 任务计数各写一份）
    expect(OVERVIEW_SERVICE).not.toContain("'发票采集 ·%'")
    expect(OVERVIEW_SERVICE).not.toContain("'涉税报送采集 ·%'")
  })
})

describe('过滤只在展示层，不破坏发票/涉税中心自身', () => {
  it('数据源 ws.tasks 保持完整', () => {
    // 若把过滤下沉到 store，发票/涉税中心会找不到自己的任务，「自动更新」会永远显示未启用
    expect(WORKSPACE).not.toContain('isInvoiceCollectTask')
    expect(WORKSPACE).not.toContain('isBackgroundCollectTask')
  })

  it('发票/涉税中心仍然看得见这些任务（认领 + 开关都靠它）', () => {
    // 认领口径统一后从 ws.tasks.find 换成了 shared 的 pickLatestCollectTask（C3），
    // 但"从数据源找任务"这一点不变：过滤只发生在展示层
    expect(DATA_PAGE).toContain('pickLatestCollectTask(ws.tasks')
    expect(DATA_PAGE).toContain('INVOICE_TASK_PREFIX')
    expect(DATA_PAGE).toContain('TAX_TASK_PREFIX')
    // 前缀只有一处定义（在 @shared/constants/*），页面里不许再写一份
    expect(DATA_PAGE).not.toMatch(/const INVOICE_TASK_PREFIX = /)
    expect(DATA_PAGE).not.toMatch(/const TAX_TASK_PREFIX = /)
  })
})
