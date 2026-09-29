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
 * 解析金额。解析不出（空 / `—` / `-` / 非数字）返回 **null**，由调用方决定不计入并计数。
 * 允许千分位逗号与负号（退款/冲正类账单实测会出现负数）。
 */
export function parseInvoiceAmount(v: unknown): number | null {
  const s = stripCurrency(v)
  if (!s || s === '—' || s === '-') return null
  const matched = /-?[\d,]+(?:\.\d+)?/.exec(s)
  if (!matched) return null
  const n = Number(matched[0].replace(/,/g, ''))
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
