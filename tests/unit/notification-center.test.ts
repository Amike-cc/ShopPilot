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

  it('进行中的任务按状态给 info；等待确认给 warning', () => {
    const items = buildWorkbenchNotifications({
      tasks: [task('a', '巡检', 'running'), task('b', '采集', 'waiting_confirmation'), task('c', '排队', 'queued')],
      now: NOW
    })
    expect(items).toHaveLength(3)
    expect(items.find(item => item.id.startsWith('task:b'))?.tone).toBe('warning')
    expect(items.find(item => item.id.startsWith('task:a'))?.tone).toBe('info')
    expect(items.find(item => item.id.startsWith('task:c'))?.detail).toContain('任务中心')
  })

  it('已结束（succeeded/cancelled）的任务不产生通知', () => {
    const items = buildWorkbenchNotifications({
      tasks: [task('ok', '成功', 'succeeded'), task('cancel', '取消', 'cancelled')],
      now: NOW
    })
    expect(items).toEqual([])
  })

  it('失败任务只在时间窗内通知，旧的失败不挂常驻', () => {
    const recent = buildWorkbenchNotifications({
      tasks: [task('bad', '失败任务', 'failed', { finishedAt: NOW - 1000, statusReason: '页面容器未命中' })],
      now: NOW
    })
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({ tone: 'error', target: 'tasks', detail: '页面容器未命中' })

    const old = buildWorkbenchNotifications({
      tasks: [task('bad', '失败任务', 'failed', { finishedAt: NOW - 48 * 60 * 60 * 1000 })],
      now: NOW
    })
    expect(old).toEqual([])
  })

  it('失败任务最多 3 条（按时间倒序），避免通知被历史失败淹没', () => {
    const tasks = Array.from({ length: 6 }, (_, i) => task(`f${i}`, `失败${i}`, 'failed', { finishedAt: NOW - i * 1000 }))
    const items = buildWorkbenchNotifications({ tasks, now: NOW })
    expect(items.filter(item => item.kind === 'task_failed')).toHaveLength(3)
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

  it('按严重程度排序（error → warning → info），总数最多 8 条', () => {
    const tasks = [
      ...Array.from({ length: 6 }, (_, i) => task(`run${i}`, `运行${i}`, 'running')),
      task('wait', '等待', 'waiting_confirmation'),
      task('bad', '失败', 'failed', { finishedAt: NOW - 10 })
    ]
    const items = buildWorkbenchNotifications({ tasks, customerUnread: 2, now: NOW })
    expect(items).toHaveLength(8)
    expect(items[0].tone).toBe('error')
    expect(items[1].tone).toBe('warning')
  })
})
