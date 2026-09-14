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
import { NON_RESUMABLE_TYPES, DEFAULT_STEP_TIMEOUT } from './task-store'
import { writeAudit } from '../services/audit-logger'
import { logMain } from '../services/logger'
import { generateInviteScript } from '../services/ai-client'
import { isAppLocked } from '../services/security-manager'
import { createTab, getTabWebContents, emitToRenderer, getOpenStoreIds, onStoreBrowserOpened, getStoreTabs, activateTab } from '../browser/window-manager'
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
/** 每个店铺的任务运行标签页（复用以防标签页/渲染进程堆积；浏览器关闭后 id 失效自动重建） */
const runTabByStore = new Map<string, string>()

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

    // 任务运行标签页：**按店铺复用**（此前每个 run 新建一个、从不回收——实测一天下来
    // 堆了 10 个渲染进程、约 1.5GB 内存）。复用不影响步骤正确性：抖店流程第 1 步就是
    // navigate、微信流程第 1 步是 mirrorTabUrl，都会把页面重新加载到目标地址。
    if (!run.tabId || !getTabWebContents(run.storeId, run.tabId)) {
      const reusedId = runTabByStore.get(run.storeId)
      if (reusedId && getTabWebContents(run.storeId, reusedId)) {
        run.tabId = reusedId
      } else {
        const firstNavigate = run.steps.find(s => s.type === 'navigate')
        run.tabId = createTab(run.storeId, (firstNavigate?.input as any)?.url || 'about:blank')
        runTabByStore.set(run.storeId, run.tabId)
      }
    }
    // 运行标签页带到前台（activateTab 已在 mirrorTabUrl 里做过，navigate 流程此前漏了）：
    // 复用的标签页若不是店铺窗口的当前页，视图视口是 0——getBoundingClientRect 全为 0，
    // 可见性判定与点击都会失真（实测"点开始邀约"首轮就失败的帮凶之一）
    try { activateTab(run.storeId, run.tabId) } catch { /* 视图未挂载等情况不阻塞流程 */ }

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
  // 微信小店（assist-form）流程专属：邀约页未打开 / 受信任写入未生效
  if (msg.includes('TASK_INVITE_PAGE_NOT_OPEN')) return 'TASK_INVITE_PAGE_NOT_OPEN'
  if (msg.includes('TASK_INPUT_NOT_APPLIED')) return 'TASK_INPUT_NOT_APPLIED'
  // 额度预检不过（微信今日剩余不足 / 抖店确认发送禁用等）
  if (msg.includes('TASK_QUOTA_EXCEEDED')) return 'TASK_QUOTA_EXCEEDED'
  // 广场可选达人不足（要 40 位但池子里只有更少）——发送前中止，别发错数量
  if (msg.includes('TASK_SELECTION_SHORTFALL')) return 'TASK_SELECTION_SHORTFALL'
  // 店铺浏览器/任务标签页被关闭（此前落进 INTERNAL_ERROR，看不出真实原因）
  if (msg.includes('BROWSER_CLOSED')) return 'BROWSER_CLOSED'
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

/** 轮询等待选择器出现；超时抛 TASK_SELECTOR_CHANGED（区别于纯超时）。
 *  deep = 穿透 ShadowRoot 查询（微信小店整页在 <micro-app shadowdom> 里，普通 querySelector 不可见） */
