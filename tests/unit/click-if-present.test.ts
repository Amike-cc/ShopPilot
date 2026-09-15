import { describe, it, expect } from 'vitest'

/**
 * `clickIfPresent.nearText` 的候选筛选逻辑（跑的是与注入脚本同构的实现）。
 *
 * 实测动因（快手达人广场）：商品弹窗的「确 认」和它上面弹出的警告框「确认」**同名**；
 * 按文案找会命中先出现的那个（下层弹窗的），点了等于白点、警告框一直留着。
 * 判据用"候选按钮的**祖先链里包含锚点文案**"——比"先找锚点再往上取浮层"可靠：
 * 实测两者共享外层容器，往上取只会拿到同时包住两者的那个 wrap。
 */

interface El {
  tag: string
  own: string
  innerText: string
  visible: boolean
  parent: El | null
  children: El[]
  contains(x: El): boolean
}

function el(tag: string, own: string, opts: { innerText?: string; children?: El[]; visible?: boolean } = {}): El {
  const children = opts.children || []
  const self: El = {
    tag, own, innerText: opts.innerText ?? own, visible: opts.visible !== false,
    parent: null, children,
    contains: (x: El) => self === x || children.some(c => c.contains(x))
  }
  for (const c of children) c.parent = self
  return self
}

/** 与 clickIfPresent 的 nearText 分支同构：候选 = 可点 + 文案匹配 + 祖先链含锚点 */
function pick(needle: string, anchor: string, all: El[]): El | null {
  const narrow = (s: string) => String(s ?? '').replace(/\s+/g, '')
  const out: El[] = []
  for (const e of all) {
    if (!['BUTTON', 'A', 'LABEL'].includes(e.tag)) continue
    if (!e.visible) continue
    const ok = e.own.includes(needle) || narrow(e.innerText) === narrow(needle)
    if (!ok) continue
    let has = false
    for (let n: El | null = e; n; n = n.parent) {
      if (String(n.innerText || '').includes(anchor)) { has = true; break }
    }
    if (has) out.push(e)
  }
  return out[0] || null
}

describe('clickIfPresent 的 nearText 范围判定', () => {
  it('同名按钮时只挑**属于该确认框**的那个（祖先链含锚点）', () => {
    const modalBtn = el('BUTTON', '确认', { innerText: '确认' })
    const modal = el('DIV', '', { innerText: '选择商品 已选择商品数：1/100 取消 确认', children: [modalBtn] })
    const warnBtn = el('BUTTON', '确认', { innerText: '确认' })
    const warn = el('DIV', '', {
      innerText: '您所选择的商品不符合达人带货要求，确认是否仍要发送邀请？取消 确认',
      children: [warnBtn]
    })
    // 关键：两者共享外层容器（这正是"往上取浮层"会失效的原因）
    const wrap = el('DIV', '', { innerText: '', children: [modal, warn] })
    const all = [wrap, modal, modalBtn, warn, warnBtn]
    expect(pick('确认', '确认是否仍要发送邀请', all)).toBe(warnBtn)
  })

  it('文案被拆进子 span 时也能命中（规范化 innerText）', () => {
    const btn = el('BUTTON', '', { innerText: '确 认' })
    const warn = el('DIV', '', { innerText: '确认是否仍要发送邀请', children: [btn] })
    expect(pick('确认', '确认是否仍要发送邀请', [warn, btn])).toBe(btn)
  })

  it('警告框不在时不选任何东西（= 这次没弹，跳过）', () => {
    const modalBtn = el('BUTTON', '确认', { innerText: '确认' })
    const modal = el('DIV', '', { innerText: '取消 确认', children: [modalBtn] })
    expect(pick('确认', '确认是否仍要发送邀请', [modal, modalBtn])).toBeNull()
  })

  it('不可见的候选不算（隐藏的预渲染弹窗不能点）', () => {
    const hidden = el('BUTTON', '确认', { innerText: '确认', visible: false })
    const warn = el('DIV', '', { innerText: '确认是否仍要发送邀请', children: [hidden] })
    expect(pick('确认', '确认是否仍要发送邀请', [warn, hidden])).toBeNull()
  })
})
