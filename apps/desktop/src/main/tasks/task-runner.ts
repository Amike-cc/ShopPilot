/**
 * TaskRunner - §4.4 / §9.2
 * 只执行预定义步骤（不接受网页或渲染层的任意代码）；
 * 状态迁移全部在 Main 执行并在 task_runs.status_reason 保留迁移原因。
 *
 * 并发策略：全局同时最多 1 个 active run（暂停/恢复/确认门禁语义确定）；
 * 店铺浏览器未打开的 run 保持 queued，不静默拉起（§4.4）。
 * 审计引用（runId 等）序列化进 audit_logs.request_id（§5.7 七列 schema 不动）。
 */

import { app } from 'electron'
import { createHash } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import type {
  TaskStepDef, TaskProgressEvent, TaskProgressPhase,
  StepResultKind, TaskConfirmationEvent, TaskScheduledFiredEvent
} from '@shared/schemas/task'
import * as TaskStore from './task-store'
import { NON_RESUMABLE_TYPES } from './task-store'
import { writeAudit } from '../services/audit-logger'
import { generateInviteScript } from '../services/ai-client'
import { isAppLocked } from '../services/security-manager'
import { createTab, getTabWebContents, emitToRenderer, getOpenStoreIds, onStoreBrowserOpened } from '../browser/window-manager'
import { getDatabase } from '../db/database'

interface RunHandle {
  runId: string
  taskId: string
  taskName: string
  storeId: string
  steps: TaskStepDef[]
  startFrom: number
  skipDone: boolean
  resumeKind: 'new' | 'continue' | 'from-failed'
  status: string
  reason: string
  cancelRequested: boolean
  pauseRequested: boolean
  deniedByConfirm: boolean
  pendingConfirm: ((answer: 'approve' | 'deny' | 'cancel' | 'timeout') => void) | null
  tabId: string | null
  startedOnce: boolean
}

const queue: RunHandle[] = []
const live = new Map<string, RunHandle>()
let current: RunHandle | null = null
let keepAliveTimer: NodeJS.Timeout | null = null

/** §9.2 任务状态机（含 A1 修订的失败恢复迁移） */
const TRANSITIONS: Record<string, string[]> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_confirmation', 'paused', 'succeeded', 'failed', 'cancelled'],
  waiting_confirmation: ['running', 'cancelled'],
  paused: ['queued', 'running', 'cancelled'],
  failed: ['queued', 'running'],
  succeeded: [],
  cancelled: []
}

const cancelSig = () => Object.assign(new Error('运行已取消'), { name: 'CancelSignal' })
const pauseSig = () => Object.assign(new Error('运行已暂停'), { name: 'PauseSignal' })

// ---------- 状态迁移 ----------

function transition(run: RunHandle, to: string, reason: string): void {
  const allowed = TRANSITIONS[run.status] || []
  if (!allowed.includes(to)) {
    throw new Error(`TASK_BAD_STATE: ${run.status} -> ${to} (${reason})`)
  }
  run.status = to
  const fields: Parameters<typeof TaskStore.updateRun>[1] = { status: to, statusReason: reason }
  if (to === 'running' && !run.startedOnce) { fields.startedAt = Date.now(); run.startedOnce = true }
  if (to === 'succeeded' || to === 'failed' || to === 'cancelled') fields.finishedAt = Date.now()
  TaskStore.updateRun(run.runId, fields)

  const phase: TaskProgressPhase =
    to === 'running' ? 'started' :
    to === 'succeeded' ? 'finished' :
    to === 'failed' ? 'failed' :
    to === 'cancelled' ? 'finished' :
    to === 'paused' ? 'paused' :
    to === 'queued' ? 'queued' : 'started'
  emitProgress(run, { phase, status: to, message: reason })

  if (to === 'succeeded' || to === 'cancelled') live.delete(run.runId)
}

function emitProgress(run: RunHandle, extra: Partial<TaskProgressEvent>): void {
  const payload: TaskProgressEvent = {
    runId: run.runId, taskId: run.taskId, storeId: run.storeId,
    status: run.status, phase: extra.phase || 'started', ...extra
  }
  emitToRenderer(EVENT_CHANNELS.TASK_PROGRESS, payload)
}

