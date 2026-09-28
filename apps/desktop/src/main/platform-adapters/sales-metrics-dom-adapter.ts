/**
 * 已实测平台（微信小店 / 快手小店 / 抖店）的经营数据采集 Adapter 基类。
 *
 * 采集不猜选择器：全部锚点来自 `BUSINESS_PROFILES`（每个平台都记录了实测日期与实测锚点文案）。
 * 因此这一步能成立的前提是"锚点已实测"，而不是"看起来像"——档案没登记的平台一律
 * 返回 `DATA_SOURCE_NOT_VERIFIED`，不拿一个猜的选择器去试。
 *
 * 一次采集的完整链路：
 *   1. 校验本次请求的周期与档案固定住的周期一致（不一致就停：把 7 天的数字标成今天，比没有数字更糟）；
 *   2. 若当前不在经营数据页，导航到**已登记**的页面并等就绪判据；
 *   3. 若档案声明了周期控件，点它（受信任鼠标），等页面重新取数；
 *   4. 逐锚点按**标签文案**读值，解析成统一指标（金额→分，计数→整数）；
 *   5. 汇总状态：全部读到 → SUCCEEDED；部分读到 → PARTIAL；标签全找不到 → PAGE_CHANGED；
 *      标签在但当前没有数值 → NO_METRICS_FOUND（**不写 0**）。
 *
 * 只读语义：除了"点周期控件"和"导航到已登记页面"，不点击任何有副作用的按钮。
 */
import type { PlatformDef } from '@shared/constants/platforms'
import { businessProfileFor, type BizMetricAnchor, type BusinessProfile } from '@shared/constants/business'
import type { SalesMetricsCollectionResult, SalesMetricsSourceType, SalesMetrics, SalesMetricsPeriodType, SalesMetricsEvidenceCheck } from '@shared/contracts/sales-metrics'
import { SALES_METRICS_METRIC_DEFINITION_VERSION, salesMetricsPeriodBounds } from '@shared/sales-metrics-rules'
import type { PlatformLoginResult } from '@shared/contracts/platform-adapter'
import type { PlatformAdapterContext, SalesMetricsCapableAdapter } from './platform-adapter'
import { createLoginResult, LOGIN_DETECTION_ONLY_CAPABILITIES } from './platform-adapter'
import { clickText, navigateTo, parseSalesValue, readLabelValue, waitForUrlMarker, type PageHandle } from './sales-metrics-page-reader'
export interface PlatformLoginProbe {
  /** 允许的 host（精确匹配，不做后缀模糊） */
  host: string
  /** 明确的登录/过期页面文案；命中即 LOGIN_REQUIRED（复用项目已有实测文案） */
  expiredText?: RegExp
  /** 明确的"需要安全验证"文案 */
  verifyText?: RegExp
  /** 登录/验证页路径特征 */
  loginPath?: RegExp
}

export interface DomAdapterOptions {
  profile: BusinessProfile | null
  probe: PlatformLoginProbe
  adapterVersion: string
}

/** 每个锚点的一次读取结果，只用于本次采集的汇总，不落库。 */
interface AnchorReading {
  anchor: BizMetricAnchor
  found: boolean
  raw: string | null
  value: number | null
  reason: string | null
}

function periodBounds(periodType: SalesMetricsPeriodType): { start: number; end: number } {
  return salesMetricsPeriodBounds(periodType)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { const handle = setTimeout(resolve, ms); if (typeof handle.unref === 'function') handle.unref() })
}

/**
 * 内容区"没渲染出来"的判据阈值。
 *
 * 真机实测（2026-09-28）：窗口不在前台时，微信小店（micro-app）与抖店后台的**内容区不渲染**，
 * 页面只剩导航外壳——实测外壳正文 106～109 字符、渲染完整后 2584 字符。
 * 这种情况下周期控件与指标卡片当然都不存在，**不能判成"页面改版"**：页面没改，
 * 只是当时没画出来。所以先量正文长度，短到只有外壳就按"页面未渲染"（可重试）处理。
 */
const SHELL_BODY_TEXT_MAX = 600

export abstract class SalesMetricsDomAdapter implements SalesMetricsCapableAdapter {
  readonly adapterName: string
  readonly adapterVersion: string
  readonly platform: string
  protected readonly profile: BusinessProfile | null
  private readonly probe: PlatformLoginProbe

