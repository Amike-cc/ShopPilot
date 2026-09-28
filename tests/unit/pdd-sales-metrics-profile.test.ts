import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BUSINESS_PROFILES, businessProfileFor, BUSINESS_SUPPORTED_PLATFORMS } from '@shared/constants/business'
import { parseSalesValue } from '../../apps/desktop/src/main/platform-adapters/sales-metrics-page-reader'

/**
 * 拼多多经营数据档案（2026-09-28 首次实测接入）。
 *
 * 背景：拼多多的经营指标长期是 `DATA_SOURCE_NOT_VERIFIED` —— 表面像"这个平台没数据"，
 * 真实原因是它的采集走"网络观察 + JSON 抽取器"路线，而那条路线的注册表在生产里是空的
 * （从未拿到可核对的响应结构），于是每次采集都直接返回未验证，**从来没读过它的页面**。
 *
 * 实测（2026-09-28，真实登录态商家后台首页）：
 *   · 首页「经营数据」卡片是纯文本可读：成交金额 204.93 / 昨日 361.01、成交订单数 7 / 昨日 13；
 *   · 「7日/30日」页签只切趋势图，**卡片数值不变** → 卡片口径是"今日实时"；
 *   · 数据中心（sycm/stores_data、sycm/evaluation）的数字是**反抓取字体**（私有区码位），
 *     取文本得到乱码 → 那两页不登记、不猜。
 *
 * 本文件钉住"档案与解析假设"，真机读值由验收脚本覆盖（锚点必须实测，单测不能替代真机）。
 */

const PDD = '拼多多'

describe('拼多多经营数据档案', () => {
  it('已登记为可采集平台，且页面/口径/实测日期明确', () => {
    expect(BUSINESS_SUPPORTED_PLATFORMS).toContain(PDD)
    const profile = businessProfileFor(PDD)!
    expect(profile).toBeTruthy()
    expect(profile.pageUrl).toBe('https://mms.pinduoduo.com/home/')
    expect(profile.urlMarker).toBe('mms.pinduoduo.com/home')
    // 卡片是"今日实时"，不是近 7 天滚动：口径写错的话，把今日累计标成 7 天比没有数字更糟
    expect(profile.salesPeriodType).toBe('TODAY')
    expect(profile.measuredAt).toBe('2026-09-28')
    // 卡片数值不随周期页签变化 → 档案里不该有"点周期控件"这一步
    expect(profile.periodText).toBeUndefined()
  })

  it('两个锚点都显式声明落到哪个统一指标（不靠中文文案推断口径）', () => {
    const metrics = businessProfileFor(PDD)!.metrics
    const byKey = new Map(metrics.map(m => [m.key, m]))
    expect(byKey.get('biz.gmv')).toMatchObject({ anchorText: '成交金额', salesField: 'grossSalesAmountMinor', salesUnit: 'MINOR_CNY' })
    expect(byKey.get('biz.orders')).toMatchObject({ anchorText: '成交订单数', salesField: 'paidOrderCount', salesUnit: 'COUNT' })
    // 数据中心的字体反爬页没有登记任何锚点（登记了就等于承认能读）
    expect(metrics).toHaveLength(2)
  })

  it('卡片文本里的三个数字只认主值：主值可解析、昨日对照与空值都不能被当成数值', () => {
    // 实测卡片文本形如「成交金额204.93趋势昨日 361.01」「成交订单数7昨日 13」
    expect(parseSalesValue('204.93', 'MINOR_CNY')).toEqual({ ok: true, value: 20493 })
    expect(parseSalesValue('7', 'COUNT')).toEqual({ ok: true, value: 7 })
    // 「昨日 361.01」是卡片内对照行；「--」是平台"当前无数据"的写法 —— 两者都必须解析失败
    expect(parseSalesValue('昨日 361.01', 'MINOR_CNY').ok).toBe(false)
    expect(parseSalesValue('--', 'COUNT').ok).toBe(false)
    expect(parseSalesValue('', 'COUNT').ok).toBe(false)
  })

  it('其它平台的档案没有被这次登记改动', () => {
    expect(businessProfileFor('快手小店')!.salesPeriodType).toBe('LAST_7_DAYS')
    expect(businessProfileFor('微信小店')!.salesPeriodType).toBe('LAST_7_DAYS')
    expect(businessProfileFor('抖店')!.salesPeriodType).toBe('TODAY')
    expect(Object.keys(BUSINESS_PROFILES)).toHaveLength(4)
  })

  it('拼多多 Adapter 走的是 DOM 档案路径（不能退回"注册表为空的网络抽取"那条沉默路径）', () => {
    const src = readFileSync(resolve('apps/desktop/src/main/platform-adapters/pdd-adapter.ts'), 'utf8')
    expect(src).toContain('extends SalesMetricsDomAdapter')
    expect(src).toContain('businessProfileFor(platform.name)')
    // 订单能力保留（网络观察），商品级能力不再声称已支持
    expect(src).toContain('orders: true')
    expect(src).toContain('productSalesMetrics: false')
    // 旧路线（自实现 collectSalesMetrics + 恒失败、恒返回"未验证"的证据自检）必须已经移除
    expect(src).not.toContain('async collectSalesMetrics(')
    expect(src).not.toContain("reasonCode: 'DATA_SOURCE_NOT_VERIFIED'")
  })
})
