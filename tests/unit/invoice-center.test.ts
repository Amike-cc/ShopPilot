import { describe, it, expect } from 'vitest'
import { PLATFORM_CATALOG, findPlatform } from '../../packages/shared/src/constants/platforms'

// ---------- 发票中心入口数据 ----------
// 这些地址是"发票中心"面板的跳转目标，属对外可见的功能数据，必须可校验、不许乱写。

describe('发票中心入口数据', () => {
  it('四家平台都有发票入口列表（不含「其他」自定义平台）', () => {
    for (const name of ['拼多多', '微信小店', '快手小店', '抖店']) {
      const p = findPlatform(name)!
      expect(p, name).toBeTruthy()
      expect(Array.isArray(p.invoiceRoutes), name).toBe(true)
      expect(p.invoiceRoutes.length, name).toBeGreaterThan(0)
      for (const r of p.invoiceRoutes) {
        expect(r.title.length).toBeGreaterThan(0)
        expect(r.url).toMatch(/^https:\/\//)
      }
    }
  })

  it('已实测的入口用的是真机验证过的地址（改地址必须同时确认，否则会挂在这里）', () => {
    // 2026-09-14 真机实测：微信小店后台导航「发票中心」、拼多多「订单开票 / 发票管理」
    const wx = findPlatform('微信小店')!.invoiceRoutes
    expect(wx.some(r => r.url === 'https://store.weixin.qq.com/shop/bill/home' && r.verified === true)).toBe(true)

    const pdd = findPlatform('拼多多')!.invoiceRoutes
    expect(pdd.some(r => r.url === 'https://mms.pinduoduo.com/invoice/center' && r.verified === true)).toBe(true)
    expect(pdd.some(r => r.url === 'https://mms.pinduoduo.com/cashier/finance/invoice' && r.verified === true)).toBe(true)
  })

  it('未实测的平台不许标 verified（快手实测无独立发票入口、抖店未登录测不了）', () => {
    for (const name of ['快手小店', '抖店']) {
      const routes = findPlatform(name)!.invoiceRoutes
      for (const r of routes) {
        expect(r.verified, `${name} ${r.title} 不应标为已实测`).not.toBe(true)
      }
      // 未实测时只给后台入口（平台首页），不给猜测的深链
      expect(routes.length).toBe(1)
      expect(routes[0].url).toBe(findPlatform(name)!.adminUrl)
    }
  })
})
