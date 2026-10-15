/**
 * 涉税报送数据的**按主体统计**（申报的单位是主体，不是店铺）。
 *
 * 为什么必须按主体统计：平台按季度报送的是「**你这个纳税人**」的收入信息，而不是"你这个店"的。
 * 同一家公司开在快手、微信、抖店的三家店，在税务机关眼里是**同一个主体的一份收入**；
 * 只按店铺列，用户得自己拿计算器把几家的净额加起来，很容易漏店或重复计。
 *
 * 归组规则（与 shared/store-license.ts 的营业执照归组同一套思路，代码优先）：
 *   1. 有纳税人识别号的 → 按识别号归组（大小写、空格、连字符都归一）；
 *   2. 没识别号但名称与某个"有识别号的主体"完全相同 → 并进那个主体
 *      （平台偶尔只在部分期间给到识别号）；
 *   3. 没识别号、名称也不匹配 → 按归一化名称归组；
 *   4. 名称与识别号都没有 → `UNKNOWN_TAX_SUBJECT_KEY`（界面显示「未读到主体信息」），
 *      **绝不与任何真实主体合并**——把读不到主体的期间混进某个真实主体，等于替它虚增收入。
 *
 * 金额口径与 constants/tax.ts 一致：解析不出的期间**不计入**合计并单独计数，
 * 绝不当 0 加进去（那会让合计看起来是算过的）。
 */

import { parseInvoiceAmount } from './invoice-amount'
import { taxIncomeFromCells, taxPeriodNetOf } from './tax-income'

/** 未读到主体信息的桶（不是真实主体，界面上单独列，且可被单独筛出来核对） */
export const UNKNOWN_TAX_SUBJECT_KEY = '__unknown__'

/** 界面上这个桶的显示名 */
export const UNKNOWN_TAX_SUBJECT_LABEL = '未读到主体信息'

export interface TaxSubjectCellSource {
  cells?: Record<string, unknown> | null
}

export interface TaxSubjectStoreInput {
  storeId: string
  storeName: string
  platform: string
  /** 店铺里填的营业执照主体名称（用于与平台报送的主体核对） */
  licenseName?: string | null
  /** 店铺里填的统一社会信用代码 */
  licenseNo?: string | null
  sections?: Array<{ items?: TaxSubjectCellSource[] }> | null
}

/** 一条报送期（归属到某个主体下） */
export interface TaxSubjectPeriod {
  storeId: string
  storeName: string
  platform: string
  period: string
  goodsNet: number | null
  serviceNet: number | null
  /** 该期申报口径净额（货物 + 服务）；任一段缺失就是 null */
  netTotal: number | null
  /**
   * 该期的「结算金额」（实测只有微信小店这种不分货物/服务的平台给）。
   * 与 netTotal **分开记**：settleAmount 是不是"收入净额"无从确认，混进去就是替平台改口径。
   */
  settleTotal: number | null
  /** 该期至少有一段解析不出（界面据此提示"这期没算进合计"） */
  incomplete: boolean
  /**
   * 这一期**只给了结算金额**、没有收入净额口径（微信小店）。
   * 与 `incomplete`（真的没解析出来）是两回事：前者是平台口径不同，后者是读失败。
   */
  settleOnly: boolean
  /** 这一期的主体是**从店铺营业执照推来的**（平台页面没给主体信息，如抖店），不是平台说的 */
  subjectFromLicense: boolean
}

/** 该主体与店铺营业执照的核对结论（只针对"填了执照的店"） */
export type TaxSubjectLicenseVerdict = 'match' | 'mismatch' | 'store-empty' | 'unknown'

