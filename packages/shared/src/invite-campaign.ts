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
  /** 已排期，等主进程调度器到点拉起（2026-10-20 定时邀约） */
  'scheduled',
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
  /** 排期时间（毫秒）；未排期为 null */
  scheduledAt: number | null
  /** 批次层的原因（排期被取消、到点额度不足等），与 stopReason（引擎停止码）分开 */
  statusReason: string | null
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
    /**
     * 定时启动（毫秒时间戳）。传了就不立即入队：批次状态为 scheduled，
     * 到点由主进程调度器拉起；中途可取消。不传 = 立即启动。
     */
    scheduleAt?: number | null
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

/**
 * 达人库 / 话术库 / 商品集的行视图（主进程 invite-creators / invite-assets 服务返回）。
 *
 * 之前渲染层（CreatorInvitePage）手写过一份字段较少的副本，和服务返回结构重复：
 * 服务加字段时副本不会跟着变，页面拿到的类型是"看起来对但少了字段"的假象，挪到这里单一事实来源。
 */
/** 达人库行（creator_profiles 表的视图） */
export interface CreatorView {
  id: string
  storeId: string
  platform: string
  creatorKey: string
  identityLevel: InviteIdentityLevel
  nickname: string
  finderUsername: string | null
  tags: string[]
  note: string | null
  blacklisted: boolean
  blacklistReason: string | null
  lastStatus: string | null
  lastInvitedAt: number | null
  inviteCount: number
  firstSeenAt: number
  lastSeenAt: number
}

/** 话术库行（invite_scripts 表的视图） */
export interface InviteScriptView {
  id: string
  storeId: string
  platform: string
  name: string
  mode: 'manual' | 'ai'
  template: string
  maxLen: number | null
  status: string
  createdAt: number
  updatedAt: number
}

/** 商品集行（invite_product_sets 表的视图） */
export interface InviteProductSetView {
  id: string
  storeId: string
  platform: string
  name: string
  productIds: string[]
  createdAt: number
  updatedAt: number
}
