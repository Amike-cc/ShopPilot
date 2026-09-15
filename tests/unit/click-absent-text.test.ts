import { describe, it, expect, beforeAll } from 'vitest'
import { ABSENT_FN, PICK_SORT_FN, VISIBLE_JS } from '../../apps/desktop/src/main/tasks/task-runner'

/**
 * 目标缺席判据，跑的是**注入页面的同一份源码**（ABSENT_FN）。
 *
 * 实测动因（微信达人详情页，2026-09-15）：可邀约的达人显示「邀请带货」，
 * 不达合作门槛的显示「暂未到达合作门槛」。两者都表现为"找不到「邀请带货」"，
 * 但处置相反——一个是"页面没渲染出来"（退避后重试同一位），
 * 一个是"这位达人天生不能邀约"（必须换下一位）。
 * 不区分就会一直重试同一位，连续 N 次后整单失败、一位都没邀约。
 *
 * 判据的松紧是关键：不能退化成"页面上出现过这几个字"。
 */

const GATE = '暂未到达合作门槛'

/** 假元素：只需 __visible 用到的两个接口（尺寸 + computed style）与 ABSENT_FN 用到的三个字段 */
class FakeEl {
  own: string
  innerText: string
  childNodes: Array<{ nodeType: number; textContent: string }>
  visible: boolean
  constructor(own: string, opts: { innerText?: string; visible?: boolean } = {}) {
    this.own = own
    this.innerText = opts.innerText ?? own
    this.visible = opts.visible !== false
    this.childNodes = own === '' ? [] : [{ nodeType: 3, textContent: own }]
  }
  getBoundingClientRect() {
    return this.visible ? { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 } : { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 }
  }
}

beforeAll(() => {
  ;(globalThis as any).getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' })
})

/** 复刻 findTextTarget 里的缺席扫描（与 task-runner 同构） */
function hasAbsent(all: FakeEl[], at: string): boolean {
  const fn = new Function(`${VISIBLE_JS}; ${PICK_SORT_FN}; ${ABSENT_FN}; return { __absentHit };`)()
  return all.some(el => fn.__absentHit(el, at))
}

describe('absentText 缺席判据：页面明说"这件事做不了"', () => {
  it('元素自己写着这句话 → 命中（微信「暂未到达合作门槛」）', () => {
    expect(hasAbsent([new FakeEl(GATE)], GATE)).toBe(true)
  })

  it('文案被拆进子元素、自身无文本时，按规范化 innerText + 长度上限命中', () => {
    expect(hasAbsent([new FakeEl('', { innerText: GATE })], GATE)).toBe(true)
    // 带一点前后缀（如箭头/图标文字）仍算命中
    expect(hasAbsent([new FakeEl('', { innerText: ' ' + GATE + ' ' })], GATE)).toBe(true)
  })

  it('不把"只是后代里含这几个字"的大容器当成命中（判据不能退化成"页面出现过这几个字"）', () => {
    const page = new FakeEl('', { innerText: GATE + ' 带货者详情 邀请带货 带货概览 ' + 'x'.repeat(200) })
    expect(hasAbsent([page], GATE)).toBe(false)
  })

  it('文案只是恰好包含这几个字（更长的一段话）→ 不算命中', () => {
    const longer = new FakeEl('', { innerText: '你还需要满足以下条件才能联系：成为热招品牌，' + GATE + '请继续努力' })
    expect(hasAbsent([longer], GATE)).toBe(false)
  })

  it('不可见的元素不算命中（隐藏的弹层文案不能当判据）', () => {
    expect(hasAbsent([new FakeEl(GATE, { visible: false })], GATE)).toBe(false)
  })

  it('页面上没有这句话 → 不命中（调用方按"没渲染出来"处理）', () => {
    expect(hasAbsent([new FakeEl('邀请带货'), new FakeEl('带货者详情')], GATE)).toBe(false)
  })

  it('可邀约的详情页（有「邀请带货」）不会被误判成缺席', () => {
    expect(hasAbsent([new FakeEl('邀请带货'), new FakeEl('近30日带货数据')], GATE)).toBe(false)
  })
})
