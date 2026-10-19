/**
 * 达人邀约身份归一（纯函数，2026-10-19）。
 *
 * 只做「用户名优先、昵称兜底」这一件事：
 *   · 详情页 URL 能拿到 finderUsername 时用 `u:<username>`，这是稳定身份；
 *   · 列表行拿不到时用 `n:<trim/压缩空白/小写后的昵称>`，并明确标成仅昵称匹配。
 *
 * 刻意**不做**拼音、模糊匹配、去后缀等"聪明"归一：误把两个人合并成一个人，
 * 会让其中一位再也收不到邀约；宁可漏合并，也不要错合并。
 */

export type InviteIdentityLevel = 'username' | 'nickname'

export interface InviteCreatorIdentity {
  key: string
  level: InviteIdentityLevel
}

export function normalizeInviteNickname(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function inviteCreatorKey(nickname: string, finderUsername?: string | null): InviteCreatorIdentity {
  const username = String(finderUsername || '').trim()
  if (username) return { key: `u:${username.slice(0, 200)}`, level: 'username' }
  return { key: `n:${normalizeInviteNickname(nickname).slice(0, 120)}`, level: 'nickname' }
}
