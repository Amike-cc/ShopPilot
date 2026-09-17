import { describe, expect, it } from 'vitest'
import { INVOICE_COLUMNS } from '@shared/constants/invoice'
import { buildInvoiceCsv, invoiceCsvRows } from '@shared/invoice-csv'

function row(overrides: any = {}) {
  return {
    storeName: '验A店',
    platform: '抖店',
    licenseName: '上海某某贸易有限公司',
    licenseNo: '91310000MA1FL1234X',
    sections: [
      {
        name: '我给平台开票',
        items: [{ cells: { id: '28351275426', amount: '¥14.89' }, extras: [{ label: '账单信息', value: '3笔订单' }] }]
      }
    ],
    ...overrides
  }
}

describe('发票导出 CSV 的行组装', () => {
  it('带「营业执照 / 统一社会信用代码」两列，且排在店铺/平台之后（代账按主体分账要用）', () => {
    const rows = invoiceCsvRows([row()], INVOICE_COLUMNS)
    expect(Object.keys(rows[0]).slice(0, 5)).toEqual(['店铺', '平台', '营业执照', '统一社会信用代码', '开票方向'])
    expect(rows[0]['营业执照']).toBe('上海某某贸易有限公司')
    expect(rows[0]['统一社会信用代码']).toBe('91310000MA1FL1234X')
  })

  it('没填营业执照的店写「未填写」，不是空字符串（留空和"漏导出"看不出区别）', () => {
    const rows = invoiceCsvRows([row({ licenseName: null, licenseNo: null })], INVOICE_COLUMNS)
    expect(rows[0]['营业执照']).toBe('未填写')
    expect(rows[0]['统一社会信用代码']).toBe('')
  })

  it('只填了代码的店，营业执照列显示代码（否则那一行看起来像没填主体）', () => {
    const rows = invoiceCsvRows([row({ licenseName: null })], INVOICE_COLUMNS)
    expect(rows[0]['营业执照']).toBe('91310000MA1FL1234X')
  })

  it('每个方向单独出行，统一列按 INVOICE_COLUMNS 顺序展开，未映射的列进「其他信息」', () => {
    const rows = invoiceCsvRows([row({
      sections: [
        { name: '我给平台开票', items: [{ cells: { id: 'A1', amount: '¥1.00' }, extras: [] }] },
        { name: '平台给我开票', items: [{ cells: { id: 'B1', amount: '¥2.00' }, extras: [{ label: '账期', value: '2026年05月' }] }] }
      ]
    })], INVOICE_COLUMNS)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r['开票方向'])).toEqual(['我给平台开票', '平台给我开票'])
    expect(rows[1]['单号/账单号']).toBe('B1')
    expect(rows[1]['其他信息']).toBe('账期：2026年05月')
  })

  it('没有行时返回空数组（导出侧据此报"没有可导出的数据"）', () => {
    expect(invoiceCsvRows([], INVOICE_COLUMNS)).toEqual([])
    expect(invoiceCsvRows([row({ sections: [] })], INVOICE_COLUMNS)).toEqual([])
  })
})

describe('发票导出 CSV 文本', () => {
  it('带 UTF-8 BOM 与 CRLF 换行（BOM 少一次 Excel 中文乱码，实测踩过）', () => {
    const csv = buildInvoiceCsv(invoiceCsvRows([row()], INVOICE_COLUMNS))
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('\r\n')
    expect(csv.split('\r\n')[0].replace('\uFEFF', '').split(',')[0]).toBe('店铺')
  })

  it('含逗号/引号/换行的值被正确转义（拼多多订单号带换行）', () => {
    const csv = buildInvoiceCsv(invoiceCsvRows([row({
      storeName: '验,A店',
      sections: [{ name: '订单开票', items: [{ cells: { id: '220630-4018\n逾期未开票', amount: '¥1.00' }, extras: [] }] }]
    })], INVOICE_COLUMNS))
    expect(csv).toContain('"验,A店"')
    expect(csv).toContain('"220630-4018\n逾期未开票"')
  })

  it('表头顺序与行组装一致（列顺序由 invoiceCsvRows 决定）', () => {
    const data = invoiceCsvRows([row()], INVOICE_COLUMNS)
    const header = buildInvoiceCsv(data).split('\r\n')[0].replace('\uFEFF', '').split(',')
    expect(header).toEqual(Object.keys(data[0]))
  })
})
