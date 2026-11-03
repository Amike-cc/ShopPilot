import { describe, expect, it } from 'vitest'
import { deriveStatus } from '../../apps/desktop/src/main/services/invite-status'

/**
 * 批次状态推导（2026-10-25 重构）。
 * 这些断言直接对应审查里发现的三类失真：
 *   · waiting_confirmation 被落成 failed；
 *   · assist 流只发 2/10 却报 completed；
 *   · 停止码不全（TASK_DAREN_* 不在白名单）。
 */
describe('达人邀约批次状态推导', () => {
  it('等待人工确认 → waiting，不是失败', () => {
    expect(deriveStatus('running', 'waiting_confirmation', null)).toBe('waiting')
  })

  it('运行中/排队 → running；暂停 → paused；取消 → stopped', () => {
    expect(deriveStatus('ready', 'queued', null)).toBe('running')
    expect(deriveStatus('ready', 'running', null)).toBe('running')
    expect(deriveStatus('running', 'paused', null)).toBe('paused')
    expect(deriveStatus('running', 'cancelled', null)).toBe('stopped')
  })

  it('成功但没有发够计划量 → exhausted（不再假报已完成）', () => {
    expect(deriveStatus('running', 'succeeded', null, { sent: 2 }, 10)).toBe('exhausted')
  })

  it('成功且发够计划量 → completed', () => {
    expect(deriveStatus('running', 'succeeded', null, { sent: 10 }, 10)).toBe('completed')
  })

  it('非达成型停止码优先于发送量判断', () => {
    for (const code of ['TASK_QUOTA_EXCEEDED', 'TASK_DAREN_ALREADY_INVITED', 'TASK_DAREN_NOT_INVITABLE', 'TASK_SEND_PARTIAL', 'TASK_DOU_DIAN_PAGE_VISITED']) {
      expect(deriveStatus('running', 'succeeded', code, { sent: 999 }, 999)).toBe('exhausted')
    }
  })

  it('没有邀约 loop 的自定义任务：成功即 completed，不按"记录 0 条"判 exhausted', () => {
    expect(deriveStatus('running', 'succeeded', null, { sent: 0 }, 5, false)).toBe('completed')
  })

  it('scheduled 在尚未入队时保留，不退回 ready', () => {
    expect(deriveStatus('scheduled', null, null)).toBe('scheduled')
  })

  it('未知 run 状态按 failed（不猜）', () => {
    expect(deriveStatus('running', 'something_new', null)).toBe('failed')
  })
})
