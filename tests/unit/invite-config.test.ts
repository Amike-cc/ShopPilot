import { describe, it, expect } from 'vitest'
import {
  INVITE_CONFIG_STORE_PREFIX, INVITE_CONFIG_PLATFORM_PREFIX,
  inviteConfigKey, legacyInviteConfigKey
} from '../../packages/shared/src/invite-config'

/**
 * 邀约配置的存储键：**按店铺独立**。
 *
 * 为什么钉住它：同一平台可以有多家店铺（实测账号里有两家抖店），
 * 而配置里装的是店铺自己的联系方式、主营类目、核心优势——按平台存会互相覆盖，
 * 真机上表现为"B 店把 A 店的手机号发给了达人"。用户的要求也是每个店铺独立。
 */
describe('邀约配置存储键（按店铺独立）', () => {
  it('两家店铺各存一份，键互不相同', () => {
    const a = inviteConfigKey('store_aaa')
    const b = inviteConfigKey('store_bbb')
    expect(a).toBe(`${INVITE_CONFIG_STORE_PREFIX}store_aaa`)
    expect(b).not.toBe(a)
    expect(a.startsWith(INVITE_CONFIG_PLATFORM_PREFIX)).toBe(true)
  })

  it('旧版本按平台的键仍然可读（只做初始值迁移，不再写入）', () => {
    expect(legacyInviteConfigKey('抖店')).toBe('invite.config.抖店')
    // 两个键不能撞：店铺键带 store. 前缀，旧键是平台名——否则迁移会自己覆盖自己
    expect(inviteConfigKey('抖店')).not.toBe(legacyInviteConfigKey('抖店'))
    expect(inviteConfigKey('抖店')).toBe('invite.config.store.抖店')
  })

  it('店铺 id 里即便含点号/斜杠也各自成键（不与平台键混淆）', () => {
    expect(inviteConfigKey('store_a/b')).toBe('invite.config.store.store_a/b')
    expect(legacyInviteConfigKey('微信小店')).toBe('invite.config.微信小店')
  })
})
