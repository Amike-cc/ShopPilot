/**
 * 「标签页批量关闭」纯逻辑的回归测试。
 *
 * 这些用例全部照着**重构前的真实行为**写：多选是显式选择（含固定），一键关闭默认
 * 跳过固定、但全是固定时退化为"含固定"，以及确认/结果文案的逐字措辞。重构只搬位置，
 * 任何一条断言挂掉都说明界面上的数字或提示词变了。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  describeCloseResult,
  planBatchClose,
  pruneTabSelection,
  selectTabRange,
  toggleTabSelection,
  type BatchCloseTab
} from '../../apps/desktop/src/renderer/src/features/workbench/tabs-batch-close'

const MODULE_PATH = 'apps/desktop/src/renderer/src/features/workbench/tabs-batch-close.ts'

const tab = (id: string, title?: string, isPinned?: boolean): BatchCloseTab => ({ id, title, isPinned })

/** 三个普通标签 + 一个固定标签的常规标签栏。 */
const MIXED: BatchCloseTab[] = [
  tab('t1', '订单管理'),
  tab('t2', '商品发布'),
  tab('t3', '店铺装修'),
  tab('t4', '客服工作台', true)
]

const ids = (tabs: readonly BatchCloseTab[]) => tabs.map(item => item.id)

describe('tabs-batch-close：模块边界', () => {
  it('纯模块，不 import vue / electron / DOM（保持可单测）', () => {
    const source = readFileSync(resolve(MODULE_PATH), 'utf8')
    expect(source).not.toMatch(/from\s+['"]vue['"]/)
    expect(source).not.toMatch(/from\s+['"]electron['"]/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
    expect(source).not.toMatch(/localStorage/)
  })
})

describe('tabs-batch-close：多选状态机', () => {
  it('Ctrl 点击在已选/未选之间切换，未选时追加在选择末尾', () => {
    expect(toggleTabSelection([], 't1')).toEqual(['t1'])
    expect(toggleTabSelection(['t1'], 't2')).toEqual(['t1', 't2'])
    expect(toggleTabSelection(['t1', 't2'], 't1')).toEqual(['t2'])
  })

  it('取消选中会清掉该 id 的全部重复项，且不动原数组', () => {
    const selected = ['t1', 't2', 't1']
    expect(toggleTabSelection(selected, 't1')).toEqual(['t2'])
    expect(selected).toEqual(['t1', 't2', 't1'])
  })

  it('Shift 选择按标签栏顺序取区间，正反方向都成立', () => {
    expect(selectTabRange(ids(MIXED), 't1', 't3')).toEqual(['t1', 't2', 't3'])
    expect(selectTabRange(ids(MIXED), 't3', 't1')).toEqual(['t1', 't2', 't3'])
    expect(selectTabRange(ids(MIXED), 't2', 't2')).toEqual(['t2'])
  })

  it('锚点或目标不存在时退化为只选中目标（锚点可能已被关掉）', () => {
    expect(selectTabRange(ids(MIXED), 'gone', 't3')).toEqual(['t3'])
    expect(selectTabRange(ids(MIXED), 't1', 'gone')).toEqual(['gone'])
    expect(selectTabRange([], 't1', 't2')).toEqual(['t2'])
  })

  it('剪枝只保留仍存在的标签，并保持原选择顺序', () => {
    expect(pruneTabSelection(['t3', 't1', 'gone'], ['t1', 't2', 't3'])).toEqual(['t3', 't1'])
    expect(pruneTabSelection(['t1'], [])).toEqual([])
    expect(pruneTabSelection([], ['t1'])).toEqual([])
  })
})

describe('tabs-batch-close：显式多选（ids）', () => {
  it('关显式选中项：连固定标签一起关，标题是「关闭选中的 N 个标签页？」', () => {
    const dialog = planBatchClose(MIXED, { mode: 'ids', tabIds: ['t1', 't4'] })
    expect(dialog).not.toBeNull()
    expect(dialog!.mode).toBe('ids')
    expect(dialog!.includePinned).toBe(true)
    expect(dialog!.tabIds).toEqual(['t1', 't4'])
    expect(dialog!.closeCount).toBe(2)
    expect(dialog!.keepPinnedCount).toBe(0)
    expect(dialog!.title).toBe('关闭选中的 2 个标签页？')
    expect(dialog!.detail).toBe('「订单管理」「客服工作台」 将被关闭，页面里未保存的内容会丢失。')
  })

  it('tabIds 里的重复 id 只算一个（走 Set 去重，数量不会虚高）', () => {
    const dialog = planBatchClose(MIXED, { mode: 'ids', tabIds: ['t1', 't1', 't2'] })
    expect(dialog!.tabIds).toEqual(['t1', 't2'])
    expect(dialog!.closeCount).toBe(2)
    expect(dialog!.title).toBe('关闭选中的 2 个标签页？')
  })

  it('选中的 id 全都不在标签栏里 → 没有可关闭项', () => {
    expect(planBatchClose(MIXED, { mode: 'ids', tabIds: ['gone'] })).toBeNull()
    expect(planBatchClose(MIXED, { mode: 'ids', tabIds: [] })).toBeNull()
    expect(planBatchClose(MIXED, { mode: 'ids' })).toBeNull()
    expect(planBatchClose([], { mode: 'ids', tabIds: ['t1'] })).toBeNull()
  })
})

describe('tabs-batch-close：关闭其他（others）', () => {
  it('跳过固定标签，并把"会保留几个固定标签"写进详情', () => {
    const dialog = planBatchClose(MIXED, { mode: 'others', keepTabId: 't1' })
    expect(dialog).not.toBeNull()
    expect(dialog!.keepTabId).toBe('t1')
    expect(dialog!.includePinned).toBe(false)
    expect(dialog!.tabIds).toBeUndefined()
    expect(dialog!.closeCount).toBe(2)
    expect(dialog!.keepPinnedCount).toBe(1)
    expect(dialog!.title).toBe('关闭其他的 2 个标签页？')
    expect(dialog!.detail).toBe('「商品发布」「店铺装修」 将被关闭，页面里未保存的内容会丢失。另有 1 个固定标签会保留。')
  })

  it('保留项自己不会被关，且只剩保留项时没有可关闭项', () => {
    expect(planBatchClose([tab('t1', '订单管理')], { mode: 'others', keepTabId: 't1' })).toBeNull()
    // 保留项之外只剩固定标签：退化为"含固定"，只关那一个固定标签
    const dialog = planBatchClose([tab('t1', '订单管理'), tab('t2', '商品发布', true)], { mode: 'others', keepTabId: 't1' })
    expect(dialog!.includePinned).toBe(true)
    expect(dialog!.closeCount).toBe(1)
    expect(dialog!.keepPinnedCount).toBe(0)
    expect(dialog!.title).toBe('关闭其他的 1 个标签页？')
  })

  it('keepTabId 不存在时按原实现"整条过滤"，等于关掉全部标签', () => {
    const dialog = planBatchClose(MIXED, { mode: 'others', keepTabId: 'gone' })
    expect(dialog!.closeCount).toBe(3)
    expect(dialog!.keepPinnedCount).toBe(1)
    expect(dialog!.title).toBe('关闭其他的 3 个标签页？')
  })

  it('目标全是固定标签时不再保留（否则菜单项点了没反应）', () => {
    const pinnedOnly = [tab('t1', '订单管理', true), tab('t2', '商品发布', true), tab('keep', '客服工作台')]
    const dialog = planBatchClose(pinnedOnly, { mode: 'others', keepTabId: 'keep' })
    expect(dialog!.includePinned).toBe(true)
    expect(dialog!.closeCount).toBe(2)
    expect(dialog!.keepPinnedCount).toBe(0)
    expect(dialog!.title).toBe('关闭其他的 2 个标签页？')
    expect(dialog!.detail).toBe('「订单管理」「商品发布」 将被关闭，页面里未保存的内容会丢失。')
  })

  it('缺 keepTabId 时返回 null（调用方已在更外层提示"没有可保留的标签页"）', () => {
    expect(planBatchClose(MIXED, { mode: 'others' })).toBeNull()
    expect(planBatchClose(MIXED, { mode: 'others', keepTabId: '' })).toBeNull()
    expect(planBatchClose([], { mode: 'others', keepTabId: 't1' })).toBeNull()
  })
})

describe('tabs-batch-close：关闭全部（all）', () => {
  it('跳过固定标签，标题是「关闭全部的 N 个标签页？」', () => {
    const dialog = planBatchClose(MIXED, { mode: 'all' })
    expect(dialog).not.toBeNull()
    expect(dialog!.mode).toBe('all')
    expect(dialog!.includePinned).toBe(false)
    expect(dialog!.tabIds).toBeUndefined()
    expect(dialog!.keepTabId).toBeUndefined()
    expect(dialog!.closeCount).toBe(3)
    expect(dialog!.keepPinnedCount).toBe(1)
    expect(dialog!.title).toBe('关闭全部的 3 个标签页？')
    expect(dialog!.detail).toBe('「订单管理」「商品发布」「店铺装修」 将被关闭，页面里未保存的内容会丢失。另有 1 个固定标签会保留。')
  })

  it('全是固定标签时退化为"含固定"，不会出现按钮可用却没有目标', () => {
    const allPinned = [tab('t1', '订单管理', true), tab('t2', '商品发布', true)]
    const dialog = planBatchClose(allPinned, { mode: 'all' })
    expect(dialog!.includePinned).toBe(true)
    expect(dialog!.closeCount).toBe(2)
    expect(dialog!.keepPinnedCount).toBe(0)
    expect(dialog!.detail).toBe('「订单管理」「商品发布」 将被关闭，页面里未保存的内容会丢失。')
  })

  it('标签栏为空时没有可关闭项', () => {
    expect(planBatchClose([], { mode: 'all' })).toBeNull()
  })
})

describe('tabs-batch-close：确认详情文案', () => {
  it('最多预览 3 个标题，超出后追加「等 N 个页面」并按实际关闭数计数', () => {
    const many: BatchCloseTab[] = [
      tab('t1', '订单管理'),
      tab('t2', '商品发布'),
      tab('t3', '店铺装修'),
      tab('t4', '数据看板'),
      tab('t5', '客服工作台')
    ]
    const dialog = planBatchClose(many, { mode: 'all' })
    expect(dialog!.closeCount).toBe(5)
    expect(dialog!.title).toBe('关闭全部的 5 个标签页？')
    expect(dialog!.detail).toBe('「订单管理」「商品发布」「店铺装修」 等 5 个页面 将被关闭，页面里未保存的内容会丢失。')
  })

  it('标题缺失回落「新标签页」，超长标题截断到 12 字', () => {
    const dialog = planBatchClose([tab('t1'), tab('t2', '一二三四五六七八九十十一十二十三')], { mode: 'all' })
    expect(dialog!.detail).toBe('「新标签页」「一二三四五六七八九十十一」 将被关闭，页面里未保存的内容会丢失。')
  })

  it('正好 3 个时不加「等 N 个页面」，正好 4 个时才加', () => {
    const three = [tab('a', 'A'), tab('b', 'B'), tab('c', 'C')]
    const four = [...three, tab('d', 'D')]
    expect(planBatchClose(three, { mode: 'all' })!.detail).toBe('「A」「B」「C」 将被关闭，页面里未保存的内容会丢失。')
    expect(planBatchClose(four, { mode: 'all' })!.detail).toBe('「A」「B」「C」 等 4 个页面 将被关闭，页面里未保存的内容会丢失。')
  })
})

describe('tabs-batch-close：关闭结果文案', () => {
  it('没有可关闭项时是信息提示', () => {
    expect(describeCloseResult({ closed: 0, skippedPinned: 0, nothingToClose: true })).toEqual({
      tone: 'info',
      text: '没有可关闭的标签页'
    })
  })

  it('关成功且没有保留固定标签时不追加后缀', () => {
    expect(describeCloseResult({ closed: 2, skippedPinned: 0, nothingToClose: false })).toEqual({
      tone: 'success',
      text: '已关闭 2 个标签页'
    })
  })

  it('保留了固定标签时追加「，保留 N 个固定标签」', () => {
    expect(describeCloseResult({ closed: 3, skippedPinned: 1, nothingToClose: false })).toEqual({
      tone: 'success',
      text: '已关闭 3 个标签页，保留 1 个固定标签'
    })
    expect(describeCloseResult({ closed: 0, skippedPinned: 4, nothingToClose: false }).text).toBe('已关闭 0 个标签页，保留 4 个固定标签')
  })

  it('nothingToClose 优先于计数（主进程说没关就按没关提示）', () => {
    expect(describeCloseResult({ closed: 5, skippedPinned: 2, nothingToClose: true }).text).toBe('没有可关闭的标签页')
  })
})
