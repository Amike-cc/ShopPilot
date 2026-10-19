import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  planTabClose,
  type TabCloseRequest,
  type TabCloseTarget
} from '../../apps/desktop/src/main/browser/tab-close-plan'

/**
 * 「标签页批量关闭计划」的回归网（2026-10-18 模块化收尾）。
 *
 * 背景：`closeTabs()` 的决策逻辑原先内联在 1600+ 行的 `window-manager.ts` 里，没有单测；
 * 抽成纯模块后至少要有两层钉：
 *   ① 真值表：把 internal 排除、ids 关固定、others/all 默认保留固定、统计口径逐条钉死；
 *   ② 对照：用「抽取前的旧实现」在随机用例上跑等价性，防止抽取时悄悄改了行为。
 */

const SOURCE = readFileSync(resolve('apps/desktop/src/main/browser/tab-close-plan.ts'), 'utf8')
// 2026-10-19 P1 重构：window-manager.ts 已拆成 browser/ 下多个内聚模块，
// 源码级断言（不是 import 调用）改为扫描整个模块集合；断言语义不变。
const WINDOW_MANAGER = ['window-manager.ts', 'window-state.ts', 'window-browser-core.ts', 'window-capture.ts', 'window-diagnostics.ts']
  .map(f => readFileSync(resolve('apps/desktop/src/main/browser', f), 'utf8'))
  .join('\n')

/**
 * 抽取前 `window-manager.ts` 里 closeTabs 的内联实现（逐行照抄，含 closeTab 之后按 live state
 * 统计 remaining 的口径）。只用于对照，不参与生产路径。
 */
function legacyCloseTabs(tabs: readonly TabCloseTarget[], input: TabCloseRequest): {
  closed: number
  skippedPinned: number
  remaining: number
  nothingToClose: boolean
} {
  type LegacyTab = TabCloseTarget
  // 模拟 live state.tabs（Map）：closeTab 会从中删元素
  const state = { tabs: new Map<string, LegacyTab>(tabs.map(tab => [tab.id, tab])) }

  const visibleTabs = Array.from(state.tabs.values()).filter(tab => tab.internal !== true)
  const selected = new Set(input.tabIds || [])
  let targets: LegacyTab[] = []
  if (input.mode === 'ids') {
    targets = visibleTabs.filter(tab => selected.has(tab.id))
  } else if (input.mode === 'others') {
    targets = visibleTabs.filter(tab => tab.id !== input.keepTabId)
  } else {
    targets = visibleTabs.slice()
  }

  const includePinned = input.includePinned === true
  const skipped = includePinned ? [] : targets.filter(tab => tab.isPinned)
  if (!includePinned) targets = targets.filter(tab => !tab.isPinned)

  // 先拷贝再逐个关：closeTab 会改 state.tabs，遍历 Map 时删元素不可靠
  for (const tab of targets) state.tabs.delete(tab.id)

  const remaining = Array.from(state.tabs.values()).filter(tab => tab.internal !== true).length
  return {
    closed: targets.length,
    skippedPinned: skipped.length,
    remaining,
    nothingToClose: targets.length === 0
  }
}

/** 把纯函数的计划折算成 closeTabs 对外返回的四个字段，便于与旧实现逐字段比对。 */
function toCloseTabsResult(plan: ReturnType<typeof planTabClose>) {
  return {
    closed: plan.targetIds.length,
    skippedPinned: plan.skippedPinnedIds.length,
    remaining: plan.remaining,
    nothingToClose: plan.nothingToClose
  }
}

function tab(id: string, extra: Omit<TabCloseTarget, 'id'> = {}): TabCloseTarget {
  return { id, ...extra }
}

describe('planTabClose：采集专用页永远不参与', () => {
  it('internal 标签既不算可见、也不会被任何模式关掉', () => {
    const tabs = [tab('collector', { internal: true }), tab('n1'), tab('n2')]
    expect(planTabClose(tabs, { mode: 'all', includePinned: true })).toEqual({
      targetIds: ['n1', 'n2'],
      skippedPinnedIds: [],
      remaining: 0,
      nothingToClose: false
    })
  })

  it('ids 显式点到 internal 也算无效选择', () => {
    const tabs = [tab('collector', { internal: true }), tab('n1')]
    expect(planTabClose(tabs, { mode: 'ids', tabIds: ['collector'], includePinned: true })).toEqual({
      targetIds: [],
      skippedPinnedIds: [],
      remaining: 1,
      nothingToClose: true
    })
  })

  it('others 的 keepTabId 指向 internal 时不产生"保护"，可见标签照样全关', () => {
    const tabs = [tab('collector', { internal: true }), tab('n1'), tab('n2')]
    expect(planTabClose(tabs, { mode: 'others', keepTabId: 'collector' }).targetIds).toEqual(['n1', 'n2'])
  })

  it('店里只剩采集专用页时无事可做，remaining 为 0', () => {
    const tabs = [tab('collector', { internal: true })]
    expect(planTabClose(tabs, { mode: 'all' })).toEqual({
      targetIds: [],
      skippedPinnedIds: [],
      remaining: 0,
      nothingToClose: true
    })
  })
})