  constructor(platform: PlatformDef, options: DomAdapterOptions) {
    this.platform = platform.name
    this.adapterName = `${platform.name}SalesMetricsAdapter`
    this.adapterVersion = options.adapterVersion
    this.profile = options.profile
    this.probe = options.probe
  }

  supports(platform: string): boolean { return platform === this.platform }

  getCapabilities() {
    return Object.freeze({ ...LOGIN_DETECTION_ONLY_CAPABILITIES, salesMetrics: true })
  }

  /** 档案固定住的周期；Main 按它请求，避免把 7 天数据标成今天。 */
  getPreferredPeriodType(): SalesMetricsPeriodType {
    return this.profile?.salesPeriodType || 'TODAY'
  }

  /**
   * 登录检测。
   *
   * 正向证据只有两种：① URL 主机属于本平台且没有命中登录/验证文案；② 经营数据锚点
   * 真的渲染出来了（未登录看不到成交金额卡片）。没有证据就返回 UNKNOWN——**绝不返回
   * LOGGED_IN**，否则采集会在一个未登录的页面上读到登录页的其它数字。
   */
  async detectLoginStatus(context: PlatformAdapterContext): Promise<PlatformLoginResult> {
    let url: URL
    try { url = new URL(context.currentUrl) } catch {
      return createLoginResult(context, 'UNKNOWN', 'PAGE_NOT_READY', 'NONE')
    }
    if (url.hostname.toLowerCase() !== this.probe.host) {
      return createLoginResult(context, 'UNKNOWN', 'PAGE_NOT_RECOGNIZED', 'URL')
    }
    if (this.probe.loginPath && this.probe.loginPath.test(url.pathname)) {
      return createLoginResult(context, 'LOGIN_REQUIRED', 'EXPLICIT_LOGIN_PAGE', 'URL')
    }
    const wc = context.webContents
    if (!wc || wc.isDestroyed()) return createLoginResult(context, 'UNKNOWN', 'PAGE_NOT_READY', 'NONE')
    // 正则**在页面里**执行，只把布尔判断带回 Main：页面正文不进主进程内存、不进日志。
    // 这是既有平台适配层一直遵守的约定（`pageTextMatches`），不要图省事改成回传 innerText。
    if (this.probe.verifyText) {
      const verifying = await this.pageTextMatches(wc, this.probe.verifyText)
      if (verifying === true) return createLoginResult(context, 'VERIFY_REQUIRED', 'EXPLICIT_VERIFY_PAGE', 'DOM')
    }
    if (this.probe.expiredText) {
      const expired = await this.pageTextMatches(wc, this.probe.expiredText)
      if (expired === true) return createLoginResult(context, 'LOGIN_REQUIRED', 'EXPLICIT_LOGIN_PAGE', 'DOM')
    }
    return createLoginResult(context, 'UNKNOWN', 'DETECTION_EVIDENCE_INSUFFICIENT', 'DOM')
  }

  /** 在页面内跑正则，只回布尔；页面不可读时返回 null（区别于"不匹配"）。 */
  private async pageTextMatches(wc: PageHandle, pattern: RegExp): Promise<boolean | null> {
    const script = `(() => {
      const text = String(document.body ? document.body.innerText : '');
      const re = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
      return re.test(text);
    })()`
    try {
      const result = await wc.executeJavaScript(script, true)
      if (typeof result === 'boolean') return result
      return result == null ? null : Boolean(result)
    } catch { return null }
  }

  /** 在页面（含 ShadowRoot）里找一段文案，只回布尔；页面不可读时按"没找到"处理。 */
  private async pageHasTextDeep(wc: PageHandle, text: string): Promise<boolean> {
    const script = `(() => {
      const want = ${JSON.stringify(text)};
      if (String(document.body ? document.body.innerText : '').includes(want)) return true;
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (!el.shadowRoot) continue;
          if (String(el.shadowRoot.textContent || '').includes(want)) return true;
          if (walk(el.shadowRoot)) return true;
        }
        return false;
      };
      return walk(document);
    })()`
    try { return (await wc.executeJavaScript(script, true)) === true } catch { return false }
  }

