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
import { clickText, navigateTo, parseSalesValue, readLabelValue, readPeriodControlState, waitForUrlMarker, type LabelReadAttempt, type PageHandle } from './sales-metrics-page-reader'
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

/** 一次采集里"某一个统计口径"的一轮：主口径 + 档案声明的附加口径。 */
interface PeriodPassPlan {
  /** 只允许档案能声明的那四种口径（CUSTOM 走外部区间，不走这条路） */
  periodType: BusinessProfile['salesPeriodType']
  /** 该口径要点的周期控件文案；没有（如首页卡片只有今日）就整轮跳过点击 */
  controlText?: string
  appliedText?: string
  deep?: boolean
  settleMs?: number
  /** 主口径失败 = 整次采集失败；附加口径失败 = 部分成功 */
  primary: boolean
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
    // 请求的口径必须是档案声明过的（主口径或附加口径）：没声明就拒绝，防止"随便点个页签
    // 就把它的数字当目标口径"。附加口径只由本次采集自己按顺序补采，不接受外部指定。
    const declaredPeriods: Array<BusinessProfile['salesPeriodType']> = [profile.salesPeriodType, ...(profile.extraPeriods || []).map(extra => extra.periodType)]
    if (!declaredPeriods.includes(options.periodType as BusinessProfile['salesPeriodType'])) {
      return {
        ...base, status: 'ERROR', reasonCode: 'PERIOD_SEMANTICS_MISMATCH',
        safeMessage: `该页面档案登记的口径是 ${declaredPeriods.join('/')}，请求的是${options.periodType}，拒绝按错误口径落库`,
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
     * 是否补采附加口径：**进门时按预算一次性决定**，而不是看"还剩多少"。
     *
     * 为什么这么定：附加口径是"顺带采"的（每个都要点页签 + 验证 + 等重取数 + 读锚点，
     * 微信小店单个口径约 10 秒）。预算本来就小的调用方（例如只想快速读一次主口径）不该被
     * 拖进多口径；而真实路径的预算都够（调度器 120 秒、手动"立即采集"60 秒）。
     * 用"剩余时间"判断会让同一个调用方在不同机器负载下时采时不采，反而更难解释。
     */
    const collectExtras = budgetMs >= 45_000 && (profile.extraPeriods || []).length > 0

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
      // 冷启动的 SPA 后台页需要更久才把地址落到位：实测拼多多在"刚启动、页面是自动打开"的那条
      // 路径上 30 秒没等到 /home（人工导航同一地址 4 秒就到），于是被判 PAGE_NOT_READY 白跑一轮。
      // 页面上真有值却因为加载慢被当成"未就绪"，属于把"慢"误报成"坏"——放宽到 45 秒，
      // 总预算仍是 90 秒，真的起不来仍会如实报 PAGE_NOT_READY。
      const ready = await waitForUrlMarker(wc, profile.urlMarker, Math.min(remaining(), 45_000))
      if (!ready) {
        return { ...base, status: 'NETWORK_ERROR', reasonCode: 'PAGE_NOT_READY', safeMessage: `经营数据页未就绪（等不到「${profile.urlMarker}」）`, dataStatus: 'COLLECTION_FAILED', finishedAt: Date.now() }
      }
    }

    // 2 + 3. 逐口径采集：主口径先采，档案声明的附加口径（同页其它周期控件）依次补采。
    //
    // 为什么要有附加口径：各平台只暴露一种固定窗口（抖店/拼多多「今日实时」、快手/微信「近 7 天」），
    // 总览每个页签就总有一半平台空白。把同页**实测点得动、切过去数值确实变**的其它周期也采下来
    // （每个口径独立验证、独立落一行），页签之间才有得比。
    const plans: PeriodPassPlan[] = [
      {
        periodType: profile.salesPeriodType,
        controlText: profile.periodText,
        appliedText: profile.periodAppliedText,
        deep: profile.periodDeep,
        settleMs: profile.periodSettleMs,
        primary: true
      },
      ...(collectExtras ? (profile.extraPeriods || []).map(extra => ({
        periodType: extra.periodType,
        controlText: extra.controlText,
        appliedText: extra.appliedText,
        deep: extra.deep ?? profile.periodDeep,
        settleMs: extra.settleMs ?? profile.periodSettleMs,
        primary: false
      })) : [])
    ]

    const storeMetrics: SalesMetrics[] = []
    const passNotes: string[] = []
    if (!collectExtras && (profile.extraPeriods || []).length) {
      // 预算不够就只采主口径：这是调用方的选择，不算失败，但要在记录里写清楚没采哪些口径。
      passNotes.push(`附加口径未采（预算 ${Math.round(budgetMs / 1000)}s < 45s）：${(profile.extraPeriods || []).map(item => item.periodType).join('/')}`)
    }
    let periodEvidence = ''   // 主口径凭什么算生效（写进运行记录供事后核对）
    let primaryFailure: { status: SalesMetricsCollectionResult['status']; reasonCode: string; safeMessage: string; dataStatus: string } | null = null
    let allComplete = true
    let extrasAttempted = false

    for (const plan of plans) {
      if (!plan.primary) extrasAttempted = true
      const pass = await this.collectPeriodPass({ wc, context, profile, plan, remaining })
      if (!pass.ok) {
        if (plan.primary) {
          primaryFailure = { status: pass.status, reasonCode: pass.reasonCode, safeMessage: pass.safeMessage, dataStatus: pass.dataStatus }
        } else {
          passNotes.push(`${plan.periodType}(${pass.reasonCode})`)
          allComplete = false
        }
        continue
      }
      storeMetrics.push(pass.metric)
      if (plan.primary) periodEvidence = pass.evidence
      if (!pass.complete) {
        allComplete = false
        passNotes.push(`${plan.periodType}部分字段：${pass.missing.join('、')}`)
      }
      if (plan.primary) continue
      passNotes.push(`${plan.periodType}判据：${pass.evidence}`)
    }

    if (primaryFailure) {
      return { ...base, ...primaryFailure, status: primaryFailure.status as SalesMetricsCollectionResult['status'], dataStatus: primaryFailure.dataStatus as SalesMetricsCollectionResult['dataStatus'], finishedAt: Date.now() }
    }
    const complete = allComplete && storeMetrics.length === plans.length
    // "预算不够所以没采附加口径"写在成功消息里（不算失败，但记录里必须看得见没采哪些口径）
    const skippedNote = !extrasAttempted && passNotes.length ? `（${passNotes.join('；')}）` : ''
    return {
      ...base,
      status: complete ? 'SUCCEEDED' : 'PARTIAL',
      reasonCode: complete ? 'SALES_METRICS_READ_FROM_PAGE' : 'SALES_METRICS_PARTIAL',
      safeMessage: complete
        // 把"周期凭什么算生效"写进运行记录：事后排查"这条 7 天数据是不是今天的"时，
        // 光有 SUCCEEDED 不够，得知道当时满足的是哪条判据。
        ? `已从${this.platform}经营数据页读取 ${storeMetrics.length} 个口径的指标${periodEvidence ? `（主口径判据：${periodEvidence}）` : ''}${skippedNote}`
        : `部分口径/字段未取到：${passNotes.join('；')}`,
      sourceType: 'DOM',
      storeMetricsCount: storeMetrics.length,
      storeMetrics,
      dataStatus: complete ? 'REAL_VALUE' : 'PARTIAL',
      finishedAt: Date.now()
    }
  }

