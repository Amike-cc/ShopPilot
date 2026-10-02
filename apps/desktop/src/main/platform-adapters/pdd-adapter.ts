import type { PlatformDef } from '@shared/constants/platforms'
import { businessProfileFor } from '@shared/constants/business'
import type {
  PlatformOrderCollectionOptions,
  PlatformOrderCollectionResult,
  PlatformOrderObservationOptions
} from '@shared/contracts/platform-adapter'
import type {
  PddOrderObservationReport,
  PddOrderObservationStartResult,
  PddOrderObservationStopResult
} from '@shared/contracts/pdd-order-observation'
import type {
  OrderObservationCapableAdapter,
  PlatformAdapterContext
} from './platform-adapter'
import { SalesMetricsDomAdapter } from './sales-metrics-dom-adapter'
import { buildPddOrderObservationReport } from '../orders/pdd-observation-report'
import { ElectronNetworkObserver, type NetworkObservationResult, type NetworkObserver } from '../orders/network-observer'
import { logMain } from '../services/logger'

const PDD_HOST = 'mms.pinduoduo.com'

export interface PddAdapterDependencies {
  createNetworkObserver?: (context: PlatformAdapterContext) => NetworkObserver
}

interface ActivePddObservation {
  context: PlatformAdapterContext
  observer: NetworkObserver
  startedAt: number
  expiresAt: number
}

function failedStart(storeId: string, reasonCode: string, safeMessage: string): PddOrderObservationStartResult {
  return {
    status: 'FAILED',
    storeId,
    platform: '拼多多',
    startedAt: null,
    expiresAt: null,
    reasonCode,
    safeMessage
  }
}

function logObservationReport(report: PddOrderObservationReport): void {
  logMain('info', `[PDD_ORDER_OBSERVATION_REPORT] ${JSON.stringify(report)}`)
}

/**
 * 拼多多经营数据 Adapter。
 *
 * 采集路径（2026-09-28 变更）：经营指标改走**已实测的 DOM 锚点档案**
 * （`BUSINESS_PROFILES['拼多多']`，实测日 2026-09-28，登录态商家后台首页卡片：
 * 成交金额 / 成交订单数，口径=今日实时）。
 *
 * 为什么不再是"网络观察 + JSON 抽取器"：那条路径的注册表在生产里是**空的**
 * （没有已验证的真实响应结构），于是每次采集都直接返回 DATA_SOURCE_NOT_VERIFIED——
 * 看起来像"拼多多没数据"，实际是"从没读过它的页面"。数据中心页（sycm/*）的数字是
 * 反抓取字体（私有区码位），而首页卡片的数字是纯文本，实测可读，所以走 DOM 档案。
 *
 * 订单能力（observation）仍走网络观察实现，与本类继承的 DOM 采集互不影响。
 * 登录检测：拼多多的登录/验证页文案从未实测过，所以不登记 probe 的否定判据（宁可不判）；
 * 能确认登录的只有"首页经营数据卡片真的渲染出来了"（见基类 anyProfileAnchorRendered）。
 */
export class PddAdapter extends SalesMetricsDomAdapter implements OrderObservationCapableAdapter {
  private readonly createNetworkObserver: (context: PlatformAdapterContext) => NetworkObserver
  private readonly activeObservations = new Map<string, ActivePddObservation>()
  private readonly completedReports = new Map<string, PddOrderObservationReport>()

  constructor(platform: PlatformDef, dependencies: PddAdapterDependencies = {}) {
    super(platform, {
      profile: businessProfileFor(platform.name),
      // 只校验主机；登录/验证页文案未实测，因此不登记（见 detectLoginStatus 的说明）
      probe: { hosts: [PDD_HOST] },
      // v1 = 网络观察式（注册表为空，从未产出数据）；v2 = DOM 锚点档案（首页卡片，实测可读）
      adapterVersion: 'pdd-sales-v2'
    })
    this.createNetworkObserver = dependencies.createNetworkObserver || ((context) => {
      if (!context.webContents) throw new Error('PAGE_NOT_READY')
      return new ElectronNetworkObserver(context.webContents)
    })
  }

  supports(platform: string): boolean { return platform === this.platform }

  getCapabilities() {
    // orders：网络观察实现真实存在（可开始/停止观察）。
    // productSalesMetrics：**恒 false**——没有任何已验证的商品级来源，声明 true 就是对自己撒谎
    // （旧值 true 是历史遗留的"预留"声明，与实现不符）。
    return Object.freeze({ ...super.getCapabilities(), orders: true, productSalesMetrics: false })
  }

  async detectLoginStatus(context: PlatformAdapterContext) {
    // 拼多多没有实测到任何明确的登录页/验证页文案 → 拿不出**否定**证据，所以直接复用基类：
    // 基类只用"经营数据锚点真的渲染出来"给出肯定的 LOGGED_IN，拿不到证据就是 UNKNOWN（不猜）。
    // 以前这里恒返回 UNKNOWN —— 等于把拼多多永久钉死在离线（2026-09-30 修）。
    return super.detectLoginStatus(context)
  }