describe('planTabClose：ids（用户明确点选，固定标签也关）', () => {
  it('固定标签被显式选中且 includePinned 为 true 时照关，且不计入 skippedPinnedIds', () => {
    const tabs = [tab('p1', { isPinned: true }), tab('n1')]
    expect(planTabClose(tabs, { mode: 'ids', tabIds: ['p1'], includePinned: true })).toEqual({
      targetIds: ['p1'],
      skippedPinnedIds: [],
      remaining: 1,
      nothingToClose: false
    })
  })

  it('旧口径对照：ids 且 includePinned !== true 时，固定标签仍按"保留固定"剔除', () => {
    // 抽取前 closeTabs 里 `if (!includePinned) targets = targets.filter(t => !t.isPinned)` 对三种 mode 都生效。
    // IPC 边界上 ids 恒为 includePinned=true（schema 约定 + 渲染层 `tabs-batch-close.ts` 的
    // `input.mode === 'ids' || unpinned.length === 0`），这条分支不可达；
    // 抽取要求"行为逐字不变"，所以保留并用对照用例钉住，而不是按注释文本特判。
    // 注意：渲染层文件不属于本模块的写范围，这里只做纯函数断言，不对渲染层源码做字面量断言。
    const tabs = [tab('p1', { isPinned: true }), tab('n1')]
    expect(planTabClose(tabs, { mode: 'ids', tabIds: ['p1', 'n1'] })).toEqual({
      targetIds: ['n1'],
      skippedPinnedIds: ['p1'],
      remaining: 1,
      nothingToClose: false
    })
    expect(planTabClose(tabs, { mode: 'ids', tabIds: ['p1', 'n1'], includePinned: false })).toEqual(
      planTabClose(tabs, { mode: 'ids', tabIds: ['p1', 'n1'] })
    )
  })

  it('includePinned 只影响"是否跳过固定标签"，不影响普通标签的选中集合', () => {
    const tabs = [tab('p1', { isPinned: true }), tab('n1')]
    const without = planTabClose(tabs, { mode: 'ids', tabIds: ['p1', 'n1'] })
    const withPinned = planTabClose(tabs, { mode: 'ids', tabIds: ['p1', 'n1'], includePinned: true })
    expect(withPinned.targetIds).toEqual(['p1', 'n1'])
    expect(without.targetIds).toEqual(['n1'])
    expect(withPinned.skippedPinnedIds).toEqual([])
    expect(without.skippedPinnedIds).toEqual(['p1'])
  })

  it('保持传入顺序（= live state.tabs 的顺序），而不是 tabIds 的顺序', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(planTabClose(tabs, { mode: 'ids', tabIds: ['c', 'a'] }).targetIds).toEqual(['a', 'c'])
  })

  it('keepTabId 在 ids 模式下被忽略', () => {
    const tabs = [tab('a'), tab('b')]
    expect(planTabClose(tabs, { mode: 'ids', tabIds: ['a', 'b'], keepTabId: 'a' }).targetIds).toEqual(['a', 'b'])
  })
})

