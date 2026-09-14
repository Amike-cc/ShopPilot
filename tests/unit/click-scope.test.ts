import { describe, it, expect } from 'vitest'
import { SCOPE_FN } from '../../apps/desktop/src/main/tasks/task-runner'

/**
 * 范围限定（`clickByText.within`）跑的是**注入页面的同一份源码**。
 *
 * 为什么必须有这个测试：旧实现用 `document.querySelector(w.selector)` 只取**第一个**匹配的
 * 容器当范围。而页签类容器的选择器（快手 `.ant-tabs-tab-btn`）天然命中多个——
 * 于是"在页签里找「处理中」"变成了"在第一个页签（未开票账单）里找处理中"，
 * 必然找不到，报出误导性的"页面上找不到文案为「处理中」的可点击元素"（真机实测踩过）。
 */

/** 最小 DOM 节点：类名、自有文本、子元素，并自动建立 parentElement 反向链接 */
interface El {
  cls: string
  own: string
  children: El[]
  parentElement: El | null
  childNodes: any[]
  contains(x: El): boolean
  querySelectorAll(sel: string): El[]
}

function makeEl(cls: string, own = '', children: El[] = []): El {
  const self: El = {
    cls, own, children, parentElement: null,
    childNodes: own ? [{ nodeType: 3, textContent: own }] : [],
    contains(x: El): boolean { return self === x || children.some(c => c.contains(x)) },
    querySelectorAll(sel: string): El[] {
      const out: El[] = []
      const walk = (e: El) => { for (const c of e.children) { if (match(c, sel)) out.push(c); walk(c) } }
      walk(self)
      return out
    }
  }
  for (const c of children) c.parentElement = self
  return self
}

/** 够用的选择器匹配：支持 '*'、'.cls'、'#id'（测试里用不到更复杂的） */
function match(e: El, sel: string): boolean {
  if (sel === '*') return true
  const parts = String(e.cls).split(/\s+/)
  if (sel.startsWith('.')) return parts.includes(sel.slice(1))
  if (sel.startsWith('#')) return String(e.cls).includes(sel.slice(1))
  return false
}

/** 把 SCOPE_FN 的真实源码放进一个假 document 里求值 */
function makeScope(roots: El[]) {
  // document 要作为**参数**注入：SCOPE_FN 里的 document 是词法解析的全局名，
  // 用 fn.call(doc, ...) 只改 this、改不到它（第一次写就踩了这个坑）。
  const all = (): El[] => {
    const out: El[] = []
    const walk = (e: El) => { out.push(e); e.children.forEach(walk) }
    roots.forEach(walk)
    return out
  }
  const doc = {
    // 与真实 DOM 一致：'*' 递归取全部元素（含宿主自身），其余选择器只查后代
    querySelectorAll: (sel: string) => sel === '*' ? all() : roots.flatMap(r => r.querySelectorAll(sel))
  }
  const fn = new Function('document', `${SCOPE_FN}; return { __scopeRoots, __inScope };`)(doc)
  return {
    roots: (w: any) => fn.__scopeRoots(w),
    inScope: (rs: El[] | null, e: El) => fn.__inScope(rs, e)
  }
}

describe('clickByText 的 within 范围限定（跑注入页面的同一份源码）', () => {
  // 三个页签容器，只有第二个里才有「处理中」的文本
  const t1 = makeEl('ant-tabs-tab-btn', '未开票账单')
  const t2 = makeEl('ant-tabs-tab-btn', '处理中')
  const t3 = makeEl('ant-tabs-tab-btn', '处理记录')
  const bar = makeEl('ant-tabs-bar', '', [t1, t2, t3])
  const page = makeEl('root', '', [bar])
  const { roots, inScope } = makeScope([page])

  it('selector 命中多个容器时**每个都算范围内**（旧实现只取第一个 → 找不到「处理中」）', () => {
    const r = roots({ selector: '.ant-tabs-tab-btn' })
    expect(r, '应返回全部三个页签容器').toHaveLength(3)
    expect(inScope(r, t2)).toBe(true)      // 「处理中」在第二个页签里——正是旧实现够不到的那个
    expect(inScope(r, t1)).toBe(true)
    expect(inScope(r, t3)).toBe(true)
  })

  it('范围外的元素仍被排除（限定真的起作用）', () => {
    const outside = makeEl('other', '处理中')
    expect(inScope(roots({ selector: '.ant-tabs-tab-btn' }), outside)).toBe(false)
  })

  it('selector 一个都匹配不到 → 返回 null（调用方如实报 SCOPE_NOT_FOUND，而不是全页乱点）', () => {
    expect(roots({ selector: '.no-such-thing' })).toBeNull()
  })

  it('climb 向上抬范围：多个容器各自上抬，不合并成一个', () => {
    const r = roots({ selector: '.ant-tabs-tab-btn', climb: 1 })
    expect(r).toHaveLength(3)
    expect(r!.every(x => x === bar)).toBe(true)
    // 上抬到 bar 之后，页签外的兄弟文案也进了范围（这正是 climb 的用途）
    const title = makeEl('title', '给平台开票')
    bar.children.push(title); title.parentElement = bar
    expect(inScope(r, title)).toBe(true)
  })

  it('按文案取范围（within.text）仍只认最短命中，不分叉', () => {
    const marker = makeEl('marker', '已筛选')
    const sibling = makeEl('other', '已筛选', [makeEl('deep', '已筛选')])
    const container = makeEl('container', '', [marker, sibling])
    const scoped = makeScope([makeEl('root', '', [container])])
    const r = scoped.roots({ text: '已筛选' })
    // 文案相同的候选里取"自身文本最短"的那个（与点击目标的选择口径一致）
    expect(r).toHaveLength(1)
    expect(r![0]).toBe(marker)
    expect(scoped.inScope(r, marker)).toBe(true)
    expect(scoped.inScope(r, sibling)).toBe(false)   // 没进范围的同名元素仍被排除
  })

  it('不给 within 时返回 null = 不限定范围（全页找）', () => {
    expect(roots(null)).toBeNull()
    expect(inScope(null, makeEl('x'))).toBe(true)
  })
})
