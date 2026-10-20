/**
 * 运行队列与控制面：入队/恢复/失败重试/暂停/取消/确认、启动归档、队列泵、定时触发入口。
 * 2026-10-19 P1 重构：由 task-runner.ts 等价搬迁；导出名不变，task-runner.ts 只做 re-export。
 */

import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import type { TaskScheduledFiredEvent } from '@shared/schemas/task'
import * as TaskStore from './task-store'
import { NON_RESUMABLE_TYPES } from './task-store'
import { writeAudit } from '../services/audit-logger'
import { logMain } from '../services/logger'
import { isAppLocked } from '../services/security-manager'
import { emitToRenderer, getOpenStoreIds, onStoreBrowserOpened, borrowStorePage, openStoreBrowser } from '../browser/window-manager'
import { getTaskKindDefinition } from './task-kinds'
import { getDatabase } from '../db/database'
import { execute } from './task-runner-execute'
import { borrowedPageReleases, findActiveRunForTask, forgetRun, transition } from './task-runner-lifecycle'
import { failedHandles, getCurrent, getKeepAliveTimer, live, queue, setCurrent, setKeepAliveTimer } from './task-runner-registry'
import type { RunHandle } from './task-runner-registry'

// ---------- 入队与控制 ----------

export function enqueueRun(taskId: string, opts: { reason: string; storeId?: string }): { runId: string; storeId: string } {
  const task = TaskStore.getTask(taskId)
  if (!task) throw new Error('TASK_NOT_FOUND')
  const active = findActiveRunForTask(live.values(), taskId)
  if (active) {
    throw new Error('TASK_BAD_STATE: 该任务已有未结束的运行，请先等待、恢复或取消当前运行后再启动')
  }
  const storeId = opts.storeId || task.storeScope
  if (!storeId) throw new Error('TASK_BAD_STATE: 任务未绑定店铺，请先在任务中指定店铺或运行时选择')
  /**
   * 达人邀约不占用户的店铺浏览器：入队前先把**隐藏后台页**建好。
   * 队列泵的放行条件是"这家店已打开"（getOpenStoreIds），而后台页会把店铺登记进
   * browserState——所以即使工作台停在欢迎页、用户没开这家店，邀约也能立刻开跑。
   */
  // prepare（为邀约等建后台隐藏页）放在 createRun 成功之后：createRun 若抛（DB 忙/IO 错），
  // 先前已建的隐藏 BrowserWindow 没有任何释放路径，会泄漏一个常驻渲染进程——先关掉 DB
  // 失败窗口，再动窗口（2026-10-21 审查 P2）。
  const run = TaskStore.createRun(taskId, storeId, opts.reason)
  getTaskKindDefinition(task.kind)?.prepare?.(storeId)
  const handle: RunHandle = {
    runId: run.id, taskId, taskName: task.name, storeId,
    taskKind: task.kind || 'custom', campaignId: task.campaignId || null,
    lastStopReason: null, lastCompletedRounds: 0,
    steps: task.steps, startFrom: 0, skipDone: false, resumeKind: 'new',
    status: 'queued', reason: opts.reason,
    cancelRequested: false, pauseRequested: false, deniedByConfirm: false,
    pendingConfirm: null, tabId: null, startedOnce: false, visitedRows: new Set(), useTabPick: null, pendingCreatorNickname: null,
    pendingInvitedNames: []
  }
  live.set(run.id, handle)
  // 同一任务重新入队后，旧的失败句柄已被新运行取代（一个任务只有一个现行运行）：
  // 立即释放，防止"定时任务反复失败又反复重跑"把失败句柄积到上限。
  for (const id of Array.from(failedHandles)) {
    const old = live.get(id)
    if (old && old.taskId === taskId) forgetRun(id)
  }
  queue.push(handle)
  writeAudit('task.run', 'success', { storeId, requestId: JSON.stringify({ runId: run.id, taskId, trigger: opts.reason }) })
  schedulePump()
  return { runId: run.id, storeId }
}