  /** 页面正文长度（只在**页面内**取长度，不把正文带回 Main）。 */
  private async bodyTextLength(wc: PageHandle): Promise<number> {
    try {
      const length = await wc.executeJavaScript('(() => (document.body ? String(document.body.innerText || "").length : 0))()', true)
      return Number.isFinite(Number(length)) ? Number(length) : 0
    } catch { return 0 }
  }

  async collectSalesMetrics(
    context: PlatformAdapterContext,
    options: { periodType: SalesMetricsPeriodType; periodStart?: number; periodEnd?: number; timeoutMs: number }
  ): Promise<SalesMetricsCollectionResult & { storeMetrics?: SalesMetrics[] }> {
    const startedAt = Date.now()
    const profile = this.profile
    const bounds = periodBounds(options.periodType)
    const base: SalesMetricsCollectionResult & { storeMetrics?: SalesMetrics[] } = {
      storeId: context.storeId,
      platform: this.platform,
      status: 'ERROR',
      startedAt,
      finishedAt: startedAt,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      storeMetricsCount: 0,
      productMetricsCount: 0,
      inserted: 0, updated: 0, skipped: 0, failed: 0,
      sourceType: 'NONE',
      reasonCode: 'COLLECTION_FAILED',
      safeMessage: '经营数据采集失败',
      adapterVersion: this.adapterVersion,
      metricDefinitionVersion: SALES_METRICS_METRIC_DEFINITION_VERSION,
      sourceUpdatedAt: null,
      dataStatus: 'COLLECTION_FAILED',
      evidence: null,
      storeMetrics: []
    }
    if (!profile) {
      return { ...base, status: 'DATA_SOURCE_NOT_VERIFIED', reasonCode: 'PAGE_PROFILE_NOT_MEASURED', safeMessage: `${this.platform}经营数据页档案尚未实测，未做任何猜测`, dataStatus: 'SOURCE_UNVERIFIED', finishedAt: Date.now() }
    }
    if (profile.salesPeriodType !== options.periodType) {
      return {
        ...base, status: 'ERROR', reasonCode: 'PERIOD_SEMANTICS_MISMATCH',
        safeMessage: `该页面档案固定的是${profile.salesPeriodType}口径，请求的是${options.periodType}，拒绝按错误口径落库`,
        dataStatus: 'COLLECTION_FAILED', finishedAt: Date.now()
      }
    }
    const wc = context.webContents
    if (!wc || wc.isDestroyed()) {
      return { ...base, status: 'NETWORK_ERROR', reasonCode: 'PAGE_NOT_READY', safeMessage: `请先在店铺浏览器中打开${this.platform}页面`, dataStatus: 'COLLECTION_FAILED', finishedAt: Date.now() }
    }

    // 本次采集的**总预算**：每个阶段都从这里扣，超预算才算超时。
    //
    // 真机实测（2026-09-28）：微信小店的经营数据区整页在 <micro-app> 的 ShadowRoot 里，
    // 冷启时正文要 30 秒以上才渲染出来（连续三次探测的正文长度 107 → 109 → 2584）。
    // 旧实现给"点周期控件"固定 20 秒，于是页面还没渲染完就报 PERIOD_CONTROL_NOT_FOUND，
    // 把一个"慢"误报成"页面改版"。慢和改版必须分开。
    //
    // 下限 5 秒：调用方给再小的预算也要够走完"读一个字段"的最小流程；
    // 上限由调用方决定（调度器给 90 秒），不在这里另设。
    const budgetMs = Math.max(5_000, Number(options.timeoutMs) || 30_000)
    const deadline = startedAt + budgetMs
    const remaining = (): number => Math.max(1_000, deadline - Date.now())

    /**
     * 页面"渲染出来了但结构对不上" vs "内容区根本没画出来"。
     *
     * 前者是页面改版（停机、等重新实测），后者是当时的渲染条件不满足（窗口最小化/被遮挡，
     * 或者页面还在冷启）——那要按可重试的失败处理，而不是把一个健康平台永久停掉。
     * 真机实测：窗口不在前台时微信/抖店的内容区都不渲染，外壳正文只有 106～109 字。
     */
    const structureFailure = async (reasonCode: string, message: string): Promise<SalesMetricsCollectionResult & { storeMetrics?: SalesMetrics[] }> => {
      const length = await this.bodyTextLength(wc)
      if (length < SHELL_BODY_TEXT_MAX) {
        return {
          ...base, status: 'NETWORK_ERROR', reasonCode: 'PAGE_NOT_RENDERED',
          safeMessage: `经营数据页内容区未渲染（正文仅 ${length} 字）——窗口可能被最小化/遮挡，或页面仍在冷启；按可重试失败处理，不判为页面改版`,
          dataStatus: 'COLLECTION_FAILED', finishedAt: Date.now()
        }
      }
      return { ...base, status: 'PAGE_CHANGED', reasonCode, safeMessage: message, dataStatus: 'PAGE_CHANGED', finishedAt: Date.now() }
    }

    // 1. 就位：不在已登记页面才导航（避免每 10 分钟把用户的标签页刷一遍）
    const currentUrl = (() => { try { return String(wc.getURL() || '') } catch { return '' } })()
    if (!currentUrl.includes(profile.urlMarker)) {
      const navigation = await navigateTo(wc, profile.pageUrl, Math.min(remaining(), 60_000))
      if (!navigation.ok) {
        const landed = (() => { try { return String(wc.getURL() || '') } catch { return '' } })()
        if (/login|passport|signin|sso|roles-select/i.test(landed)) {
          return { ...base, status: 'LOGIN_REQUIRED', reasonCode: 'LOGIN_REQUIRED', safeMessage: `${this.platform}登录态已失效，请打开平台页面重新登录`, dataStatus: 'LOGIN_REQUIRED', finishedAt: Date.now() }
        }
        const detail = navigation.errorCode || 'UNKNOWN'
        return {
          ...base,
          status: 'NETWORK_ERROR',
          // 原因码带上 Electron 的 net 错误码：用户看到的是"到底是断网、DNS 还是被拦"，
          // 排障时也不用再问"当时是什么错误"。
          reasonCode: `NAVIGATION_${detail}`,
          safeMessage: navigation.timedOut
            ? `${this.platform}经营数据页加载超时（${detail}）`
            : `无法打开${this.platform}经营数据页（${detail}）`,
          dataStatus: 'COLLECTION_FAILED',
          finishedAt: Date.now()
        }
      }
      const ready = await waitForUrlMarker(wc, profile.urlMarker, Math.min(remaining(), 30_000))
      if (!ready) {
        return { ...base, status: 'NETWORK_ERROR', reasonCode: 'PAGE_NOT_READY', safeMessage: `经营数据页未就绪（等不到「${profile.urlMarker}」）`, dataStatus: 'COLLECTION_FAILED', finishedAt: Date.now() }
      }
    }

    // 2. 固定统计口径：点不到周期控件就**不采**——周期没切成功却按目标周期落库是口径错误。
    //
    // 但"点不到"有两种原因，必须分开对待：页面真的改版了，或者 SPA 还没渲染出来。
    // 真机实测（2026-09-28）微信小店的经营数据区要 30 秒以上才渲染，冷启时控件还不存在。
    // 所以第一次点不到就**重载一次再给一轮机会**，两轮都点不到才判 PAGE_CHANGED。
    if (profile.periodText) {
      const probeAnchor = profile.metrics[0]
      /** 读首个指标的当前原文（用于判断"周期真的切过去了"） */
      const readProbeAnchor = () => readLabelValue(wc, {
        label: probeAnchor.anchorText,
        deep: !!probeAnchor.deep,
        valueMaxLen: probeAnchor.valueMaxLen,
        timeoutMs: Math.min(remaining(), 8_000)
      })
      const beforeClick = await readProbeAnchor()
      let clicked = false
      for (let round = 0; round < 2 && !clicked; round++) {
        clicked = await clickText(wc, { text: profile.periodText, deep: !!profile.periodDeep, timeoutMs: Math.min(remaining(), 30_000) })
        if (clicked) break
        const canRetry = round === 0 && remaining() > 20_000
        if (!canRetry) break
        await navigateTo(wc, profile.pageUrl, Math.min(remaining(), 30_000))
        await waitForUrlMarker(wc, profile.urlMarker, Math.min(remaining(), 20_000))
      }
      if (!clicked) {
        return structureFailure('PERIOD_CONTROL_NOT_FOUND', `页面上点不到周期控件「${profile.periodText}」（重载一次仍未出现）——页面可能已改版，已停采等待重新实测`)
      }
      /**
       * 「点到控件」不等于「周期已生效」。
       *
       * 2026-09-28 实测事故：微信小店那次点击没生效，采集把「今天」视图的 `¥0 / 0 单`
       * 当成「近7天」写进了库（近7天真实值是 `¥108.90 / 11 单`）。把默认周期的数字
       * 标成目标周期，比没有数字更糟，所以点完之后必须**验证**，验不了就不采。
       *
       * 判据（任一成立即可）：
       *   ① 首个指标的值与点击前不同（默认周期与目标周期的数据几乎不会完全相同）；
       *   ② 档案声明的 `periodAppliedText` 出现（微信实测：近7天视图显示「较上周期 X%」，
       *      而默认的「今天」视图显示的是「昨日 X」）。
       */
      const appliedDeadline = Date.now() + Math.min(remaining(), 20_000)
      let applied = false
      for (;;) {
        const afterClick = await readProbeAnchor()
        const valueChanged = afterClick.ok && (!beforeClick.ok || String(afterClick.raw) !== String(beforeClick.raw))
        const markerSeen = !!profile.periodAppliedText && await this.pageHasTextDeep(wc, profile.periodAppliedText)
        if (valueChanged || markerSeen) { applied = true; break }
        if (Date.now() >= appliedDeadline) break
        await delay(700)
      }
      if (!applied) {
        return {
          ...base,
          status: 'ERROR',
          reasonCode: 'PERIOD_NOT_APPLIED',
          safeMessage: `点了周期控件「${profile.periodText}」但页面数值没跟着变（读数仍是「${beforeClick.ok ? String(beforeClick.raw) : '原值'}」）——周期可能没生效，按错误口径落库比没有数字更糟，本次不采集`,
          dataStatus: 'COLLECTION_FAILED',
          finishedAt: Date.now()
        }
      }
      // 等页面按新周期把**其余**卡片也刷完（首个指标已经确认变了）；等待时间不得超过剩余预算，
      // 否则一次采集会超出调度器给的时限（被测/被限速时尤其明显）。
      const settleMs = Math.min(profile.periodSettleMs || 6000, remaining())
      await delay(settleMs)
    }

    // 3. 逐锚点读值
    const readings: AnchorReading[] = []
    for (const anchor of profile.metrics) {
      const read = await readLabelValue(wc, {
        label: anchor.anchorText,
        deep: !!anchor.deep,
        valueMaxLen: anchor.valueMaxLen,
        timeoutMs: Math.min(remaining(), 15_000)
      })
      const parsed = read.ok ? parseSalesValue(read.raw, anchor.salesUnit || 'COUNT') : { ok: false as const, reason: read.reason || 'NO_VALUE' }
      readings.push({
        anchor,
        found: read.ok,
        raw: read.ok ? String(read.raw ?? '') : null,
        value: parsed.ok ? parsed.value : null,
        reason: parsed.ok ? null : parsed.reason
      })
    }

    const foundCount = readings.filter(item => item.found).length
    const valuesPresent = readings.filter(item => item.value != null).length
    // 标签全找不到 → 页面结构变了（旧解析器作废），而不是"没数据"；
    // 但如果内容区压根没渲染（窗口被遮挡/最小化），那不算改版。
    if (foundCount === 0) {
      return structureFailure('EVIDENCE_SHAPE_MISMATCH', `档案里的锚点一个都没命中（${profile.measuredAt} 实测），页面可能已改版，已停采等待重新实测`)
    }
    // 标签在但当前都没数值：平台此刻没有数据 → 不写 0，也不写空行
    if (valuesPresent === 0) {
      return {
        ...base, status: 'NO_METRICS_FOUND', reasonCode: 'PAGE_SHOWS_NO_VALUE',
        safeMessage: '页面上指标当前没有数值（平台未返回数据）——按"未采集"记录，不写 0',
        dataStatus: 'NOT_COLLECTED', sourceType: 'DOM', finishedAt: Date.now()
      }
    }

    const metric = this.buildMetric(context, profile, bounds, readings)
    const complete = foundCount === profile.metrics.length && readings.every(item => item.reason == null)
    const sourceType: SalesMetricsSourceType = 'DOM'
    return {
      ...base,
      status: complete ? 'SUCCEEDED' : 'PARTIAL',
      reasonCode: complete ? 'SALES_METRICS_READ_FROM_PAGE' : 'SALES_METRICS_PARTIAL',
      safeMessage: complete
        ? `已从${this.platform}经营数据页读取指标`
        : `只读到部分指标：${readings.filter(item => item.value == null).map(item => `${item.anchor.anchorText}(${item.reason})`).join('、')}`,
      sourceType,
      storeMetricsCount: 1,
      storeMetrics: [metric],
      dataStatus: complete ? 'REAL_VALUE' : 'PARTIAL',
      finishedAt: Date.now()
    }
  }

