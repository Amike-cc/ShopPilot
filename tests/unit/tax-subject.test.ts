import { describe, it, expect } from 'vitest'
import {
  UNKNOWN_TAX_SUBJECT_KEY, UNKNOWN_TAX_SUBJECT_LABEL,
  groupTaxPeriodsBySubject, normalizeTaxSubjectName, normalizeTaxSubjectNo,
  taxSubjectOf, taxSubjectTotals
} from '../../packages/shared/src/tax-subject'
import type { TaxSubjectStoreInput } from '../../packages/shared/src/tax-subject'

/* 三段式收入文本（形状与真机实测一致，数字是合成的） */
const income = (kind: 'goods' | 'service', amount: number, refund = 0): string => {
  const label = kind === 'goods' ? '销售货物' : '销售服务'
  return `${label}收入金额 (元): ${amount.toFixed(2)} ${label}退款金额 (元): ${refund.toFixed(2)} ${label}收入净额 (元): ${(amount - refund).toFixed(2)}`
}

/**
 * 一条报送期。
 *
 * **服务那一段默认给 0.00**——这是真机的实际形状：平台把「销售货物」和「销售服务」两格都给出来，
 * 只卖货的店服务格是 `0.00` 而不是空。要用"某一段没给"的场景，显式传 `serviceRaw: ''`。
 */
const period = (opts: {
  period: string; subject?: string; taxNo?: string
  goods?: number | null; service?: number | null
  goodsRaw?: string; serviceRaw?: string
  /** 微信小店口径：一格「结算金额」（没有货物/服务分段） */
  settleTotal?: string; refundTotal?: string
}) => ({
  cells: {
    period: opts.period,
    subject: opts.subject ?? '',
    taxNo: opts.taxNo ?? '',
    goodsIncome: opts.goodsRaw ?? (opts.goods == null ? '' : income('goods', opts.goods)),
    serviceIncome: opts.serviceRaw ?? (opts.service === null ? '' : income('service', opts.service ?? 0)),
    ...(opts.settleTotal === undefined ? {} : { settleTotal: opts.settleTotal }),
    ...(opts.refundTotal === undefined ? {} : { refundTotal: opts.refundTotal })
  }
})

const store = (
  id: string, name: string, platform: string, items: unknown[],
  license?: { name?: string; no?: string }
): TaxSubjectStoreInput => ({
  storeId: id, storeName: name, platform,
  licenseName: license?.name ?? null,
  licenseNo: license?.no ?? null,
  sections: [{ items: items as Array<{ cells: Record<string, unknown> }> }]
})

describe('涉税主体归一化', () => {
  it('纳税人识别号归一：去空白/连字符、转大写', () => {
    expect(normalizeTaxSubjectNo(' 9241 1426-ma9kebph6l ')).toBe('92411426MA9KEBPH6L')
    expect(normalizeTaxSubjectNo(null)).toBe('')
    expect(normalizeTaxSubjectNo(undefined)).toBe('')
  })

  it('主体名称归一：去首尾空白、内部连续空白压成一个', () => {
    expect(normalizeTaxSubjectName('  上海　某某  贸易有限公司 ')).toBe('上海 某某 贸易有限公司')
    expect(normalizeTaxSubjectName(null)).toBe('')
  })

  it('从单元格里取主体信息（缺字段不抛）', () => {
    expect(taxSubjectOf({ subject: ' A公司 ', taxNo: '91 31' })).toEqual({ name: 'A公司', no: '9131' })
    expect(taxSubjectOf(null)).toEqual({ name: '', no: '' })
    expect(taxSubjectOf({})).toEqual({ name: '', no: '' })
  })
})