/**
 * 恢复/重试前确保 run 有页面可用。
 *
 * 普通任务沿用"打开并显示店铺浏览器"（用户要看着页面继续点）；
 * 达人邀约走后台隐藏页——用户点"继续/重试"时界面不该跳到店铺浏览器。
 */
function ensurePageForRun(run: RunHandle): void {
  if (getOpenStoreIds().includes(run.storeId)) return
  const kind = getTaskKindDefinition(run.taskKind)
  if (kind?.surface === 'background') {
    kind.prepare?.(run.storeId)
    return
  }
  openStoreBrowser(run.storeId, { display: true, source: 'main' })
}

/** 从暂停恢复（paused -> queued -> running）：从当前步骤继续 */
export function resumeRun(runId: string): void {
  const run = live.get(runId)
  if (!run) throw new Error('TASK_BAD_STATE: 该运行属于上一进程会话，无法原地恢复；请重新运行任务')
  if (run.status !== 'paused') throw new Error(`TASK_BAD_STATE: ${run.status} 状态不可恢复`)
  // 暂停期间店铺可能已进入冷休眠。恢复是用户明确发起的动作，先恢复页面再入队；
  // 达人邀约恢复的是后台隐藏页，不把界面切到店铺浏览器。
  ensurePageForRun(run)
  run.resumeKind = 'continue'
  run.pauseRequested = false
  run.lastStopReason = null
  run.lastCompletedRounds = 0
  transition(run, 'queued', '用户恢复执行，排队等待')
  queue.push(run)
  writeAudit('task.resume', 'success', { storeId: run.storeId, requestId: JSON.stringify({ runId }) })
  schedulePump()
}

/** 从失败恢复（failed -> running）：跳过已成功步骤；副作用步骤拒绝自动重试 - §9.2 */
export function retryRunFromFailed(runId: string): void {
  const run = live.get(runId)
  if (!run) throw new Error('TASK_BAD_STATE: 该运行属于上一进程会话，无法原地恢复；请重新运行任务')
  if (run.status !== 'failed') throw new Error(`TASK_BAD_STATE: ${run.status} 状态不可从失败恢复`)
  const active = findActiveRunForTask(live.values(), run.taskId)
  if (active) {
    throw new Error('TASK_BAD_STATE: 该任务已有未结束的运行，不能同时恢复旧运行')
  }
  const failedIdx = run.startFrom
  const step = run.steps[failedIdx]
  if (step && NON_RESUMABLE_TYPES.has(step.type)) {
    throw new Error('TASK_BAD_STATE: 失败步骤为副作用步骤（草稿填充/人工确认），按规范不进入可恢复重试范围，请重新运行任务')
  }
  // 冷休眠可能已经关闭了该店铺。用户明确点击重试时恢复页面，否则 run 会进入 queued
  // 后一直等待"店铺已打开"。达人邀约恢复的是后台隐藏页，界面不跳转。
  ensurePageForRun(run)
  run.skipDone = true
  run.resumeKind = 'from-failed'
  run.lastStopReason = null
  run.lastCompletedRounds = 0
  transition(run, 'queued', '从失败恢复（跳过已成功步骤），排队等待')
  queue.push(run)
  writeAudit('task.retry', 'success', { storeId: run.storeId, requestId: JSON.stringify({ runId, fromStep: failedIdx }) })
  schedulePump()
}

export function pauseRun(runId: string): void {
  const run = live.get(runId)
  if (!run) throw terminalError(runId, '暂停')
  if (run.status !== 'running') throw new Error(`TASK_BAD_STATE: ${run.status} 状态不可暂停（仅运行中可暂停）`)
  run.pauseRequested = true
  writeAudit('task.pause', 'success', { storeId: run.storeId, requestId: JSON.stringify({ runId }) })
}

