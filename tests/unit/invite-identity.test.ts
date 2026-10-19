import { describe, expect, it } from 'vitest'
import { inviteCreatorKey, normalizeInviteNickname } from '@shared/invite-identity'

describe('达人邀约身份归一', () => {
  it('用户名优先：有 finderUsername 时得到稳定 key，并标记 username', () => {
    expect(inviteCreatorKey('力哥', 'finder_123')).toEqual({ key: 'u:finder_123', level: 'username' })
    // 昵称变了也不影响用户名身份
    expect(inviteCreatorKey('力哥改名前', 'finder_123').key).toBe('u:finder_123')
  })

  it('昵称兜底：trim/压缩空白/小写，不做拼音或模糊匹配', () => {
    expect(normalizeInviteNickname('  九零后   老母亲 ')).toBe('九零后 老母亲')
    expect(inviteCreatorKey('  九零后   老母亲 ')).toEqual({ key: 'n:九零后 老母亲', level: 'nickname' })
    // 形近/拼音不同的人不会被合并
    expect(inviteCreatorKey('力哥').key).not.toBe(inviteCreatorKey('力 哥').key)
  })

  it('空用户名按昵称处理，空昵称也给出可预期的 key（不抛错）', () => {
    expect(inviteCreatorKey('力哥', '   ')).toEqual({ key: 'n:力哥', level: 'nickname' })
    expect(inviteCreatorKey('', null)).toEqual({ key: 'n:', level: 'nickname' })
  })
})
