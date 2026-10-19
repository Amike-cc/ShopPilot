import { describe, it, expect } from 'vitest'
import { buildWorkbenchNotifications } from '../../apps/desktop/src/renderer/src/features/workbench/notification-center'

const NOW = 1_800_000_000_000

function task(id: string, name: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, name, latestRun: { id: `run_${id}`, status, ...extra } }
}

describe('工作台通知中心：只把真实状态映射成通知', () => {
  it('没有任务、没有未读 → 空数组（界面显示暂无通知）', () => {
    expect(buildWorkbenchNotifications({ tasks: [], customerUnread: 0, now: NOW })).toEqual([])
  })

  it('非达人邀约任务不再生成通知，达人邀约按状态给 info；等待确认给 warning', () => {
    const items = buildWorkbenchNotifications({
      tasks: [
        task('hidden', '巡检', 'running'),
        { ...task('invite-wait', '达人邀约 · 抖店', 'waiting_confirmation'), kind: 'creator_invite' },
        { ...task('invite-run', '达人邀约 · 抖店', 'running'), kind: 'creator_invite' }
      ],
      now: NOW
    })
    expect(items).toHaveLength(2)
    expect(items.find(item => item.id.startsWith('invite:invite-wait'))?.tone).toBe('warning')
    expect(items.find(item => item.id.startsWith('invite:invite-run'))?.tone).toBe('info')
    expect(items.every(item => item.target === 'creator-invite')).toBe(true)
  })

  it('已结束（succeeded/cancelled）的任务不产生通知', () => {
    const items = buildWorkbenchNotifications({
      tasks: [task('ok', '成功', 'succeeded'), task('cancel', '取消', 'cancelled')],
      now: NOW
    })
    expect(items).toEqual([])
  })

  it('达人邀约失败只在时间窗内通知，普通任务失败不挂常驻', () => {
    const recent = buildWorkbenchNotifications({
      tasks: [
        task('hidden', '普通失败任务', 'failed', { finishedAt: NOW - 1000 }),
        { ...task('bad', '达人邀约 · 抖店', 'failed', { finishedAt: NOW - 1000, statusReason: '页面容器未命中' }), kind: 'creator_invite' }
      ],
      now: NOW
    })
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({ tone: 'error', target: 'creator-invite', detail: '页面容器未命中' })

    const old = buildWorkbenchNotifications({
      tasks: [task('bad', '失败任务', 'failed', { finishedAt: NOW - 48 * 60 * 60 * 1000 })],
      now: NOW
    })
    expect(old).toEqual([])
  })

  it('失败任务最多 3 条（按时间倒序），避免通知被历史失败淹没', () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({ ...task(`f${i}`, `达人邀约 · 失败${i}`, 'failed', { finishedAt: NOW - i * 1000 }), kind: 'creator_invite' }))
    const items = buildWorkbenchNotifications({ tasks, now: NOW })
    expect(items.filter(item => item.kind === 'invite_failed')).toHaveLength(3)
    expect(items[0].title).toContain('失败0')
  })

  it('客服未读生成一条可跳转通知，99+ 截断', () => {
    const one = buildWorkbenchNotifications({ tasks: [], customerUnread: 3, now: NOW })
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ kind: 'customer_unread', target: 'customer-service', tone: 'warning' })
    expect(one[0].title).toContain('3')

    const many = buildWorkbenchNotifications({ tasks: [], customerUnread: 120, now: NOW })
    expect(many[0].title).toContain('99+')
    expect(buildWorkbenchNotifications({ tasks: [], customerUnread: -2, now: NOW })).toEqual([])
  })

  it('达人邀约：进行中/失败/已结束都带 creator-invite 深链，额度用尽按 warning 提示', () => {
    const invite = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: '达人邀约 · 抖店 · 美妆 · 最多 40 位',
      kind: 'creator_invite',
      latestRun: { id: `run_${id}`, status, ...extra }
    })
    const items = buildWorkbenchNotifications({
      tasks: [
        invite('live', 'running', { startedAt: NOW - 100 }),
        invite('bad', 'failed', { finishedAt: NOW - 200, statusReason: 'TASK_SELECTOR_CHANGED: 选择器失配' }),
        invite('done', 'succeeded', { finishedAt: NOW - 300, statusReason: '达人邀约结束：平台额度用尽，完成 3 轮' })
      ],
      now: NOW
    })
    expect(items.every(item => item.target === 'creator-invite')).toBe(true)
    expect(items.map(item => item.kind)).toEqual(expect.arrayContaining(['invite_active', 'invite_failed', 'invite_finished']))
    expect(items.find(item => item.kind === 'invite_finished')?.tone).toBe('warning')
    expect(items.find(item => item.kind === 'invite_active')?.title).toContain('达人邀约「抖店 · 美妆')
    expect(items.find(item => item.kind === 'invite_failed')?.detail).toContain('选择器失配')
  })

  it('按严重程度排序（error → warning → info），总数最多 8 条', () => {
    const tasks = [
      ...Array.from({ length: 6 }, (_, i) => ({ ...task(`run${i}`, `达人邀约 · 运行${i}`, 'running'), kind: 'creator_invite' })),
      { ...task('wait', '达人邀约 · 等待', 'waiting_confirmation'), kind: 'creator_invite' },
      { ...task('bad', '达人邀约 · 失败', 'failed', { finishedAt: NOW - 10 }), kind: 'creator_invite' }
    ]
    const items = buildWorkbenchNotifications({ tasks, customerUnread: 2, now: NOW })
    expect(items).toHaveLength(8)
    expect(items[0].tone).toBe('error')
    expect(items[1].tone).toBe('warning')
  })
})