describe('涉税数据按主体统计', () => {
  it('同一识别号的期间跨店合并成一个主体（申报的单位是主体，不是店铺）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', '快手店', '快手小店', [period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 100, service: 10 })],
        { name: '甲公司', no: '9131A' }),
      store('s2', '拼多多店', '拼多多', [period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 200, service: 20 })],
        { name: '甲公司', no: '9131A' })
    ])
    expect(groups.length).toBe(1)
    expect(groups[0].storeIds.sort()).toEqual(['s1', 's2'])
    expect(groups[0].periodCount).toBe(2)
    // 100+10 + 200+20 = 330
    expect(groups[0].netTotal).toBeCloseTo(330)
    expect(groups[0].goodsNet).toBeCloseTo(300)
    expect(groups[0].serviceNet).toBeCloseTo(30)
  })

  it('识别号优先：名称写法不同（空格/大小写）也能归到一起', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A', '快手小店', [period({ period: '2026.01.01-01.31', subject: '某某贸易', taxNo: '9131a', goods: 1 })]),
      store('s2', 'B', '抖店', [period({ period: '2026.02.01-02.28', subject: '某某 贸易', taxNo: '9131A', goods: 2 })])
    ])
    expect(groups.length).toBe(1)
    expect(groups[0].taxNo).toBe('9131A')
    expect(groups[0].periodCount).toBe(2)
  })

  it('只有名称的期间会认领到**有识别号**的同名主体（平台偶尔才给识别号）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A', '快手小店', [
        period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 10 }),
        period({ period: '2026.02.01-02.28', subject: '甲公司', goods: 5 })   // 这一期没有识别号
      ])
    ])
    expect(groups.length).toBe(1)
    expect(groups[0].taxNo).toBe('9131A')
    expect(groups[0].periodCount).toBe(2)
    expect(groups[0].netTotal).toBeCloseTo(15)
  })

  it('名称不同的同名度不够就当两个主体（不做模糊合并）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A', '快手小店', [
        period({ period: '2026.01.01-01.31', subject: '甲公司', goods: 10 }),
        period({ period: '2026.01.01-01.31', subject: '乙公司', goods: 20 })
      ])
    ])
    expect(groups.length).toBe(2)
    expect(groups.map(g => g.label).sort()).toEqual(['乙公司', '甲公司'].sort())
  })

  it('平台页面不给主体时退回店铺执照，并**标记来源**（实测抖店这页只有金额、没有主体）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', '抖店A', '抖店', [period({ period: '2026年第三季度(7-9月)', goods: 1324.88, service: 92.86 })],
        { name: '甲公司', no: '9131A' })
    ])
    expect(groups.length).toBe(1)
    expect(groups[0].label).toBe('甲公司')
    expect(groups[0].taxNo).toBe('9131A')
    expect(groups[0].netTotal).toBeCloseTo(1417.74)
    // 关键：标出来源，界面才不会写成"与执照一致"（那是循环论证）
    expect(groups[0].subjectSource).toBe('license')
    expect(groups[0].periods[0].subjectFromLicense).toBe(true)
  })

  it('平台给了主体就标 platform（哪怕同时也有执照）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A店', '快手小店', [period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 1 })],
        { name: '甲公司', no: '9131A' })
    ])
    expect(groups[0].subjectSource).toBe('platform')
  })

  it('两边都没有 → 仍然是未知桶（不硬塞一个主体）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A店', '抖店', [period({ period: '2026年第三季度(7-9月)', goods: 10 })])
    ])
    expect(groups[0].key).toBe(UNKNOWN_TAX_SUBJECT_KEY)
    expect(groups[0].subjectSource).toBe('unknown')
  })

  it('识别号与名称都没有 → 未知桶，且**绝不**并进真实主体', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A', '快手小店', [
        period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 10 }),
        period({ period: '2026.02.01-02.28', goods: 99 })                    // 这一期主体信息一个字都没读到
      ])
    ])
    expect(groups.length).toBe(2)
    const unknown = groups.find(g => g.key === UNKNOWN_TAX_SUBJECT_KEY)!
    expect(unknown).toBeTruthy()
    expect(unknown.label).toBe('')                    // 界面据此显示 UNKNOWN_TAX_SUBJECT_LABEL
    expect(unknown.periodCount).toBe(1)
    expect(unknown.netTotal).toBeCloseTo(99)
    // 关键：真实主体的合计没被这 99 污染
    expect(groups.find(g => g.key === '9131A')!.netTotal).toBeCloseTo(10)
    expect(UNKNOWN_TAX_SUBJECT_LABEL).toBe('未读到主体信息')
  })

  it('解析不出的期间不计入合计并单独计数（绝不当 0）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A', '快手小店', [
        period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 10, service: 2 }),
        period({ period: '2026.02.01-02.28', subject: '甲公司', taxNo: '9131A', goodsRaw: '—' })  // 读到了行但金额是占位
      ])
    ])
    const g = groups[0]
    expect(g.periodCount).toBe(2)
    expect(g.incompletePeriods).toBe(1)
    expect(g.netTotal).toBeCloseTo(12)                 // 只有第一期进了合计
    expect(g.goodsNet).toBeCloseTo(10)                 // 未解析的那期没当成 0 拉低/抬高
  })

  it('一期都没算出金额 → 合计是 null（不是 0）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A', '快手小店', [period({ period: '2026.01.01-01.31', subject: '甲', taxNo: 'X', goodsRaw: '—' })])
    ])
    expect(groups[0].netTotal).toBeNull()
    expect(groups[0].goodsNet).toBeNull()
    expect(taxSubjectTotals(groups).netTotal).toBeNull()
  })

  it('期间范围按文本取最早/最新', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A', '快手小店', [
        period({ period: '2026.03.01-03.31', subject: '甲', taxNo: 'X', goods: 1 }),
        period({ period: '2025.12.13-12.31', subject: '甲', taxNo: 'X', goods: 1 }),
        period({ period: '2026.01.01-01.31', subject: '甲', taxNo: 'X', goods: 1 })
      ])
    ])
    expect(groups[0].earliest).toBe('2025.12.13-12.31')
    expect(groups[0].latest).toBe('2026.03.01-03.31')
  })

  it('排序：能算合计的在前（金额降序），未知桶永远最后', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A', '快手小店', [
        period({ period: '2026.01.01-01.31', subject: '小额', taxNo: 'S', goods: 1 }),
        period({ period: '2026.01.01-01.31', goods: 999 }),                       // 未知桶，金额最大
        period({ period: '2026.01.01-01.31', subject: '大额', taxNo: 'B', goods: 100 }),
        period({ period: '2026.01.01-01.31', subject: '没金额', taxNo: 'Z', goodsRaw: '—' })
      ])
    ])
    // 未知桶即使金额最大也排最后：它是要被清理的桶，不是"最大的主体"
    expect(groups.map(g => g.key)).toEqual(['B', 'S', 'Z', UNKNOWN_TAX_SUBJECT_KEY])
  })
})

