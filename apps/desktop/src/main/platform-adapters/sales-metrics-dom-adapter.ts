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
import { clickNextPage, readProductImages, readProductTable, waitForProductListReady } from './product-page-reader'
import { productProfileFor, type ProductProfile } from '@shared/constants/product'
import { logMain } from '../services/logger'
import { mapProductRows } from '@shared/product-rules'
import type {
  PlatformProduct,
  PlatformProductCollectionOptions,
  PlatformProductCollectionResult
} from '@shared/contracts/platform-product'

/** 翻页之间的等待：给平台留余量，也避免连续请求触发风控（方案 §5.4 的限速口径）。 */
const PRODUCT_PAGE_DELAY_MS = 1200
/** 表格比数据行先渲染：读到 0 行时的重试次数与间隔（实测各平台都需要等一次重新渲染）。
 *  12 次 × 1.2s ≈ 14s：四平台验收里出现过"7s 还不够"的情况（微信/快手都碰到过），
 *  但即使等满仍为 0 行也不会破坏数据（0 行按不完整轮次处理，见 collectProducts）。 */
const EMPTY_ROWS_RETRY = 12
const EMPTY_ROWS_RETRY_DELAY_MS = 1200

export interface PlatformLoginProbe {
  /**
   * 允许的 host，**精确匹配（不做后缀模糊）**。
   *
   * 为什么是列表而不是单个字符串：同一家平台的商家后台常由多个域名承载。实测 2026-09-30：
   * 快手小店的店铺平时停在 `https://s.kwaixiaodian.com/zone/home`（页面标题「快手小店」，
   * 页面上有店铺名/商户 ID/商家后台导航），而经营数据档案页在 `syt.kwaixiaodian.com`——
   * 只登记一个域名时，停在另一个域名上的店铺永远返回 `PAGE_NOT_RECOGNIZED`，
   * 于是"登录成功了，界面还一直显示离线"（这正是本轮实测复现的故障）。
   */
  hosts: readonly string[]
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

  /**
   * 能力位只描述**真实实现边界**（方案 §5.2 的纪律：声明了就必须真的能采）：
   * `products` 为真 ⟺ 这个平台登记了**真机实测过**的商品档案。
   * 没实测过的平台不许点亮，否则界面会给出一个点了没用的「同步」按钮。
   */
  getCapabilities() {
    return Object.freeze({
      ...LOGIN_DETECTION_ONLY_CAPABILITIES,
      salesMetrics: true,
      products: productProfileFor(this.platform) !== null
    })
  }

  /** 商品档案（未实测登记的平台为 null）。 */
  protected get productProfile(): ProductProfile | null {
    return productProfileFor(this.platform)
  }

  /** 档案固定住的周期；Main 按它请求，避免把 7 天数据标成今天。 */
  getPreferredPeriodType(): SalesMetricsPeriodType {
    return this.profile?.salesPeriodType || 'TODAY'
  }

