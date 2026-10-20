import { computed, type ComputedRef } from 'vue'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'
import { createInviteState } from '../invite/composables/invite-state'
import { useInviteQuota } from '../invite/composables/use-invite-quota'
import { useInviteAssets } from '../invite/composables/use-invite-assets'
import { useInviteConfig } from '../invite/composables/use-invite-config'
import { useInviteNavigation } from '../invite/composables/use-invite-navigation'
import { useInviteRun } from '../invite/composables/use-invite-run'

/**
 * 「达人邀约」的门面（facade）。
 *
 * 2026-10-20 P2 拆分的第二半：状态与五个领域 composable 已分别落在
 * `features/invite/composables/`，这里只做接线，并**保持返回结构不变**——
 * 侧栏 `DashboardBrowserSurface.vue` 与独立页 `CreatorInvitePage.vue`
 * 都按这个对象取值，锚点与行为不受拆分影响。
 *
 *   invite-state        表单/选项/校验/快照（纯状态，无 IPC）
 *   use-invite-config   配置读写（含串行号与切店保护、自动保存）
 *   use-invite-quota    额度与黑名单人数（只读、失败降级）
 *   use-invite-assets   话术库
 *   use-invite-navigation 平台广场地址/类目树/入口/打开广场
 *   use-invite-run      任务进度映射、启动与停止
 */
export interface CreatorInviteOptions {
  /** 店铺行（含平台）。不传 = 跟随工作台当前显示的店铺。 */
  store?: ComputedRef<StoreRow | null>
  /**
   * 显式店铺 id。独立模块页用：页面自己的店铺下拉框选哪家，配置/额度/启动就作用于哪家，
   * 与"浏览器当前显示哪家店"解耦（用户可以在任何页面上发起邀约）。
   * 不传 = 沿用侧栏面板的行为，跟随 ws.displayedStoreId。
   */
  storeId?: ComputedRef<string | null>
}

export function useCreatorInvite(options: CreatorInviteOptions = {}) {
  const ws = useWorkspaceStore()
  const store = options.store ?? computed(() => ws.stores.find(item => item.id === ws.displayedStoreId) || null)
  /** 本次配置/运行归属的店铺：显式传入优先，否则跟随工作台当前店铺。 */
  const currentStoreId = options.storeId ?? computed(() => ws.displayedStoreId)

  const state = createInviteState({ store, storeId: currentStoreId })
  const quota = useInviteQuota(state)
  const assets = useInviteAssets(state)
  const config = useInviteConfig(state, {
    loadQuota: quota.loadInviteQuota,
    loadScripts: assets.loadInviteScripts,
    loadBlacklistCount: quota.loadBlacklistCount
  })
  const navigation = useInviteNavigation(state, { reloadConfig: config.loadInviteConfig })
  const run = useInviteRun(state, { reloadQuota: quota.loadInviteQuota })

  return {
    ...state,
    ...quota,
    ...assets,
    ...config,
    ...navigation,
    ...run,
    currentStoreId
  }
}

/** 面板视图组件只认这个返回类型（把 `useCreatorInvite()` 的接线结果原样传进去）。 */
export type CreatorInviteController = ReturnType<typeof useCreatorInvite>