  /**
   * 证据自检：只有"至少一个字段有值"才算通过。
   * 结构性问题（锚点全不命中、周期控件失效）在采集阶段就已经返回 PAGE_CHANGED，
   * 这里再挡一道，防止将来有人改动状态映射时把无证据的结果当成功写库。
   */
  verifyEvidence(result: SalesMetricsCollectionResult & { storeMetrics?: SalesMetrics[] }, _context: PlatformAdapterContext): SalesMetricsEvidenceCheck {
    const profile = this.profile
    const metric = result.storeMetrics?.[0]
    const fields = (profile?.metrics || [])
      .filter(anchor => !!anchor.salesField)
      .map(anchor => ({
        field: String(anchor.salesField),
        present: !!metric && metric[anchor.salesField as keyof SalesMetrics] != null,
        sourceType: 'DOM' as SalesMetricsSourceType,
        confidence: 0.9
      }))
    if (!fields.length) {
      return { ok: false, reasonCode: 'EVIDENCE_SHAPE_MISMATCH', safeMessage: '档案没有声明任何统一字段映射', fields }
    }
    const present = fields.filter(field => field.present).length
    if (!present) return { ok: false, reasonCode: 'NO_METRICS_FOUND', safeMessage: '读到的指标没有可落库的字段', fields }
    return { ok: true, reasonCode: 'EVIDENCE_OK', safeMessage: `字段与来源一致（${present}/${fields.length}）`, fields }
  }

