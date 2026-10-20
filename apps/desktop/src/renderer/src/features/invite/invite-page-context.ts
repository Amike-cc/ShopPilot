/**
 * 达人邀约独立页的页面级上下文。
 *
 * 为什么用 provide/inject 而不是逐层 props：页面有 5 个页签 + 抽屉，它们共享同一批
 * ref（批次/记录/达人库/资产）与动作（打开详情、改状态、删除资产）。逐层传 props
 * 会让页面壳变成一个巨大的参数中转站；把「同一份页面 API」注入下去，页签组件只声明
 * 自己用到的那几个字段，页面壳保持薄。
 *
 * 约定：注入的是**原始 ref 与函数**，子组件在 setup 顶层解构后，模板仍会自动解包并
 * 保持响应性（不要把它包成 reactive 再解构，否则会丢响应性）。
 */
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { StoreRow } from '../../stores/workspace'
import type { TaskView } from '@shared/schemas/task'
import type { CreatorView, InviteCampaignDetail, InviteCampaignView, InviteProductSetView, InviteRecordView, InviteScriptView } from '@shared/invite-campaign'

/**
 * 页面 API 逐字段声明（与 CreatorInvitePage 的 provide 侧一一对应）：
 * 之前是 Record<string, any>，键名打错/签名改了页签组件不会在编译期报错。
 * 视图类型统一来自 @shared/invite-campaign（与服务返回结构同一份契约）。
 */
export interface InvitePageApi {
  loading: Ref<boolean>
  campaigns: Ref<InviteCampaignView[]>
  /** 升级前创建、没有 campaignId 的旧邀约任务（仍按任务卡片展示） */
  orphanTasks: ComputedRef<TaskView[]>
  openConfig: () => void
  openDetail: (campaign: InviteCampaignView) => Promise<void>
  campaignStatusTone: (status: string) => string
  campaignStatusLabel: (status: string) => string
  storeName: (id: string | null | undefined) => string
  formatTime: (value: number | null | undefined) => string
  stopReasonLabel: (reason: string | null | undefined) => string
  stopCampaign: (runId: string | null | undefined) => Promise<void>
  cancelSchedule: (campaignId: string | null | undefined) => Promise<void>
  openStore: (id: string) => void
  statusFilter: Ref<string>
  records: Ref<InviteRecordView[]>
  exportRecordsCsv: () => void
  recordStatusTone: (status: string) => string
  recordStatusLabel: (status: string) => string
  creatorQuery: Ref<string>
  creatorBlacklistedOnly: Ref<boolean>
  visibleCreators: ComputedRef<CreatorView[]>
  loadCreators: () => Promise<void>
  toggleBlacklist: (creator: CreatorView) => Promise<void>
  /** 资产页签当前生效的店铺（"全部店铺"视图下是第一家），行结构即工作台店铺列表行 */
  assetStore: ComputedRef<StoreRow | null>
  assetPlatform: ComputedRef<string>
  storeId: Ref<string>
  scriptDraft: { name: string; template: string; mode: 'manual' | 'ai' }
  productSetDraft: { name: string; productIds: string }
  scripts: Ref<InviteScriptView[]>
  productSets: Ref<InviteProductSetView[]>
  saveScript: () => Promise<void>
  removeScript: (script: InviteScriptView) => Promise<void>
  saveProductSet: () => Promise<void>
  removeProductSet: (set: InviteProductSetView) => Promise<void>
  parseProductIds: (value: string) => string[]
  detailOpen: Ref<boolean>
  detail: Ref<InviteCampaignDetail | null>
  detailLoading: Ref<boolean>
  closeDetail: () => void
  setManualStatus: (record: InviteRecordView, status: string) => Promise<void>
}

export const INVITE_PAGE_KEY: InjectionKey<InvitePageApi> = Symbol('shopilot-invite-page')
