/**
 * 发票金额解析与展示（发票中心的合计与 CSV 共用同一份规则）。
 *
 * 为什么单独成模块：各平台金额是**带符号的字符串**（实测：`￥14.89` / `￥9.49` / `2.02` /
 * `421.40` / `-` / `—`），而合计必须"解析不出就不计入，并且如实标出未解析条数"——
 * 绝不把解析失败当 0 加进去（那会让合计看起来齐全、实际少算）。
 * 解析规则以前写在旧 WorkbenchView 里，界面重制后新页面要用同一套，抽到这里免得两份实现漂移。
 */

/** 去掉平台常见的货币符号与空白；不改变数字串本身 */
function stripCurrency(v: unknown): string {
  return String(v ?? '').replace(/[￥¥$€\s]/g, '')
}

/**
 * 已知的"金额前缀词"：单元格里常写成「金额 128.00 元」。
 * 只剥这几个**已知**的词，不做通用的"取第一段数字"——那正是 P2-10 要挡的形态。
 */
const AMOUNT_PREFIX_RE = /^(?:金额|合计|可开金额|可开票金额|待开票金额|账单金额|发票金额)/

/**
 * 解析金额。解析不出（空 / `—` / `-` / 非数字）返回 **null**，由调用方决定不计入并计数。
 * 允许千分位逗号与负号（退款/冲正类账单实测会出现负数）。
 *
 * P2-10（2026-10-14）：以前是"从任意位置抠出第一段数字"（`/-?[\d,]+(\.\d+)?/.exec`），
 * 于是「2 笔订单」会被解析成 **2.00**、「订单号 2000000038930468」会变成一个天文数字——
 * 金额列一旦改版/串列，合计就会静默变错。现在只认"**整串就是一个金额**"
 * （允许货币符号、已知金额前缀词、千分位、末尾「元」），别的形态一律 null（由界面如实标"未解析"）。
 */
export function parseInvoiceAmount(v: unknown): number | null {
  const s = stripCurrency(v).replace(AMOUNT_PREFIX_RE, '')
  if (!s || s === '—' || s === '-' || s === '--') return null
  const matched = /^(-?[\d,]+(?:\.\d+)?)(?:元)?$/.exec(s)
  if (!matched) return null
  const raw = matched[1]
  // 逗号必须是正常千分位（123,456.78）；"1,2,3" 这类脏值直接判未解析，别让 Number 悄悄吃掉
  if (raw.includes(',') && !/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) return null
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** 合计展示：两位小数 + 千分位（不带货币符号，符号由调用方拼，便于 '—' 兜底） */
export function formatInvoiceAmount(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 合计文案：没有任何可解析金额时返回 '—'，而不是 '¥0.00'（"没数据"和"金额是 0"不是一回事） */
export function invoiceAmountText(total: number, hasAny: boolean): string {
  // 货币符号统一用 **¥（U+00A5）**：全角「￥（U+FFE5）」与本字符**看起来一模一样**，
  // 但字符串比较不等——验收脚本、KPI 卡片（DashboardView 的 formatMoneyCompact）用的都是 U+00A5，
  // 这里若写成全角，界面照常显示、断言却永远失败（2026-09-29 实测踩到，两个字符肉眼无法区分）。
  return hasAny ? `¥${formatInvoiceAmount(total)}` : '—'
}
