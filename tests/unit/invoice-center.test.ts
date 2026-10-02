import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findPlatform } from '../../packages/shared/src/constants/platforms'
import { invoiceProfileFor } from '../../packages/shared/src/constants/invoice'

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

// ---------- 发票中心：店铺行跳转「开票地址」 ----------
// 「N 条待办」之后，用户的下一步就是去平台把票开了。所以店铺行要能一键跳过去。
// 地址口径（与采集口径一致，宁缺毋滥）：优先档案里**实测的发票页**（就是采集读的那一页），
// 没档案的平台退回该店后台地址，两者都没有就置灰——绝不猜一个地址出来。

describe('发票中心跳转开票地址', () => {
  const PAGE = readFileSync(resolve('apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue'), 'utf8')
  const OVERVIEW = readFileSync(resolve('apps/desktop/src/main/services/overview-service.ts'), 'utf8')

  it('主进程为每个店铺返回实测发票页与后台地址（界面才有得跳）', () => {
    expect(OVERVIEW).toContain('pageUrl: profile?.pageUrl')
    expect(OVERVIEW).toContain('adminUrl: s.admin_url')
  })

  it('店铺行用这两个字段：优先发票页 → 退回后台地址 → 都没有就置灰', () => {
    expect(PAGE).toContain('row?.pageUrl')
    expect(PAGE).toContain('row?.adminUrl')
    expect(PAGE).toMatch(/return String\(row\?\.pageUrl \|\| row\?\.adminUrl \|\| ''\)/)
    expect(PAGE).toContain(':disabled="!invoiceOpenUrl(row)"')
  })

  it('点击后切到该店浏览器页并直达地址（新标签页，不覆盖用户当前页）', () => {
    expect(PAGE).toContain('async function openInvoicePage')
    expect(PAGE).toMatch(/emit\('open-store', row\.storeId\)/)
    expect(PAGE).toMatch(/await ws\.newTab\(url\)/)
    // 供 CDP 验收脚本定位
    expect(PAGE).toContain("'invoice-open-page-' + row.storeId")
  })

  it('界面里不写死任何平台开票地址（地址一律来自档案或店铺配置）', () => {
    expect(PAGE).not.toMatch(/https:\/\/[a-z0-9.-]*(pinduoduo|weixin|jinritemai|kwaixiaodian)/)
  })

  it('已实测发票入口的平台，跳转目标与「发票入口」登记的是同一个地址', () => {
    for (const name of ['微信小店', '拼多多']) {
      const profile = invoiceProfileFor(name)!
      const routes = findPlatform(name)!.invoiceRoutes
      expect(routes.some(r => r.url === profile.pageUrl && r.verified === true), name).toBe(true)
    }
  })
})