export interface TaxSubjectGroup {
  /** 归组 key：识别号 / 小写名称 / UNKNOWN_TAX_SUBJECT_KEY */
  key: string
  /** 主体名称（读不到时为空串，由界面写「未读到主体信息」） */
  label: string
  /** 纳税人识别号（该主体里没人给到就是空串） */
  taxNo: string
  storeIds: string[]
  storeNames: string[]
  periods: TaxSubjectPeriod[]
  periodCount: number
  /** 各期货物净额之和；一期都没解析出来就是 null */
  goodsNet: number | null
  serviceNet: number | null
  /** 申报口径合计（货物净额 + 服务净额），解析不出的期不计入 */
  netTotal: number | null
  /** 「结算金额」合计（微信小店口径）；与 netTotal 分开列，不混口径 */
  settleTotal: number | null
  /** 只给结算金额、没有收入净额口径的期数（口径不同，不是读失败） */
  settleOnlyPeriods: number
  /** 没有算进合计的期数（任一段解析不出） */
  incompletePeriods: number
  /** 最早的报送期 / 最新的报送期（按期间文本排序，形如 2025.12.13-12.31） */
  earliest: string
  latest: string
  licenseVerdict: TaxSubjectLicenseVerdict
  /**
   * 主体信息的来源：`platform` = 平台页面自己写的（如快手）；`license` = 页面没给，
   * 用店铺营业执照推的（如抖店）——界面要如实标出来，别让用户以为平台页面上写着这个主体。
   */
  subjectSource: 'platform' | 'license' | 'unknown'
  /** 营业执照与平台报送主体不一致的店铺名（申报前要核对的正是这些） */
  mismatchedStores: string[]
  /** 还没填营业执照的店铺名 */
  unlicensedStores: string[]
}

/** 纳税人识别号归一：去空白/连字符并转大写（与统一社会信用代码同一套归一化） */
export function normalizeTaxSubjectNo(value: unknown): string {
  return String(value ?? '').replace(/[\s-]/g, '').toUpperCase()
}