  /**
   * 单个口径的一轮：可选地点周期控件（并验证真的生效）→ 按锚点读值 → 生成该口径的指标行。
   *
   * 失败**不抛异常**，把可诊断的原因码交回调用方：主口径失败 = 整次采集失败，
   * 附加口径失败 = 部分成功（其它口径的数据照旧落库，并在 safeMessage 里如实列出谁没成）。
   */
  private async collectPeriodPass(input: {
    wc: PageHandle
    context: PlatformAdapterContext
    profile: BusinessProfile
    plan: PeriodPassPlan
    remaining: () => number
  }): Promise<
    | { ok: true; metric: SalesMetrics; evidence: string; complete: boolean; missing: string[] }
    | { ok: false; status: SalesMetricsCollectionResult['status']; reasonCode: string; safeMessage: string; dataStatus: string }
  > {
    const { wc, context, profile, plan, remaining } = input
    const bounds = periodBounds(plan.periodType)
    let evidence = ''

    if (plan.controlText) {
      const probeAnchor = profile.metrics[0]
      const readProbeAnchor = (): Promise<LabelReadAttempt> => readLabelValue(wc, {
        label: probeAnchor.anchorText,
        deep: !!probeAnchor.deep,
        valueMaxLen: probeAnchor.valueMaxLen,
        timeoutMs: Math.min(remaining(), 8_000)
      })
      const beforeClick = await readProbeAnchor()
      // 页面可能**本来就停在目标周期**（SPA 记住上次选择）：这时点同一个页签不会改变任何东西，
      // 只靠"值变了/文案变了"会把这种情况判成失败。先读一次控件自身的选中态作为基线。
      const periodStateBefore = await readPeriodControlState(wc, {
        text: plan.controlText,
        deep: !!plan.deep,
        timeoutMs: Math.min(remaining(), 4_000)
      })
      let clicked = false
      for (let round = 0; round < 2 && !clicked; round++) {
        // 附加口径是"顺带采"的：点不到就快点放弃，别把 30 秒预算烧在一个可选页签上
        // （单测里这一点很直观：一个点不到的附加控件会让整轮多等 30 秒）。
        clicked = await clickText(wc, { text: plan.controlText, deep: !!plan.deep, timeoutMs: Math.min(remaining(), plan.primary ? 30_000 : 8_000) })
        if (clicked) break
        // 只有主口径值得"重载一次再来"：附加口径点不到就直接放弃，别把预算烧在重载上
        const canRetry = round === 0 && plan.primary && remaining() > 20_000
        if (!canRetry) break
        await navigateTo(wc, profile.pageUrl, Math.min(remaining(), 30_000))
        await waitForUrlMarker(wc, profile.urlMarker, Math.min(remaining(), 20_000))
      }
      if (!clicked) {
        const length = await this.bodyTextLength(wc)
        if (plan.primary && length < SHELL_BODY_TEXT_MAX) {
          return { ok: false, status: 'NETWORK_ERROR', reasonCode: 'PAGE_NOT_RENDERED', safeMessage: `经营数据页内容区未渲染（正文仅 ${length} 字）——窗口可能被最小化/遮挡，或页面仍在冷启；按可重试失败处理，不判为页面改版`, dataStatus: 'COLLECTION_FAILED' }
        }
        return { ok: false, status: plan.primary ? 'PAGE_CHANGED' : 'ERROR', reasonCode: 'PERIOD_CONTROL_NOT_FOUND', safeMessage: `页面上点不到周期控件「${plan.controlText}」（重载一次仍未出现）——页面可能已改版，已停采等待重新实测`, dataStatus: plan.primary ? 'PAGE_CHANGED' : 'COLLECTION_FAILED' }
      }
      const appliedDeadline = Date.now() + Math.min(remaining(), 20_000)
      let applied = false
      if (periodStateBefore.selected) { applied = true; evidence = 'BASE_SELECTED' }
      for (;;) {
        if (applied) break
        const afterClick = await readProbeAnchor()
        const valueChanged = afterClick.ok && (!beforeClick.ok || String(afterClick.raw) !== String(beforeClick.raw))
        const markerSeen = !!plan.appliedText && await this.pageHasTextDeep(wc, plan.appliedText)
        const periodState = await readPeriodControlState(wc, { text: plan.controlText, deep: !!plan.deep, timeoutMs: Math.min(remaining(), 4_000) })
        if (valueChanged) { applied = true; evidence = 'VALUE_CHANGED' }
        else if (markerSeen) { applied = true; evidence = 'MARKER' }
        else if (periodState.selected) { applied = true; evidence = 'CONTROL_SELECTED' }
        if (applied) break
        if (Date.now() >= appliedDeadline) break
        await delay(700)
      }
      if (!applied) {
        return {
          ok: false,
          status: plan.primary ? 'ERROR' : 'PARTIAL',
          reasonCode: 'PERIOD_NOT_APPLIED',
          safeMessage: `点了周期控件「${plan.controlText}」但页面数值没跟着变（读数仍是「${beforeClick.ok ? String(beforeClick.raw) : '原值'}」），控件自身也没显示该周期已被选中——周期可能没生效，按错误口径落库比没有数字更糟，本次不采集`,
          dataStatus: plan.primary ? 'COLLECTION_FAILED' : 'PARTIAL'
        }
      }
      // 等页面按新周期把**其余**卡片也刷完（首个指标已经确认变了）；等待时间不得超过剩余预算，
      // 否则一次采集会超出调度器给到的时限（被测/被限速时尤其明显）。
      await delay(Math.min(plan.settleMs || 6000, remaining()))
    }

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
      const length = await this.bodyTextLength(wc)
      if (length < SHELL_BODY_TEXT_MAX) {
        return { ok: false, status: 'NETWORK_ERROR', reasonCode: 'PAGE_NOT_RENDERED', safeMessage: `经营数据页内容区未渲染（正文仅 ${length} 字）——窗口可能被最小化/遮挡，或页面仍在冷启；按可重试失败处理，不判为页面改版`, dataStatus: 'COLLECTION_FAILED' }
      }
      return { ok: false, status: plan.primary ? 'PAGE_CHANGED' : 'PARTIAL', reasonCode: 'EVIDENCE_SHAPE_MISMATCH', safeMessage: `档案里的锚点一个都没命中（${profile.measuredAt} 实测），页面可能已改版，已停采等待重新实测`, dataStatus: plan.primary ? 'PAGE_CHANGED' : 'PARTIAL' }
    }
    // 标签在但当前都没数值：平台此刻没有数据 → 不写 0，也不写空行
    if (valuesPresent === 0) {
      return { ok: false, status: 'NO_METRICS_FOUND', reasonCode: 'PAGE_SHOWS_NO_VALUE', safeMessage: `「${plan.periodType}」口径下页面上指标当前没有数值（平台未返回数据）——按"未采集"记录，不写 0`, dataStatus: 'NOT_COLLECTED' }
    }

    const metric = this.buildMetric(context, profile, bounds, readings, plan.periodType)
    const missing = readings.filter(item => item.value == null).map(item => `${item.anchor.anchorText}(${item.reason})`)
    return { ok: true, metric, evidence, complete: foundCount === profile.metrics.length && readings.every(item => item.reason == null), missing }
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
    readings: readonly AnchorReading[],
    periodType: SalesMetricsPeriodType
  ): SalesMetrics {
    const collectedAt = Date.now()
    const fields: Record<string, number | null> = {
      orderCount: null, paidOrderCount: null, salesQuantity: null,
      grossSalesAmountMinor: null, paidSalesAmountMinor: null, refundAmountMinor: null,
      refundOrderCount: null, refundQuantity: null, netSalesAmountMinor: null, adSpendMinor: null
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
      periodType,
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
      adSpendMinor: fields.adSpendMinor,
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
