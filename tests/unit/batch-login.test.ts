import { describe, expect, it } from 'vitest'
import { batchLoginStatusLabel, batchLoginSummaryText, summarizeBatchLogin } from '@shared/batch-login'

describe('批量登录检测的展示口径', () => {
  it('六种状态各有中文，未知状态原样保留', () => {
    expect(batchLoginStatusLabel('ONLINE')).toBe('已登录')
    expect(batchLoginStatusLabel('LOGIN_REQUIRED')).toBe('未登录')
    expect(batchLoginStatusLabel('VERIFY_REQUIRED')).toBe('需安全验证')
    expect(batchLoginStatusLabel('UNKNOWN')).toBe('未识别')
    expect(batchLoginStatusLabel('ERROR')).toBe('检测失败')
    expect(batchLoginStatusLabel('SKIPPED')).toBe('未检测')
    expect(batchLoginStatusLabel('WHATEVER')).toBe('WHATEVER')
  })

  it('按状态分类计数，"没拿到证据"单独算，不并进未登录', () => {
    const summary = summarizeBatchLogin([
      { status: 'ONLINE' },
      { status: 'ONLINE' },
      { status: 'LOGIN_REQUIRED' },
      { status: 'UNKNOWN' },
      { status: 'ERROR' },
      { status: 'SKIPPED' }
    ])
    expect(summary).toEqual({ online: 2, needsLogin: 1, verify: 0, unknown: 1, error: 1, skipped: 1, total: 6 })
  })

  it('未知/缺失状态归入"未识别"，不谎报成功或未登录', () => {
    const summary = summarizeBatchLogin([{ status: 'SOMETHING_NEW' }, {}])
    expect(summary.unknown).toBe(2)
    expect(summary.online).toBe(0)
    expect(summary.needsLogin).toBe(0)
  })

  it('汇总文案只追加非零的异常类别', () => {
    expect(batchLoginSummaryText({ online: 3, needsLogin: 0, verify: 0, unknown: 0, error: 0, skipped: 0, total: 3 }))
      .toBe('已登录 3 · 未登录 0')
    expect(batchLoginSummaryText({ online: 1, needsLogin: 2, verify: 1, unknown: 0, error: 0, skipped: 1, total: 5 }))
      .toBe('已登录 1 · 未登录 2 · 需验证 1 · 未检测 1')
  })

  it('空输入给出"没有可检测的店铺"，不是一句 0/0', () => {
    expect(batchLoginSummaryText(summarizeBatchLogin([]))).toBe('没有可检测的店铺')
    expect(summarizeBatchLogin(null).total).toBe(0)
  })
})
