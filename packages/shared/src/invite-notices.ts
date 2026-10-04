/**
 * 平台"为什么点不动"的提示分类（单一事实来源，纯函数，可直接单测）。
 *
 * 动机（2026-10-04 真机）：微信达人详情页点「邀请带货」4 次都没跳到表单页时，
 * 日志里只有一句 `TASK_TIMEOUT: 点击「邀请带货」4 次后地址仍未变为含「initiate-invite」的页面`
 * —— **平台到底说了什么一个字都没有**，排查只能靠猜。而这三种情况的处置完全相反：
 *
 *   · 已邀约（7 天内）→ 换下一位（advance 跳过这一位，不是失败）；
 *   · 邀请机会用完   → **干净收工**（TASK_QUOTA_EXCEEDED 在 stopOn 里；继续跑只是白耗额度）；
 *   · 操作过于频繁   → 退避后**重试同一位**（限流不是这一位的问题，换人反而漏人）。
 *
 * 因此：先如实读出平台措辞，再按它分流；认不出来就如实失败（错误信息带上原话）。
 */
export type InviteBlockKind = 'already-invited' | 'quota-exhausted' | 'throttled' | 'unknown'

/** 已邀约：平台原话是「你已经邀请过该达人，7天内不可再次发送带货邀约」 */
const ALREADY_INVITED_RE = /已邀请过该达人|已经邀请过该达人|7\s*天内不可再次发送|已邀约|已经邀约/
/** 额度：平台可能说「今日邀请机会已用完」「今日邀请次数已达上限」「额度不足」 */
const QUOTA_RE = /邀请机会.{0,6}(用完|已用完|不足)|次数已用完|已达.{0,4}上限|额度.{0,4}(用完|不足|已达)|今日.{0,6}(上限|用完)/
/** 限流：平台可能说「操作过于频繁，请稍后重试」 */
const THROTTLED_RE = /过于频繁|操作频繁|稍后(再|重)试|请等待|请求过快|风控|限流/

export function classifyInviteBlockNotice(notice: string | null | undefined): InviteBlockKind {
  const text = String(notice || '')
  if (!text) return 'unknown'
  if (ALREADY_INVITED_RE.test(text)) return 'already-invited'
  if (QUOTA_RE.test(text)) return 'quota-exhausted'
  if (THROTTLED_RE.test(text)) return 'throttled'
  return 'unknown'
}

/**
 * "登录态没拿到"的正文判据（2026-10-04 快手分销后台真机）。
 *
 * 实测状态：页面地址完全正确（`/zone/daren-match/daren-square-pro`）、标题也是「分销商家」，
 * 但正文只有一句「正在获取用户信息，请稍后…」，筛选区永远不渲染。
 * 这种时候任何"等文案/等元素"都只会超时报 TASK_TIMEOUT，而用户唯一能做的事就是重新登录。
 * 判据只认平台自己的措辞，不做推断（判错会把"页面慢"说成"登录失效"）。
 */
const SESSION_STALL_RE = /正在获取用户信息|请先登录|请登录后|扫码登录|登录已过期|登录状态失效|无权限访问|暂无权限/

/** 返回命中的那句（用于错误信息），没有则 null */
export function matchSessionStall(bodyText: string | null | undefined): string | null {
  const text = String(bodyText || '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const m = text.match(SESSION_STALL_RE)
  if (m) return m[0]
  // 极短的正文且带"获取/登录/权限"字样：典型的"壳页面"（没有业务内容）
  if (text.length <= 40 && /获取|登录|权限/.test(text)) return text.slice(0, 40)
  return null
}
