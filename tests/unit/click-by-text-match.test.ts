import { describe, it, expect } from 'vitest'
import { PICK_SORT_FN } from '../../apps/desktop/src/main/tasks/task-runner'

/**
 * 文案规范化 + 两级候选匹配，跑的是**注入页面的同一份源码**（PICK_SORT_FN 里的 __narrow）。
 *
 * 实测动因（快手达人广场，2026-09-15）：平台把按钮文案拆进子 span 并用 CSS 拉字距，
 * innerText 变成「确 认」「重 置」「查 询」，而元素的 ownText 是空串——
 * 只按 ownText 精确匹配一个都命中不了，点击会报"找不到文案为「确认」的可点击元素"。
 */

interface El {
  tag: string
  own: string
  innerText: string
  cls: string
  visible: boolean
  inScope?: boolean
  contains(x: El): boolean
}

function makeEl(tag: string, own: string, opts: { innerText?: string; cls?: string; children?: El[]; visible?: boolean } = {}): El {
  const children = opts.children || []
  const self: El = {
    tag, own, innerText: opts.innerText ?? own, cls: opts.cls || '', visible: opts.visible !== false,
    contains: (x: El) => self === x || children.some(c => c.contains(x))
  }
  return self
}

/** 复刻 findTextTarget 的两级候选收集（与 task-runner 里的逻辑同构） */
function collect(all: El[], needle: string, roots: El[] | null): El[] {
  const fn = new Function(`${PICK_SORT_FN}; return { __narrow };`)()
  const narrow = fn.__narrow
  const nw = narrow(needle)
  const inScope = (el: El) => !roots || roots.some(r => r.contains(el))
  const cands: El[] = []
  // ① 自有文本
  for (const el of all) {
    if (!el.own.includes(needle)) continue
    if (!inScope(el)) continue
    if (!el.visible) continue
    cands.push(el)
  }
  if (cands.length) return cands
  // ② 规范化 innerText 兜底
  for (const el of all) {
    if (!['BUTTON', 'A', 'LABEL', 'SPAN'].includes(el.tag)) continue
    if (!el.visible) continue
    if (narrow(el.innerText) !== nw) continue
    if (!inScope(el)) continue
    cands.push(el)
  }
  return cands
}

describe('clickByText 文案匹配：自有文本优先，规范化 innerText 兜底', () => {
  it('① 自有文本命中时只用自有文本（既有平台行为零变化）', () => {
    const plain = makeEl('SPAN', '批量邀约')
    const spaced = makeEl('BUTTON', '', { innerText: '批 量 邀 约' })
    const got = collect([plain, spaced], '批量邀约', null)
    expect(got).toEqual([plain])
  })

  it('② 自有文本为空、innerText 被拆字距时能命中（快手「确 认」「重 置」「查 询」）', () => {
    const confirm = makeEl('BUTTON', '', { innerText: '确 认', cls: 'kwaishop-...-btn' })
    const got = collect([confirm], '确认', null)
    expect(got).toEqual([confirm])
    // 三种实测文案都能命中
    for (const [inner, want] of [['重 置', '重置'], ['查 询', '查询'], ['取 消', '取消']] as const) {
      expect(collect([makeEl('BUTTON', '', { innerText: inner })], want, null)).toHaveLength(1)
    }
  })

  it('② 不把普通容器当目标（只有可能是控件本身的标签才收）', () => {
    // 一个大 DIV 的 innerText 恰好等于该文案 → 点了等于点空白，不能算候选
    const div = makeEl('DIV', '', { innerText: '确认' })
    expect(collect([div], '确认', null)).toHaveLength(0)
  })

  it('② 仍然遵守范围限定与可见性', () => {
    const inside = makeEl('BUTTON', '', { innerText: '确 认' })
    const outside = makeEl('BUTTON', '', { innerText: '确 认' })
    const root = makeEl('DIV', '', { children: [inside] })
    expect(collect([inside, outside], '确认', [root])).toEqual([inside])
    const hidden = makeEl('BUTTON', '', { innerText: '确 认', visible: false })
    expect(collect([hidden], '确认', null)).toHaveLength(0)
  })

  it('① 与 ② 都不命中时返回空（调用方如实报找不到）', () => {
    expect(collect([makeEl('BUTTON', '别的文案')], '确认', null)).toHaveLength(0)
    // 部分匹配不行：②要求整段规范化后**完全相等**
    expect(collect([makeEl('BUTTON', '', { innerText: '确认发送邀请' })], '确认', null)).toHaveLength(0)
  })
})