// ---------- 入队与控制 ----------

export function enqueueRun(taskId: string, opts: { reason: string; storeId?: string }): { runId: string; storeId: string } {
  const task = TaskStore.getTask(taskId)
  if (!task) throw new Error('TASK_NOT_FOUND')
  const storeId = opts.storeId || task.storeScope
  if (!storeId) throw new Error('TASK_BAD_STATE: 任务未绑定店铺，请先在任务中指定店铺或运行时选择')
  const run = TaskStore.createRun(taskId, storeId, opts.reason)
  const handle: RunHandle = {
    runId: run.id, taskId, taskName: task.name, storeId,
    steps: task.steps, startFrom: 0, skipDone: false, resumeKind: 'new',
    status: 'queued', reason: opts.reason,
    cancelRequested: false, pauseRequested: false, deniedByConfirm: false,
    pendingConfirm: null, tabId: null, startedOnce: false
  }
  live.set(run.id, handle)
  queue.push(handle)
  writeAudit('task.run', 'success', { storeId, requestId: JSON.stringify({ runId: run.id, taskId, trigger: opts.reason }) })
  schedulePump()
  return { runId: run.id, storeId }
}

/** 从暂停恢复（paused -> queued -> running）：从当前步骤继续 */
export function resumeRun(runId: string): void {
  const run = live.get(runId)
  if (!run) throw new Error('TASK_BAD_STATE: 该运行属于上一进程会话，无法原地恢复；请重新运行任务')
  if (run.status !== 'paused') throw new Error(`TASK_BAD_STATE: ${run.status} 状态不可恢复`)
  run.resumeKind = 'continue'
  run.pauseRequested = false
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
  const failedIdx = run.startFrom
  const step = run.steps[failedIdx]
  if (step && NON_RESUMABLE_TYPES.has(step.type)) {
    throw new Error('TASK_BAD_STATE: 失败步骤为副作用步骤（草稿填充/人工确认），按规范不进入可恢复重试范围，请重新运行任务')
  }
  run.skipDone = true
  run.resumeKind = 'from-failed'
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

/** 引擎启动：归档遗留 run + 注册店铺打开监听唤醒队列（不静默拉起 - §4.4） */
export function startEngine(): void {
  reconcileOnStartup()
  onStoreBrowserOpened(() => schedulePump())
  if (!keepAliveTimer) keepAliveTimer = setInterval(schedulePump, 1500)
}

/** 进程重启：遗留的非终态 run 如实标记中断（跨进程原地恢复不在本轮范围） */
function reconcileOnStartup(): void {
  try {
    const db = getDatabase()
    db.prepare(
      "UPDATE task_runs SET status = 'failed', status_reason = '进程重启，运行中断（请重新运行任务）', finished_at = COALESCE(finished_at, ?) WHERE status IN ('queued','running','waiting_confirmation','paused')"
    ).run(Date.now())
  } catch { /* 启动路径不因归档失败而中断 */ }
}

// ---------- 队列泵 ----------

function schedulePump(): void { setImmediate(pump) }

function pump(): void {
  if (current) return
  if (isAppLocked()) return // 应用锁期间不启动新运行（解锁后 keepAlive 自动续泵）
  const open = getOpenStoreIds()
  const idx = queue.findIndex(r => r.status === 'queued' && !r.cancelRequested && open.includes(r.storeId))
  if (idx === -1) return
  const run = queue.splice(idx, 1)[0]
  if (run.cancelRequested) { transition(run, 'cancelled', '用户取消'); schedulePump(); return }
  current = run
  execute(run).catch(e => {
    console.error('[task-runner] execute 未捕获异常:', e)
  }).finally(() => {
    current = null
    schedulePump()
  })
}

// ---------- 执行循环 ----------

async function execute(run: RunHandle): Promise<void> {
  try {
    if (run.resumeKind === 'new') transition(run, 'running', run.reason)
    else if (run.resumeKind === 'continue') transition(run, 'running', '用户恢复执行')
    else transition(run, 'running', '从失败步骤恢复，跳过已完成步骤')

    // 每 run 独立标签页，不干扰用户正在看的页面
    if (!run.tabId || !getTabWebContents(run.storeId, run.tabId)) {
      const firstNavigate = run.steps.find(s => s.type === 'navigate')
      run.tabId = createTab(run.storeId, (firstNavigate?.input as any)?.url || 'about:blank')
    }

    const doneSet = run.skipDone ? TaskStore.succeededStepIndexes(run.runId) : new Set<number>()

    for (let i = run.startFrom; i < run.steps.length; i++) {
      if (run.cancelRequested) { transition(run, 'cancelled', '用户取消'); return }
      if (run.pauseRequested) {
        run.pauseRequested = false
        run.startFrom = i; run.resumeKind = 'continue'
        transition(run, 'paused', '用户暂停（将从该步骤继续）')
        return
      }
      if (doneSet.has(i)) {
        emitProgress(run, { phase: 'succeeded', stepIndex: i, stepType: run.steps[i].type, message: '跳过已完成步骤（恢复模式）' })
        continue
      }

      const step = run.steps[i]
      TaskStore.updateRun(run.runId, { currentStep: i })
      emitProgress(run, { phase: 'started', stepIndex: i, stepType: step.type })

      let attempt = 0
      for (;;) {
        try {
          const out = await execStep(run, step)
          // 每步成功都有落库凭据：产物步骤写内容结果，等待/导航类写 executed 行
          // （succeededStepIndexes 据此实现"恢复不重复执行已成功步骤" - §9.2）
          if (out) TaskStore.insertStepResult(run.runId, i, out.kind, out.payload, out.artifact)
          else if (!run.deniedByConfirm) TaskStore.insertStepResult(run.runId, i, 'executed', { done: true, stepType: step.type })
          if (run.deniedByConfirm) {
            transition(run, 'cancelled', '用户拒绝确认，门禁拦截')
            return
          }
          emitProgress(run, { phase: 'succeeded', stepIndex: i, stepType: step.type })
          break
        } catch (e: any) {
          if (e?.name === 'CancelSignal') {
            if (run.status === 'running' || run.status === 'waiting_confirmation') transition(run, 'cancelled', '用户取消')
            return
          }
          if (e?.name === 'PauseSignal') {
            if (run.status === 'running') {
              run.pauseRequested = false
              run.startFrom = i; run.resumeKind = 'continue'
              transition(run, 'paused', '用户暂停')
            }
            return
          }
          if (attempt < step.retryLimit && !run.cancelRequested && run.status === 'running') {
            attempt++
            emitProgress(run, { phase: 'retry', stepIndex: i, stepType: step.type, message: `第 ${attempt} 次重试：${String(e?.message).slice(0, 160)}` })
            continue
          }
          const code = classifyError(e)
          TaskStore.updateRun(run.runId, { errorCode: code, errorMessage: String(e?.message || e).slice(0, 500) })
          run.startFrom = i
          transition(run, 'failed', `步骤 ${i + 1}/${run.steps.length}（${step.type}）失败`)
          return
        }
      }
    }

    transition(run, 'succeeded', '全部步骤完成')
  } catch (e: any) {
    console.error('[task-runner] run 执行异常', run.runId, e)
    try { TaskStore.updateRun(run.runId, { errorCode: 'INTERNAL_ERROR', errorMessage: String(e?.message || e).slice(0, 500) }) } catch { /* ignore */ }
    try { transition(run, 'failed', '引擎异常') } catch { /* 状态机不允许则保留现场 */ }
  }
}

function classifyError(e: any): string {
  const msg = String(e?.message || e)
  if (msg.startsWith('TASK_TIMEOUT')) return 'TASK_TIMEOUT'
  if (msg.includes('TASK_SELECTOR_CHANGED')) return 'TASK_SELECTOR_CHANGED'
  if (msg.includes('NAVIGATION_BLOCKED')) return 'NAVIGATION_BLOCKED'
  if (msg.includes('TASK_CONFIRMATION_REQUIRED')) return 'TASK_CONFIRMATION_REQUIRED'
  if (msg.includes('TASK_TARGET_DISABLED')) return 'TASK_TARGET_DISABLED'
  // AI 相关的固定错误码：如实透出，便于界面区分"没配 Key / 地址不合法 / 超时 / 请求失败"
  if (msg.includes('AI_NOT_CONFIGURED')) return 'AI_NOT_CONFIGURED'
  if (msg.includes('AI_BAD_ENDPOINT')) return 'AI_BAD_ENDPOINT'
  if (msg.includes('AI_EMPTY_SOURCE') || msg.includes('AI_EMPTY_OUTPUT')) return 'AI_EMPTY_OUTPUT'
  if (msg.includes('AI_TIMEOUT')) return 'AI_TIMEOUT'
  if (msg.includes('AI_REQUEST_FAILED')) return 'AI_REQUEST_FAILED'
  return 'INTERNAL_ERROR'
}

// ---------- 步骤执行器（全部预定义，无任意代码路径） ----------

// kind 与 store 侧 insertStepResult 的联合一致：副作用步骤返回 executed 并带明细
// （executed 也是"已成功"的凭据，succeededStepIndexes 只按 step_index 去重）
interface StepOutput { kind: StepResultKind | 'confirm' | 'executed'; payload: unknown; artifact?: { path: string; sha256: string } }

function wcOrThrow(run: RunHandle): Electron.WebContents {
  const wc = run.tabId ? getTabWebContents(run.storeId, run.tabId) : null
  if (!wc) throw new Error('BROWSER_CLOSED: 店铺浏览器或任务标签页已被关闭')
  return wc
}

function guardSignals(run: RunHandle): void {
  if (run.cancelRequested) throw cancelSig()
  if (run.pauseRequested && current === run) throw pauseSig()
}

async function withTimeout<T>(fn: () => Promise<T>, run: RunHandle, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`TASK_TIMEOUT: ${label} 超过 ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([fn(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 轮询式等待（每 300ms 检查一次，支持暂停/取消协作式打断） */
async function pollUntil(run: RunHandle, cond: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  await withTimeout(async () => {
    for (;;) {
      guardSignals(run)
      if (await cond()) return
      await new Promise(r => setTimeout(r, 300))
    }
  }, run, timeoutMs, label)
}

/** 轮询等待选择器出现；超时抛 TASK_SELECTOR_CHANGED（区别于纯超时） */
async function waitForSelector(wc: Electron.WebContents, sel: string, run: RunHandle, timeoutMs: number): Promise<void> {
  const expr = `!!document.querySelector(${JSON.stringify(sel)})`
  try {
    await withTimeout(async () => {
      for (;;) {
        guardSignals(run)
        const found = await wc.executeJavaScript(expr).catch(() => false)
        if (found) return
        await new Promise(r => setTimeout(r, 300))
      }
    }, run, timeoutMs, `等待选择器 ${sel}`)
  } catch (e: any) {
    if (String(e?.message).startsWith('TASK_TIMEOUT')) throw new Error(`TASK_SELECTOR_CHANGED: 超时未出现元素 ${sel}`)
    throw e
  }
}

async function execStep(run: RunHandle, step: TaskStepDef): Promise<StepOutput | null> {
  const input = step.input as any
  switch (step.type) {
    case 'navigate': {
      if (!/^https?:\/\//i.test(String(input.url))) throw new Error('NAVIGATION_BLOCKED: 仅允许 http/https')
      const wc = wcOrThrow(run)
      await withTimeout(async () => {
        guardSignals(run)
        try {
          await wc.loadURL(String(input.url))
        } catch (e: any) {
          // 重定向引起的 ERR_ABORTED 属正常导航链
          if (!/ERR_ABORTED/.test(String(e?.message))) throw e
        }
      }, run, step.timeoutMs, 'navigate')
      await pollUntil(run, () => !wcOrThrow(run).isLoading(), Math.max(step.timeoutMs, 5000), 'navigate 加载完成')
      return null
    }
    case 'waitForPage': {
      const wc = wcOrThrow(run)
      if (input.urlIncludes) {
        await pollUntil(run, () => String(wc.getURL()).includes(String(input.urlIncludes)), step.timeoutMs, 'waitForPage')
      } else {
        await pollUntil(run, () => !wc.isLoading(), step.timeoutMs, 'waitForPage 加载完成')
      }
      return null
    }
    case 'waitForSelector': {
      const wc = wcOrThrow(run)
      await waitForSelector(wc, String(input.selector), run, step.timeoutMs)
      return null
    }
    case 'readText': {
      const wc = wcOrThrow(run)
      await waitForSelector(wc, String(input.selector), run, step.timeoutMs)
      const text = await wc.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(String(input.selector))});
        if (!el) return null;
        // 表单控件读 value：textarea 的 textContent 是"默认值"，用 setInput/aiGenerate 写入后并不会变，
        // 照 innerText||textContent 读会拿到空串（实测），留档就失真了
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value ?? '').trim().slice(0, 100000);
        return String(el.innerText || el.textContent || '').trim().slice(0, 100000);
      })()`)
      if (text == null) throw new Error(`TASK_SELECTOR_CHANGED: 未找到元素 ${String(input.selector)}`)
      if (input.metric) {
        const num = parseFloat(String(text).replace(/[^\d.\-]/g, ''))
        TaskStore.insertSnapshot(run.storeId, String(input.metric), Number.isFinite(num) ? num : text, run.runId)
      }
      return { kind: 'text', payload: { text, metric: input.metric || null } }
    }
    case 'readTable': {
      const wc = wcOrThrow(run)
      await waitForSelector(wc, String(input.selector), run, step.timeoutMs)
      const rows = await wc.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(String(input.selector))});
        if (!el) return null;
        return Array.from(el.querySelectorAll('tr')).slice(0, 2000).map(tr =>
          Array.from(tr.children).map(c => String(c.innerText || '').trim().slice(0, 500)));
      })()`)
      if (!rows) throw new Error(`TASK_SELECTOR_CHANGED: 未找到表格 ${String(input.selector)}`)
      if (input.metric) {
        TaskStore.insertSnapshot(run.storeId, String(input.metric), rows.length, run.runId)
      }
      return { kind: 'table', payload: { rows, rowCount: rows.length, metric: input.metric || null } }
    }
    case 'screenshot': {
      const wc = wcOrThrow(run)
      const image = await withTimeout(() => wc.capturePage(), run, step.timeoutMs, 'screenshot')
      const buf = image.toPNG()
      if (buf.length < 100) {
        // 视口未渲染时 capturePage 返回空图：如实失败，不落 0 字节工件
        throw new Error('CAPTURE_EMPTY: 页面当前不可见（视口未渲染），无法截图')
      }
      const dir = join(app.getPath('userData'), 'stores', run.storeId, 'artifacts')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${run.runId}_step${step.index}.png`)
      writeFileSync(path, buf)
      const sha256 = createHash('sha256').update(buf).digest('hex')
      return { kind: 'screenshot', payload: null, artifact: { path, sha256 } }
    }
    case 'fillDraft': {
      const wc = wcOrThrow(run)
      const okFilled = await wc.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(String(input.selector))});
        if (!el) return false;
        const text = ${JSON.stringify(String(input.text ?? ''))};
        if (el.isContentEditable) { el.textContent = text; }
        else {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, text); else el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      if (!okFilled) throw new Error(`TASK_SELECTOR_CHANGED: 未找到填充目标 ${String(input.selector)}`)
      // §4.5：payload 只存摘要与长度，绝不存表单完整值
      return { kind: 'text', payload: { filled: true, selector: String(input.selector), length: String(input.text ?? '').length } }
    }
    case 'waitForUserConfirmation': {
      const message = String(input.message || '请确认继续')
      transition(run, 'waiting_confirmation', `等待人工确认：${message}`)
      emitToRenderer(EVENT_CHANNELS.TASK_CONFIRMATION_REQUIRED, {
        runId: run.runId, taskId: run.taskId, storeId: run.storeId, stepIndex: step.index, message
      } satisfies TaskConfirmationEvent)

      const answer = await new Promise<'approve' | 'deny' | 'cancel' | 'timeout'>((resolve) => {
        let done = false
        const finish = (a: 'approve' | 'deny' | 'cancel' | 'timeout') => { if (!done) { done = true; resolve(a) } }
        run.pendingConfirm = finish
        setTimeout(() => finish('timeout'), step.timeoutMs)
        const sig = setInterval(() => {
          if (done) { clearInterval(sig); return }
          // 暂停不打断门禁：确认/拒绝是用户必须做出的决定，仅响应取消
          if (run.cancelRequested) { finish('cancel'); clearInterval(sig) }
        }, 250)
      })
      run.pendingConfirm = null

      if (answer === 'timeout') throw new Error(`TASK_CONFIRMATION_REQUIRED: 确认超时（${Math.round(step.timeoutMs / 60000)} 分钟）`)
      if (answer === 'cancel') throw cancelSig()
      if (answer === 'deny') { run.deniedByConfirm = true; return { kind: 'confirm', payload: { approved: false, message } } }
      transition(run, 'running', '用户确认通过')
      return { kind: 'confirm', payload: { approved: true, message } }
    }
    // ---------- 副作用步骤（点击/写入）：固定注入脚本 + Zod 校验参数，仍无任意代码入口 ----------
    case 'click': {
      const wc = wcOrThrow(run)
      const sel = String(input.selector)
      await waitForSelector(wc, sel, run, step.timeoutMs)
      guardSignals(run)
      const res = await withTimeout(() => wc.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return { ok: false, reason: 'NOT_FOUND' };
        let dis = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
        let p = el.parentElement;
        for (let i = 0; i < 3 && p && !dis; i++, p = p.parentElement) {
          if (/disabled/i.test(String(p.className || ''))) dis = true;
        }
        if (dis) return { ok: false, reason: 'DISABLED' };
        const target = el.closest('button, a, label, [role="button"]') || el;
        target.click();
        return { ok: true, text: String(target.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) };
      })()`), run, step.timeoutMs, 'click')
      if (!res || !res.ok) throw new Error(res && res.reason === 'DISABLED'
        ? `TASK_TARGET_DISABLED: 目标为禁用态，平台不允许该操作 ${sel}`
        : `TASK_SELECTOR_CHANGED: 未找到可点击元素 ${sel}`)
      guardSignals(run)
      return { kind: 'executed', payload: { action: 'click', selector: sel, clickedText: res.text || null } }
    }
    case 'clickByText': {
      // 平台页面没有稳定选择器，只能按"元素自身的直接文本"点；
      // 取文本最短的命中项（最具体的那个），再向上找可点击祖先
      const wc = wcOrThrow(run)
      const needle = String(input.text)
      guardSignals(run)
      const res = await withTimeout(() => wc.executeJavaScript(`(() => {
        const needle = ${JSON.stringify(needle)};
        const cands = [];
        for (const el of document.querySelectorAll('*')) {
          const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
          if (!own.includes(needle)) continue;
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          cands.push({ el, len: own.length });
        }
        if (!cands.length) return { ok: false, reason: 'NOT_FOUND' };
        cands.sort((a, b) => a.len - b.len);
        const hit = cands[0].el;
        let dis = hit.disabled === true || hit.getAttribute('aria-disabled') === 'true';
        let p = hit.parentElement;
        for (let i = 0; i < 3 && p && !dis; i++, p = p.parentElement) {
          if (/disabled/i.test(String(p.className || ''))) dis = true;
        }
        if (dis) return { ok: false, reason: 'DISABLED' };
        const target = hit.closest('button, a, label, [role="button"], [class*="btn"]') || hit;
        target.click();
        return { ok: true, matched: needle, clickedText: String(target.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), candidates: cands.length };
      })()`), run, step.timeoutMs, 'clickByText')
      if (!res || !res.ok) throw new Error(res && res.reason === 'DISABLED'
        ? `TASK_TARGET_DISABLED: 「${needle}」当前为禁用态（平台限制该操作）`
        : `TASK_SELECTOR_CHANGED: 页面上找不到文案为「${needle}」的可点击元素`)
      guardSignals(run)
      return { kind: 'executed', payload: { action: 'clickByText', matched: needle, clickedText: res.clickedText, candidates: res.candidates } }
    }
    case 'clickAll': {
      // 批量点击并跳过不可用项：达人选人时"已发过消息"的行复选框是 disabled，必须跳过而不是硬点；
      // 同时受平台单次上限约束（max 已由 Zod 限到 40）。点击之间留间隔，避免与框架重渲染打架。
      const wc = wcOrThrow(run)
      const sel = input.selector ? String(input.selector) : ''
      const txt = input.text ? String(input.text) : ''
      const max = Number(input.max)
      guardSignals(run)
      const res = await withTimeout(() => wc.executeJavaScript(`(async () => {
        const SEL = ${JSON.stringify(sel)}, TXT = ${JSON.stringify(txt)}, MAX = ${max};
        let els = [];
        if (SEL) els = Array.from(document.querySelectorAll(SEL));
        else {
          for (const el of document.querySelectorAll('*')) {
            const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
            if (own.includes(TXT)) els.push(el);
          }
        }
        const clicked = [];
        let skippedDisabled = 0, skippedInvisible = 0;
        for (const el of els) {
          if (clicked.length >= MAX) break;
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) { skippedInvisible++; continue }
          let dis = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
          let p = el.parentElement;
          for (let i = 0; i < 3 && p && !dis; i++, p = p.parentElement) {
            if (/disabled/i.test(String(p.className || ''))) dis = true;
          }
          if (dis) { skippedDisabled++; continue }
          const target = el.closest('label, [class*="checkbox"]') || el;
          target.click();
          const rowText = String((el.closest('tr') || el.parentElement || el).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
          clicked.push(rowText);
          await new Promise(r => setTimeout(r, 150));
        }
        return { ok: true, clicked: clicked.length, skippedDisabled, skippedInvisible, total: els.length, samples: clicked.slice(0, 5) };
      })()`), run, step.timeoutMs, 'clickAll')
      if (!res || !res.ok) throw new Error(`TASK_SELECTOR_CHANGED: 批量点击未执行（${sel || txt}）`)
      if (res.clicked === 0) {
        throw new Error(`TASK_SELECTOR_CHANGED: 没有可用的目标（匹配 ${res.total} 项，其中 ${res.skippedDisabled} 项禁用、${res.skippedInvisible} 项不可见）`)
      }
      guardSignals(run)
      return { kind: 'executed', payload: { action: 'clickAll', target: sel || txt, clicked: res.clicked, skippedDisabled: res.skippedDisabled, skippedInvisible: res.skippedInvisible, samples: res.samples } }
    }
    case 'setInput': {
      const wc = wcOrThrow(run)
      const sel = String(input.selector)
      await waitForSelector(wc, sel, run, step.timeoutMs)
      guardSignals(run)
      // 受控组件必须用原生 value setter + 派发 input 事件，直接赋 .value 不会更新框架状态
      const okFilled = await withTimeout(() => wc.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        const text = ${JSON.stringify(String(input.text ?? ''))};
        if (el.isContentEditable) { el.textContent = text; }
        else {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, text); else el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`), run, step.timeoutMs, 'setInput')
      if (!okFilled) throw new Error(`TASK_SELECTOR_CHANGED: 未找到输入目标 ${sel}`)
      guardSignals(run)
      // §4.5：payload 只存摘要与长度，绝不存写入的完整文本
      return { kind: 'executed', payload: { action: 'setInput', selector: sel, length: String(input.text ?? '').length } }
    }
    case 'aiGenerate': {
      // 从页面读"商品信息" → 主进程调大模型生成话术 → 写回页面输入框（受控组件方式）
      // 未配置 AI / 接口不可用时如实失败（AI_NOT_CONFIGURED 等），绝不静默跳过或写假话术
      const wc = wcOrThrow(run)
      const srcSel = input.sourceSelector ? String(input.sourceSelector) : ''
      const sel = String(input.selector)
      if (srcSel) await waitForSelector(wc, srcSel, run, step.timeoutMs)
      guardSignals(run)
      // srcSel 留空 = 平台的"商品区"定位不到稳定选择器时的如实降级：从写入目标（话术框）向上
      // 找最近的固定定位浮层（邀约抽屉），只读抽屉文本；找不到就报 AI_EMPTY_SOURCE，
      // 绝不把整页噪音（达人列表、菜单）当商品信息喂给模型
      const src = await withTimeout(() => wc.executeJavaScript(`(() => {
        const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        ${srcSel
          ? `const el = document.querySelector(${JSON.stringify(srcSel)});
             return el ? { how: 'selector', text: clean(el.innerText || el.textContent).slice(0, 2000) } : { how: 'none', text: '' };`
          : `let node = document.querySelector(${JSON.stringify(sel)});
             while (node && node !== document.body) {
               const cs = getComputedStyle(node);
               if (cs.position === 'fixed') {
                 const r = node.getBoundingClientRect();
                 if (r.width >= innerWidth * 0.2 && r.height >= innerHeight * 0.2) {
                   const t = clean(node.innerText || node.textContent).slice(0, 2000);
                   if (t) return { how: 'drawer', text: t };
                 }
               }
               node = node.parentElement;
             }
             return { how: 'none', text: '' };`}
      })()`), run, step.timeoutMs, 'aiGenerate 读取商品信息')
      if (!src || src.how === 'none') {
        throw new Error(srcSel
          ? `TASK_SELECTOR_CHANGED: 未找到商品信息来源 ${srcSel}`
          : 'AI_EMPTY_SOURCE: 未能在邀约抽屉里读到商品信息（话术框所在的浮层没找到）')
      }
      const goods = String(src.text || '')
      if (!goods) throw new Error(`AI_EMPTY_SOURCE: 商品信息来源文本为空（${srcSel || 'drawer'}）`)
      guardSignals(run)

      let generated: { script: string; model: string; sourceChars: number }
      try {
        generated = await withTimeout(
          () => generateInviteScript({
            goodsText: goods,
            maxLen: Number(input.maxLen),
            instruction: input.instruction ? String(input.instruction) : undefined
          }),
          run, step.timeoutMs, 'aiGenerate 调用大模型'
        )
        writeAudit('ai.generate', 'success', { storeId: run.storeId, requestId: run.runId })
      } catch (e: any) {
        writeAudit('ai.generate', 'failure', { storeId: run.storeId, requestId: run.runId })
        throw e
      }
      guardSignals(run)

      const okWrote = await withTimeout(() => wc.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        const text = ${JSON.stringify(generated.script)};
        if (el.isContentEditable) { el.textContent = text; }
        else {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, text); else el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`), run, step.timeoutMs, 'aiGenerate 写入')
      if (!okWrote) throw new Error(`TASK_SELECTOR_CHANGED: 未找到写入目标 ${sel}`)
      guardSignals(run)
      // §4.5：payload 只存摘要（模型名/长度/来源字符数/前 40 字预览）；
      // 完整话术由紧随其后的 readText 步骤落库，便于事后审计"到底发了什么"
      return {
        kind: 'executed',
        payload: {
          action: 'aiGenerate', model: generated.model, length: generated.script.length,
          sourceChars: generated.sourceChars, sourceHow: src.how,
          sourceSelector: srcSel || null, preview: generated.script.slice(0, 40)
        }
      }
    }
    default:
      throw new Error(`TASK_INVALID_STEP: 未知步骤类型 ${String(step.type)}`)
  }
}

// ---------- 定时触发入口（供 Scheduler 使用；共享同一队列与确认门禁） ----------

export function fireScheduled(taskId: string): TaskScheduledFiredEvent {
  const task = TaskStore.getTask(taskId)
  const { runId, storeId } = enqueueRun(taskId, { reason: '调度触发' })
  const queuedWaiting = !getOpenStoreIds().includes(storeId)
  const ev: TaskScheduledFiredEvent = {
    runId, taskId, storeId, queuedWaiting,
    message: queuedWaiting
      ? `定时任务「${task?.name}」已触发：店铺浏览器未打开，保持排队等待，不静默拉起`
      : `定时任务「${task?.name}」已触发并入队`
  }
  emitToRenderer(EVENT_CHANNELS.TASK_SCHEDULED_FIRED, ev)
  return ev
}
