import type { PlatformDef } from '@shared/constants/platforms'
import { businessProfileFor } from '@shared/constants/business'
import { SalesMetricsDomAdapter } from './sales-metrics-dom-adapter'

const KUAISHOU_LEGACY_HOST = 's.kwaixiaodian.com'
const KUAISHOU_SYT_HOST = 'syt.kwaixiaodian.com'

/**
 * 快手小店经营数据 Adapter。
 *
 * **两个 host 都要认（2026-09-30 实测）**：店铺平时停在 `s.kwaixiaodian.com/zone/home`
 * （页面标题「快手小店」，含店铺名/商户 ID/商家后台导航，且页面上有「成交金额」「成交订单数」
 * 两个档案锚点），而经营数据档案页在 `syt.kwaixiaodian.com` 的生意通商品总览。
 * 以前只登记 syt 一个域名，停在旧域名的店铺永远 `PAGE_NOT_RECOGNIZED` → 登录了也显示离线。
 *
 * 顺带一个安全性质：未登录访问 `s.kwaixiaodian.com` 会 **302 到 `login.kwaixiaodian.com`**
 * （实测同一时间），登录页根本不在白名单里——所以"主机匹配"这一步本身就排除了登录页，
 * 不需要再登记（也从未实测到）页面内的登录文案。
 *
 * 档案例外说明：这个平台**没有**可复用的登录页/验证页文案，所以登录检测不登记否定判据；
 * 能确认登录态的只有"经营数据锚点真的渲染出来了"（两个域名下的首页都有其中至少一项）。
 *
 * 采集锚点：生意通 → 商品 → 商品总览（实测 2026-09-13），一页覆盖五个指标；
 * 页面默认周期是「昨日」，档案统一点「近7日」，因此落库周期是 LAST_7_DAYS 而不是 TODAY。
 */
export class KuaishouAdapter extends SalesMetricsDomAdapter {
  constructor(platform: PlatformDef) {
    super(platform, {
      profile: businessProfileFor(platform.name),
      probe: { hosts: [KUAISHOU_SYT_HOST, KUAISHOU_LEGACY_HOST] },
      adapterVersion: 'kuaishou-sales-v1'
    })
  }
}
