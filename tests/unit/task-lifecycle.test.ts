import { describe, expect, it } from 'vitest'
import { findActiveRunForTask } from '../../apps/desktop/src/main/tasks/task-runner'

describe('任务生命周期防护', () => {
  it('同一任务存在未结束运行时拒绝重复启动', () => {
    for (const status of ['queued', 'running', 'waiting_confirmation', 'paused']) {
      expect(findActiveRunForTask([
        { taskId: 'task_other', status: 'running' },
        { taskId: 'task_1', status }
      ], 'task_1')?.status).toBe(status)
    }
  })

  it('终态运行不会阻止同一任务再次启动', () => {
    for (const status of ['succeeded', 'failed', 'cancelled']) {
      expect(findActiveRunForTask([{ taskId: 'task_1', status }], 'task_1')).toBeNull()
    }
  })

  it('其他任务的运行不影响当前任务', () => {
    expect(findActiveRunForTask([
      { taskId: 'task_other', status: 'running' },
      { taskId: 'task_1', status: 'succeeded' }
    ], 'task_1')).toBeNull()
  })
})
