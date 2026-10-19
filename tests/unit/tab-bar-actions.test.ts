/**
 * 标签栏「固定 / 拖拽重排」纯逻辑的回归测试。
 *
 * 覆盖三类容易出错的地方：
 *   ① 拖拽落点算错一位（向右拖时摘掉被拖项后目标下标会整体左移）；
 *   ② 非法输入（id 不存在、自己拖自己、空列表）把顺序搞乱或产出重复 id
 *      ——主进程 `browserTabReorderSchema` 会直接拒收重复列表；
 *   ③ 固定标签被"想当然"地排到最前（本产品不这么做，用户拖到哪就是哪）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  computeReorderedIds,
  nextPinnedState,
  pinMenuLabel,
  tabDropSide
} from '../../apps/desktop/src/renderer/src/features/workbench/tab-bar-actions'

const MODULE_PATH = 'apps/desktop/src/renderer/src/features/workbench/tab-bar-actions.ts'
const TABS = ['a', 'b', 'c', 'd']

describe('tab-bar-actions：模块边界', () => {
  it('纯模块，不 import vue / electron / DOM（保持可单测）', () => {
    const source = readFileSync(resolve(MODULE_PATH), 'utf8')
    expect(source).not.toMatch(/from\s+['"]vue['"]/)
    expect(source).not.toMatch(/from\s+['"]electron['"]/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
  })
})

describe('tab-bar-actions：固定/取消固定', () => {
  it('菜单文案按当前状态给动作：未固定 → 固定标签页', () => {
    expect(pinMenuLabel({})).toBe('固定标签页')
    expect(pinMenuLabel({ isPinned: false })).toBe('固定标签页')
  })

  it('菜单文案按当前状态给动作：已固定 → 取消固定', () => {
    expect(pinMenuLabel({ isPinned: true })).toBe('取消固定')
  })

  it('点击后的状态永远取反', () => {
    expect(nextPinnedState({})).toBe(true)
    expect(nextPinnedState({ isPinned: false })).toBe(true)
    expect(nextPinnedState({ isPinned: true })).toBe(false)
  })

  it('文案与状态取自同一个 isPinned，不会出现"写着取消固定却又要固定"', () => {
    for (const isPinned of [true, false, undefined]) {
      const tab = { isPinned }
      expect(pinMenuLabel(tab) === '取消固定').toBe(nextPinnedState(tab) === false)
    }
  })
})

describe('tab-bar-actions：拖拽落点左右半', () => {
  const rect = { left: 100, width: 80 } // 中线 = 140

  it('左半 → before，右半 → after', () => {
    expect(tabDropSide(rect, 100)).toBe('before')
    expect(tabDropSide(rect, 139.9)).toBe('before')
    expect(tabDropSide(rect, 140.1)).toBe('after')
    expect(tabDropSide(rect, 180)).toBe('after')
  })

  it('正好落在中线上算 after（与"插到后面"的直觉一致）', () => {
    expect(tabDropSide(rect, 140)).toBe('after')
  })

  it('宽度拿不到（0 / 负数 / NaN）时退化为 after，不产生 NaN 判断', () => {
    expect(tabDropSide({ left: 100, width: 0 }, 100)).toBe('after')
    expect(tabDropSide({ left: 100, width: -10 }, 100)).toBe('after')
    expect(tabDropSide({ left: 100, width: Number.NaN }, 100)).toBe('after')
  })
})

describe('tab-bar-actions：拖拽重排', () => {
  it('向右拖：放到目标之后（摘掉自己后目标下标左移，不能差一位）', () => {
    expect(computeReorderedIds(TABS, { draggedId: 'a', targetId: 'c', position: 'after' })).toEqual(['b', 'c', 'a', 'd'])
    expect(computeReorderedIds(TABS, { draggedId: 'a', targetId: 'd', position: 'after' })).toEqual(['b', 'c', 'd', 'a'])
  })

  it('向左拖：放到目标之前', () => {
    expect(computeReorderedIds(TABS, { draggedId: 'd', targetId: 'b', position: 'before' })).toEqual(['a', 'd', 'b', 'c'])
    expect(computeReorderedIds(TABS, { draggedId: 'c', targetId: 'a', position: 'before' })).toEqual(['c', 'a', 'b', 'd'])
  })

  it('拖到首/末两端', () => {
    expect(computeReorderedIds(TABS, { draggedId: 'd', targetId: 'a', position: 'before' })).toEqual(['d', 'a', 'b', 'c'])
    expect(computeReorderedIds(TABS, { draggedId: 'b', targetId: 'a', position: 'before' })).toEqual(['b', 'a', 'c', 'd'])
    expect(computeReorderedIds(TABS, { draggedId: 'c', targetId: 'd', position: 'after' })).toEqual(['a', 'b', 'd', 'c'])
  })

  it('相邻项原地放回时顺序不变（a 放到 b 之前 / b 放到 a 之后）', () => {
    expect(computeReorderedIds(TABS, { draggedId: 'a', targetId: 'b', position: 'before' })).toEqual(TABS)
    expect(computeReorderedIds(TABS, { draggedId: 'b', targetId: 'a', position: 'after' })).toEqual(TABS)
  })

  it('自己拖自己 → 原顺序副本', () => {
    expect(computeReorderedIds(TABS, { draggedId: 'b', targetId: 'b', position: 'before' })).toEqual(TABS)
    expect(computeReorderedIds(TABS, { draggedId: 'b', targetId: 'b', position: 'after' })).toEqual(TABS)
  })

  it('id 不存在（被别处关掉 / 拖拽状态没清干净）→ 原顺序副本', () => {
    expect(computeReorderedIds(TABS, { draggedId: 'gone', targetId: 'b', position: 'after' })).toEqual(TABS)
    expect(computeReorderedIds(TABS, { draggedId: 'b', targetId: 'gone', position: 'after' })).toEqual(TABS)
    expect(computeReorderedIds(TABS, { draggedId: '', targetId: '', position: 'before' })).toEqual(TABS)
  })

  it('空列表 / 单元素列表都安全', () => {
    expect(computeReorderedIds([], { draggedId: 'a', targetId: 'b', position: 'before' })).toEqual([])
    expect(computeReorderedIds(['a'], { draggedId: 'a', targetId: 'a', position: 'after' })).toEqual(['a'])
  })

  it('永远返回新数组、不改入参，且不产生重复 id', () => {
    const input = ['a', 'b', 'c']
    const moved = computeReorderedIds(input, { draggedId: 'c', targetId: 'a', position: 'before' })
    expect(moved).toEqual(['c', 'a', 'b'])
    expect(moved).not.toBe(input)
    expect(input).toEqual(['a', 'b', 'c'])

    const unchanged = computeReorderedIds(input, { draggedId: 'gone', targetId: 'a', position: 'after' })
    expect(unchanged).toEqual(input)
    expect(unchanged).not.toBe(input)

    // 主进程 schema 会拒收重复 id：任何分支都不能造出重复
    for (const move of [
      { draggedId: 'a', targetId: 'b', position: 'before' as const },
      { draggedId: 'a', targetId: 'c', position: 'after' as const },
      { draggedId: 'c', targetId: 'a', position: 'before' as const },
      { draggedId: 'b', targetId: 'b', position: 'after' as const },
      { draggedId: 'gone', targetId: 'b', position: 'after' as const }
    ]) {
      const result = computeReorderedIds(TABS, move)
      expect(new Set(result).size).toBe(result.length)
      expect([...result].sort()).toEqual([...TABS].sort())
    }
  })

  it('固定标签不强制排到最前：按用户拖到哪就是哪', () => {
    // 入参不含 isPinned 信息，顺序完全由拖动决定（'p' 是固定标签，被拖到中间就留在中间）
    const withPinned = ['p', 'a', 'b']
    expect(computeReorderedIds(withPinned, { draggedId: 'a', targetId: 'p', position: 'after' })).toEqual(['p', 'a', 'b'])
    expect(computeReorderedIds(withPinned, { draggedId: 'b', targetId: 'p', position: 'before' })).toEqual(['b', 'p', 'a'])
  })
})
