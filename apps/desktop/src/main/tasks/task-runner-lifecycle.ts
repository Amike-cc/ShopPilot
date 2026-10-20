/**
 * 运行生命周期：状态迁移（task_runs 的唯一漏斗）、进度事件、借用页面终态归还、
 * 错误码分类别名（2026-10-19 P1 重构：由 task-runner.ts 等价搬迁，实现逐字保留）。
 */

import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import type { TaskProgressEvent } from '@shared/schemas/task'
import { assertRunTransition, isActiveRunStatus, isTerminalRunStatus, progressPhaseForStatus } from './run-state'
import { classifyTaskError } from './error-classifier'
import { logMain } from '../services/logger'
import { emitToRenderer, setStoreTaskActivity } from '../browser/window-manager'
import { getTaskKindDefinition } from './task-kinds'
import * as TaskStore from './task-store'
import { FAILED_HANDLE_KEEP, failedHandles, live } from './task-runner-registry'
import type { RunHandle } from './task-runner-registry'

/** 未结束运行状态：同一任务只能存在一个，避免重复点击/定时叠加造成真实副作用重复执行。 */
export function findActiveRunForTask(
  runs: Iterable<{ taskId: string; status: string }>,
  taskId: string
): { taskId: string; status: string } | null {
  for (const run of runs) {
    if (run.taskId === taskId && isActiveRunStatus(run.status)) {
      return run
    }
  }
  return null
}

/** §9.2 任务状态机（含 A1 修订的失败恢复迁移）：迁移表与断言已抽到 run-state.ts（P1-1，可单测） */


// ---------- 状态迁移 ----------


export function forgetRun(runId: string): void {
  const fi = failedHandles.indexOf(runId)
  if (fi >= 0) failedHandles.splice(fi, 1)
  live.delete(runId)
}

export function transition(run: RunHandle, to: string, reason: string): void {
  assertRunTransition(run.status, to, reason)
  const from = run.status
  const fields: Parameters<typeof TaskStore.updateRun>[1] = { status: to, statusReason: reason }
  if (to === 'running' && !run.startedOnce) fields.startedAt = Date.now()
  if (isTerminalRunStatus(to)) fields.finishedAt = Date.now()
  // P2-7（2026-10-15 审查）：**先落库、成功后再提交内存状态**。此前顺序相反——
  // updateRun 抛异常（库忙/关库）会留下"内存已迁移、库里没有"的分歧，
  // findActiveRunForTask / 恢复逻辑随之失真。落库失败时内存保持原状态，异常照常上抛。
  TaskStore.updateRun(run.runId, fields)
  run.status = to
  if (fields.startedAt) run.startedOnce = true
  // 状态机是所有 run 生命周期的唯一漏斗：起止/失败/取消都在这里落一行文件日志。
  // 此前引擎 3000 行只有 1 处 logMain，7×24 无人值守时"凌晨 3 点第 25 轮为什么失败"
  // 在日志里查不到（2026-09-28 审查确认的可观测性缺口）。
  try {
    logMain(to === 'failed' ? 'error' : 'info',
      `[task] run=${run.runId} task=${run.taskId} store=${run.storeId} ${from}→${to}（${reason}）`)
  } catch { /* 日志失败不能影响状态机 */ }

  emitProgress(run, { phase: progressPhaseForStatus(to), status: to, message: reason })

  // 跑到终态就归还"定时任务后台开店"借来的页面（2026-10-02 用户要求：采集任务完成后关闭网页）。
  // 只在终态归还：paused / waiting_confirmation 还要接着跑，页面得留着。
  // 先解除本次运行的 task 门禁，再归还租约；归还函数仍会检查下载、上传、人工确认、
  // 独立窗口和其它租约等门禁，避免“任务结束”误把别的并发使用者的页面关掉。
  if (isTerminalRunStatus(to)) {
    setStoreTaskActivity(run.storeId, false)
    releaseBorrowedPage(run.runId)
    /**
     * 后台执行面的页面只服务这一轮：成功/失败/取消后释放，避免隐藏窗口常驻吃内存。
     * paused 不在此列（上面 isTerminalRunStatus 为 false）——继续跑还要用同一张页面。
     */
    const kind = getTaskKindDefinition(run.taskKind)
    try { kind?.release?.(run.storeId) } catch (error) {
      logMain('warn', `[task-kind] 释放执行面失败 kind=${run.taskKind} store=${run.storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
    }
    try { kind?.onTerminal?.(run, to, reason) } catch { /* 业务钩子失败不影响状态机 */ }
  }

  if (to === 'failed') {
    // 重复失败（failed -> queued 重试后再 failed）会二次进入：先去重再入队
    const fi = failedHandles.indexOf(run.runId)
    if (fi >= 0) failedHandles.splice(fi, 1)
    failedHandles.push(run.runId)
    while (failedHandles.length > FAILED_HANDLE_KEEP) forgetRun(failedHandles[0])
  } else if (to === 'succeeded' || to === 'cancelled') {
    forgetRun(run.runId)
  }
}

/**
 * 定时任务后台开店借用的页面：runId → 归还函数。
 *
 * 为什么按 runId 记账：借页面的是 `fireScheduled`，还页面的是 run 的终态，两者之间隔着
 * 整个执行循环（可能几分钟）。归还只做一次，重复调用/没有借用记录都是空操作。
 */
export const borrowedPageReleases = new Map<string, () => void>()

function releaseBorrowedPage(runId: string): void {
  const release = borrowedPageReleases.get(runId)
  if (!release) return
  borrowedPageReleases.delete(runId)
  try {
    release()
  } catch (error) {
    logMain('warn', `[task] 归还后台借用的店铺页面失败 run=${runId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
  }
}

export function emitProgress(run: RunHandle, extra: Partial<TaskProgressEvent>): void {
  const payload: TaskProgressEvent = {
    runId: run.runId, taskId: run.taskId, storeId: run.storeId,
    status: run.status, phase: extra.phase || 'started', ...extra
  }
  emitToRenderer(EVENT_CHANNELS.TASK_PROGRESS, payload)
}

/** 错误码分类见 ./error-classifier（独立成模块以便单测钉住"新错误码不许漏登记"） */
export const classifyError = classifyTaskError
