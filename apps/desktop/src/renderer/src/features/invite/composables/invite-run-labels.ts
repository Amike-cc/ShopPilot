import type {
  InviteCampaignStatus,
  InviteCampaignView,
  InviteRecordStatus,
  InviteRecordView
} from '@shared/invite-campaign'

/**
 * 邀约运行/记录的展示文案（纯函数）。
 *
 * 之前侧栏日志行直接打印引擎日志，重启后内存日志消失就只剩「等待运行输出」；
 * 批次/记录一旦改为从库里读，就必须有一套稳定的中文字典——放这里，组件只负责渲染。
 */
export const INVITE_CAMPAIGN_STATUS_LABELS: Record<InviteCampaignStatus, string> = {
  draft: '草稿',
  ready: '准备启动',
  scheduled: '已排期',
  running: '运行中',
  waiting: '等待确认',
  paused: '已暂停',
  completed: '已完成',
  exhausted: '已结束（候选用尽）',
  stopped: '已停止',
  failed: '执行失败'
}

export const INVITE_RECORD_STATUS_LABELS: Record<InviteRecordStatus, string> = {
  queued: '排队',
  selected: '已选中',
  opening: '打开中',
  sending: '发送中',
  sent: '已发出',
  inviting: '邀请中',
  accepted: '已接受',
  rejected: '已拒绝',
  expired: '已过期',
  skipped_already_invited: '跳过·近 7 天已邀',
  skipped_not_invitable: '跳过·不满足条件',
  failed_open: '失败·页面打不开',
  failed_send: '失败·发送未成功',
  unknown: '结果未知'
}

export function inviteCampaignStatusLabel(status: string | null | undefined): string {
  return INVITE_CAMPAIGN_STATUS_LABELS[status as InviteCampaignStatus] || '状态未知'
}

export function inviteRecordStatusLabel(status: string | null | undefined): string {
  return INVITE_RECORD_STATUS_LABELS[status as InviteRecordStatus] || String(status || '状态未知')
}

/** 记录行着色：成功/邀请中为绿、跳过为黄、失败为红，未知保持默认色。 */
export function inviteRecordToneClass(status: string | null | undefined): string {
  const value = String(status || '')
  if (value.startsWith('failed_')) return 'log-fail'
  // unknown = 点击已发生但平台没回读，不等于失败；用黄色提醒人工核对，不吓成红色。
  if (value === 'unknown') return 'log-skip'
  if (value.startsWith('skipped_')) return 'log-skip'
  if (['sent', 'inviting', 'accepted'].includes(value)) return 'log-ok'
  return ''
}

/** 逐人记录行：时间 + 昵称 + 状态 + 原因。 */
export function inviteRecordLineText(record: Pick<InviteRecordView, 'nickname' | 'status' | 'statusReason' | 'invitedAt' | 'createdAt'>): string {
  const at = Number(record.invitedAt || record.createdAt || 0)
  const time = at > 0 ? new Date(at).toLocaleTimeString([], { hour12: false }) : ''
  const nickname = String(record.nickname || '').trim() || '未命名达人'
  const reason = String(record.statusReason || '').trim()
  return `${time ? `[${time}] ` : ''}${nickname} · ${inviteRecordStatusLabel(record.status)}${reason ? ` · ${reason}` : ''}`
}

/** 「最近批次」下拉的一行：时间 · 状态 · 已发/目标。 */
export function inviteCampaignOptionText(campaign: Pick<InviteCampaignView, 'createdAt' | 'status' | 'sentCount' | 'targetCount'>): string {
  const at = Number(campaign.createdAt) || 0
  const time = at > 0
    ? new Date(at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    : '时间未知'
  return `${time} · ${inviteCampaignStatusLabel(campaign.status)} · ${Number(campaign.sentCount) || 0}/${Number(campaign.targetCount) || 0}`
}

/** 批次摘要：目标/已发/跳过/失败/未知；为零的项不占行宽。 */
export function inviteCampaignCountsText(campaign: Pick<InviteCampaignView, 'targetCount' | 'sentCount' | 'skippedCount' | 'failedCount' | 'unknownCount'>): string {
  const parts = [`目标 ${Number(campaign.targetCount) || 0}`, `已发 ${Number(campaign.sentCount) || 0}`]
  if (Number(campaign.skippedCount) > 0) parts.push(`跳过 ${campaign.skippedCount}`)
  if (Number(campaign.failedCount) > 0) parts.push(`失败 ${campaign.failedCount}`)
  if (Number(campaign.unknownCount) > 0) parts.push(`未知 ${campaign.unknownCount}`)
  return parts.join(' · ')
}