describe('涉税主体与店铺营业执照的核对', () => {
  const items = [period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 1 })]

  it('执照与平台报送主体一致 → match', () => {
    const groups = groupTaxPeriodsBySubject([store('s1', 'A店', '快手小店', items, { name: '甲公司', no: '9131A' })])
    expect(groups[0].licenseVerdict).toBe('match')
    expect(groups[0].mismatchedStores).toEqual([])
    expect(groups[0].unlicensedStores).toEqual([])
  })

  it('只填了名称但一致（无识别号）→ 也算 match', () => {
    const groups = groupTaxPeriodsBySubject([store('s1', 'A店', '快手小店', items, { name: '甲公司' })])
    expect(groups[0].licenseVerdict).toBe('match')
  })

  it('不一致 → mismatch，并列出是哪几家店（申报前要核对的正是这些）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A店', '快手小店', items, { name: '乙公司', no: '9131B' })
    ])
    expect(groups[0].licenseVerdict).toBe('mismatch')
    expect(groups[0].mismatchedStores).toEqual(['A店'])
  })

  it('还没填执照 → store-empty（不是 mismatch，两件事不能混）', () => {
    const groups = groupTaxPeriodsBySubject([store('s1', 'A店', '快手小店', items)])
    expect(groups[0].licenseVerdict).toBe('store-empty')
    expect(groups[0].unlicensedStores).toEqual(['A店'])
    expect(groups[0].mismatchedStores).toEqual([])
  })

  it('逐店只判一次（同一家店多个期间不会重复计进核对结果）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A店', '快手小店', [
        period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 1 }),
        period({ period: '2026.02.01-02.28', subject: '甲公司', taxNo: '9131A', goods: 1 }),
        period({ period: '2026.03.01-03.31', subject: '甲公司', taxNo: '9131A', goods: 1 })
      ], { name: '乙公司', no: '9131B' })
    ])
    expect(groups[0].mismatchedStores).toEqual(['A店'])
    expect(groups[0].licenseVerdict).toBe('mismatch')
  })
})

