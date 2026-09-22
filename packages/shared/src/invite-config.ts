/**
 * 达人邀约配置的**存储键**（按店铺独立保存）。
 *
 * 为什么按店铺而不是按平台：同一个平台可以有多家店铺（实测账号里就有两家抖店），
 * 它们的联系人/手机号/微信号、主营类目、核心优势这些**都是店铺自己的信息**——
 * 按平台存会互相覆盖（A 店填完 B 店就成了 A 店的联系方式，真机上会直接把 A 店的
 * 手机号发给达人）。用户的要求也是"每个店铺独立，配置一次就够了"。
 *
 * 旧版本按平台存（`invite.config.<平台>`）。那份存档不删：新店铺第一次打开面板时
 * 拿它当**初始值**（迁移），此后这家店就写自己的键，两边各自独立。
 */
export const INVITE_CONFIG_STORE_PREFIX = 'invite.config.store.'
export const INVITE_CONFIG_PLATFORM_PREFIX = 'invite.config.'

/** 某店铺自己的邀约配置键 */
export function inviteConfigKey(storeId: string): string {
  return `${INVITE_CONFIG_STORE_PREFIX}${storeId}`
}

/** 旧版本按平台存的键（只用于给新店铺做初始值迁移，不再写入） */
export function legacyInviteConfigKey(platform: string): string {
  return `${INVITE_CONFIG_PLATFORM_PREFIX}${platform}`
}