function terminalError(runId: string, verb: string): Error {
  const p = TaskStore.getRun(runId)
  if (!p) return new Error('TASK_NOT_FOUND')
  if (['succeeded', 'failed', 'cancelled'].includes(p.status)) {
    return new Error(`TASK_BAD_STATE: 运行已结束（${p.status}），不可${verb}`)
  }
  return new Error('TASK_BAD_STATE: 上一进程会话的遗留记录，请重新运行任务')
}

export function cancelRun(runId: string, reason = '用户取消'): void {
  const run = live.get(runId)
  if (!run) {
    const p = TaskStore.getRun(runId)
    if (!p) throw new Error('TASK_NOT_FOUND')
    if (['succeeded', 'failed', 'cancelled'].includes(p.status)) return // 幂等
    throw new Error('TASK_BAD_STATE: 上一进程会话的遗留记录，已在启动时归档')
  }
  run.cancelRequested = true
  run.pendingConfirm?.('cancel')
  writeAudit('task.cancel', 'success', { storeId: run.storeId, requestId: JSON.stringify({ runId }) })
  if (run.status === 'queued' || run.status === 'paused') {
    const qi = queue.indexOf(run)
    if (qi >= 0) queue.splice(qi, 1)
    transition(run, 'cancelled', reason)
  }
  // running / waiting_confirmation：协作式，由执行循环在等待点感知
}

export function confirmRun(runId: string, approved: boolean): void {
  const run = live.get(runId)
  if (!run) throw terminalError(runId, '确认')
  if (run.status !== 'waiting_confirmation') throw new Error(`TASK_BAD_STATE: ${run.status} 状态不在等待确认`)
  writeAudit('task.confirm', 'success', { storeId: run.storeId, requestId: JSON.stringify({ runId, approved: !!approved }) })
  run.pendingConfirm?.(approved ? 'approve' : 'deny')
}

/** 当前内存里未结束的运行（退出流程用它主动取消，别把句柄丢在半路）。
 *  说明：live 里的 failed 句柄没有意义——它们已经不跑了，所以这里只报"还会动"的状态。 */
export function listLiveRuns(): Array<{ runId: string; taskId: string; storeId: string; status: string }> {
  return [...live.values()]
    .filter(r => r.status === 'queued' || r.status === 'running' || r.status === 'paused' || r.status === 'waiting_confirmation')
    .map(r => ({ runId: r.runId, taskId: r.taskId, storeId: r.storeId, status: r.status }))
}

/** 引擎启动：归档遗留 run + 注册店铺打开监听唤醒队列（不静默拉起 - §4.4） */
export function startEngine(): void {
  reconcileOnStartup()
  onStoreBrowserOpened(() => schedulePump())
  if (!getKeepAliveTimer()) setKeepAliveTimer(setInterval(schedulePump, 1500))
}

/**
 * 进程重启：遗留的非终态 run 如实标记中断（跨进程原地恢复不在本轮范围）。
 *
 * queued 与 running 必须分开说：queued 的 run 还没开始执行过任何步骤（内存队列
 * 随进程一起没了，它不可能产生过副作用），而 running/waiting_confirmation/paused
 * 可能停在任意步骤中间。混成一句"运行中断"会让用户以为 queued 的那次也跑了一半，
 * 去对账一个根本不存在的部分执行。
 *
 * 两条语句拆开且导出给单测：必须同时存在（queued 一条、running 系一条），
 * 合并或漏掉任一条都会让某类遗留 run 永远卡在非终态。单测扫这两条常量断言。
 */
export const RECONCILE_QUEUED_SQL =
  "UPDATE task_runs SET status = 'failed', status_reason = '进程重启，排队未开始（无任何步骤已执行，可直接重新运行）', finished_at = COALESCE(finished_at, ?) WHERE status = 'queued'"
