/**
 * 发票中心导出的 CSV 组装（纯函数，主进程与单测共用）。
 *
 * 单独抽出来的原因：导出要弹保存框，端到端脚本没法自动点它，
 * 「CSV 里到底有没有营业执照两列」就只能靠这份纯函数来钉住。
 *
 * 为什么导出也带营业执照：导出的表是拿去**报税/交给代账**的，代账按主体分账，
 * 只有「店铺」这一列他们得再问一遍哪家店属于哪个公司。
 */

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
        其他信息: (it.extras || []).map(x => `${x.label}：${x.value}`).join('；')
      }))
    )
  )
}

/** CSV 单元格转义：含逗号/引号/换行一律加引号，内部引号翻倍（拼多多订单号带换行，实测踩过） */
export function escapeCsvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * 拼成 CSV 文本。带 UTF-8 BOM——否则 Excel 打开中文会乱码（实测过）。
 * 列名取第一行的 key 顺序，所以 `invoiceCsvRows` 决定了列顺序。
 */
export function buildInvoiceCsv(dataRows: Array<Record<string, string>>): string {
  if (!dataRows.length) return '\uFEFF'
  const headers = Object.keys(dataRows[0])
  return '\uFEFF' + [
    headers.join(','),
    ...dataRows.map(r => headers.map(h => escapeCsvCell(r[h])).join(','))
  ].join('\r\n')
}
