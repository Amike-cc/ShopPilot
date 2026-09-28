import type { Session, WebContents } from 'electron'
import type {
  PlatformAdapterCapabilities,
  PlatformOrderCollectionOptions,
  PlatformOrderCollectionResult,
  PlatformOrderObservationOptions,
  PlatformEvidenceType,
  PlatformLoginResult,
  PlatformLoginStatus
} from '@shared/contracts/platform-adapter'
import type {
  PddOrderObservationStartResult,
  PddOrderObservationStopResult
} from '@shared/contracts/pdd-order-observation'
import type {
  SalesMetricsCollectionResult,
  SalesMetricsEvidenceCheck,
  SalesMetricsPeriodType
} from '@shared/contracts/sales-metrics'

/**
 * 采集拒停的原因码：Adapter 用它表达"再重试也不会好"，Main 据此停机等待用户。
 * 这些码会一路传到运行记录、计划和前端状态卡，所以必须是稳定的大写码。
 */
export const SALES_METRICS_STOP_REASON_CODES = [
  'LOGIN_REQUIRED',
  'VERIFY_REQUIRED',
  'PERMISSION_DENIED',
  'PAGE_CHANGED'
] as const
export type SalesMetricsStopReasonCode = typeof SALES_METRICS_STOP_REASON_CODES[number]

/** Main 进程内部上下文；严禁把它序列化或返回给 Renderer。 */
export interface PlatformAdapterContext {
  storeId: string
  platform: string
  session: Session
  webContents: WebContents | null
  currentUrl: string
  timeoutMs: number
}

export interface PlatformAdapter {
  readonly adapterName: string
  /**
   * Adapter 版本。页面改版后旧解析器必须作废，所以版本号会随每次运行写进
   * `sales_metrics.adapter_version` 与运行记录，用来回答"这行数据是哪版解析器写的"。
   */
  readonly adapterVersion: string
  readonly platform: string
  supports(platform: string): boolean
  getCapabilities(): Readonly<PlatformAdapterCapabilities>
  detectLoginStatus(context: PlatformAdapterContext): Promise<PlatformLoginResult>
}

/** 只由已经声明 orders=true 的平台实现；其它 Adapter 不需要假方法。 */
export interface OrderCapableAdapter extends PlatformAdapter {
  collectOrders(
    context: PlatformAdapterContext,
    options: PlatformOrderCollectionOptions
  ): Promise<PlatformOrderCollectionResult>
}

/** 只由拼多多 Adapter 实现的人工数据源观察生命周期。 */
export interface OrderObservationCapableAdapter extends OrderCapableAdapter {
  startOrderObservation(
    context: PlatformAdapterContext,
    options: PlatformOrderObservationOptions
  ): Promise<PddOrderObservationStartResult>
  stopOrderObservation(storeId: string): Promise<PddOrderObservationStopResult>
}

/** 只由已声明 salesMetrics=true 的平台实现；能力未验证时仍可安全返回 DATA_SOURCE_NOT_VERIFIED。 */
export interface SalesMetricsCapableAdapter extends PlatformAdapter {
  /**
   * 该平台页面**固定住的**统计周期。
   *
   * 为什么需要：页面默认周期各平台不同，档案里的周期控件会把口径切成不同长度
   * （实测快手商品总览默认"昨日"、微信首页默认"今天"，两者档案都统一切成"近7日/近7天"）。
   * 自动采集必须按这个周期落库，否则就是把 7 天的数字标成今天。
   */
  getPreferredPeriodType?(): SalesMetricsPeriodType
  collectSalesMetrics(
    context: PlatformAdapterContext,
    options: { periodType: SalesMetricsPeriodType; periodStart?: number; periodEnd?: number; timeoutMs: number }
  ): Promise<SalesMetricsCollectionResult & { storeMetrics?: import('@shared/contracts/sales-metrics').SalesMetrics[]; productMetrics?: import('@shared/contracts/sales-metrics').ProductSalesMetrics[] }>
  /**
   * 证据自检：本次拿到的字段是否真的由该来源产生。
   *
   * Main 用它把"Adapter 自称成功"降级：`SUCCEEDED` 但证据不通过 → `PARTIAL`，
   * 字段与页面结构对不上 → `PAGE_CHANGED`。没有这一步，页面改版后旧选择器
   * 匹配到别的数字也会被当成成功写库。
   */
  verifyEvidence(
    result: SalesMetricsCollectionResult & { storeMetrics?: import('@shared/contracts/sales-metrics').SalesMetrics[] },
    context: PlatformAdapterContext
  ): SalesMetricsEvidenceCheck
}

export const LOGIN_DETECTION_ONLY_CAPABILITIES: Readonly<PlatformAdapterCapabilities> = Object.freeze({
  loginDetection: true,
  orders: false,
  salesMetrics: false,
  productSalesMetrics: false,
  products: false,
  inventory: false,
  refunds: false,
  salesData: false
})

export function createLoginResult(
  context: Pick<PlatformAdapterContext, 'storeId' | 'platform'>,
  status: PlatformLoginStatus,
  reasonCode: string,
  evidenceType: PlatformEvidenceType
): PlatformLoginResult {
  const messages: Record<PlatformLoginStatus, string> = {
    UNKNOWN: '无法确认平台登录状态',
    LOGGED_IN: '平台登录状态已确认',
    LOGIN_REQUIRED: '需要在店铺浏览器中登录',
    VERIFY_REQUIRED: '需要在店铺浏览器中完成安全验证',
    ERROR: '平台登录状态检测失败'
  }
  return {
    platform: context.platform,
    storeId: context.storeId,
    status,
    checkedAt: Date.now(),
    reasonCode,
    safeMessage: messages[status],
    evidenceType
  }
}

/** 页面脚本只返回布尔判断，不把页面文字、账号信息或认证数据传回 Main。 */
export async function pageTextMatches(context: PlatformAdapterContext, expression: string): Promise<boolean> {
  if (!context.webContents || context.webContents.isDestroyed()) return false
  const script = `(() => {
    const text = String(document.body ? document.body.innerText : '')
    return (${expression}).test(text)
  })()`
  return Boolean(await context.webContents.executeJavaScript(script, true))
}
