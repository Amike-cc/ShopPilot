import type { PlatformDef } from '@shared/constants/platforms'
import { businessProfileFor } from '@shared/constants/business'
import { SalesMetricsDomAdapter } from './sales-metrics-dom-adapter'

const DOUYIN_HOST = 'fxg.jinritemai.com'
/** 项目里已实测的抖店未登录/选角色文案。 */
const KNOWN_LOGIN_TEXT = /请选择您要登录的角色|登录商家工作台|账号未登录|请重新登录/
/** 选角色页与登录页都是"未登录"的明确 URL 证据。 */
const LOGIN_PATH = /roles-select|\/login\//i

/**
 * 抖店经营数据 Adapter。
 *
 * 档案例外说明：该店**罗盘未开通**，后台首页只有卡片式「成交金额」（今日）。
 * 其余指标在首页与广告文案同名（实测「销量」读到的是"销量高"这类文案），
 * 因此档案只登记这一项，其它字段保持 null——不猜别的页面。
 *
 * 注意：后台首页能打开**不代表**经营数据能力已验证，所以本 Adapter 只认"锚点真的读到值"。
 */
export class DouDianAdapter extends SalesMetricsDomAdapter {
  constructor(platform: PlatformDef) {
    super(platform, {
      profile: businessProfileFor(platform.name),
      probe: { host: DOUYIN_HOST, expiredText: KNOWN_LOGIN_TEXT, loginPath: LOGIN_PATH },
      adapterVersion: 'doudian-sales-v1'
    })
  }
}
