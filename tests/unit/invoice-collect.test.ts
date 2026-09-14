import { describe, it, expect } from 'vitest'
import {
  INVOICE_COLUMNS, INVOICE_PROFILES, INVOICE_SUPPORTED_PLATFORMS,
  invoiceProfileFor, INVOICE_UNSUPPORTED_NOTE
} from '../../packages/shared/src/constants/invoice'
import { buildInvoiceCollectSteps } from '../../packages/shared/src/invoice-steps'
import { stepInputSchemas } from '../../apps/desktop/src/main/tasks/task-step-schemas'

describe('发票档案（抓取待开票信息用）', () => {
  it('统一列定义稳定（界面表头直接用这份）', () => {
    expect(INVOICE_COLUMNS.map(c => c.key)).toEqual(
      ['id', 'period', 'type', 'amount', 'title', 'taxNo', 'status', 'deadline']
    )
  })

  it('已实测平台都有页地址/就绪判据/表头映射/指标名（缺一项就抓不了）', () => {
    expect(INVOICE_SUPPORTED_PLATFORMS.sort()).toEqual(['微信小店', '抖店', '拼多多', '快手小店'].sort())
    for (const [name, p] of Object.entries(INVOICE_PROFILES)) {
      expect(p.platform, name).toBe(name)
      expect(p.pageUrl).toMatch(/^https:\/\//)
      expect(p.urlMarker.length).toBeGreaterThan(0)
      expect(p.tableSelector.length).toBeGreaterThan(0)
      expect(p.pickByHeader.length).toBeGreaterThan(0)
      expect(p.metric).toBe('invoice.rows')
      expect(p.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // 表头映射的值必须落在统一列里（写错 key 界面会显示不出来）
      const valid = new Set(INVOICE_COLUMNS.map(c => c.key as string))
      for (const [h, k] of Object.entries(p.headerMap)) {
        expect(valid.has(k as string), `${name} 表头「${h}」映射到未知列 ${k}`).toBe(true)
      }
    }
  })

  it('实测地址被钉住（改地址必须同步确认，否则挂在这里）', () => {
    expect(invoiceProfileFor('微信小店')!.pageUrl).toBe('https://store.weixin.qq.com/shop/bill/home')
    expect(invoiceProfileFor('微信小店')!.deep).toBe(true)   // 整页在 ShadowRoot 内
    expect(invoiceProfileFor('拼多多')!.pageUrl).toBe('https://mms.pinduoduo.com/invoice/center')
    expect(invoiceProfileFor('抖店')!.pageUrl).toBe('https://fxg.jinritemai.com/ffa/m-invoice/merchant-invoice')
  })

  it('表头映射用实测的列名（微信 账单号 / 拼多多 订单号 / 抖店 账单名称）', () => {
    expect(Object.keys(invoiceProfileFor('微信小店')!.headerMap)).toEqual(
      expect.arrayContaining(['账单号', '账单日期', '账单类型', '可开金额'])
    )
    expect(Object.keys(invoiceProfileFor('拼多多')!.headerMap)).toEqual(
      expect.arrayContaining(['订单号', '申请时间', '发票金额', '企业税号', '承诺开票时间'])
    )
    expect(Object.keys(invoiceProfileFor('抖店')!.headerMap)).toEqual(
      expect.arrayContaining(['账单名称', '账单类型', '收票方主体', '账单总额'])
    )
  })

  it('快手已实测到发票页（资金 → 给平台开票 → 未开票账单）', () => {
    const ks = invoiceProfileFor('快手小店')!
    expect(ks).toBeTruthy()
    expect(ks.pageUrl).toBe('https://s.kwaixiaodian.com/zone/fund/tax-bill/subsidy')
    expect(ks.urlMarker).toBe('tax-bill/subsidy')
    expect(ks.pickByHeader).toBe('账单编号')
    // 实测表头（含单位后缀，必须按原样写才匹配得上）
    expect(Object.keys(ks.headerMap)).toEqual(
      expect.arrayContaining(['账单编号', '账单月份', '账单类型', '账单金额（元）', '开票主体名称', '阈值生效时间'])
    )
    // 已实测 → 不该再出现在"未支持"说明里
    expect(INVOICE_UNSUPPORTED_NOTE['快手小店']).toBeUndefined()
  })
})

describe('发票采集步骤', () => {
  it('序列：navigate → waitForPage → (可选点页签) → waitMs → readTable(keepRows+pickByHeader)', () => {
    const steps = buildInvoiceCollectSteps(invoiceProfileFor('微信小店')!)
    expect(steps[0].type).toBe('navigate')
    expect(steps[1].type).toBe('waitForPage')
    const read = steps.find(s => s.type === 'readTable')!
    expect(read).toBeTruthy()
    expect(read.input.keepRows).toBe(true)          // 要整表行，不只是行数
    expect(read.input.pickByHeader).toBe('账单号')   // 多张表时挑数据表
    expect(read.input.metric).toBe('invoice.rows')
    expect(read.input.deep).toBe(true)              // 微信整页在 shadow 内
    // 微信默认就在「可开票」页签 → 不该生成点页签的步骤（点了反而会命中同名 DIV）
    expect(invoiceProfileFor('微信小店')!.tabText).toBeUndefined()
    expect(steps.some(s => s.type === 'clickByText')).toBe(false)
    // 末尾就是读表，中间必须有一次 waitMs（等异步取数）
    expect(steps[steps.length - 1].type).toBe('readTable')
    expect(steps.some(s => s.type === 'waitMs')).toBe(true)
  })

  it('拼多多的表头与数据分属两张表 → 步骤里带 mergeHeaderTable', () => {
    const pdd = invoiceProfileFor('拼多多')!
    expect(pdd.mergeHeaderTable).toBe(true)
    const read = buildInvoiceCollectSteps(pdd).find(s => s.type === 'readTable')!
    expect(read.input.mergeHeaderTable).toBe(true)
  })

  it('readTable 新增字段过白名单，多余键仍被拒', () => {
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', metric: 'invoice.rows', keepRows: true, pickByHeader: '账单号', mergeHeaderTable: true, deep: true }).success).toBe(true)
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', keepRows: true, evil: 1 }).success).toBe(false)
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', pickByHeader: 'x'.repeat(61) }).success).toBe(false)
  })
})