describe('planTabClose：others / all 一键操作默认保留固定标签', () => {
  const tabs = [tab('p1', { isPinned: true }), tab('n1'), tab('n2')]

  it('others：关掉除 keepTabId 外的可见标签，跳过固定标签并如实上报', () => {
    expect(planTabClose(tabs, { mode: 'others', keepTabId: 'n1' })).toEqual({
      targetIds: ['n2'],
      skippedPinnedIds: ['p1'],
      remaining: 2,
      nothingToClose: false
    })
  })

  it('all：关掉全部可见标签，但固定标签默认保留', () => {
    expect(planTabClose(tabs, { mode: 'all' })).toEqual({
      targetIds: ['n1', 'n2'],
      skippedPinnedIds: ['p1'],
      remaining: 1,
      nothingToClose: false
    })
  })

  it('others：要保留的正好是固定标签时，跳过数为 0（它根本不在候选里）', () => {
    expect(planTabClose(tabs, { mode: 'others', keepTabId: 'p1' })).toEqual({
      targetIds: ['n1', 'n2'],
      skippedPinnedIds: [],
      remaining: 1,
      nothingToClose: false
    })
  })

  it('includePinned === true 时 others / all 连固定标签一起关', () => {
    expect(planTabClose(tabs, { mode: 'others', keepTabId: 'n1', includePinned: true })).toEqual({
      targetIds: ['p1', 'n2'],
      skippedPinnedIds: [],
      remaining: 1,
      nothingToClose: false
    })
    expect(planTabClose(tabs, { mode: 'all', includePinned: true })).toEqual({
      targetIds: ['p1', 'n1', 'n2'],
      skippedPinnedIds: [],
      remaining: 0,
      nothingToClose: false
    })
  })
})

describe('planTabClose：无标签 / 未知 id / 重复 id 都安全', () => {
  it('店铺没有任何标签：nothingToClose，remaining 为 0', () => {
    expect(planTabClose([], { mode: 'all' })).toEqual({
      targetIds: [],
      skippedPinnedIds: [],
      remaining: 0,
      nothingToClose: true
    })
    expect(planTabClose([], { mode: 'others', keepTabId: 'ghost' }).nothingToClose).toBe(true)
  })

  it('ids 不传 / 传空数组：nothingToClose，remaining 等于可见标签数', () => {
    const tabs = [tab('n1'), tab('n2')]
    expect(planTabClose(tabs, { mode: 'ids' })).toEqual({
      targetIds: [],
      skippedPinnedIds: [],
      remaining: 2,
      nothingToClose: true
    })
    expect(planTabClose(tabs, { mode: 'ids', tabIds: [] }).remaining).toBe(2)
  })

  it('ids 里的未知 id 被忽略，重复 id 只关一次', () => {
    const tabs = [tab('collector', { internal: true }), tab('n1'), tab('n2')]
    expect(planTabClose(tabs, {
      mode: 'ids',
      tabIds: ['ghost', 'n2', 'n2', 'collector', 'n2']
    })).toEqual({
      targetIds: ['n2'],
      skippedPinnedIds: [],
      remaining: 1,
      nothingToClose: false
    })
  })

  it('others 的 keepTabId 未知时等于全关（可见标签都在候选里）', () => {
    const tabs = [tab('n1'), tab('n2')]
    expect(planTabClose(tabs, { mode: 'others', keepTabId: 'ghost' }).targetIds).toEqual(['n1', 'n2'])
  })

  it('未知 mode 走兜底分支（与旧实现的 if/else 链一致：按 all 处理）', () => {
    const tabs = [tab('p1', { isPinned: true }), tab('n1')]
    const bogus = { mode: 'bogus' as unknown as TabCloseRequest['mode'] }
    expect(planTabClose(tabs, bogus)).toEqual(planTabClose(tabs, { mode: 'all' }))
  })
})

describe('planTabClose：remaining 统计口径 = 存活可见标签数', () => {
  it('混固定 + 普通：remaining 只数可见标签（internal 不计入）', () => {
    const tabs = [
      tab('collector', { internal: true }),
      tab('p1', { isPinned: true }),
      tab('p2', { isPinned: true }),
      tab('n1'),
      tab('n2')
    ]
    expect(planTabClose(tabs, { mode: 'all' })).toMatchObject({
      targetIds: ['n1', 'n2'],
      skippedPinnedIds: ['p1', 'p2'],
      remaining: 2
    })
    expect(planTabClose(tabs, { mode: 'ids', tabIds: ['p1', 'n1'], includePinned: true })).toMatchObject({
      targetIds: ['p1', 'n1'],
      remaining: 2
    })
    expect(planTabClose(tabs, { mode: 'all', includePinned: true }).remaining).toBe(0)
  })

  it('没事可做时 remaining 不减少（标签栏原样）', () => {
    const tabs = [tab('p1', { isPinned: true }), tab('collector', { internal: true })]
    expect(planTabClose(tabs, { mode: 'all' }).remaining).toBe(1)
    expect(planTabClose(tabs, { mode: 'all' }).nothingToClose).toBe(true)
  })

  it('remaining 与 nothingToClose 自洽：关闭数 0 ⇔ nothingToClose', () => {
    const cases: Array<[TabCloseTarget[], TabCloseRequest]> = [
      [[], { mode: 'all' }],
      [[tab('p1', { isPinned: true })], { mode: 'all' }],
      [[tab('collector', { internal: true })], { mode: 'all' }],
      [[tab('n1')], { mode: 'ids', tabIds: ['ghost'] }],
      [[tab('n1')], { mode: 'all' }]
    ]
    for (const [tabs, input] of cases) {
      const plan = planTabClose(tabs, input)
      expect(plan.nothingToClose).toBe(plan.targetIds.length === 0)
      expect(plan.remaining).toBe(tabs.filter(item => item.internal !== true).length - plan.targetIds.length)
    }
  })
})

