/**
 * 涉税报送「收入」单元格的解析与展示（界面与单测共用同一份规则）。
 *
 * 为什么单独成模块：平台把收入做成**三段式文本**塞在一个单元格里
 * （实测快手 2026-10-14）：
 *   `销售货物收入金额 (元): 10183.56 销售货物退款金额 (元): 0.00 销售货物收入净额 (元): 10183.56`
 * 直接把这串文本摊到界面上，用户没法看也没法对账；而申报要看的是**净额**，
 * "收入总额"和"退款"是核对依据——三段都要，而且要各自是数字才能求和/比对。
 *
 * 口径（与 invoice-amount 同一条红线）：**解析不出就是 null**，绝不当 0。
 * 把读不到的退款额当 0 加进去，会让"净额"看起来是算过的——那比不显示更危险。
 */

import { parseInvoiceAmount } from './invoice-amount'

/** 一个收入口径的三段：收入金额 / 退款金额 / 收入净额 */
export interface TaxIncomeBreakdown {
  /** 收入金额（税前口径按平台页面，应用不做换算） */
  amount: number | null
  /** 退款金额 */
  refund: number | null
  /** 收入净额（= 收入金额 − 退款金额，平台自己给的这一项优先） */
  net: number | null
  /** 三段里至少解析出一项（用于区分"确实是 0"与"一个字都没读到"） */
  parsed: boolean
  /**
   * 三段是否自洽（`金额 − 退款 = 净额`，允许 1 分钱的四舍五入）。
   * null = 有段解析不出，没法判断。false = 平台给的三段对不上——申报前正是要被看见的那种事。
   */
  reconciles: boolean | null
}

/** 两种口径的标签（页面原文，含空格与全角括号，必须原样匹配） */
const LABELS = {
  goods: { amount: '销售货物收入金额', refund: '销售货物退款金额', net: '销售货物收入净额' },
  service: { amount: '销售服务收入金额', refund: '销售服务退款金额', net: '销售服务收入净额' }
} as const

export type TaxIncomeKind = keyof typeof LABELS

/** 在整段文本里找 `标签 (元): 数值` 的数值部分；找不到或不是数字 → null */
function pick(text: string, label: string): number | null {
  // 标签与 (元) 之间可能没有空格（平台偶尔改排版），冒号半角/全角都收
  const matched = new RegExp(`${label}\\s*\\(\\s*元\\s*\\)\\s*[:：]\\s*([^\\s]+)`).exec(text)
  if (!matched) return null
  return parseInvoiceAmount(matched[1])
}

/**
 * 解析一个收入单元格。`kind` 决定用「销售货物」还是「销售服务」的标签组。
 *
 * 容错：整段为空 / 只有 `—` → 三段全 null、parsed=false；某一项缺失只影响那一项。
 */
export function parseTaxIncomeCell(value: unknown, kind: TaxIncomeKind): TaxIncomeBreakdown {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  const labels = LABELS[kind]
  const empty: TaxIncomeBreakdown = { amount: null, refund: null, net: null, parsed: false, reconciles: null }
  if (!text) return empty

  const amount = pick(text, labels.amount)
  const refund = pick(text, labels.refund)
  const net = pick(text, labels.net)
  const parsed = amount != null || refund != null || net != null

  let reconciles: boolean | null = null
  if (amount != null && refund != null) {
    const expected = Math.round((amount - refund) * 100) / 100
    if (net != null) reconciles = Math.abs(expected - net) <= 0.01
    else reconciles = null
  }
  return { amount, refund, net, parsed, reconciles }
}

/**
 * 从采集到的单元格里取收入三段——**两种平台形态的统一入口**。
 *
 * 实测两家平台的给法完全不同：
 *  · 快手：三段挤在**一格文本**里（`销售货物收入金额 (元): X 销售货物退款金额 (元): Y 销售货物收入净额 (元): Z`）
 *    → 走 `parseTaxIncomeCell` 拆；
 *  · 抖店：三段是**三列**（`货物收入金额 / 货物退款 / 货物净额` 各自一格）
 *    → 直接逐格解析。
 *
 * 界面与按主体统计都只调这一个函数，免得两处各写一套"哪家平台是哪种形态"的分支
 * （那种分支迟早会漂移，而它决定的是申报要用的金额）。
 */
export function taxIncomeFromCells(
  cells: Record<string, unknown> | null | undefined,
  kind: TaxIncomeKind
): TaxIncomeBreakdown {
  const prefix = kind === 'goods' ? 'goods' : 'service'
  const combined = cells?.[`${prefix}Income`]
  // 形态一：一格三段式文本
  if (combined != null && String(combined).trim() !== '') return parseTaxIncomeCell(combined, kind)
  // 形态二：三列分开给
  const amount = parseInvoiceAmount(cells?.[`${prefix}Amount`])
  const refund = parseInvoiceAmount(cells?.[`${prefix}Refund`])
  const net = parseInvoiceAmount(cells?.[`${prefix}Net`])
  const parsed = amount != null || refund != null || net != null
  let reconciles: boolean | null = null
  if (amount != null && refund != null && net != null) {
    reconciles = Math.abs(Math.round((amount - refund) * 100) / 100 - net) <= 0.01
  }
  return { amount, refund, net, parsed, reconciles }
}

/**
 * 该期的申报口径收入净额——**平台自己给了就用它的**。
 *
 * 实测抖店直接给了一列「收入净额合计」，而快手没有（要拿货物净额 + 服务净额自己加）。
 * 优先用平台给的数，是为了"以平台上报的为准"：我们自己加出来的和它对不上时，
 * 差异本身就是要被看见的事，而不是被我们的加法抹平。
 */
export function taxPeriodNetOf(
  cells: Record<string, unknown> | null | undefined,
  goods: TaxIncomeBreakdown,
  service: TaxIncomeBreakdown
): number | null {
  const given = parseInvoiceAmount(cells?.netTotal)
  if (given != null) return given
  return taxPeriodNetTotal(goods, service)
}

/** 三段展示：两位小数 + 千分位；解析不出返回 `—`（不是 ¥0.00，"没读到"和"就是 0"不是一回事） */
export function taxAmountText(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * 一段期间的「申报口径收入净额」= 货物净额 + 服务净额。
 *
 * 为什么要有它：页面把它们分成两列，而申报时看的是这一期的合计。
 * **任一段解析不出就返回 null**（宁可显示 `—`，也不给一个少算了一半的合计数）。
 */
export function taxPeriodNetTotal(goods: TaxIncomeBreakdown, service: TaxIncomeBreakdown): number | null {
  if (goods.net == null || service.net == null) return null
  return Math.round((goods.net + service.net) * 100) / 100
}
