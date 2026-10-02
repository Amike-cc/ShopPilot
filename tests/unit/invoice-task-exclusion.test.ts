import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INVOICE_TASK_PREFIX, isInvoiceCollectTask } from '@shared/constants/invoice'

/**
 * 用户口径：**发票采集不计入任务**。
 *
 * 背景：发票中心「每 3 小时自动更新」会在库里建一个「发票采集 ·<店铺>」任务。
 * 那是**后台刷新**，不是用户要管理的活儿——任务中心的列表与统计、概览「待办任务」卡、
 * 任务总数与工具栏任务红点都不该把它算成一项任务。
 *
 * 为什么要有这份源码级回归：这类"某个统计口径漏排除一处"的问题运行时不会报错、
 * 类型检查也看不出来，只会让用户看到"数字比列表多"或"待办里混进后台刷新"——
 * 与仓库里已经修过的「恒错数字」是同一类。所以把每个口径都钉在这里。
 *
 * 同时钉住**反面**：不能把过滤下沉到 `ws.tasks` 数据源。发票中心自己的
 * 「每 3 小时自动更新」开关要靠 `ws.tasks` 找到那个任务改周期，采集也要靠它复用同一个任务；
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

describe('发票采集不计入任务的各个口径', () => {
  it('任务中心：列表与四个统计数都走同一份「可见任务」', () => {
    expect(TASK_PAGE).toMatch(/visibleTasks = computed\([\s\S]{0,240}?isInvoiceCollectTask/)
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

  it('概览：待办任务卡与工具栏红点都不含发票采集任务', () => {
    expect(DASHBOARD).toMatch(/pendingTasks = computed\([\s\S]{0,240}?isInvoiceCollectTask/)
    expect(DASHBOARD).toMatch(/activeTaskCount = computed\([\s\S]{0,320}?isInvoiceCollectTask/)
  })

  it('浏览器右栏「任务中心 → 任务列表」同样排除（只取 6 条，不排就被挤出去）', () => {
    expect(SURFACE).toMatch(/taskRows = computed\([\s\S]{0,240}?isInvoiceCollectTask/)
  })

  it('主进程的任务总数用它排除，且前缀不再有第二处硬编码', () => {
    expect(OVERVIEW_SERVICE).toContain('INVOICE_TASK_PREFIX')
    expect(OVERVIEW_SERVICE).toContain('NOT LIKE ?')
    // 硬编码前缀正是口径漂移的源头（认领任务 / 查最近失败 / 任务计数各写一份）
    expect(OVERVIEW_SERVICE).not.toContain("'发票采集 ·%'")
  })
})

describe('过滤只在展示层，不破坏发票中心自身', () => {
  it('数据源 ws.tasks 保持完整', () => {
    // 若把过滤下沉到 store，发票中心会找不到自己的任务，「每 3 小时自动更新」会永远显示未启用
    expect(WORKSPACE).not.toContain('isInvoiceCollectTask')
  })

  it('发票中心仍然看得见这些任务（认领 + 开关都靠它）', () => {
    expect(DATA_PAGE).toContain('ws.tasks.find')
    expect(DATA_PAGE).toContain('INVOICE_TASK_PREFIX')
    // 前缀只有一处定义（在 @shared/constants/invoice），页面里不许再写一份
    expect(DATA_PAGE).not.toMatch(/const INVOICE_TASK_PREFIX = /)
  })
})
