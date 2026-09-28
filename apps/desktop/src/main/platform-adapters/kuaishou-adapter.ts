import type { PlatformDef } from '@shared/constants/platforms'
import { businessProfileFor } from '@shared/constants/business'
import { SalesMetricsDomAdapter } from './sales-metrics-dom-adapter'

const KUAISHOU_HOST = 'syt.kwaixiaodian.com'

/**
 * 快手小店经营数据 Adapter。
 *
 * 档案例外说明：这个平台**没有**可复用的登录页/验证页判定规则（项目里从未实测到明确文案），
 * 所以登录检测保持 UNKNOWN；能确认登录态的只有"经营数据锚点真的渲染出来了"——
 * 那由采集阶段读值成功来体现，不由检测阶段猜。
 *
 * 采集锚点：生意通 → 商品 → 商品总览（实测 2026-09-13），一页覆盖五个指标；
 * 页面默认周期是「昨日」，档案统一点「近7日」，因此落库周期是 LAST_7_DAYS 而不是 TODAY。
 */
export class KuaishouAdapter extends SalesMetricsDomAdapter {
  constructor(platform: PlatformDef) {
    super(platform, {
      profile: businessProfileFor(platform.name),
      probe: { host: KUAISHOU_HOST },
      adapterVersion: 'kuaishou-sales-v1'
    })
  }
}