  private buildMetric(
    context: PlatformAdapterContext,
    profile: BusinessProfile,
    bounds: { start: number; end: number },
    readings: readonly AnchorReading[]
  ): SalesMetrics {
    const collectedAt = Date.now()
    const fields: Record<string, number | null> = {
      orderCount: null, paidOrderCount: null, salesQuantity: null,
      grossSalesAmountMinor: null, paidSalesAmountMinor: null, refundAmountMinor: null,
      refundOrderCount: null, refundQuantity: null, netSalesAmountMinor: null
    }
    for (const reading of readings) {
      const field = reading.anchor.salesField
      if (!field) continue
      // 同一字段被多个锚点声明时取第一个有值的（档案里目前不会重复声明，这里是防御性规则）
      if (fields[field] == null && reading.value != null) fields[field] = reading.value
    }
    // 净销售额按已写明的口径补算：gross - refund，任一算子缺失则保持 null（不用 0 补齐）
    if (fields.netSalesAmountMinor == null && (fields.grossSalesAmountMinor != null || fields.refundAmountMinor != null)) {
      fields.netSalesAmountMinor = fields.grossSalesAmountMinor != null && fields.refundAmountMinor != null
        ? fields.grossSalesAmountMinor - fields.refundAmountMinor
        : null
    }
    return {
      id: `page-${context.storeId}-${bounds.start}-${bounds.end}`,
      platform: this.platform,
      storeId: context.storeId,
      periodType: profile.salesPeriodType,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      orderCount: fields.orderCount,
      paidOrderCount: fields.paidOrderCount,
      salesQuantity: fields.salesQuantity,
      grossSalesAmountMinor: fields.grossSalesAmountMinor,
      paidSalesAmountMinor: fields.paidSalesAmountMinor,
      refundAmountMinor: fields.refundAmountMinor,
      refundOrderCount: fields.refundOrderCount,
      refundQuantity: fields.refundQuantity,
      netSalesAmountMinor: fields.netSalesAmountMinor,
      collectedAt,
      // 页面没有对外暴露"数据更新时间"时保持 null——不拿采集时刻冒充平台更新时间
      sourceUpdatedAt: null,
      sourceType: 'DOM',
      adapterVersion: this.adapterVersion,
      metricDefinitionVersion: SALES_METRICS_METRIC_DEFINITION_VERSION,
      dataStatus: 'REAL_VALUE',
      runId: null
    }
  }
}

export function profileFor(platform: string): BusinessProfile | null {
  return businessProfileFor(platform)
}