  async collectOrders(
    context: PlatformAdapterContext,
    options: PlatformOrderCollectionOptions
  ): Promise<PlatformOrderCollectionResult> {
    try {
      const observation = await this.createNetworkObserver(context).observe({
        timeoutMs: options.timeoutMs,
        maxResponses: Math.min(200, Math.max(20, options.maxOrders * 2)),
        maxBodyBytes: 512 * 1024
      })
      const report = buildPddOrderObservationReport(context, observation)
      logObservationReport(report)
      return {
        status: 'OBSERVATION_ONLY',
        source: 'OBSERVATION_ONLY',
        orders: [],
        fetchedCount: 0,
        skippedCount: 0,
        observedResponseCount: observation.observations.length,
        nextCursor: null,
        hasMore: false,
        reasonCode: observation.reasonCode === 'NETWORK_OBSERVER_UNAVAILABLE'
          ? 'NETWORK_OBSERVER_UNAVAILABLE'
          : 'ORDER_DATA_SOURCE_UNVERIFIED',
        safeMessage: report.safeMessage,
        observationReport: report
      }
    } catch {
      return {
        status: 'FAILED',
        source: 'OBSERVATION_ONLY',
        orders: [],
        fetchedCount: 0,
        skippedCount: 0,
        observedResponseCount: 0,
        nextCursor: null,
        hasMore: false,
        reasonCode: 'ADAPTER_ERROR',
        safeMessage: '拼多多订单观察失败'
      }
    }
  }

  async startOrderObservation(
    context: PlatformAdapterContext,
    options: PlatformOrderObservationOptions
  ): Promise<PddOrderObservationStartResult> {
    const existing = this.activeObservations.get(context.storeId)
    if (existing) {
      if (existing.observer.isRunning?.() !== false) {
        return {
          status: 'ALREADY_RUNNING',
          storeId: context.storeId,
          platform: '拼多多',
          startedAt: existing.startedAt,
          expiresAt: existing.expiresAt,
          reasonCode: 'ALREADY_RUNNING',
          safeMessage: '该店铺已经在观察中'
        }
      }
      await this.stopOrderObservation(context.storeId)
    }
    this.completedReports.delete(context.storeId)

    const observer = this.createNetworkObserver(context)
    if (!observer.start || !observer.stop) {
      return failedStart(context.storeId, 'NETWORK_OBSERVER_UNAVAILABLE', '当前网络观察器不支持启动/停止控制')
    }
    const startedAt = Date.now()
    const active: ActivePddObservation = {
      context,
      observer,
      startedAt,
      expiresAt: startedAt + options.timeoutMs
    }
    this.activeObservations.set(context.storeId, active)
    try {
      await observer.start({
        timeoutMs: options.timeoutMs,
        maxResponses: options.maxResponses,
        maxBodyBytes: 512 * 1024,
        onComplete: (result) => this.completeObservation(active, result)
      })
      return {
        status: 'STARTED',
        storeId: context.storeId,
        platform: '拼多多',
        startedAt,
        expiresAt: active.expiresAt,
        reasonCode: 'OBSERVATION_STARTED',
        safeMessage: '已开始观察，请在拼多多后台刷新订单页、切换筛选或翻页'
      }
    } catch (error) {
      if (this.activeObservations.get(context.storeId) === active) this.activeObservations.delete(context.storeId)
      return failedStart(
        context.storeId,
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'NETWORK_OBSERVER_UNAVAILABLE',
        '无法启动拼多多网络观察'
      )
    }
  }

  async stopOrderObservation(storeId: string): Promise<PddOrderObservationStopResult> {
    const active = this.activeObservations.get(storeId)
    if (active) {
      try {
        const result = await active.observer.stop!()
        const report = this.completedReports.get(storeId) || this.completeObservation(active, result)
        this.activeObservations.delete(storeId)
        this.completedReports.delete(storeId)
        return {
          status: 'STOPPED',
          storeId,
          platform: '拼多多',
          report,
          reasonCode: report.reasonCode,
          safeMessage: '已停止观察并生成脱敏报告'
        }
      } catch {
        this.activeObservations.delete(storeId)
        return {
          status: 'FAILED',
          storeId,
          platform: '拼多多',
          report: null,
          reasonCode: 'NETWORK_OBSERVER_UNAVAILABLE',
          safeMessage: '停止拼多多网络观察失败'
        }
      }
    }

    const completed = this.completedReports.get(storeId)
    if (completed) {
      this.completedReports.delete(storeId)
      return {
        status: 'STOPPED',
        storeId,
        platform: '拼多多',
        report: completed,
        reasonCode: completed.reasonCode,
        safeMessage: '观察已自动结束，返回脱敏报告'
      }
    }
    return {
      status: 'NOT_RUNNING',
      storeId,
      platform: '拼多多',
      report: null,
      reasonCode: 'OBSERVATION_NOT_RUNNING',
      safeMessage: '该店铺当前没有运行中的观察'
    }
  }

  private completeObservation(active: ActivePddObservation, result: NetworkObservationResult): PddOrderObservationReport {
    const report = buildPddOrderObservationReport(active.context, result)
    this.completedReports.set(active.context.storeId, report)
    if (this.activeObservations.get(active.context.storeId) === active) this.activeObservations.delete(active.context.storeId)
    logObservationReport(report)
    return report
  }
}