/** 主体名称归一：去首尾空白 + 内部连续空白压成一个（半角/全角空格都归一） */
export function normalizeTaxSubjectName(value: unknown): string {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 从一条报送期的单元格里取出主体信息 */
export function taxSubjectOf(cells: Record<string, unknown> | null | undefined): { name: string; no: string } {
  return {
    name: normalizeTaxSubjectName(cells?.subject),
    no: normalizeTaxSubjectNo(cells?.taxNo)
  }
}

/**
 * 按主体把各店的报送期归组。
 *
 * 排序：能算出合计的在前（金额大的在前），算不出合计的次之，`未读到主体信息` 永远最后
 * （它是要被清理的桶，不是主角——和营业执照归组里 `未填写` 的处置一致）。
 */
export function groupTaxPeriodsBySubject(stores: readonly TaxSubjectStoreInput[]): TaxSubjectGroup[] {
  type Bucket = TaxSubjectGroup & { _hasAmount: boolean }
  const buckets = new Map<string, Bucket>()
  const keyByName = new Map<string, string>()

  const ensure = (key: string): Bucket => {
    const hit = buckets.get(key)
    if (hit) return hit
    const created: Bucket = {
      key, label: '', taxNo: '', storeIds: [], storeNames: [], periods: [],
      periodCount: 0, goodsNet: null, serviceNet: null, netTotal: null,
      settleTotal: null, settleOnlyPeriods: 0,
      incompletePeriods: 0, earliest: '', latest: '',
      licenseVerdict: 'unknown', mismatchedStores: [], unlicensedStores: [],
      subjectSource: 'unknown',
      _hasAmount: false
    }
    buckets.set(key, created)
    return created
  }

  /** 第一遍：先把有识别号的主体立起来，好让"只有名称"的期间能认领过去 */
  const resolved: Array<{ store: TaxSubjectStoreInput; key: string; name: string; no: string; source: 'platform' | 'license' | 'none'; period: TaxSubjectPeriod }> = []
  for (const store of stores) {
    for (const section of store.sections || []) {
      for (const item of section.items || []) {
        const fromPage = taxSubjectOf(item.cells)
        /**
         * 页面没给主体信息时退回**店铺营业执照**——并打上标记。
         *
         * 为什么需要：实测抖店「涉税信息报送数据」这页**只有金额、没有主体名称/纳税人识别号**
         * （快手那页有）。不给回退的话，抖店的数据只能落进「未读到主体信息」桶，
         * 按主体统计里根本看不到它——而它的主体其实就是这家店的执照。
         *
         * 为什么必须标记：这不是平台说的，是我们自己填的。界面要如实标「主体取自营业执照」，
         * 否则用户会以为平台页面上写着这个主体。
         */
        const pageHasSubject = !!(fromPage.name || fromPage.no)
        const name = fromPage.name || normalizeTaxSubjectName(store.licenseName)
        const no = fromPage.no || normalizeTaxSubjectNo(store.licenseNo)
        const fromLicense = !pageHasSubject && !!(name || no)
        // 主体信息的来源三分：平台页面给的 / 拿执照推的 / 两边都没有（未知桶）
        const source: 'platform' | 'license' | 'none' = pageHasSubject ? 'platform' : (fromLicense ? 'license' : 'none')
        const goods = taxIncomeFromCells(item.cells, 'goods')
        const service = taxIncomeFromCells(item.cells, 'service')
        const netTotal = taxPeriodNetOf(item.cells, goods, service)
        const settleTotal = parseInvoiceAmount(item.cells?.settleTotal)
        const period: TaxSubjectPeriod = {
          storeId: store.storeId,
          storeName: store.storeName,
          platform: store.platform,
          period: String(item.cells?.period ?? '').trim(),
          goodsNet: goods.net,
          serviceNet: service.net,
          netTotal,
          settleTotal,
          // "没算进净额合计"分两种：真的没解析出来（incomplete），
          // 与"这家平台只给结算金额"（settleOnly）——混成一句会让人以为读失败了
          incomplete: netTotal == null && settleTotal == null,
          settleOnly: netTotal == null && settleTotal != null,
          subjectFromLicense: fromLicense
        }
        const key = no || (name ? `name:${name.toLowerCase()}` : UNKNOWN_TAX_SUBJECT_KEY)
        resolved.push({ store, key, name, no, source, period })
        if (no && name && !keyByName.has(name.toLowerCase())) keyByName.set(name.toLowerCase(), no)
      }
    }
  }

  /** 第二遍：只有名称的期间，若同名主体已有识别号 → 并过去（平台偶尔才给识别号） */
  for (const row of resolved) {
    // 归组 key 优先级：识别号 > 认领到已登记识别号的同名主体 > 名称 > 未知桶
    const key = row.no
      ? row.no
      : row.name
        ? (keyByName.get(row.name.toLowerCase()) || `name:${row.name.toLowerCase()}`)
        : UNKNOWN_TAX_SUBJECT_KEY
    const bucket = ensure(key)
    if (row.name && !bucket.label) bucket.label = row.name
    if (row.no && !bucket.taxNo) bucket.taxNo = row.no
    if (!bucket.storeIds.includes(row.store.storeId)) {
      bucket.storeIds.push(row.store.storeId)
      bucket.storeNames.push(row.store.storeName)
    }
    bucket.periods.push(row.period)
    bucket.periodCount++
    if (row.period.incomplete) bucket.incompletePeriods++
    else bucket._hasAmount = true
    if (row.period.settleOnly) bucket.settleOnlyPeriods++
    // 只要有**一期**的主体是平台页面给的，这个主体就算"平台说的"；
    // 全是从执照推来的才标 license；两边都没有的（未知桶）保持 unknown。
    if (row.source === 'platform') bucket.subjectSource = 'platform'
    else if (row.source === 'license' && bucket.subjectSource === 'unknown') bucket.subjectSource = 'license'
    const periodText = row.period.period
    if (periodText) {
      if (!bucket.earliest || periodText < bucket.earliest) bucket.earliest = periodText
      if (!bucket.latest || periodText > bucket.latest) bucket.latest = periodText
    }
  }

  /** 求和 + 营业执照核对（逐店算一次，不按期间重复累加） */
  for (const bucket of buckets.values()) {
    let goods = 0
    let goodsParsed = 0
    let service = 0
    let serviceParsed = 0
    for (const p of bucket.periods) {
      if (p.goodsNet != null) { goods += p.goodsNet; goodsParsed++ }
      if (p.serviceNet != null) { service += p.serviceNet; serviceParsed++ }
    }
    bucket.goodsNet = goodsParsed ? Math.round(goods * 100) / 100 : null
    bucket.serviceNet = serviceParsed ? Math.round(service * 100) / 100 : null
    const totals = bucket.periods.map(p => p.netTotal).filter((v): v is number => v != null)
    bucket.netTotal = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) * 100) / 100 : null
    const settles = bucket.periods.map(p => p.settleTotal).filter((v): v is number => v != null)
    bucket.settleTotal = settles.length ? Math.round(settles.reduce((a, b) => a + b, 0) * 100) / 100 : null

    // 营业执照 vs 平台报送主体：只对"这个主体下面这些店"各判一次
    const seen = new Set<string>()
    for (const store of stores) {
      if (!bucket.storeIds.includes(store.storeId) || seen.has(store.storeId)) continue
      seen.add(store.storeId)
      const licenseNo = normalizeTaxSubjectNo(store.licenseNo)
      const licenseName = normalizeTaxSubjectName(store.licenseName)
      if (!licenseNo && !licenseName) { bucket.unlicensedStores.push(store.storeName); continue }
      const noMatch = !!licenseNo && !!bucket.taxNo && licenseNo === bucket.taxNo
      const nameMatch = !!licenseName && !!bucket.label && licenseName.toLowerCase() === bucket.label.toLowerCase()
      if (noMatch || nameMatch) continue
      bucket.mismatchedStores.push(store.storeName)
    }
    if (bucket.mismatchedStores.length) bucket.licenseVerdict = 'mismatch'
    else if (bucket.unlicensedStores.length) bucket.licenseVerdict = 'store-empty'
    else bucket.licenseVerdict = bucket.taxNo || bucket.label ? 'match' : 'unknown'
  }

  return [...buckets.values()]
    .sort((a, b) => {
      if (a.key === UNKNOWN_TAX_SUBJECT_KEY) return 1
      if (b.key === UNKNOWN_TAX_SUBJECT_KEY) return -1
      // 能算出合计的排前面，再按金额从大到小（申报先看大数）
      if (a._hasAmount !== b._hasAmount) return a._hasAmount ? -1 : 1
      const netA = a.netTotal ?? -1
      const netB = b.netTotal ?? -1
      if (netB !== netA) return netB - netA
      return a.label.localeCompare(b.label, 'zh-CN') || a.taxNo.localeCompare(b.taxNo)
    })
    .map(({ _hasAmount, ...rest }) => rest)
}

