import type { PlatformDef } from '@shared/constants/platforms'
import { businessProfileFor } from '@shared/constants/business'
import type { PlatformAdapterContext } from './platform-adapter'
import { SalesMetricsDomAdapter } from './sales-metrics-dom-adapter'

const PDD_HOST = 'mms.pinduoduo.com'

/**
 * 拼多多经营数据 Adapter。
 *
 * 经营指标走已实测的 DOM 锚点档案（首页卡片：成交金额 / 成交订单数，
 * 口径为今日实时）。订单明细和订单观察已从产品中移除，不再在适配器层暴露。
 */
export class PddAdapter extends SalesMetricsDomAdapter {
  constructor(platform: PlatformDef) {
    super(platform, {
      profile: businessProfileFor(platform.name),
      // 只校验主机；登录/验证页文案未实测，因此不登记否定判据。
      probe: { hosts: [PDD_HOST] },
      adapterVersion: 'pdd-sales-v2'
    })
  }

  supports(platform: string): boolean { return platform === this.platform }

  getCapabilities() {
    // 没有已验证的商品级来源，保持 false；订单管理已下线，不再提供订单适配能力。
    return Object.freeze({ ...super.getCapabilities(), productSalesMetrics: false })
  }

  async detectLoginStatus(context: PlatformAdapterContext) {
    // 只用已验证的经营数据锚点给出肯定登录证据，拿不到证据就返回 UNKNOWN。
    return super.detectLoginStatus(context)
  }
}
