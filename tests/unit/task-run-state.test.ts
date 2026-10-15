import { describe, it, expect } from 'vitest'
import {
  TASK_RUN_TRANSITIONS,
  TASK_RUN_STATUSES,
  assertRunTransition,
  isActiveRunStatus,
  isRunTransitionAllowed,
  isTerminalRunStatus,
  progressPhaseForStatus
} from '../../apps/desktop/src/main/tasks/run-state'

/**
 * 任务运行状态机（2026-10-15 审查 P1-1：从 task-runner.ts 抽出的第一块纯逻辑）。
 *
 * 这组断言是"从 4230 行文件里保下来"的回归保护：迁移表、IPC 层依赖的错误格式、
 * 以及进度阶段映射（旧实现对未列举状态按 'started' 兜底）都不允许无声漂移。
 */
describe('任务运行状态机（run-state）', () => {
  it('迁移表覆盖全部 7 个状态，两个终态没有出边', () => {
    expect(Object.keys(TASK_RUN_TRANSITIONS).sort()).toEqual([...TASK_RUN_STATUSES].sort())
    expect(TASK_RUN_TRANSITIONS.succeeded).toEqual([])
    expect(TASK_RUN_TRANSITIONS.cancelled).toEqual([])
  })

  it('A1 修订：failed 可恢复到 queued / running（从失败恢复）；running 不能直接回 queued', () => {
    expect(isRunTransitionAllowed('failed', 'queued')).toBe(true)
    expect(isRunTransitionAllowed('failed', 'running')).toBe(true)
    expect(isRunTransitionAllowed('running', 'queued')).toBe(false)
  })

  it('确认门禁链路：running ↔ waiting_confirmation 双向，waiting_confirmation 可取消、不可直接成功', () => {
    expect(isRunTransitionAllowed('running', 'waiting_confirmation')).toBe(true)
    expect(isRunTransitionAllowed('waiting_confirmation', 'running')).toBe(true)
    expect(isRunTransitionAllowed('waiting_confirmation', 'cancelled')).toBe(true)
    expect(isRunTransitionAllowed('waiting_confirmation', 'succeeded')).toBe(false)
  })

  it('暂停链路：running -> paused -> queued/running；paused 可取消', () => {
    expect(isRunTransitionAllowed('running', 'paused')).toBe(true)
    expect(isRunTransitionAllowed('paused', 'queued')).toBe(true)
    expect(isRunTransitionAllowed('paused', 'running')).toBe(true)
    expect(isRunTransitionAllowed('paused', 'cancelled')).toBe(true)
  })

  it('未知状态一律拒绝迁移（防御脏数据/拼写错误）', () => {
    expect(isRunTransitionAllowed('bogus', 'running')).toBe(false)
    expect(isRunTransitionAllowed('running', 'bogus')).toBe(false)
  })

  it('assertRunTransition 的抛错格式与 IPC 层 taskError 的解析约定一致', () => {
    expect(() => assertRunTransition('succeeded', 'running', '重复启动')).toThrowError(
      'TASK_BAD_STATE: succeeded -> running (重复启动)'
    )
    expect(() => assertRunTransition('queued', 'running', 'ok')).not.toThrow()
  })

  it('isActiveRunStatus：未结束的四种状态为真，终态/未知为假', () => {
    for (const s of ['queued', 'running', 'waiting_confirmation', 'paused']) {
      expect(isActiveRunStatus(s)).toBe(true)
    }
    for (const s of ['succeeded', 'failed', 'cancelled', 'bogus']) {
      expect(isActiveRunStatus(s)).toBe(false)
    }
  })

  it('isTerminalRunStatus：恰为三种终态', () => {
    for (const s of ['succeeded', 'failed', 'cancelled']) expect(isTerminalRunStatus(s)).toBe(true)
    for (const s of ['queued', 'running', 'waiting_confirmation', 'paused']) {
      expect(isTerminalRunStatus(s)).toBe(false)
    }
  })

  it('progressPhaseForStatus：与旧实现逐状态一致（含未列举状态的 started 兜底）', () => {
    expect(progressPhaseForStatus('running')).toBe('started')
    expect(progressPhaseForStatus('succeeded')).toBe('finished')
    expect(progressPhaseForStatus('failed')).toBe('failed')
    expect(progressPhaseForStatus('cancelled')).toBe('finished')
    expect(progressPhaseForStatus('paused')).toBe('paused')
    expect(progressPhaseForStatus('queued')).toBe('queued')
    expect(progressPhaseForStatus('waiting_confirmation')).toBe('started')
    expect(progressPhaseForStatus('bogus')).toBe('started')
  })

  it('迁移表自洽：所有出边指向合法状态且不允许自环', () => {
    for (const [from, tos] of Object.entries(TASK_RUN_TRANSITIONS)) {
      for (const to of tos) {
        expect(TASK_RUN_STATUSES as readonly string[]).toContain(to)
      }
      expect(tos).not.toContain(from)
    }
  })
})