  /**
   * 登录检测。证据分两类，**明确证据优先**：
   *   ① 否定证据（页面自己说没登录）：命中 loginPath / verifyText / expiredText
   *      → LOGIN_REQUIRED / VERIFY_REQUIRED；
   *   ② 肯定证据：档案里登记的**经营数据锚点真的渲染出来了**（未登录时平台挡在登录页/
   *      选角色页，那些页面不会有成交金额这类卡片）→ LOGGED_IN。
   *
   * 两类都不成立 → UNKNOWN：**不猜**。只凭"主机对得上"绝不返回 LOGGED_IN（未登录时平台
   * 同样会在这个主机上给出登录页），"当前页恰好不是档案页"也同样是 UNKNOWN——
   * 这两种情况由调用方按"没拿到证据"处理，不得据此断言离线。
   */
  async detectLoginStatus(context: PlatformAdapterContext): Promise<PlatformLoginResult> {
    let url: URL
    try { url = new URL(context.currentUrl) } catch {
      return createLoginResult(context, 'UNKNOWN', 'PAGE_NOT_READY', 'NONE')
    }
    if (!this.probe.hosts.includes(url.hostname.toLowerCase())) {
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
    // 正向证据：档案里登记的经营数据锚点**真的渲染出来了**（见 anyProfileAnchorRendered 的说明）。
    // 放在最后：明确的登录页/验证页证据优先，不能被"页面上恰好有同名字样"翻过来。
    if (await this.anyProfileAnchorRendered(wc)) {
      return createLoginResult(context, 'LOGGED_IN', 'PROFILE_ANCHOR_RENDERED', 'DOM')
    }
    // 第二条正向证据：**商品列表页**的表格真的渲染出来了。
    // 为什么需要它：经营数据锚点只存在于后台**首页**，而商品同步会把店铺标签页导航到商品列表页
    // 并留在那里 —— 重启后再打开该店，`openStoreBrowser` 先置 OFFLINE，随后在列表页上拿不到任何
    // 正向证据 → 一个明明登录着、页面上还摆着商品的店铺一直显示离线（2026-09-30 真机截图抓到）。
    // 判据同样是"实测过的 DOM 渲染"（未登录会跳到登录页，那种页面渲染不出商品表格），不是新猜的选择器。
    if (await this.productListRendered(wc, context.currentUrl)) {
      return createLoginResult(context, 'LOGGED_IN', 'PROFILE_ANCHOR_RENDERED', 'DOM')
    }
    return createLoginResult(context, 'UNKNOWN', 'DETECTION_EVIDENCE_INSUFFICIENT', 'DOM')
  }

  /**
   * 商品列表页是否已渲染（第二条正向证据）。
   *
   * 只在"当前地址确实是这个平台已登记的商品列表页"时才判断，避免把"某个恰好有表格的页面"当证据；
   * 且必须等表格真的可见（`waitForProductListReady` 同时校验 urlMarker 与表格可见性）。
   */
  protected async productListRendered(wc: PageHandle, currentUrl: string): Promise<boolean> {
    const profile = this.productProfile
    if (!profile) return false
    const url = String(currentUrl || '')
    // 用 path 前缀比对，忽略查询串与末尾斜杠
    let path = ''
    try { path = new URL(url).pathname } catch { return false }
    let expected = ''
    try { expected = new URL(profile.listUrl).pathname } catch { return false }
    if (!expected || !path.startsWith(expected.replace(/\/$/, ''))) return false
    return waitForProductListReady(wc, profile, 2_500)
  }

  /**
   * 正向证据：档案里登记的**经营数据锚点**真的渲染在页面上 → 已登录。
   *
   * 为什么"锚点在"就能证明登录：这些锚点就是采集要读的指标卡片（成交金额 / 成交订单数 /
   * 退款金额…）。未登录时平台把访问挡在登录页或选角色页，那种页面根本不会渲染这些卡片——
   * 而它们已被上面的 loginPath / verifyText / expiredText 判据拦走（明确证据优先）。
   *
   * 为什么只判文案在不在、不去读值：登录检测只回答"这个页面能不能用"，
   * 值对不对是采集阶段的事；读值要轮询、要处理周期控件，放进检测既慢又容易假阴性。
   *
   * 这不是"猜"：锚点来自 BUSINESS_PROFILES 的**实测档案**，档案没登记的平台
   * （profile 为 null）直接返回 false，仍然只能落到 UNKNOWN。
   *
   * 2026-09-30 修复：此前这个方法不存在，`detectLoginStatus` 只有"登录页/验证页"这些
   * **否定**证据，正常页面一律落到 UNKNOWN；而全项目唯一把店铺置为 online 的路径就是
   * 本方法所在函数返回 LOGGED_IN —— 于是"登录成功了，界面还一直显示离线"。
   */
  private async anyProfileAnchorRendered(wc: PageHandle): Promise<boolean> {
    const anchors = this.profile?.metrics || []
    for (const anchor of anchors) {
      if (await this.pageHasTextDeep(wc, anchor.anchorText)) return true
    }
    return false
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

  /**
   * 采集商品列表（商品管理方案 §5.3）。
   *
   * 这一份实现是**档案驱动**的，四个平台共用：差异全部在 `ProductProfile` 里
   * （地址、表头/列序、是否穿透 ShadowRoot、翻页文案、总数文案），代码里不写平台分支。
   *
   * 失败一律**如实分类**，绝不返回半真半假的数据：
   *   · 打开后跳到登录页 → LOGIN_REQUIRED（命中各平台已实测的登录/过期文案）；
   *   · 表头整体对不上 / 读不到表格 → PAGE_CHANGED，上层**不得写任何数据**；
   *   · 达上限截断 → hasMore=true，界面必须如实说"还有更多"。
   *
   * 只读语义：只导航、只点「下一页」，不点任何有副作用的按钮。
   */
  async collectProducts(
    context: PlatformAdapterContext,
    options: PlatformProductCollectionOptions
  ): Promise<PlatformProductCollectionResult> {
    const empty = (
      status: PlatformProductCollectionResult['status'],
      reasonCode: string,
      safeMessage: string
    ): PlatformProductCollectionResult => ({
      status, products: [], fetchedCount: 0, skippedCount: 0, pageCount: 0, hasMore: false, reasonCode, safeMessage
    })

    const profile = this.productProfile
    if (!profile) {
      return empty('DATA_SOURCE_NOT_VERIFIED', 'PRODUCT_PROFILE_MISSING', '该平台尚未实测到商品列表，暂不能同步')
    }
    const wc = context.webContents
    if (!wc || wc.isDestroyed()) {
      return empty('FAILED', 'PAGE_NOT_READY', '店铺页面不可用，请先打开店铺浏览器')
    }

    const startedAt = Date.now()
    const products: PlatformProduct[] = []
    let pageCount = 0
    let skippedCount = 0
    let hasMore = false
    let totalOnPage: number | null = null
    /** 累计读到的数据行数（含没有 ID 被跳过的）——收尾时拿它与页面自报条数对账 */
    let rowCount = 0

    for (let page = 1; page <= Math.max(1, options.maxPages); page++) {
      if (page === 1) {
        const nav = await navigateTo(wc, profile.listUrl, Math.min(options.timeoutMs, 30000))
        if (!nav.ok) {
          return empty('FAILED', nav.timedOut ? 'NAVIGATION_TIMEOUT' : 'NAVIGATION_FAILED',
            '打开商品列表页失败，请确认已登录该店铺')
        }
      }

      const ready = await waitForProductListReady(wc, profile, Math.min(30_000, options.timeoutMs))
      if (!ready) {
        // 先排除"其实是登录页"：命中已实测的登录/过期文案就如实报 LOGIN_REQUIRED，
        // 而不是笼统地说"平台改版"（页面没就绪有两种可能，必须让用户看出是哪一种）。
        if (await this.pageLooksLikeLogin(wc)) {
          return empty('LOGIN_REQUIRED', 'LOGIN_PAGE', '打开商品列表页跳到了登录页，请在店铺浏览器里登录后再同步')
        }
        if (page === 1) {
          return empty('PAGE_CHANGED', 'PAGE_NOT_READY',
            `没有等到商品列表页就绪（未出现「${profile.urlMarker}」且表格未渲染），平台可能已改版`)
        }
        hasMore = true
        break
      }

      // 表格比数据行先渲染（实测）：拿到"表格可见"之后仍可能 0 行，等一会儿再读。
      let read = await readProductTable(wc, profile)
      for (let attempt = 1; attempt <= EMPTY_ROWS_RETRY && read.ok && read.rows.length === 0; attempt++) {
        await delay(EMPTY_ROWS_RETRY_DELAY_MS)
        read = await readProductTable(wc, profile)
      }
      if (read.ok && read.rows.length === 0) {
        // 读到 0 行要留痕：把"页面上有几张表、各多少行"记进日志，
        // 下次再出现"同步成功但 0 件"时能一眼看出是选错了表还是这家店真没商品。
        logMain('warn', `[product-collect] 读到 0 行 platform=${this.platform} url=${String(context.currentUrl || '').slice(0, 80)} tables=${JSON.stringify(read.diagnostics ?? [])}`)
      }
      if (!read.ok) {
        if (page === 1) {
          // 读不到表格有两种可能，**两种都要说**。状态一律 PAGE_CHANGED（= 不写任何数据）是**故意的
          // fail-closed**：页面读不到时若按"0 个商品"落库，完整轮次会把该店已有商品全部标成 missing。
          return empty('PAGE_CHANGED', read.reason === 'TABLE_NOT_FOUND' ? 'PRODUCT_TABLE_NOT_FOUND' : 'PAGE_READ_FAILED',
            '页面上没有读到商品表格（可能是这家店确实 0 个商品，也可能平台已改版）——本次未写入任何数据，请打开店铺后台确认一次')
        }
        hasMore = true
        break
      }

      const mapped = mapProductRows(profile, read.headers, read.rows)
      if (mapped.headerMismatch) {
        // 表头一条都没对上 → 平台改版。**绝不硬套列**（错位的库存会被当成价格写进库）
        return empty('PAGE_CHANGED', 'HEADERS_CHANGED',
          `商品列表表头与登记的不一致（缺：${mapped.missingHeaders.join('、')}），平台可能已改版（本次未写入任何数据）`)
      }
      pageCount += 1
      rowCount += mapped.rows.length
      if (read.total != null) totalOnPage = read.total
      logMain('info', `[product-collect] page=${page} rows=${read.rows.length} mapped=${mapped.rows.length} products=${products.length} headers=${JSON.stringify(read.headers).slice(0, 140)} total=${String(read.total)} tables=${JSON.stringify(read.diagnostics ?? [])}`)

      // ⚠️ 读到 **0 行**时必须 fail-closed（2026-09-30 四平台验收抓到的数据破坏性缺陷）：
      // 页面刚打开时表格可能是"已渲染但还没填数据"的中间态（实测：微信/快手都会出现，
      // 同一秒读到的「共0条」在几秒后变成「共4条」）。若把它当成完整轮次，
      // 下游的 markMissing 会把**该店已有的商品全部标成 missing** —— 数据被自己的同步破坏。
      // 所以：0 行一律按"不完整轮次"处理（hasMore=true → 上层不标 missing），并如实说明两种可能。
      if (mapped.rows.length === 0) {
        logMain('warn', `[product-collect] 读到 0 行，按不完整轮次处理 platform=${this.platform} tables=${JSON.stringify(read.diagnostics ?? [])} total=${String(read.total)}`)
        return {
          status: 'SUCCEEDED',
          products,
          fetchedCount: products.length,
          skippedCount,
          pageCount,
          hasMore: true,
          reasonCode: 'EMPTY_TABLE',
          safeMessage: '这次没有读到商品行（可能是这家店确实 0 个商品，也可能是页面还没渲染完）——本次不会改动已有数据，请再同步一次或打开店铺后台确认'
        }
      }

      // 图片：列表页只有缩略图，按行取不到精确归属，这里只给"这一屏的第一张"，不硬凑整组
      const pageImages = await readProductImages(wc, profile)

      for (const row of mapped.rows) {
        if (products.length >= options.maxProducts) { hasMore = true; break }
        if (!row.platformProductId) { skippedCount += 1; continue }
        products.push({
          platformProductId: row.platformProductId,
          title: row.title,
          subtitle: row.subtitle,
          status: row.status,
          priceMinor: row.priceMinor,
          stock: row.stock,
          categoryPath: row.categoryPath,
          imageUrls: pageImages.slice(0, 1),
          skus: row.skus,
          platformUpdatedAt: row.platformUpdatedAt,
          rawRow: row.rawRow
        })
      }

      if (products.length >= options.maxProducts) { hasMore = true; break }
      if (Date.now() - startedAt >= options.timeoutMs) { hasMore = true; break }
      if (!read.nextEnabled) break                       // 最后一页
      const clicked = await clickNextPage(wc, profile)
      if (!clicked) break
      await delay(PRODUCT_PAGE_DELAY_MS)
    }

    const totalText = totalOnPage == null ? '' : `（页面显示共 ${totalOnPage} 条）`

    // ⚠️ 收尾对账：**页面自报的条数必须与读到的行数一致**，否则按"页面还没渲染完"处理。
    // 2026-09-30 四平台验收实测到的形态：快手的列表在冷启动时会短暂处于
    // 「只有 1 行骨架 + 自报共0条」的中间态 —— 只判"0 行"挡不住它（1 行假数据就绕过去了），
    // 那一轮被当成完整轮次，把该店已有 4 个商品全标成了 missing。
    // 判据用页面自己给的数字，比任何启发式都可靠；不一致时 hasMore=true → 上层不标 missing。
    const incompleteRender = totalOnPage != null && rowCount !== totalOnPage
    if (incompleteRender) {
      logMain('warn', `[product-collect] 条数对不上，按未渲染完处理 platform=${this.platform} 页面自报=${String(totalOnPage)} 读到=${rowCount} 页数=${pageCount}`)
      return {
        status: 'SUCCEEDED',
        products,
        fetchedCount: products.length,
        skippedCount,
        pageCount,
        hasMore: true,
        reasonCode: 'INCOMPLETE_RENDER',
        safeMessage: `页面显示共 ${totalOnPage} 条，但只读到 ${rowCount} 行 —— 页面可能还没渲染完，本次不改动已有数据，请再同步一次`
      }
    }

    return {
      status: 'SUCCEEDED',
      products,
      fetchedCount: products.length,
      skippedCount,
      pageCount,
      hasMore,
      reasonCode: hasMore ? 'TRUNCATED' : 'OK',
      safeMessage: hasMore
        ? `本次只同步了前 ${products.length} 件${totalText}，还有更多`
        : `已同步 ${products.length} 件${totalText}`
    }
  }

  /**
   * 页面是不是登录/过期页。判据是各平台**已实测的登录文案**（`probe.expiredText`），不是新猜的选择器；
   * 微信小店整页在 ShadowRoot 内（实测 body.innerText 只有 160 字），所以文本要穿透 shadowRoot 收集。
   */
  protected async pageLooksLikeLogin(wc: PageHandle): Promise<boolean> {
    const pattern = this.probe.expiredText
    if (!pattern || wc.isDestroyed()) return false
    const code = `(() => {
      const parts = [String(document.title || '')];
      const roots = [document];
      for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) roots.push(el.shadowRoot) }
      for (const root of roots) {
        let text = '';
        try { text = String(root.innerText || '') } catch { text = '' }
        if (text) parts.push(text);
        if (parts.join(' ').length > 20000) break;
      }
      return ${pattern}.test(parts.join(' '));
    })()`
    try {
      return (await wc.executeJavaScript(code, false)) === true
    } catch {
      return false
    }
  }
}

export function profileFor(platform: string): BusinessProfile | null {
  return businessProfileFor(platform)
}