describe('planTabClose：纯函数（不改入参、可冻结）', () => {
  it('不修改传入的 tabs / tabIds 数组', () => {
    const tabIds = ['n1', 'n1', 'ghost']
    const tabs = Object.freeze([
      Object.freeze(tab('p1', { isPinned: true })),
      Object.freeze(tab('collector', { internal: true })),
      Object.freeze(tab('n1'))
    ])
    const before = JSON.stringify({ tabs, tabIds })
    const plan = planTabClose(tabs, Object.freeze({ mode: 'ids', tabIds: Object.freeze(tabIds) } as TabCloseRequest))
    expect(plan.targetIds).toEqual(['n1'])
    expect(JSON.stringify({ tabs, tabIds })).toBe(before)
  })
})

describe('planTabClose：与抽取前的旧实现等价（property-style）', () => {
  /** 可复现的线性同余伪随机（不引第三方依赖） */
  function makeRandom(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
  }

  it('随机 500 组用例：四个返回字段与旧实现逐字段一致', () => {
    const random = makeRandom(20261018)
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]
    const modes: TabCloseRequest['mode'][] = ['ids', 'others', 'all']

    for (let round = 0; round < 500; round++) {
      const count = Math.floor(random() * 9)
      const tabs: TabCloseTarget[] = []
      for (let i = 0; i < count; i++) {
        tabs.push({
          id: `t${i}`,
          isPinned: random() < 0.35,
          internal: random() < 0.2 ? true : undefined
        })
      }
      // tabIds 里混入未知 id 与重复 id，模拟渲染层可能过期的列表
      const tabIds: string[] = []
      const asked = Math.floor(random() * 5)
      for (let i = 0; i < asked; i++) {
        tabIds.push(random() < 0.25 ? `ghost${i}` : pick(tabs.length ? tabs : [tab('none')]).id)
      }
      const input: TabCloseRequest = {
        mode: pick(modes),
        tabIds,
        keepTabId: random() < 0.2 ? `ghost-keep` : pick(tabs.length ? tabs : [tab('none')]).id,
        includePinned: random() < 0.5 ? true : random() < 0.5 ? false : undefined
      }

      const plan = planTabClose(tabs, input)
      expect({ round, ...toCloseTabsResult(plan) }).toEqual({ round, ...legacyCloseTabs(tabs, input) })
    }
  })
})

describe('模块边界与对外契约', () => {
  it('tab-close-plan 不依赖 electron / node（保持可单测的纯模块）', () => {
    expect(SOURCE).not.toMatch(/from\s+['"]electron['"]/)
    expect(SOURCE).not.toMatch(/from\s+['"]node:/)
    expect(SOURCE).not.toMatch(/require\(/)
  })

  it('window-manager 的 closeTabs 导出签名与返回字段不变（IPC / preload / 渲染层零改动）', () => {
    expect(WINDOW_MANAGER).toContain('export function closeTabs(storeId: string, input: CloseTabsInput): CloseTabsResult {')
    expect(WINDOW_MANAGER).toContain('export interface CloseTabsInput {')
    expect(WINDOW_MANAGER).toContain('export interface CloseTabsResult {')
    // 渲染层读的四个字段一个都不能少
    for (const field of ['closed: number', 'skippedPinned: number', 'remaining: number', 'nothingToClose: boolean']) {
      expect(WINDOW_MANAGER).toContain(field)
    }
    // 决策已经委托给纯模块，执行与日志仍在这里
    expect(WINDOW_MANAGER).toContain("import { planTabClose } from './tab-close-plan'")
    expect(WINDOW_MANAGER).toContain('const plan = planTabClose(Array.from(state.tabs.values()), input)')
    expect(WINDOW_MANAGER).toContain('[tabs] closeMany store=${storeId} mode=${input.mode} asked=')
  })
})
