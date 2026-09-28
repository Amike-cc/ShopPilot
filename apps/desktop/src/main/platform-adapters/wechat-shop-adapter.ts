import type { PlatformDef } from '@shared/constants/platforms'
import { businessProfileFor } from '@shared/constants/business'
import { SalesMetricsDomAdapter } from './sales-metrics-dom-adapter'

const WECHAT_SHOP_HOST = 'store.weixin.qq.com'
/** 项目里已实测的微信小店登录过期文案。 */
const KNOWN_EXPIRED_TEXT = /登录超时|请重新\s*登录|扫码进入我的小店/

/**
 * 微信小店经营数据 Adapter。
 *
 * 采集锚点是实测档案（`BUSINESS_PROFILES['微信小店']`，实测日期 2026-09-13）：
 * 后台首页「经营数据」区，整页在 `<micro-app shadowdom>` 的 ShadowRoot 内，因此全部走 deep。
 * 档案只登记了成交金额/成交订单数/成交退款金额——销量与退款订单数在该店没有可靠来源，
 * 对应字段保持 null（前端显示"未采集"），不猜别的页面口径。
 */
export class WeChatShopAdapter extends SalesMetricsDomAdapter {
  constructor(platform: PlatformDef) {
    super(platform, {
      profile: businessProfileFor(platform.name),
      probe: { host: WECHAT_SHOP_HOST, expiredText: KNOWN_EXPIRED_TEXT },
      adapterVersion: 'wechat-shop-sales-v1'
    })
  }
}
