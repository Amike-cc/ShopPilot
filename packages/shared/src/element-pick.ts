/**
 * 「拾取元素」的跨进程契约：结果结构 + 人话描述。
 *
 * 【为什么单独放在 shared】
 * 拾取结果要穿过三层：注入页面的脚本（主进程）→ IPC → 编排器界面（渲染层）。
 * 描述文案如果只在主进程写一份、渲染层再写一份，同一个失败原因就会有两种说法
 * （日志里"PICK_TIMEOUT"、界面上"拾取失败"），排查时对不上号。
 * 这里放一份，两边都引它。
 */

/** 拾取目标：要选择器（CSS 路径）还是要文案锚点 */
export type PickMode = 'selector' | 'text'

export interface ElementPickResult {
  ok: boolean
  /** 用户按 Esc 主动取消（与"失败"区分，界面提示措辞不同） */
  cancelled?: boolean
  reason?: string
  /** CSS 路径（mode='selector' 时填进选择器字段） */
  selector?: string
  /** 自有文案（mode='text' 时填进文案字段） */
  text?: string
  tag?: string
  inShadowRoot?: boolean
  /** 所在行（表格行/列表项）的选择器与文本，供 within 使用 */
  rowSelector?: string
  rowText?: string
  hashyClasses?: string[]
  stableClasses?: string[]
  url?: string
}

/** 把拾取结果整理成人话（日志与界面提示共用，避免两处措辞不一致） */
export function describePickResult(r: ElementPickResult, mode: PickMode): string {
  if (r.cancelled) return '已取消拾取'
  if (!r.ok) {
    const why: Record<string, string> = {
      NO_ELEMENT_AT_POINT: '落点处没有元素',
      PICK_TIMEOUT: '拾取超时（长时间没有点击）',
      PICK_NAVIGATED: '拾取期间页面跳转了（请重新导航到目标页再拾取）',
      NO_STORE_PAGE: '当前没有打开的店铺页面',
      NO_ACTIVE_TAB: '当前店铺没有活动标签页',
      INJECT_FAILED: '页面注入失败（页面可能正在跳转或已崩溃）',
      NO_VALUE: '这个元素取不到可用锚点'
    }
    return why[r.reason || ''] || ('拾取失败：' + (r.reason || '未知原因'))
  }
  if (mode === 'text' && !r.text) {
    return '这个元素没有可用的文案（文本都在子元素里或没有文本），建议改用「拾取选择器」'
  }
  return mode === 'text' ? ('已拾取文案：' + r.text) : ('已拾取选择器：' + r.selector)
}