describe('涉税主体合计', () => {
  it('主体数 / 涉及店铺数 / 期数 / 净额合计 / 未解析期数 / 不一致主体数', () => {
    const groups = groupTaxPeriodsBySubject([
      store('s1', 'A店', '快手小店', [
        period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 100 }),
        period({ period: '2026.01.01-01.31', subject: '乙公司', taxNo: '9131B', goodsRaw: '—' })
      ], { name: '甲公司', no: '9131A' }),
      store('s2', 'B店', '拼多多', [
        period({ period: '2026.01.01-01.31', subject: '甲公司', taxNo: '9131A', goods: 50 })
      ], { name: '别的公司', no: '9131Z' })
    ])
    const totals = taxSubjectTotals(groups)
    expect(totals.subjects).toBe(2)
    expect(totals.stores).toBe(2)
    expect(totals.periods).toBe(3)
    expect(totals.netTotal).toBeCloseTo(150)
    expect(totals.incompletePeriods).toBe(1)
    // **两个**主体各自都有对不上的店，别只想到一个：
    //   · 甲公司（9131A）下挂 A店 + B店，而 B店 的执照填的是「别的公司/9131Z」→ 对不上
    //   · 乙公司（9131B）只挂 A店，而 A店 的执照填的是「甲公司/9131A」→ 也对不上
    // 计数口径 = "有多少个主体需要你去核对"，不是"有多少条不一致记录"。
    expect(totals.mismatched).toBe(2)
  })

  it('一个主体都没有时合计是全零而不是崩', () => {
    expect(taxSubjectTotals([])).toEqual({
      subjects: 0, stores: 0, periods: 0, netTotal: null,
      settleTotal: null, incompletePeriods: 0, settleOnlyPeriods: 0, mismatched: 0
    })
  })

  it('「结算金额」单列合计，**不并进**收入净额合计（微信小店口径不同，不替平台改口径）', () => {
    const groups = groupTaxPeriodsBySubject([
      store('w1', '微信店', '微信小店', [
        period({ period: '2026年第三季度(7-9月)', goodsRaw: '', serviceRaw: '', settleTotal: '¥3,742.20', refundTotal: '¥0.00' }),
        period({ period: '2026年第二季度(4-6月)', goodsRaw: '', serviceRaw: '', settleTotal: '¥138.60', refundTotal: '¥0.00' })
      ], { name: '甲公司', no: '9131A' })
    ])
    const g = groups[0]
    // 没有货物/服务分段 → 收入净额**算不出来**（不是 0）
    expect(g.netTotal).toBeNull()
    expect(g.goodsNet).toBeNull()
    // 但结算金额要单独合计出来，否则这两期在界面上等于丢了
    expect(g.settleTotal).toBeCloseTo(3880.8)
    // 关键区分：这是"口径不同"，不是"读失败"——混成一句会让人以为采集坏了
    expect(g.settleOnlyPeriods).toBe(2)
    expect(g.incompletePeriods).toBe(0)
    const totals = taxSubjectTotals(groups)
    expect(totals.settleTotal).toBeCloseTo(3880.8)
    expect(totals.netTotal).toBeNull()
    expect(totals.settleOnlyPeriods).toBe(2)
    expect(totals.incompletePeriods).toBe(0)
  })

  it('既没有分段也没有结算金额，才算真的「未解析」', () => {
    const groups = groupTaxPeriodsBySubject([
      store('w1', '微信店', '微信小店', [period({ period: '2026年第三季度(7-9月)', goodsRaw: '', serviceRaw: '' })])
    ])
    expect(groups[0].incompletePeriods).toBe(1)
    expect(groups[0].settleOnlyPeriods).toBe(0)
  })
})