/** 所有主体合计（界面顶部的"共 N 个主体 / 净额合计"用；解析不出的不计入） */
export function taxSubjectTotals(groups: readonly TaxSubjectGroup[]): {
  subjects: number; stores: number; periods: number; netTotal: number | null
  settleTotal: number | null; incompletePeriods: number; settleOnlyPeriods: number; mismatched: number
} {
  const storeIds = new Set<string>()
  let periods = 0
  let net = 0
  let parsed = 0
  let settle = 0
  let settleParsed = 0
  let incomplete = 0
  let settleOnly = 0
  let mismatched = 0
  for (const group of groups) {
    for (const id of group.storeIds) storeIds.add(id)
    periods += group.periodCount
    incomplete += group.incompletePeriods
    settleOnly += group.settleOnlyPeriods
    if (group.netTotal != null) { net += group.netTotal; parsed++ }
    if (group.settleTotal != null) { settle += group.settleTotal; settleParsed++ }
    if (group.licenseVerdict === 'mismatch') mismatched++
  }
  return {
    subjects: groups.length,
    stores: storeIds.size,
    periods,
    netTotal: parsed ? Math.round(net * 100) / 100 : null,
    settleTotal: settleParsed ? Math.round(settle * 100) / 100 : null,
    incompletePeriods: incomplete,
    settleOnlyPeriods: settleOnly,
    mismatched
  }
}
