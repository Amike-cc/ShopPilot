/**
 * 任务引擎 IPC 处理器 - §6.4 / §6.6
 * 所有状态迁移与执行都在 Main，渲染层只能触发白名单动作并订阅事件。
 */

import { familyHandle } from './family-handle'
import { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as TaskStore from '../tasks/task-store'
import * as Runner from '../tasks/task-runner'
import * as Scheduler from '../tasks/scheduler'
import { getOpenStoreIds } from '../browser/window-manager'

function rid(): string { return randomUUID() }
function ok<T>(data: T, requestId: string): IPCResult<T> { return { ok: true, data, requestId } }
function err(code: string, message: string, requestId: string): IPCResult { return { ok: false, error: { code, message }, requestId } }

function taskError(e: any, requestId: string): IPCResult {
  const msg = String(e?.message || e)
  if (msg.includes('TASK_INVALID_STEP') || e?.name === 'ZodError') {
    return err(ERROR_CODES.TASK_INVALID_STEP.code, `步骤不合法：${msg.replace('TASK_INVALID_STEP:', '').trim().slice(0, 300)}`, requestId)
  }
  if (msg.includes('TASK_NOT_FOUND')) return err(ERROR_CODES.TASK_NOT_FOUND.code, '任务或运行记录不存在', requestId)
  if (msg.includes('TASK_BAD_STATE')) {
    // transition 抛的是 "TASK_BAD_STATE: from -> to (reason)"：from/to 是定位"为什么不让做"
    // 的关键上下文（例如 paused 的 run 点"暂停"），此前正则把它们剥掉了，只剩 reason。
    // 改为保留状态上下文，整体截断防超长。
    const m = msg.replace('TASK_BAD_STATE:', '').trim().slice(0, 300)
    const st = m.match(/^(\S+)\s*->\s*(\S+)\s*\((.*)\)\s*$/)
    const friendly = st
      ? `当前状态为「${st[1]}」，不允许该操作（${st[3]}）`
      : (m || '当前任务状态不允许该操作')
    return err(ERROR_CODES.TASK_BAD_STATE.code, friendly, requestId)
  }
  return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
}

const handle = familyHandle('任务')

export function registerTaskHandlers(): void {
  handle(IPC_CHANNELS.TASK_CREATE, async (_e: IpcMainInvokeEvent, input: any): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(TaskStore.createTask(input), requestId)
    } catch (e: any) { return taskError(e, requestId) }
  })

  // 编辑任务定义（部分更新：未传的字段保留原值）。运行中的任务不允许改步骤，
  // task-store 抛 TASK_BAD_STATE（消息里带当前状态与原因），由 taskError 统一转文案。
  handle(IPC_CHANNELS.TASK_UPDATE, async (_e: IpcMainInvokeEvent, input: TaskStore.TaskUpdateInput): Promise<IPCResult> => {
    const requestId = rid()
    try { return ok(TaskStore.updateTask(input), requestId) } catch (e: any) { return taskError(e, requestId) }
  })

  handle(IPC_CHANNELS.TASK_LIST, async (): Promise<IPCResult> => {
    const requestId = rid()
    try { return ok(TaskStore.listTasks(), requestId) } catch (e: any) { return taskError(e, requestId) }
  })

  handle(IPC_CHANNELS.TASK_RUN, async (_e: IpcMainInvokeEvent, input: { taskId: string; storeId?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const res = Runner.enqueueRun(input.taskId, { reason: '手动触发', storeId: input.storeId })
      return ok({ ...res, waitingForStore: !getOpenStoreIds().includes(res.storeId) }, requestId)
    } catch (e: any) { return taskError(e, requestId) }
  })

  handle(IPC_CHANNELS.TASK_PAUSE, async (_e: IpcMainInvokeEvent, input: { runId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try { Runner.pauseRun(input.runId); return ok({ success: true }, requestId) } catch (e: any) { return taskError(e, requestId) }
  })

  // resume 支持两种：continue（从暂停）/ retry（从失败步骤恢复，跳过已完成）
  handle(IPC_CHANNELS.TASK_RESUME, async (_e: IpcMainInvokeEvent, input: { runId: string; mode?: 'continue' | 'retry' }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      if (input.mode === 'retry') Runner.retryRunFromFailed(input.runId)
      else Runner.resumeRun(input.runId)
      return ok({ success: true }, requestId)
    } catch (e: any) { return taskError(e, requestId) }
  })

  handle(IPC_CHANNELS.TASK_CANCEL, async (_e: IpcMainInvokeEvent, input: { runId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try { Runner.cancelRun(input.runId); return ok({ success: true }, requestId) } catch (e: any) { return taskError(e, requestId) }
  })

  handle(IPC_CHANNELS.TASK_CONFIRM, async (_e: IpcMainInvokeEvent, input: { runId: string; approved: boolean }): Promise<IPCResult> => {
    const requestId = rid()
    try { Runner.confirmRun(input.runId, !!input.approved); return ok({ success: true }, requestId) } catch (e: any) { return taskError(e, requestId) }
  })

  handle(IPC_CHANNELS.TASK_RESULTS, async (_e: IpcMainInvokeEvent, input: { runId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const res = TaskStore.getResults(input.runId)
      if (!res) return err(ERROR_CODES.TASK_NOT_FOUND.code, '运行记录不存在', requestId)
      return ok(res, requestId)
    } catch (e: any) { return taskError(e, requestId) }
  })

  handle(IPC_CHANNELS.TASK_DELETE, async (_e: IpcMainInvokeEvent, input: { taskId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const task = TaskStore.getTask(input.taskId)
      if (!task) return err(ERROR_CODES.TASK_NOT_FOUND.code, '任务不存在', requestId)
      const activeRunId = task.latestRun && ['queued', 'running', 'waiting_confirmation', 'paused'].includes(task.latestRun.status)
        ? task.latestRun.id
        : null
      // 运行中的先取消再删（级联删除 runs / step results）
      if (activeRunId) {
        try { Runner.cancelRun(activeRunId, '任务被删除') } catch { /* ignore */ }
      }
      /**
       * B2（2026-10-15 审查）：取消是**协作式**的——running / waiting_confirmation 只置标志，
       * 靠执行循环在下一个检查点感知。以前这里 cancel 后立即 deleteTask 级联删行，在途 run
       * 的下一次写库（insertStepResult）会撞 run_id 外键，把"已执行成功的步骤"误判成失败。
       * 现在：**有界等待运行真正到达终态**（最多 8 秒）再删；等不到就如实拒绝本次删除，
       * 不制造"删了但其实还在跑"的假象（界面会提示稍后重试）。
       */
      if (activeRunId && Runner.listLiveRuns().some(r => r.runId === activeRunId)) {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline && Runner.listLiveRuns().some(r => r.runId === activeRunId)) {
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        if (Runner.listLiveRuns().some(r => r.runId === activeRunId)) {
          return err(ERROR_CODES.TASK_BAD_STATE.code, '运行仍在停止中（可能正停在长等待步骤），请稍等几秒后重试删除', requestId)
        }
      }
      TaskStore.deleteTask(input.taskId)
      return ok({ success: true }, requestId)
    } catch (e: any) { return taskError(e, requestId) }
  })

  // 诊断：立即触发定时任务（与到点触发同路径），便于验收与用户"立即运行一次"
  handle(IPC_CHANNELS.TASK_CREATE_FIRE, async (_e: IpcMainInvokeEvent, input: { taskId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try { return ok(Scheduler.fireNow(input.taskId), requestId) } catch (e: any) { return taskError(e, requestId) }
  })

  // 店铺指标快照 - §5.11（供环境面板/概览页展示巡检聚合指标）
  handle(IPC_CHANNELS.SNAPSHOT_LIST, async (_e: IpcMainInvokeEvent, input: { storeId: string; limit?: number }): Promise<IPCResult> => {
    const requestId = rid()
    try { return ok(TaskStore.listSnapshots(input.storeId, input.limit), requestId) } catch (e: any) { return taskError(e, requestId) }
  })

  Runner.startEngine()
  Scheduler.startScheduler()
}
