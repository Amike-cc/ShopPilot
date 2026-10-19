/**
 * 工作台通知中心的数据装配（纯函数，2026-10-17）。
 *
 * 顶栏通知按钮此前只弹一句「通知中心暂未接入独立页面」——但界面已经有真实的
 * 待办来源：达人邀约运行状态、客服未读消息。这里只做**已有的真实状态**
 * 到通知条目的映射，不生成推测内容；没有数据时返回空数组（界面显示「暂无通知」）。
 */

export type WorkbenchNotificationTone = 'info' | 'warning' | 'error'
export type WorkbenchNotificationTarget = 'customer-service' | 'creator-invite'

export interface WorkbenchNotificationItem {
  id: string
  kind: 'invite_waiting' | 'invite_active' | 'invite_failed' | 'invite_finished' | 'customer_unread'
  title: string
  detail: string
  tone: WorkbenchNotificationTone
  target: WorkbenchNotificationTarget
  at: number | null
}

export interface NotificationTaskLike {
  id: string
  name?: string | null
  /** 迁移 v33：creator_invite = 达人邀约；缺省时回退名称前缀（旧数据） */
  kind?: string | null
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
const MAX_FINISHED = 3
const DEFAULT_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000
const SEVERITY: Record<WorkbenchNotificationTone, number> = { error: 0, warning: 1, info: 2 }

function isInviteTask(task: NotificationTaskLike): boolean {
  return task.kind === 'creator_invite' || String(task.name || '').trim().startsWith('达人邀约 ·')
}

/** 通知标题里不再重复「达人邀约 · 」前缀：达人邀约「抖店 · 美妆 · 最多 40 位」 */
function inviteName(task: NotificationTaskLike): string {
  const name = String(task.name || '').trim() || `达人邀约 ${String(task.id || '').slice(0, 8)}`
  return name.replace(/^达人邀约\s*·\s*/, '')
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
    const invite = isInviteTask(task)
    if (!invite) continue
    items.push({
      id: `invite:${task.id}:${run.id || status}`,
      kind: waiting ? 'invite_waiting' : 'invite_active',
      title: `达人邀约「${inviteName(task)}」${waiting ? '等待确认' : STATUS_LABELS[status] || '进行中'}`,
      detail: waiting
        ? '需要你在达人邀约页确认后才会继续'
        : '可在达人邀约页查看批次进度与逐人记录',
      tone: waiting ? 'warning' : 'info',
      target: 'creator-invite',
      at: Number.isFinite(run.startedAt) ? Number(run.startedAt) : null
    })
  }

  const failed: WorkbenchNotificationItem[] = []
  for (const task of input.tasks || []) {
    const run = task?.latestRun
    if (!run || String(run.status || '') !== 'failed') continue
    const at = Number.isFinite(run.finishedAt) ? Number(run.finishedAt) : Number.isFinite(run.startedAt) ? Number(run.startedAt) : null
    if (at == null || now - at > windowMs) continue
    const invite = isInviteTask(task)
    if (!invite) continue
    failed.push({
      id: `invite:${task.id}:${run.id || 'failed'}`,
      kind: 'invite_failed',
      title: `达人邀约「${inviteName(task)}」失败`,
      detail: String(run.statusReason || '').trim().slice(0, 120) || '可到达人邀约页查看日志与失败步骤',
      tone: 'error',
      target: 'creator-invite',
      at
    })
  }
  failed.sort((a, b) => (b.at || 0) - (a.at || 0))
  items.push(...failed.slice(0, MAX_FAILED))

  /**
   * 邀约成功终态：额度用尽/候选不足不是"失败"，但需要用户知道"停在哪、发了多少"。
   * 只取 24h 内最近 3 条，避免把历史批次一直挂在通知里。
   */
  const finished: WorkbenchNotificationItem[] = []
  for (const task of input.tasks || []) {
    if (!isInviteTask(task)) continue
    const run = task?.latestRun
    if (!run || String(run.status || '') !== 'succeeded') continue
    const at = Number.isFinite(run.finishedAt) ? Number(run.finishedAt) : Number.isFinite(run.startedAt) ? Number(run.startedAt) : null
    if (at == null || now - at > windowMs) continue
    const detail = String(run.statusReason || '').trim().slice(0, 120) || '可查看逐人记录'
    finished.push({
      id: `invite:${task.id}:${run.id || 'finished'}`,
      kind: 'invite_finished',
      title: `达人邀约「${inviteName(task)}」已结束`,
      detail,
      tone: /额度|候选|TASK_QUOTA|SHORTFALL|EXHAUSTED/.test(detail) ? 'warning' : 'info',
      target: 'creator-invite',
      at
    })
  }
  finished.sort((a, b) => (b.at || 0) - (a.at || 0))
  items.push(...finished.slice(0, MAX_FINISHED))

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
