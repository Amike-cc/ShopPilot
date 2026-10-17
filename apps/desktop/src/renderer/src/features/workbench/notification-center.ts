/**
 * 工作台通知中心的数据装配（纯函数，2026-10-17）。
 *
 * 顶栏通知按钮此前只弹一句「通知中心暂未接入独立页面」——但界面已经有真实的
 * 待办来源：进行中/待确认/失败的任务、客服未读消息。这里只做**已有的真实状态**
 * 到通知条目的映射，不生成推测内容；没有数据时返回空数组（界面显示「暂无通知」）。
 */

export type WorkbenchNotificationTone = 'info' | 'warning' | 'error'
export type WorkbenchNotificationTarget = 'tasks' | 'customer-service'

export interface WorkbenchNotificationItem {
  id: string
  kind: 'task_active' | 'task_waiting' | 'task_failed' | 'customer_unread'
  title: string
  detail: string
  tone: WorkbenchNotificationTone
  target: WorkbenchNotificationTarget
  at: number | null
}

export interface NotificationTaskLike {
  id: string
  name?: string | null
  latestRun?: {
    id?: string | null
    status?: string | null
    statusReason?: string | null
    startedAt?: number | null
    finishedAt?: number | null
  } | null
}

const ACTIVE_STATUSES = new Set(['queued', 'running', 'paused', 'waiting_confirmation'])
const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '正在运行',
  paused: '已暂停',
  waiting_confirmation: '等待人工确认'
}
const MAX_ITEMS = 8
const MAX_FAILED = 3
const DEFAULT_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000
const SEVERITY: Record<WorkbenchNotificationTone, number> = { error: 0, warning: 1, info: 2 }

function taskName(task: NotificationTaskLike): string {
  const name = String(task.name || '').trim()
  return name || `任务 ${String(task.id || '').slice(0, 8)}`
}

/**
 * @param tasks 工作台任务列表（ws.tasks 的子集即可）
 * @param customerUnread 客服未读总数（0/负数视为无未读）
 * @param now 注入时间便于单测；默认 Date.now()
 * @param failedWindowMs 失败通知的时间窗（默认 24h）——避免把几个月前的失败一直挂在通知里
 */
export function buildWorkbenchNotifications(input: {
  tasks: NotificationTaskLike[]
  customerUnread?: number
  now?: number
  failedWindowMs?: number
}): WorkbenchNotificationItem[] {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now()
  const windowMs = Number.isFinite(input.failedWindowMs) && Number(input.failedWindowMs) > 0
    ? Number(input.failedWindowMs)
    : DEFAULT_FAILED_WINDOW_MS
  const items: WorkbenchNotificationItem[] = []

  for (const task of input.tasks || []) {
    const run = task?.latestRun
    const status = String(run?.status || '')
    if (!run || !ACTIVE_STATUSES.has(status)) continue
    const waiting = status === 'waiting_confirmation'
    items.push({
      id: `task:${task.id}:${run.id || status}`,
      kind: waiting ? 'task_waiting' : 'task_active',
      title: waiting ? `任务「${taskName(task)}」等待确认` : `任务「${taskName(task)}」${STATUS_LABELS[status] || '进行中'}`,
      detail: waiting ? '需要你在任务中心确认后才会继续' : '可在任务中心查看进度或暂停',
      tone: waiting ? 'warning' : 'info',
      target: 'tasks',
      at: Number.isFinite(run.startedAt) ? Number(run.startedAt) : null
    })
  }

  const failed: WorkbenchNotificationItem[] = []
  for (const task of input.tasks || []) {
    const run = task?.latestRun
    if (!run || String(run.status || '') !== 'failed') continue
    const at = Number.isFinite(run.finishedAt) ? Number(run.finishedAt) : Number.isFinite(run.startedAt) ? Number(run.startedAt) : null
    if (at == null || now - at > windowMs) continue
    failed.push({
      id: `task:${task.id}:${run.id || 'failed'}`,
      kind: 'task_failed',
      title: `任务「${taskName(task)}」运行失败`,
      detail: String(run.statusReason || '').trim().slice(0, 120) || '可到任务中心查看失败原因并重试',
      tone: 'error',
      target: 'tasks',
      at
    })
  }
  failed.sort((a, b) => (b.at || 0) - (a.at || 0))
  items.push(...failed.slice(0, MAX_FAILED))

  const unread = Math.max(0, Math.floor(Number(input.customerUnread) || 0))
  if (unread > 0) {
    items.push({
      id: 'customer:unread',
      kind: 'customer_unread',
      title: `客服有 ${unread > 99 ? '99+' : unread} 条未读消息`,
      detail: '打开电商客服工作区查看会话',
      tone: 'warning',
      target: 'customer-service',
      at: null
    })
  }

  return items
    .sort((a, b) => SEVERITY[a.tone] - SEVERITY[b.tone] || (b.at || 0) - (a.at || 0))
    .slice(0, MAX_ITEMS)
}