export const RECONCILE_ACTIVE_SQL =
  "UPDATE task_runs SET status = 'failed', status_reason = '进程重启，运行中断（请重新运行任务）', finished_at = COALESCE(finished_at, ?) WHERE status IN ('running','waiting_confirmation','paused')"
function reconcileOnStartup(): void {
  try {
    const db = getDatabase()
    const now = Date.now()
    db.prepare(RECONCILE_QUEUED_SQL).run(now)
    db.prepare(RECONCILE_ACTIVE_SQL).run(now)
  } catch { /* 启动路径不因归档失败而中断 */ }
}

// ---------- 队列泵 ----------

function schedulePump(): void { setImmediate(pump) }

function pump(): void {
  if (getCurrent()) return
  if (isAppLocked()) return // 应用锁期间不启动新运行（解锁后 keepAlive 自动续泵）
  const open = getOpenStoreIds()
  const idx = queue.findIndex(r => r.status === 'queued' && !r.cancelRequested && open.includes(r.storeId))
  if (idx === -1) return
  const run = queue.splice(idx, 1)[0]
  if (run.cancelRequested) { transition(run, 'cancelled', '用户取消'); schedulePump(); return }
  setCurrent(run)
  execute(run).catch(e => {
    // 走 logMain（脱敏 + 落盘）：console.error 的原文可能带 token/cookie 的 URL（P1-3）
    logMain('error', `[task] execute 未捕获异常 run=${run.runId}：${String((e as any)?.stack || (e as any)?.message || e).slice(0, 500)}`)
  }).finally(() => {
    setCurrent(null)
    schedulePump()
  })
}

// ---------- 定时触发入口（供 Scheduler 使用；共享同一队列与确认门禁） ----------

export function fireScheduled(taskId: string): TaskScheduledFiredEvent {
  const task = TaskStore.getTask(taskId)
  const { runId, storeId } = enqueueRun(taskId, { reason: '调度触发' })
  let queuedWaiting = !getOpenStoreIds().includes(storeId)
  /**
   * 任务自己声明了 `schedule.backgroundOpen` 时，没开店铺浏览器就**后台把它开起来**
   * （display:false，不抢当前视图）再跑。
   *
   * 为什么需要这个开关：默认的"不静默拉起"（§4.4）是给有副作用的任务的护栏；但只读的采集类
   * 定时任务（如发票中心每 3 小时刷新）如果不这么做，无人值守时每次触发都只是把 run 排进队列，
   * 界面上看着"定时任务已触发"，实际一次都没采到——比不排更糟（有动作没结果）。
   * 开页面失败也不抛：如实把 queuedWaiting 留在 true（排队等人开），消息里说明。
   */
  let autoOpened = false
  if (queuedWaiting && (task?.schedule as { backgroundOpen?: boolean } | null | undefined)?.backgroundOpen === true) {
    try {
      // 借页面而不是"开完就不管"：run 跑到终态时归还，页面按需关掉（见 releaseBorrowedPage）。
      // 用户自己开着的店铺页面不会被借用，也永远不会被这次采集关掉。
      borrowedPageReleases.set(runId, borrowStorePage(storeId))
      autoOpened = true
      queuedWaiting = false
      logMain('info', `[scheduler] 定时任务后台打开店铺页面 store=${storeId} task=${taskId}`)
    } catch (error) {
      logMain('warn', `[scheduler] 后台打开店铺页面失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
    }
  }
  const ev: TaskScheduledFiredEvent = {
    runId, taskId, storeId, queuedWaiting,
    message: queuedWaiting
      ? `定时任务「${task?.name}」已触发：店铺浏览器未打开，保持排队等待，不静默拉起`
      : autoOpened
        ? `定时任务「${task?.name}」已触发：店铺页面已在后台打开，采完自动关闭（你正在看的页面不受影响）`
        : `定时任务「${task?.name}」已触发并入队`
  }
  emitToRenderer(EVENT_CHANNELS.TASK_SCHEDULED_FIRED, ev)
  return ev
}
