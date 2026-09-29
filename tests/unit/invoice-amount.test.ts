import { describe, it, expect } from 'vitest'
import { formatInvoiceAmount, invoiceAmountText, parseInvoiceAmount } from '@shared/invoice-amount'

/**
 * 发票金额解析/展示（发票中心合计与 CSV 共用）。
 *
 * 为什么单独钉一遍：合计的口径是"解析不出就**不计入**并如实标出未解析条数"，
 * 把解析失败当 0 加进去会让合计看起来齐全、实际少算——这类错误在界面上完全看不出来。
 */
describe('发票金额解析与展示', () => {
  it('各平台实测的金额写法都能解析（符号/千分位/全角括号等噪音）', () => {
    expect(parseInvoiceAmount('￥14.89')).toBe(14.89)
    expect(parseInvoiceAmount('¥9.49')).toBe(9.49)
    expect(parseInvoiceAmount('2.02')).toBe(2.02)
    expect(parseInvoiceAmount('421.40')).toBe(421.4)
    expect(parseInvoiceAmount('1,234.56')).toBe(1234.56)
    expect(parseInvoiceAmount('金额 128.00 元')).toBe(128)
  })

  it('解析不出的一律返回 null（由调用方决定不计入），绝不返回 0', () => {
    for (const value of ['', '   ', '—', '-', '--', '暂无', null, undefined, {}]) {
      expect(parseInvoiceAmount(value as unknown)).toBeNull()
    }
  })

  it('负数照实解析（退款/冲正类账单会出现）', () => {
    expect(parseInvoiceAmount('-12.50')).toBe(-12.5)
    expect(parseInvoiceAmount('￥-0.01')).toBe(-0.01)
  })

  it('合计文案：有值才带货币符号，一条都没解析出来时给「—」而不是「¥0.00」', () => {
    expect(invoiceAmountText(120.5, true)).toBe('¥120.50')
    expect(invoiceAmountText(0, false)).toBe('—')
    expect(formatInvoiceAmount(120.5)).toBe('120.50')
  })

  it('货币符号必须是 U+00A5（全角「￥」肉眼一样但字符串比较不等）', () => {
    // 2026-09-29 实测踩到：界面用全角、验收脚本期望半角，显示正常但断言恒失败。
    const text = invoiceAmountText(1, true)
    expect(text.codePointAt(0)).toBe(0x00a5)
    expect(text).not.toBe(`￥1.00`)
  })
})
