import type { AgentUiStatus } from './job-status'

export type ConversationTone = 'neutral' | 'info' | 'pending' | 'success' | 'danger'

export type ConversationMessage = {
  id?: string
  at?: number
  role: 'user' | 'assistant'
  text: string
  thought?: boolean
  meta?: string
}

const STATUS_LABELS: Record<string, string> = {
  idle: '就绪',
  thinking: '思考中',
  observing: '观察页面',
  plan_ready: '计划待确认',
  validating: '校验计划',
  creating_task: '准备执行',
  executing_software: '操作软件中',
  running: '执行中',
  paused: '已暂停',
  waiting_confirmation: '等待确认',
  succeeded: '已完成',
  failed: '需要处理',
  cancelled: '已取消',
  recovery_required: '需要恢复',
  blocked_budget: '预算受阻',
  blocked_permission: '权限受阻',
  not_verified: '未验证'
}

export function conversationStatusLabel(status: string | AgentUiStatus): string {
  return STATUS_LABELS[status] || status
}

export function conversationStatusTone(status: string | AgentUiStatus): ConversationTone {
  if (['succeeded'].includes(status)) return 'success'
  if (['failed', 'cancelled', 'recovery_required', 'blocked_budget', 'blocked_permission'].includes(status)) return 'danger'
  if (['thinking', 'observing', 'creating_task', 'executing_software', 'running'].includes(status)) return 'info'
  if (['waiting_confirmation', 'plan_ready', 'paused', 'not_verified'].includes(status)) return 'pending'
  return 'neutral'
}

export function messageRoleLabel(message: ConversationMessage): string {
  if (message.role === 'user') return '你'
  if (message.thought) return '分析过程'
  return 'root-ceo'
}

export function messageTone(message: ConversationMessage): ConversationTone {
  if (message.role === 'user') return 'info'
  if (message.thought) return 'neutral'
  const text = message.text.toLowerCase()
  if (/失败|未完成|错误|阻塞|恢复|未验证|not_verified/.test(text)) return 'danger'
  if (/确认|等待|待审核|需要你/.test(text)) return 'pending'
  if (/完成|成功|已读取|已观察/.test(text)) return 'success'
  return 'neutral'
}

export function groupThoughtMessages(messages: ConversationMessage[]): Array<ConversationMessage | { thoughtGroup: ConversationMessage[] }> {
  const output: Array<ConversationMessage | { thoughtGroup: ConversationMessage[] }> = []
  let group: ConversationMessage[] = []
  const flush = () => {
    if (group.length) output.push({ thoughtGroup: group })
    group = []
  }
  for (const message of messages) {
    if (message.thought) group.push(message)
    else { flush(); output.push(message) }
  }
  flush()
  return output
}

export function recoveryHint(status: string, errorMessage?: string | null): string {
  if (status === 'recovery_required') return '先回读平台状态，再选择安全恢复或取消；不要盲目重试。'
  if (status === 'blocked_permission') return '检查店铺、平台能力和人工确认权限后，再重新派发。'
  if (status === 'blocked_budget') return '检查 Agent 日预算或模型配置，再决定是否重新运行。'
  return errorMessage || '查看 Job 事件和证据后决定下一步。'
}