async function waitForSelector(wc: Electron.WebContents, sel: string, run: RunHandle, timeoutMs: number, deep = false): Promise<void> {
  const expr = deep
    ? `(() => { ${ENUM_DEEP_FN} return __enumDeep().some(el => { try { return el.matches(${JSON.stringify(sel)}) } catch { return false } }) })()`
    : `!!document.querySelector(${JSON.stringify(sel)})`
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

// ---------- ShadowRoot 穿透与受信任输入（微信小店 assist-form 流程的基础设施） ----------

/**
 * 枚举主文档与所有开放 ShadowRoot 的元素（文档序深度优先，宿主先于其 Shadow 内容）。
 * 以字符串注入 executeJavaScript 使用；只声明注入脚本自身的常量，不碰页面全局。
 */
const ENUM_DEEP_FN = `
  const __enumDeep = () => {
    const out = []
    const walk = (r) => {
      for (const el of r.querySelectorAll('*')) {
        out.push(el)
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    return out
  }
`

/**
 * 元素可见性判据（微信的弹窗节点常预渲染在 DOM 里，仅靠存在性判断会被隐藏节点骗过）。
 */
const VISIBLE_JS = `
  const __visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
`

/** 按自有文本定位可见目标（取最短命中），滚动到可见并返回真实点击坐标 */
/**
 * 候选排序：先按"自身文本最短"（最具体的那个），长度相同的再优先"看起来可点的标签"。
 * 实测动机：容器元素常常和里面的按钮拥有**同样的自身文本**（如 <div>达人等级
 * <button>达人等级</button></div>），只按长度排会先命中容器——点容器是个空操作，
 * 后续步骤就找不到本该出现的元素（仿真站点验证时踩到）。
 */
const PICK_SORT_FN = `
  const __clickableScore = (el) => {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'LABEL' || tag === 'SELECT') return 0;
    if (el.getAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab')) return 0;
    if (/btn|button|chip|tab|option|item|link/i.test(String(el.className || ''))) return 1;
    return 2;
  };
  const __pickBest = (cands) => {
    cands.sort((a, b) => (a.len - b.len) || (__clickableScore(a.el) - __clickableScore(b.el)));
    return cands[0];
  };
`

/**
 * 查找范围限定（clickByText / waitForText 的 within）。
 * 实测动机（抖店广场）：类目名同时出现在筛选 chip 与达人卡片的类目文案里，
 * "不限"在等级下拉里也有同名项——不限定范围就会点错目标，筛选静默失效。
 */
const SCOPE_FN = `
  const __scopeRoot = (w) => {
    if (!w) return null;
    let root = null;
    if (w.selector) root = document.querySelector(w.selector);
    else {
      const cands = [];
      for (const el of document.querySelectorAll('*')) {
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        if (own === w.text || (own.includes(w.text) && own.length <= w.text.length + 12)) cands.push({ el, len: own.length });
      }
      if (cands.length) { cands.sort((a, b) => a.len - b.len); root = cands[0].el }
    }
    if (!root) return null;
    for (let i = 0; i < (w.climb || 0); i++) { if (!root.parentElement) break; root = root.parentElement }
    return root;
  }
`

async function findTextTarget(
  wc: Electron.WebContents, run: RunHandle, needle: string, deep: boolean, timeoutMs: number, label: string,
  within?: { selector?: string; text?: string; climb?: number }
): Promise<{ ok: boolean; reason?: string; x?: number; y?: number; clickedText?: string; candidates?: number }> {
  return withTimeout(() => wc.executeJavaScript(`(() => {
    ${deep ? ENUM_DEEP_FN : ''}
    ${VISIBLE_JS}
    ${SCOPE_FN}
    ${PICK_SORT_FN}
    const needle = ${JSON.stringify(needle)};
    const within = ${JSON.stringify(within || null)};
    const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
    const root = within ? __scopeRoot(within) : null;
    if (within && !root) return { ok: false, reason: 'SCOPE_NOT_FOUND' };
    const cands = [];
    for (const el of scope) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (!own.includes(needle)) continue;
      if (root && !root.contains(el)) continue;
      if (!__visible(el)) continue;
      cands.push({ el, len: own.length });
    }
    if (!cands.length) return { ok: false, reason: 'NOT_FOUND' };
    cands.sort((a, b) => (a.len - b.len) || (__clickableScore(a.el) - __clickableScore(b.el)));
    const hit = cands[0].el;
    let dis = hit.disabled === true || hit.getAttribute('aria-disabled') === 'true';
    let p = hit.parentElement;
    for (let i = 0; i < 3 && p && !dis; i++, p = p.parentElement) {
      if (/disabled/i.test(String(p.className || ''))) dis = true;
    }
    if (dis) return { ok: false, reason: 'DISABLED' };
    hit.scrollIntoView({ block: 'center' });
    const r = hit.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickedText: String(hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), candidates: cands.length };
  })()`), run, timeoutMs, label)
}

/** 在 (x,y) 发受信任鼠标点击（走浏览器输入管线，页面收到 isTrusted 事件） */
function realClick(wc: Electron.WebContents, x: number, y: number): void {
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

/**
 * 受信任文本写入：真实点击聚焦 → Ctrl+A 全选 → Delete → insertText（IME 同管线）→ 回读校验。
 * 微信表单不吃合成 input 事件（实测：原生 setter + dispatchEvent 后计数器/按钮状态不动），
 * 所以 setInput 的 JS 写入路径对它无效，必须走这里。
 * 校验不过如实抛 TASK_INPUT_NOT_APPLIED——绝不假装写入成功。
 */
async function trustedWrite(
  wc: Electron.WebContents, run: RunHandle, sel: string, deep: boolean, text: string, timeoutMs: number, label: string
): Promise<void> {
  const findEl = deep
    ? `(() => { ${ENUM_DEEP_FN} return __enumDeep().find(el => { try { return el.matches(${JSON.stringify(sel)}) } catch { return false } }) || null })()`
    : `(document.querySelector(${JSON.stringify(sel)}))`
  const located = await withTimeout(() => wc.executeJavaScript(`(() => {
    const el = ${findEl};
    if (!el) return { ok: false, reason: 'NOT_FOUND' };
    ${VISIBLE_JS}
    if (!__visible(el)) return { ok: false, reason: 'INVISIBLE' };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: 'ZERO_RECT' };
    return { ok: true, x: Math.round(r.left + Math.min(r.width / 2, Math.max(r.width - 6, 1))), y: Math.round(r.top + r.height / 2) };
  })()`), run, timeoutMs, `${label} 定位`)
  if (!located || !located.ok) {
    throw new Error(`TASK_SELECTOR_CHANGED: ${label} 目标不可用（${located && located.reason || 'UNKNOWN'}）${sel}`)
  }
  guardSignals(run)

  // 同内容重写是幂等的，允许一次整体重试吸收偶发竞态（忙机焦点/输入管线滞后）
  let lastDiag = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    // 点击后必须等焦点真正落到目标上再发键盘事件：忙时点击的聚焦会慢于后续按键，
    // Ctrl+A/Delete 会打到上一个字段、insertText 落空（实测复现过）。轮询确认，兜底 JS focus。
    // 注意 ShadowRoot 内的元素要看 getRootNode().activeElement——document.activeElement
    // 只会返回 shadow 宿主，永远不相等（微信整页在 shadow 里，实测踩过）。
    let focused = 'no'
    for (let i = 0; i < 3 && focused !== 'yes'; i++) {
      realClick(wc, located.x, located.y)
      await new Promise(r => setTimeout(r, 220))
      guardSignals(run)
      focused = await wc.executeJavaScript(`(() => {
        const el = ${findEl};
        if (!el) return 'GONE';
        const root = el.getRootNode ? el.getRootNode() : null;
        const active = (root && root.activeElement) || document.activeElement;
        return active === el ? 'yes' : 'no';
      })()`).catch(() => 'ERR')
    }
    if (focused !== 'yes') {
      const jsFocused = await wc.executeJavaScript(`(() => {
        const el = ${findEl};
        if (!el) return false;
        el.focus();
        const root = el.getRootNode ? el.getRootNode() : null;
        const active = (root && root.activeElement) || document.activeElement;
        return active === el;
      })()`).catch(() => false)
      if (!jsFocused) throw new Error(`TASK_SELECTOR_CHANGED: ${label} 无法聚焦写入目标 ${sel}`)
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' })
    // Electron 30 的类型标注是 void，实际会 resolve boolean；只对明确的 false 判失败
    const inserted = await wc.insertText(text) as unknown
    if (inserted === false) {
      throw new Error(`TASK_INPUT_NOT_APPLIED: ${label} insertText 未被接受（目标可能不可编辑）${sel}`)
    }
    await new Promise(r => setTimeout(r, 200))
    const chk = await withTimeout(() => wc.executeJavaScript(`(() => {
      const el = ${findEl};
      if (!el) return JSON.stringify({ val: null, focused: false });
      const root = el.getRootNode ? el.getRootNode() : null;
      const active = (root && root.activeElement) || document.activeElement;
      return JSON.stringify({ val: el.isContentEditable ? String(el.textContent || '') : String(el.value ?? ''), focused: active === el, activeTag: active ? active.tagName + (active.id ? '#' + active.id : '') : 'none' });
    })()`), run, timeoutMs, `${label} 回读`).then(s => JSON.parse(s)).catch(() => ({ val: null, focused: false, activeTag: 'ERR' }))
    if (chk.val === text) { guardSignals(run); return }
    lastDiag = `页面值 ${String(chk.val ?? '').length} 字（前20:${String(chk.val ?? '').slice(0, 20).replace(/\s+/g, ' ')}）焦点=${chk.focused ? '在目标' : '在 ' + (chk.activeTag || '?')} 期望 ${text.length} 字`
    logMain('warn', `[task-runner] ${label} 写入校验未过（第 ${attempt + 1} 次）：${lastDiag}`)
  }
  throw new Error(`TASK_INPUT_NOT_APPLIED: ${label} 写入未生效（${lastDiag}）`)
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
      await waitForSelector(wc, String(input.selector), run, step.timeoutMs, !!input.deep)
      return null
    }
    case 'readText': {
      const wc = wcOrThrow(run)
      const deep = !!input.deep
      await waitForSelector(wc, String(input.selector), run, step.timeoutMs, deep)
      const findEl = deep
        ? `(() => { ${ENUM_DEEP_FN} return __enumDeep().find(el => { try { return el.matches(${JSON.stringify(String(input.selector))}) } catch { return false } }) || null })()`
        : `(document.querySelector(${JSON.stringify(String(input.selector))}))`
      const text = await wc.executeJavaScript(`(() => {
        const el = ${findEl};
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
      const deepTable = !!input.deep
      await waitForSelector(wc, String(input.selector), run, step.timeoutMs, deepTable)
      const findTable = deepTable
        ? `(() => { ${ENUM_DEEP_FN} return __enumDeep().find(el => { try { return el.matches(${JSON.stringify(String(input.selector))}) } catch { return false } }) || null })()`
        : `(document.querySelector(${JSON.stringify(String(input.selector))}))`
      const rows = await wc.executeJavaScript(`(() => {
        const el = ${findTable};
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
      // 取文本最短的命中项（最具体的那个），再向上找可点击祖先。
      // deep = ShadowRoot 穿透；mode:'real' = 定位后发受信任鼠标点击
      // （微信对框架托管的按钮/复选框，合成 click() 不生效或点到隐藏克隆上，实测必须真实输入）。
      // 轮询式：SPA 的筛选区/按钮常在导航完成后才渲染（抖店广场实测踩过：单发点击必然撞空），
      // 在步骤超时内每 300ms 重找一次；找到即点，禁用态立即如实失败。
      const wc = wcOrThrow(run)
      const needle = String(input.text)
      const deep = !!input.deep
      const within = input.within as { selector?: string; text?: string; climb?: number } | undefined
      guardSignals(run)
      const deadline = Date.now() + step.timeoutMs
      let sawScopeMiss = false
      let hit: Awaited<ReturnType<typeof findTextTarget>> | null = null
      if (input.mode === 'real') {
        for (;;) {
          guardSignals(run)
          hit = await findTextTarget(wc, run, needle, deep, step.timeoutMs, 'clickByText', within)
          if (hit.ok) break
          if (hit.reason === 'DISABLED') {
            throw new Error(`TASK_TARGET_DISABLED: 「${needle}」当前为禁用态（平台限制该操作）`)
          }
          // SCOPE_NOT_FOUND 不能立即失败：导航刚完成时筛选区往往还没渲染出来
          // （实测真店"点开始邀约"就折在这里——第一步点类目时 .quick-filter-button-enums 还不存在）。
          // 与"没找到元素"一样在超时内轮询等待，超时仍没有才算真的找不到。
          sawScopeMiss = sawScopeMiss || hit.reason === 'SCOPE_NOT_FOUND'
          if (Date.now() >= deadline) {
            if (sawScopeMiss) {
              throw new Error(`TASK_SELECTOR_CHANGED: 超时内未出现「${needle}」的限定范围（${JSON.stringify(within)}）`)
            }
            throw new Error(`TASK_SELECTOR_CHANGED: 页面上找不到文案为「${needle}」的可点击元素`)
          }
          await new Promise(r => setTimeout(r, 300))
        }
        guardSignals(run)
        realClick(wc, hit.x!, hit.y!)
        guardSignals(run)
        return { kind: 'executed', payload: { action: 'clickByText', matched: needle, clickedText: hit.clickedText, candidates: hit.candidates, mode: 'real' } }
      }
      for (;;) {
        guardSignals(run)
        const res = await withTimeout(() => wc.executeJavaScript(`(() => {
        ${deep ? ENUM_DEEP_FN : ''}
        ${SCOPE_FN}
        ${PICK_SORT_FN}
        const needle = ${JSON.stringify(needle)};
        const within = ${JSON.stringify(within || null)};
        const root = within ? __scopeRoot(within) : null;
        if (within && !root) return { ok: false, reason: 'SCOPE_NOT_FOUND' };
        const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
        const cands = [];
        for (const el of scope) {
          const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
          if (!own.includes(needle)) continue;
          if (root && !root.contains(el)) continue;
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          cands.push({ el, len: own.length });
        }
        if (!cands.length) return { ok: false, reason: 'NOT_FOUND' };
        cands.sort((a, b) => (a.len - b.len) || (__clickableScore(a.el) - __clickableScore(b.el)));
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
      })()`), run, Math.min(step.timeoutMs, 10000), 'clickByText')
        if (res && res.ok) {
          guardSignals(run)
          return { kind: 'executed', payload: { action: 'clickByText', matched: needle, clickedText: res.clickedText, candidates: res.candidates } }
        }
        if (res && res.reason === 'DISABLED') {
          throw new Error(`TASK_TARGET_DISABLED: 「${needle}」当前为禁用态（平台限制该操作）`)
        }
        // SCOPE_NOT_FOUND 同样轮询等待（导航刚完成时筛选区可能还没渲染，见 mode:'real' 分支的说明）
        sawScopeMiss = sawScopeMiss || (res && res.reason === 'SCOPE_NOT_FOUND')
        if (Date.now() >= deadline) {
          if (sawScopeMiss) {
            throw new Error(`TASK_SELECTOR_CHANGED: 超时内未出现「${needle}」的限定范围（${JSON.stringify(within)}）`)
          }
          throw new Error(`TASK_SELECTOR_CHANGED: 页面上找不到文案为「${needle}」的可点击元素`)
        }
        await new Promise(r => setTimeout(r, 300))
      }
    }
    case 'loop': {
      // 批次循环（复合作步骤）：把一轮完整动作重复执行到"该停了"为止。
      // 用途：抖店达人邀约——一轮 = 进广场 → 选类目/等级 → 勾 40 位 → 批量邀约 → 确认发送，
      // 循环到**邀约额度用完**（确认发送变禁用 → TASK_QUOTA_EXCEEDED）或**可选达人不足 40**
      // （TASK_SELECTION_SHORTFALL）为止——这两种都算**正常收尾**（stopOn 命中即干净停止，run 仍成功）。
      // 其它错误照常向上抛，run 如实失败（绝不吞错、也绝不把"跑了一半"报成成功）。
      //
      // 说明：本步骤不套 withTimeout——单轮耗时由嵌套步骤各自的超时约束，整体时长由 maxRounds 封顶；
      // 嵌套步骤不单独落库（只发进度事件），整轮的汇总写进本步骤的 payload，界面/日志能看明白跑到第几轮。
      const nestedRaw = Array.isArray(input.steps) ? input.steps : []
      // 运行时兜底补超时：早于创建侧修复建的任务，嵌套步骤可能没有 timeoutMs
      // （undefined → withTimeout(NaN)，真店实测报「clickByText 超过 NaNms」）
      const nested = (nestedRaw as TaskStepDef[]).map(c => ({
        ...c,
        timeoutMs: Number(c?.timeoutMs) > 0 ? Number(c.timeoutMs) : (DEFAULT_STEP_TIMEOUT[c.type] ?? 15000)
      }))
      if (!nested.length) throw new Error('TASK_INVALID_STEP: loop 缺少 steps')
      const maxRounds = Number(input.maxRounds)
      const stopOn: string[] = Array.isArray(input.stopOn) ? input.stopOn.map(String) : []
      const loopLabel = input.label ? String(input.label) : `${nested.length} 步`
      const parentIndex = run.steps.indexOf(step)
      const summary: any[] = []
      let completedRounds = 0
      let stopReason: string | null = null
      let lastArtifact: { path: string; sha256: string } | undefined
      for (let round = 1; round <= maxRounds; round++) {
        guardSignals(run)
        const startedAt = Date.now()
        let childIdx = 0
        let childType = ''
        try {
          for (childIdx = 0; childIdx < nested.length; childIdx++) {
            const child = nested[childIdx]
            childType = child.type
            guardSignals(run)
            emitProgress(run, { phase: 'started', stepIndex: parentIndex, stepType: child.type, message: `第 ${round}/${maxRounds} 轮 · ${loopLabel}` })
            const out = await execStep(run, child)
            if (out?.artifact) lastArtifact = out.artifact
            if (run.deniedByConfirm) break
          }
          if (run.deniedByConfirm) break
          completedRounds = round
          summary.push({ round, ok: true, ms: Date.now() - startedAt })
          emitProgress(run, { phase: 'succeeded', stepIndex: parentIndex, stepType: step.type, message: `第 ${round} 轮完成` })
        } catch (e: any) {
          // 取消/暂停信号照常向上抛（由外层统一处理状态迁移）
          if (e?.name === 'CancelSignal' || e?.name === 'PauseSignal') throw e
          const code = classifyError(e)
          if (stopOn.includes(code)) {
            stopReason = code
            summary.push({ round, ok: false, stop: code, message: String(e?.message || e).slice(0, 240), ms: Date.now() - startedAt })
            emitProgress(run, { phase: 'succeeded', stepIndex: parentIndex, stepType: step.type, message: `第 ${round} 轮按预期停止：${code}` })
            break
          }
          // 其他错误照常失败，但把"第几轮、哪个子步骤"带进消息——否则只看到子步骤报错，不知道跑到哪了
          throw new Error(`LOOP_ROUND_FAILED: 第 ${round}/${maxRounds} 轮（子步骤 ${childIdx + 1}/${nested.length} ${childType}）失败：${String(e?.message || e)}`)
        }
      }
      guardSignals(run)
      return {
        kind: 'executed',
        payload: {
          action: 'loop',
          label: loopLabel,
          maxRounds,
          completedRounds,
          stopReason,
          stopOn,
          rounds: summary
        },
        artifact: lastArtifact
      }
    }
    case 'clickAll': {
      // 批量点击并跳过不可用项：达人选人时"已发过消息"的行复选框是 disabled，必须跳过而不是硬点；
      // 同时受平台单次上限约束（max 已由 Zod 限到 40）。点击之间留间隔，避免与框架重渲染打架。
      //
      // 2026-09-13 真店实测修三个问题（抖店达人广场"要勾 40 位却只勾中 1 位/勾不满"）：
      //  ① **轮询等待表格渲染**：此步骤原为单发——筛选后表格尚未排完版时行高为 0，会被判"不可见"
      //     全部跳过（实测 15 项里 14 项被跳过、只点中 1 项）。现在每轮先等到有"可点的新行"再点；
      //  ② **滚动续选**（input.scroll=true）：广场列表是虚拟滚动（.auxo-table-body，无分页），
      //     一屏只渲染 ~19 行，装不下 40 位；点完当前窗口向下滚动、等新行渲染再继续。
      //     注意容器带 `scroll-behavior: smooth`，赋完 scrollTop 立刻读回还是旧值，必须强制
      //     auto 并等位置落定——否则"有没有滚动"恒判 false，续选一轮就退出（实测踩过）；
      //  ③ **勾选数必须与页面自认一致**：虚拟列表会回收行节点，某些行"表格模型已选中但复选框
      //     渲染还没同步"，照 DOM 的 checked 判断就会把已选行点反选（实测点 40 次、页面只认 35）。
      //     现在按行的 data-row-key 去重（同一行只碰一次），每点一次回读页面自己的
      //     「已选择 N 位达人」，没让计数增加就再点一次纠正；并把页面计数当作权威值，
      //     勾不满就在发送前如实失败（TASK_SELECTION_SHORTFALL），绝不按错的位数发出去。
      const wc = wcOrThrow(run)
      const sel = input.selector ? String(input.selector) : ''
      const txt = input.text ? String(input.text) : ''
      const max = Number(input.max)
      const scroll = !!input.scroll
      const maxRounds = input.maxRounds == null ? 25 : Number(input.maxRounds)
      const deadline = Date.now() + step.timeoutMs
      // 页面自己的权威计数（抖店广场："已选择 N 位达人"；没有则为 null → 退回按点击数判断）
      const counterExpr = `(() => {
        const re = /\\u5df2\\u9009\\u62e9\\s*(\\d+)\\s*\\u4f4d\\u8fbe\\u4eba/;
        for (const el of document.querySelectorAll('div,span,p,b,strong,em')) {
          const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
          if (t.length > 40) continue;
          const m = re.exec(t);
          if (m) return Number(m[1]);
        }
        return null;
      })()`
      const initialSelected: number | null = await wc.executeJavaScript(counterExpr).catch(() => null)
      let pageSelected: number | null = initialSelected
      let counterKnown = typeof initialSelected === 'number'
      const seenKeys: string[] = []
      const batchExpr = (seen: string[], limit: number) => `(async () => {
        const SEL = ${JSON.stringify(sel)}, TXT = ${JSON.stringify(txt)}, LIMIT = ${limit};
        const seen = new Set(${JSON.stringify(seen)});
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const read = () => { try {
          const re = /\\u5df2\\u9009\\u62e9\\s*(\\d+)\\s*\\u4f4d\\u8fbe\\u4eba/;
          for (const el of document.querySelectorAll('div,span,p,b,strong,em')) {
            const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
            if (t.length > 40) continue;
            const m = re.exec(t);
            if (m) return Number(m[1]);
          }
          return null;
        } catch { return null } };
        let els = [];
        if (SEL) els = Array.from(document.querySelectorAll(SEL));
        else {
          for (const el of document.querySelectorAll('*')) {
            const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
            if (own.includes(TXT)) els.push(el);
          }
        }
        const clicked = [], seenNew = [];
        let skippedDisabled = 0, skippedInvisible = 0, skippedChecked = 0, retried = 0, corrected = 0;
        for (const el of els) {
          if (clicked.length >= LIMIT) break;
          const row = el.closest('tr') || el.parentElement;
          // 行 key 是去重的锚：虚拟列表重渲染后同一行只点一次，避免把已选行点反选
          const key = (row && row.getAttribute && row.getAttribute('data-row-key')) ||
            String((row || el).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
          if (!key) continue;
          if (seen.has(key)) { skippedChecked++; continue }
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) { skippedInvisible++; continue }
          let dis = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
          let p = el.parentElement;
          for (let i = 0; i < 3 && p && !dis; i++, p = p.parentElement) {
            if (/disabled/i.test(String(p.className || ''))) dis = true;
          }
          if (dis) { skippedDisabled++; continue }
          seen.add(key); seenNew.push(key);
          const label = el.closest('label, [class*="checkbox"]') || el;
          const before = read();
          label.click();
          await sleep(240);
          let after = read();
          let didRetry = false;
          // 页面计数没涨 = 这次没选上（或被反选）→ 再点一次纠正，然后如实记录结果
          if (before != null && after != null && after <= before) {
            didRetry = true; retried++;
            label.click();
            await sleep(240);
            after = read();
            if (after != null && after > before) corrected++;
          }
          clicked.push({
            key: key.slice(0, 40),
            name: String((row || el).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
            delta: (before != null && after != null) ? after - before : null,
            retried: didRetry
          });
        }
        return { ok: true, clicked, seenNew, skippedDisabled, skippedInvisible, skippedChecked, retried, corrected, total: els.length, pageSelected: read() };
      })()`
      // 滚动：从首个目标元素向上找可滚动祖先，向下滚一屏的 95%。
      // 必须先强制 scroll-behavior:auto，否则 smooth 动画期间读到的是旧 scrollTop，"滚没滚"永远判 false。
      const scrollExpr = `(async () => {
        const SEL = ${JSON.stringify(sel)}, TXT = ${JSON.stringify(txt)};
        let first = null;
        if (SEL) first = document.querySelector(SEL);
        else {
          for (const el of document.querySelectorAll('*')) {
            const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
            if (own.includes(TXT)) { first = el; break }
          }
        }
        let box = null;
        if (first) {
          let node = first;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 20 && node.clientHeight > 120) { box = node; break }
            node = node.parentElement;
          }
        }
        if (!box) box = document.querySelector('.auxo-table-body, [class*="table-body"]');
        if (!box) return { moved: false, reason: 'NO_SCROLLER' };
        const before = Math.round(box.scrollTop);
        const maxTop = Math.max(0, box.scrollHeight - box.clientHeight);
        box.style.scrollBehavior = 'auto';
        const target = Math.min(maxTop, before + Math.floor(box.clientHeight * 0.95));
        box.scrollTop = target;
        let settle = -1;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 80));
          const now = Math.round(box.scrollTop);
          if (Math.abs(now - target) <= 2) { settle = now; break }
          if (now === settle) break
          settle = now;
        }
        const at = Math.round(box.scrollTop);
        return { moved: at > before + 5, before, scrollTop: at, maxTop: Math.round(maxTop), scrollHeight: box.scrollHeight, clientHeight: box.clientHeight, atBottom: at >= maxTop - 3 };
      })()`
      const probeExpr = (seen: string[]) => `(() => {
        const SEL = ${JSON.stringify(sel)}, TXT = ${JSON.stringify(txt)};
        const seen = new Set(${JSON.stringify(seen)});
        let els = [];
        if (SEL) els = Array.from(document.querySelectorAll(SEL));
        else {
          for (const el of document.querySelectorAll('*')) {
            const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
            if (own.includes(TXT)) els.push(el);
          }
        }
        let vis = 0, usable = 0;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          vis++;
          const row = el.closest('tr') || el.parentElement;
          const key = (row && row.getAttribute && row.getAttribute('data-row-key')) ||
            String((row || el).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
          let dis = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
          let p = el.parentElement;
          for (let i = 0; i < 3 && p && !dis; i++, p = p.parentElement) if (/disabled/i.test(String(p.className || ''))) dis = true;
          if (!dis && !seen.has(key)) usable++;
        }
        return { total: els.length, vis, usable };
      })()`

      let totalClicked = 0, skippedDisabled = 0, skippedInvisible = 0, skippedChecked = 0, retried = 0, corrected = 0
      const samples: string[] = []
      let rounds = 0, scrolled = 0, stalls = 0
      let lastScrollHeight = 0
      let exhausted = false
      /** 权威进度：页面有计数就信页面，没有才退回数自己的点击数 */
      const progress = () => (counterKnown ? (pageSelected ?? 0) - (initialSelected ?? 0) : totalClicked)
      for (let round = 0; round < maxRounds; round++) {
        guardSignals(run)
        rounds++
        // 等表格把行渲染出来：出现"可点的新行"就开工；可见数稳定且没有新行则不再空等
        let lastVisible = -1
        for (;;) {
          guardSignals(run)
          const probe: any = await wc.executeJavaScript(probeExpr(seenKeys)).catch(() => ({ total: 0, vis: 0, usable: 0 }))
          if (probe.usable > 0) break
          if (Date.now() >= deadline) break
          if (probe.vis === lastVisible && probe.vis > 0) break
          lastVisible = probe.vis
          await new Promise(r => setTimeout(r, 300))
        }
        // 单轮点击数严格等于"还差几位"：曾给 +5 余量，结果一批勾了 45 位而不是 40 位
        // （用户要求"一次勾 40 位"，多勾就是发错数量）；纠偏重试不额外计数，不需要余量
        const limit = Math.max(1, max - progress())
        const res: any = await withTimeout(() => wc.executeJavaScript(batchExpr(seenKeys, limit)), run, step.timeoutMs, 'clickAll')
        if (!res || !res.ok) throw new Error(`TASK_SELECTOR_CHANGED: 批量点击未执行（${sel || txt}）`)
        seenKeys.push(...(res.seenNew || []))
        totalClicked += (res.clicked || []).length
        skippedDisabled = Math.max(skippedDisabled, res.skippedDisabled)
        skippedInvisible = Math.max(skippedInvisible, res.skippedInvisible)
        skippedChecked += res.skippedChecked || 0
        retried += res.retried || 0
        corrected += res.corrected || 0
        for (const c of res.clicked || []) if (samples.length < 8) samples.push(c.name)
        if (typeof res.pageSelected === 'number') { pageSelected = res.pageSelected; counterKnown = true }
        if (progress() >= max) break
        if (Date.now() >= deadline) break
        if (!scroll) { exhausted = true; break }
        const sc: any = await wc.executeJavaScript(scrollExpr).catch(() => ({ moved: false }))
        if (!sc || !sc.moved) {
          // 不一定真到底：虚拟列表/懒加载会在滚到底后再追加内容。等一会儿看高度有没有长，
          // 长了说明还有货、继续；连着几次都不长才算池子真的完了（不空转、也不早退）。
          await new Promise(r => setTimeout(r, 1500))
          const h: number = await wc.executeJavaScript(`(() => { const b = document.querySelector('.auxo-table-body, [class*="table-body"]'); return b ? b.scrollHeight : 0 })()`).catch(() => 0)
          const grew = h > lastScrollHeight + 50
          lastScrollHeight = Math.max(lastScrollHeight, h)
          if (!grew) { stalls++; if (stalls >= 3) { exhausted = true; break } } else stalls = 0
          const after: any = await wc.executeJavaScript(probeExpr(seenKeys)).catch(() => ({ usable: 0 }))
          if (!after || after.usable === 0) { exhausted = true; break }
          continue
        }
        scrolled++
        lastScrollHeight = Math.max(lastScrollHeight, Number(sc.scrollHeight) || 0)
        await new Promise(r => setTimeout(r, 700)) // 等虚拟列表把新行渲染出来
      }
      guardSignals(run)
      const selected = progress()
      if (totalClicked === 0 && selected <= 0) {
        throw new Error(`TASK_SELECTOR_CHANGED: 没有可用的目标（可见 ${skippedInvisible} 项不可见、${skippedDisabled} 项禁用，共 ${rounds} 轮）`)
      }
      // 勾不满就必须在门禁之前如实失败：用户要的是 max 位，少勾还照发就是发错数量
      if (selected < max) {
        throw new Error(`TASK_SELECTION_SHORTFALL: 本次只勾中 ${selected} 位（要求 ${max} 位；${exhausted ? '当前筛选下的可选达人已全部勾完' : '扫描未完成'}，其中 ${skippedDisabled} 位已邀约/禁用）。请减少本批数量或调整筛选项后重试`)
      }
      return { kind: 'executed', payload: { action: 'clickAll', target: sel || txt, clicked: totalClicked, pageSelected, initialSelected, selected, skippedDisabled, skippedInvisible, skippedChecked, retried, corrected, rounds, scrolled, requested: max, exhausted, samples } }
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
      const deep = !!input.deep
      if (srcSel) await waitForSelector(wc, srcSel, run, step.timeoutMs, deep)
      guardSignals(run)
      // srcSel 留空 = 平台的"商品区"定位不到稳定选择器时的如实降级：从写入目标（话术框）向上
      // 找最近的固定定位浮层（邀约抽屉），只读抽屉文本；找不到就报 AI_EMPTY_SOURCE，
      // 绝不把整页噪音（达人列表、菜单）当商品信息喂给模型
      const src = await withTimeout(() => wc.executeJavaScript(`(() => {
        const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        ${deep ? ENUM_DEEP_FN : ''}
        ${srcSel
          ? `const el = ${deep
            ? `__enumDeep().find(e => { try { return e.matches(${JSON.stringify(srcSel)}) } catch { return false } }) || null`
            : `document.querySelector(${JSON.stringify(srcSel)})`};
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

      // deep（微信小店）= 受信任输入写入（微信表单不吃合成 input 事件）；否则保持受控组件 JS 写入
      if (deep) {
        await trustedWrite(wc, run, sel, true, generated.script, step.timeoutMs, 'aiGenerate 写入')
        // §4.5：payload 只存摘要（模型名/长度/来源字符数/前 40 字预览）；
        // 完整话术由紧随其后的 readText 步骤落库，便于事后审计"到底发了什么"
        return {
          kind: 'executed',
          payload: {
            action: 'aiGenerate', model: generated.model, length: generated.script.length,
            sourceChars: generated.sourceChars, sourceHow: src.how,
            sourceSelector: srcSel || null, preview: generated.script.slice(0, 40), writeMode: 'trusted'
          }
        }
      }
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
    // ---------- 微信小店（assist-form 流程） ----------
    case 'mirrorTabUrl': {
      // 人工已在店铺浏览器进到某达人的邀约表单页（URL 含 urlIncludes）；
      // 引擎把运行标签页导航到同一 URL——列表 DOM 拿不到 finderUsername，选人必须人工完成。
      const marker = String(input.urlIncludes)
      guardSignals(run)
      const others = getStoreTabs(run.storeId).filter(t => t.id !== run.tabId)
      let mirrored: string | null = null
      for (const t of others) {
        const live = getTabWebContents(run.storeId, t.id)
        const u = live && !live.isDestroyed() ? live.getURL() : t.url
        if (u.includes(marker)) { mirrored = u; break }
      }
      if (!mirrored) {
        throw new Error(`TASK_INVITE_PAGE_NOT_OPEN: 店铺浏览器里没有已打开且 URL 含「${marker}」的页面——请先手动进到达人的邀约表单页，再运行任务`)
      }
      const target = mirrored
      const wc = wcOrThrow(run)
      await withTimeout(async () => {
        guardSignals(run)
        try {
          await wc.loadURL(target)
        } catch (e: any) {
          if (!/ERR_ABORTED/.test(String(e?.message))) throw e
        }
      }, run, step.timeoutMs, 'mirrorTabUrl')
      await pollUntil(run, () => !wcOrThrow(run).isLoading(), Math.max(step.timeoutMs, 5000), 'mirrorTabUrl 加载完成')
      // 运行标签页带到前台：门禁阶段用户核对的就是这一页
      try { activateTab(run.storeId, run.tabId!) } catch { /* 视图未挂载等情况不阻塞流程 */ }
      // §4.5：payload 只存 origin+path——query 里有 finderUsername 等 token，不落库
      let originPath = target
      try { const u = new URL(target); originPath = u.origin + u.pathname } catch { /* 保底原样 */ }
      return { kind: 'executed', payload: { action: 'mirrorTabUrl', url: originPath } }
    }
    case 'typeText': {
      // 受信任文本写入（见 trustedWrite 注释）：点击聚焦 → Ctrl+A → Delete → insertText → 回读校验
      const wc = wcOrThrow(run)
      await waitForSelector(wc, String(input.selector), run, step.timeoutMs, !!input.deep)
      await trustedWrite(wc, run, String(input.selector), !!input.deep, String(input.text ?? ''), step.timeoutMs, 'typeText')
      // §4.5：payload 只存摘要与长度，不存写入的完整文本
      return { kind: 'executed', payload: { action: 'typeText', selector: String(input.selector), length: String(input.text ?? '').length } }
    }
    case 'waitForText': {
      // 等「可见元素的自有文本」包含 text。waitForSelector 只查存在性，而微信的弹窗
      // 节点常预渲染在 DOM 里（隐藏态也查得到），必须以可见文本为准。
      const wc = wcOrThrow(run)
      const needle = String(input.text)
      const deep = !!input.deep
      const within = input.within as { selector?: string; text?: string; climb?: number } | undefined
      await withTimeout(async () => {
        for (;;) {
          guardSignals(run)
          const found = await wc.executeJavaScript(`(() => {
            ${deep ? ENUM_DEEP_FN : ''}
            ${VISIBLE_JS}
            ${SCOPE_FN}
            const needle = ${JSON.stringify(needle)};
            const within = ${JSON.stringify(within || null)};
            const root = within ? __scopeRoot(within) : null;
            if (within && !root) return false;
            const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
            for (const el of scope) {
              const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
              if (!own.includes(needle)) continue;
              if (root && !root.contains(el)) continue;
              if (__visible(el)) return true;
            }
            return false;
          })()`).catch(() => false)
          if (found) return
          await new Promise(r => setTimeout(r, 300))
        }
      }, run, step.timeoutMs, `等待文本「${needle}」`)
      guardSignals(run)
      return null
    }
    case 'ensureRows': {
      // 确保"页面可见行数"≥ min：已有则原样不动（payload 报 added:0）；
      // 没有才点 addText 入口 → 等弹窗复选框 → 勾选未选项（≤max，真实点击）→
      // 点 confirmText → 复核行数。自适应在于避免对"已有商品"的页面重复添加。
      const wc = wcOrThrow(run)
      const deep = !!input.deep
      const min = input.min == null ? 1 : Number(input.min)
      const max = Number(input.max)
      const countRowsExpr = `(() => {
        ${deep ? ENUM_DEEP_FN : ''}
        const sel = ${JSON.stringify(String(input.rowsSelector))};
        let n = 0;
        for (const el of ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'}) {
          try { if (!el.matches(sel)) continue } catch { continue }
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          n++;
        }
        return n;
      })()`
      guardSignals(run)
      let present = await withTimeout(() => wc.executeJavaScript(countRowsExpr).catch(() => 0), run, step.timeoutMs, 'ensureRows 计数')
      if (present >= min) {
        return { kind: 'executed', payload: { action: 'ensureRows', present, added: 0 } }
      }
      const addHit = await findTextTarget(wc, run, String(input.addText), deep, step.timeoutMs, 'ensureRows 打开添加入口')
      if (!addHit.ok) throw new Error(`TASK_SELECTOR_CHANGED: 找不到「${String(input.addText)}」入口（${addHit.reason}）`)
      realClick(wc, addHit.x!, addHit.y!)
      await new Promise(r => setTimeout(r, 600))
      guardSignals(run)
      await waitForSelector(wc, String(input.checkboxSelector), run, step.timeoutMs, deep)
      const boxes = await withTimeout(() => wc.executeJavaScript(`(() => {
        ${deep ? ENUM_DEEP_FN : ''}
        const sel = ${JSON.stringify(String(input.checkboxSelector))};
        const out = [];
        for (const el of ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'}) {
          try { if (!el.matches(sel)) continue } catch { continue }
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          const input = el.querySelector('input[type=checkbox]');
          out.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), checked: input ? !!input.checked : false });
        }
        return out;
      })()`), run, step.timeoutMs, 'ensureRows 找复选框')
      let added = 0
      for (const b of boxes) {
        if (added >= max) break
        if (b.checked) continue
        guardSignals(run)
        realClick(wc, b.x, b.y)
        added++
        await new Promise(r => setTimeout(r, 200))
      }
      if (added === 0) {
        throw new Error('TASK_SELECTOR_CHANGED: 没有可勾选的行（弹窗内没有未选中项）——请人工确认平台是否还有可添加内容')
      }
      const confirmHit = await findTextTarget(wc, run, String(input.confirmText), deep, step.timeoutMs, 'ensureRows 确认')
      if (!confirmHit.ok) throw new Error(`TASK_SELECTOR_CHANGED: 找不到「${String(input.confirmText)}」确认按钮（${confirmHit.reason}）`)
      realClick(wc, confirmHit.x!, confirmHit.y!)
      await new Promise(r => setTimeout(r, 800))
      guardSignals(run)
      present = await withTimeout(() => wc.executeJavaScript(countRowsExpr).catch(() => 0), run, step.timeoutMs, 'ensureRows 复核')
      if (present < min) {
        throw new Error(`TASK_SELECTOR_CHANGED: 确认后页面仍未见 ${min} 行（当前 ${present}）——请人工确认内容是否添加成功`)
      }
      return { kind: 'executed', payload: { action: 'ensureRows', present, added } }
    }
    case 'ensureRowsById': {
      // 按商品ID在邀约商品弹窗中逐项搜索并勾选（微信小店流程：用户指定ID，系统代填）。
      // 与 ensureRows 不同：不是"勾前N个未选项"，而是"找到匹配 ID 的行并勾上"。
      const wc = wcOrThrow(run)
      const deep = !!input.deep
      const ids = Array.isArray(input.productIds) ? input.productIds.map(String) : []
      if (!ids.length) throw new Error('TASK_INVALID_STEP: ensureRowsById 缺少 productIds')
      const addHit = await findTextTarget(wc, run, String(input.addText), deep, step.timeoutMs, 'ensureRowsById 打开添加入口')
      if (!addHit.ok) throw new Error(`TASK_SELECTOR_CHANGED: 找不到「${String(input.addText)}」入口（${addHit.reason}）`)
      realClick(wc, addHit.x!, addHit.y!)
      await new Promise(r => setTimeout(r, 600))
      guardSignals(run)
      await waitForSelector(wc, String(input.checkboxSelector), run, step.timeoutMs, deep)
      const boxes = await withTimeout(() => wc.executeJavaScript(`(() => {
        ${deep ? ENUM_DEEP_FN : ''}
        ${VISIBLE_JS}
        const sel = ${JSON.stringify(String(input.checkboxSelector))};
        const ids = ${JSON.stringify(ids)};
        const out = [];
        for (const el of ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'}) {
          try { if (!el.matches(sel)) continue } catch { continue }
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          // 商品 ID 在行内的其它单元格里，不在复选框自身上——必须按"所在行"的文本匹配
          // （实测：只看复选框 innerText 会永远匹配不到）
          const row = el.closest('tr') || el.parentElement || el;
          const rowText = String(row.innerText || '');
          if (!ids.some(id => rowText.includes(id))) continue;
          const input = el.querySelector('input[type=checkbox]');
          out.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), checked: input ? !!input.checked : false, text: rowText.slice(0, 40) });
        }
        return out;
      })()`), run, step.timeoutMs, 'ensureRowsById 搜索匹配行')
      if (!boxes.length) {
        throw new Error(`TASK_SELECTOR_CHANGED: 弹窗中未找到匹配商品ID「${ids.join(', ')}」的行——请确认商品ID正确且已上架`)
      }
      let added = 0
      for (const b of boxes) {
        if (b.checked) continue
        guardSignals(run)
        realClick(wc, b.x, b.y)
        added++
        await new Promise(r => setTimeout(r, 200))
      }
      const confirmHit = await findTextTarget(wc, run, String(input.confirmText), deep, step.timeoutMs, 'ensureRowsById 确认')
      if (!confirmHit.ok) throw new Error(`TASK_SELECTOR_CHANGED: 找不到「${String(input.confirmText)}」确认按钮（${confirmHit.reason}）`)
      realClick(wc, confirmHit.x!, confirmHit.y!)
      await new Promise(r => setTimeout(r, 800))
      guardSignals(run)
      const countRowsExpr = `(() => {
        ${deep ? ENUM_DEEP_FN : ''}
        const sel = ${JSON.stringify(String(input.rowsSelector))};
        let n = 0;
        for (const el of ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'}) {
          try { if (!el.matches(sel)) continue } catch { continue }
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          n++;
        }
        return n;
      })()`
      const present = await withTimeout(() => wc.executeJavaScript(countRowsExpr).catch(() => 0), run, step.timeoutMs, 'ensureRowsById 复核')
      return { kind: 'executed', payload: { action: 'ensureRowsById', requested: ids.length, added, present } }
    }
    case 'requireQuota': {
      // 额度预检（读型）：可见元素自有文本含 textIncludes → 提取第一个数字 → ≥ min 放行。
      // 微信小店「今日剩余N次邀请机会」是平台唯一明示的额度口径；optional=true 时平台
      // 不展示额度文案也算通过（payload 如实记录），绝不猜测、不虚构额度。
      const wc = wcOrThrow(run)
      const marker = String(input.textIncludes)
      const min = Number(input.min)
      const deep = !!input.deep
      const optional = !!input.optional
      const deadline = Date.now() + step.timeoutMs
      let found: string | null = null
      for (;;) {
        guardSignals(run)
        found = await wc.executeJavaScript(`(() => {
          ${deep ? ENUM_DEEP_FN : ''}
          const marker = ${JSON.stringify(marker)};
          for (const el of ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'}) {
            const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
            if (!own.includes(marker)) continue;
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
            return own;
          }
          return null;
        })()`).catch(() => null)
        if (found != null) break
        if (Date.now() >= deadline) break
        await new Promise(r => setTimeout(r, 300))
      }
      guardSignals(run)
      if (found == null) {
        if (optional) return { kind: 'executed', payload: { action: 'requireQuota', present: false, min } }
        throw new Error(`TASK_SELECTOR_CHANGED: 页面上找不到含「${marker}」的额度文案（平台可能已改版）`)
      }
      const m = /\d+/.exec(found)
      const quota = m ? parseInt(m[0], 10) : NaN
      if (!Number.isFinite(quota)) {
        throw new Error(`TASK_QUOTA_EXCEEDED: 额度文案「${found.slice(0, 60)}」里没有可识别的数字，无法确认可邀约额度`)
      }
      if (input.metric) {
        TaskStore.insertSnapshot(run.storeId, String(input.metric), quota, run.runId)
      }
      if (quota < min) {
        throw new Error(`TASK_QUOTA_EXCEEDED: 可邀约额度不足——页面显示「${found.slice(0, 60)}」（需要 ≥ ${min}），本次邀约已按你的要求在发送前中止`)
      }
      return { kind: 'executed', payload: { action: 'requireQuota', present: true, quota, min, text: found.slice(0, 60) } }
    }
    case 'requireEnabled': {
      // 可用性预检（读型）：找文案为 text 的可见按钮，禁用态如实失败。
      // 抖店不在页面展示剩余邀约额度数字；额度用尽/平台限制的表现是「确认发送」变禁用——
      // 在打开抽屉后、填话术与门禁之前先校验，额度不足时快速如实失败，不浪费一轮人工确认。
      const wc = wcOrThrow(run)
      const needle = String(input.text)
      const deep = !!input.deep
      const hint = input.hint ? String(input.hint) : ''
      const deadline = Date.now() + step.timeoutMs
      for (;;) {
        guardSignals(run)
        const hit = await findTextTarget(wc, run, needle, deep, Math.min(step.timeoutMs, 10000), 'requireEnabled')
        if (hit.ok) {
          return { kind: 'executed', payload: { action: 'requireEnabled', text: needle, clickedText: hit.clickedText, candidates: hit.candidates, enabled: true } }
        }
        if (hit.reason === 'DISABLED') {
          throw new Error(`TASK_QUOTA_EXCEEDED: 「${needle}」当前为禁用态——可邀约额度已用尽或平台限制该操作${hint ? '（' + hint + '）' : ''}，本次邀约在发送前中止`)
        }
        if (Date.now() >= deadline) {
          throw new Error(`TASK_SELECTOR_CHANGED: 页面上找不到文案为「${needle}」的按钮（${hint || '平台可能已改版'}）`)
        }
        await new Promise(r => setTimeout(r, 300))
      }
    }
    case 'readLabelValue': {
      // 按标签文案读指标值：找可见元素（自有文本 === label）→ 向上找最近"文本比 label 只多一小段"
      // 的祖先 → 多出来的那段就是值。卡片类名普遍带构建哈希（快手 kpro-data / 微信 weui 实测），
      // 以文案为锚才能在平台改版时"要么读对、要么如实报错"，而不是读到别的数字。
      const wc = wcOrThrow(run)
      const label = String(input.label)
      const deep = !!input.deep
      const maxLen = input.maxValueLen == null ? 40 : Number(input.maxValueLen)
      const deadline = Date.now() + step.timeoutMs
      let res: any = null
      for (;;) {
        guardSignals(run)
        res = await wc.executeJavaScript(`(() => {
          ${deep ? ENUM_DEEP_FN : ''}
          ${VISIBLE_JS}
          const label = ${JSON.stringify(label)};
          const MAX = ${maxLen};
          const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
          const cands = [];
          for (const el of scope) {
            const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
            if (!own.includes(label)) continue;
            if (!__visible(el)) continue;
            cands.push({ el, len: own.length });
          }
          if (!cands.length) return { ok: false, reason: 'NOT_FOUND' };
          cands.sort((a, b) => (a.len - b.len) || (__clickableScore(a.el) - __clickableScore(b.el)));
          let node = cands[0].el;
          // 向上找"比标签只多出一小段文本"的最近祖先（= 指标卡片本体）
          for (let i = 0; i < 6 && node && node !== document.body; i++) {
            const txt = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
            if (txt.length > label.length) {
              const value = txt.replace(label, '').trim();
              if (value && value.length <= MAX) return { ok: true, value, cardText: txt.slice(0, 60) };
              if (value && value.length > MAX) return { ok: false, reason: 'VALUE_TOO_LONG', cardText: txt.slice(0, 80) };
            }
            node = node.parentElement;
          }
          return { ok: false, reason: 'NO_VALUE_SIBLING' };
        })()`).catch(() => ({ ok: false, reason: 'ERR' }))
        if (res && res.ok) break
        if (Date.now() >= deadline) {
          throw new Error(res && res.reason === 'VALUE_TOO_LONG'
            ? `TASK_SELECTOR_CHANGED: 「${label}」向上找到的容器文本过长（${String(res.cardText).slice(0, 60)}）——页面结构已改，未取到单值`
            : `TASK_SELECTOR_CHANGED: 页面上读不到「${label}」对应的值（${res && res.reason}）`)
        }
        await new Promise(r => setTimeout(r, 300))
      }
      guardSignals(run)
      // 卡片文本常带"较上期/比上周 X%"等对比噪音（实测快手指标卡）：只取开头的"数字（可带货币
      // 符号与万/亿）"作为指标值，其余丢弃——绝不把对比数字当成指标值。
      const raw = String(res.value)
      const m = /^[¥￥$€]?\s*[\d,]+(?:\.\d+)?\s*(?:万|亿)?/.exec(raw)
      // 作为"指标"落库时必须真的取到数字：取不到如实失败，绝不把 "(退款时间)" 这类文字当指标值存进数据中心
      if (input.metric && !m) {
        throw new Error(`TASK_SELECTOR_CHANGED: 「${label}」旁取到的不是数值（${raw.slice(0, 40)}）——页面结构或文案已变，未落库`)
      }
      const shown = (m ? m[0] : raw).replace(/\s+/g, '').slice(0, 40)
      let num = parseFloat(shown.replace(/[^\d.]/g, ''))
      if (Number.isFinite(num) && shown.includes('亿')) num *= 1e8
      else if (Number.isFinite(num) && shown.includes('万')) num *= 1e4
      if (input.metric) {
        TaskStore.insertSnapshot(run.storeId, String(input.metric), Number.isFinite(num) ? num : shown, run.runId)
      }
      return { kind: 'text', payload: { text: shown, rawText: raw.slice(0, 60), label, cardText: res.cardText, metric: input.metric || null } }
    }
    case 'waitMs': {
      // 显式等待：SPA 按新周期/筛选重新取数时，数值是原地刷新（元素早就在），
      // 任何"等元素出现"的判据都会立刻命中旧值——只能显式等。分段 sleep 以支持暂停/取消。
      const total = Number(input.ms)
      const deadline = Date.now() + total
      while (Date.now() < deadline) {
        guardSignals(run)
        await new Promise(r => setTimeout(r, Math.min(300, Math.max(50, deadline - Date.now()))))
      }
      guardSignals(run)
      return { kind: 'executed', payload: { action: 'waitMs', ms: total } }
    }
    case 'waitForGone': {
      // 等元素消失或不可见（提交类动作的结果校验）：抽屉没关就说明提交没被平台接受，
      // 如实失败——绝不以"点过了"代替"发出去了"。
      const wc = wcOrThrow(run)
      const sel = String(input.selector)
      const deep = !!input.deep
      const goneExpr = `(() => {
        ${deep ? ENUM_DEEP_FN : ''}
        ${VISIBLE_JS}
        const el = ${deep
          ? `__enumDeep().find(e => { try { return e.matches(${JSON.stringify(sel)}) } catch { return false } }) || null`
          : `document.querySelector(${JSON.stringify(sel)})`};
        if (!el) return true;
        return !__visible(el);
      })()`
      await withTimeout(async () => {
        for (;;) {
          guardSignals(run)
          const gone = await wc.executeJavaScript(goneExpr).catch(() => false)
          if (gone) return
          await new Promise(r => setTimeout(r, 300))
        }
      }, run, step.timeoutMs, `等待元素消失 ${sel}`)
      guardSignals(run)
      return { kind: 'executed', payload: { action: 'waitForGone', selector: sel } }
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
