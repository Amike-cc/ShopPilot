import { describe, expect, it } from 'vitest'
import { platformAdminUrl, platformHomeUrl } from '@shared/constants/platforms'

/**
 * 平台默认首页（2026-10-25）。
 *
 * 浏览器「首页」按钮与登录失效后的重开都读这里：
 *   · 平台声明了更具体的 homeUrl（抖店 = 后台 trade/dashboard）→ 用它，不再停在根域名；
 *   · 未声明的平台 → 回退 adminUrl（拼多多/微信/快手的既有行为不变）；
 *   · 自定义平台/未知平台 → 空串（调用方如实报"没有配置首页地址"）。
 *
 * adminUrl 与 homeUrl 是两件事：adminUrl 仍是"新建店铺默认填入的后台地址"，
 * 只把首页落地页换成更深的一层，避免两者被改成同一个值后无法区分。
 */
describe('平台默认首页地址', () => {
  it('抖店使用用户给定的后台首页，adminUrl 保持后台根地址', () => {
    expect(platformHomeUrl('抖店')).toBe('https://fxg.jinritemai.com/ffa/mshop/trade/dashboard')
    expect(platformAdminUrl('抖店')).toBe('https://fxg.jinritemai.com')
  })

  it('未声明 homeUrl 的平台回退 adminUrl', () => {
    expect(platformHomeUrl('拼多多')).toBe(platformAdminUrl('拼多多'))
    expect(platformHomeUrl('微信小店')).toBe(platformAdminUrl('微信小店'))
    expect(platformHomeUrl('快手小店')).toBe(platformAdminUrl('快手小店'))
  })

  it('未知/自定义平台返回空串，不编造地址', () => {
    expect(platformHomeUrl('其他')).toBe('')
    expect(platformHomeUrl('不存在的平台')).toBe('')
  })
})
