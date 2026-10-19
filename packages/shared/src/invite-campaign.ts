/**
 * 达人邀约 v2 的共享契约（2026-10-19）。
 *
 * 只放**渲染层/主进程都要用**的类型，不放 SQL 与业务实现：
 *   · Campaign = 一次「邀谁、邀多少、用什么话术/商品」的计划；
 *   · InviteRecord = 某位达人的逐人结果（引擎真实发出的证据）；
 *   · InviteSummary = 工作台 KPI 的只读汇总。
 *
 * 红线：状态必须带来源（local/platform/manual）。平台没回读就是 unknown，
 * 不根据「列表里没出现」推断「已过期」。
 */
import type { TaskCreateInput, TaskRunView, TaskView } from './schemas/task'
import type { InviteIdentityLevel } from './invite-identity'

export const INVITE_CAMPAIGN_STATUSES = [
  'draft',
  'ready',
  'running',
  'paused',
  'completed',
  'exhausted',
  'stopped',
  'failed'
] as const
export type InviteCampaignStatus = (typeof INVITE_CAMPAIGN_STATUSES)[number]

export const INVITE_RECORD_STATUSES = [
  'queued',
  'selected',
  'opening',
  'sending',
  'sent',
  'inviting',
  'accepted',
  'rejected',
  'expired',
  'skipped_already_invited',
  'skipped_not_invitable',
  'failed_open',
  'failed_send',
  'unknown'
] as const
export type InviteRecordStatus = (typeof INVITE_RECORD_STATUSES)[number]

export type InviteStatusSource = 'local' | 'platform' | 'manual'

export interface InviteCampaignView {
  id: string
  storeId: string
  storeName: string | null
  platform: string
  name: string
  status: InviteCampaignStatus
  targetCount: number
  sentCount: number
  skippedCount: number
  failedCount: number
  unknownCount: number
  taskId: string | null
  runId: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  /** 引擎停止码（如 TASK_QUOTA_EXCEEDED / TASK_SELECTION_SHORTFALL），没有就是 null */
  stopReason: string | null
  filters: Record<string, unknown> | null
  scriptText: string | null
  productIds: string[]
  createdBy: string
}

export interface InviteRecordView {
  id: string
  campaignId: string | null
  campaignName: string | null
  storeId: string
  storeName: string | null
  platform: string
  creatorKey: string
  identityLevel: InviteIdentityLevel
  nickname: string
  finderUsername: string | null
  status: InviteRecordStatus
  statusSource: InviteStatusSource
  statusReason: string | null
  scriptText: string | null
  productIds: string[]
  taskId: string | null
  runId: string | null
  invitedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface InviteSummary {
  /** 今天（本地时区）发出去的条数 */
  todaySent: number
  /** 近 7 天发出去的条数 */
  recentSent: number
  accepted: number
  rejected: number
  unknown: number
  total: number
}

export interface InviteCampaignDetail {
  campaign: InviteCampaignView
  task: TaskView | null
  run: TaskRunView | null
  records: InviteRecordView[]
  summary: InviteSummary
}

/** 面板/智能体启动一次邀约：任务载荷 + 批次元数据。任务与批次由主进程同一事务路径创建。 */
export interface InviteCampaignStartInput {
  task: TaskCreateInput
  campaign: {
    storeId: string
    /** 目标人数（面板的每批数量 / 微信的本次最多邀约） */
    targetCount: number
    /** 配置快照（筛选、联系方式等）；只做留档，不参与执行 */
    filters?: Record<string, unknown>
    scriptText?: string
    productIds?: string[]
    createdBy?: string
    /** 预留：direct=点开始即真实发送；confirm=启动前再确认一次 */
    sendMode?: 'direct' | 'confirm'
  }
}

export interface InviteCampaignListInput {
  storeId?: string
  limit?: number
}

export interface InviteRecordListInput {
  storeId?: string
  campaignId?: string
  status?: string
  limit?: number
  offset?: number
}
