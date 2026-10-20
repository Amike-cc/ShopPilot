import { onBeforeUnmount, watch } from 'vue'
import { isBatchProfile } from '@shared/constants/invite'
import { normalizeInviteTaskConfig, parseInviteProductIds } from '@shared/invite-task'
import { inviteConfigKey, legacyInviteConfigKey } from '@shared/invite-config'
import type { InviteState } from './invite-state'

/**
 * 配置的读写（每个店铺一份，键 = invite.config.<storeId>）。
 *
 * 拆出来的价值：这段有**串行号 + 店铺校验**（切店时旧请求可能后到），
 * 与 UI 生命周期无关，出错面也集中；额度/话术/黑名单通过 ports 注入，
 * 避免这里 import 另外三个 composable 形成环。
 */
export interface InviteConfigPorts {
  loadQuota(storeId: string): void | Promise<void>
  loadScripts(storeId: string, platform: string): void | Promise<void>
  loadBlacklistCount(storeId: string, platform: string): void | Promise<void>
}

export function useInviteConfig(state: InviteState, ports: InviteConfigPorts) {
  const { ws, currentStoreId, inviteProfile, invite, inviteConfigLoaded, inviteSaving, inviteAiConfigured } = state

  let serial = 0
  let loadedStoreId = ''
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  /** 挂起防抖定时器对应的店铺：卸载时补写要沿用定时器创建时的那家店，不能用可能已变的 currentStoreId。 */
  let saveTimerStoreId = ''

  async function readInviteSetting(key: string) {
    const result = await window.shopilot.settings.get(key)
    const value = result.ok ? result.data?.value : null
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  }

  async function loadInviteAiStatus() {
    try {
      const result = await window.shopilot.ai.configGet()
      inviteAiConfigured.value = !!(result.ok && (result.data as { hasKey?: boolean })?.hasKey)
    } catch {
      inviteAiConfigured.value = false
    }
  }

  async function loadInviteConfig() {
    const token = ++serial
    const profile = inviteProfile.value
    const storeId = currentStoreId.value
    inviteConfigLoaded.value = false
    loadedStoreId = ''
    state.resetInviteDefaults()
    if (!profile || !storeId) return
    void ports.loadQuota(storeId)
    void ports.loadScripts(storeId, profile.platform)
    void ports.loadBlacklistCount(storeId, profile.platform)
    void loadInviteAiStatus()
    let saved = await readInviteSetting(inviteConfigKey(storeId))
    if (token !== serial || currentStoreId.value !== storeId) return
    let fromLegacy = false
    if (!saved) {
      saved = await readInviteSetting(legacyInviteConfigKey(profile.platform))
      fromLegacy = !!saved
    }
    if (token !== serial || currentStoreId.value !== storeId) return
    if (saved) Object.assign(invite, normalizeInviteTaskConfig(profile.flow, saved))
    /**
     * 商品ID 统一成"一行一个"的字符串再放进多行框：
     * `normalizeInviteTaskConfig` 给的是数组（`['a','b']`），直接绑到 textarea 会被拼成 `a,b`——
     * 能跑但不好核对（用户是按"一列 ID"粘贴进来的，理应一行一个显示）。状态类型也统一为 string。
     */
    invite.productIds = parseInviteProductIds(invite.productIds).join('\n')
    // 档案实测清单之外的值（旧配置 / 平台改名后的遗留，如「汽车电动」→「汽摩电动」）不进界面：
    // 面板只能提供实测过的选项，否则勾选列表里点不亮，运行到页面又必然找不到。
    // （智能体/其它调用方塞进来的清单外值不受此影响：inviteTaskIssues 会把它们逐条报成缺项。）
    if (!isBatchProfile(profile)) {
      invite.finderCategories = invite.finderCategories.filter(c => profile.finderCategories.includes(c))
      invite.finderSalesTiers = invite.finderSalesTiers.filter(t => (profile.finderSalesTiers || []).includes(t))
      invite.finderOtherFilters = invite.finderOtherFilters.filter(f => profile.finderOtherFilters.includes(f))
      if (!profile.finderTypes.includes(invite.finderType)) invite.finderType = profile.finderTypes[0] || '全部带货者'
    }
    if (token !== serial || currentStoreId.value !== storeId) return
    inviteConfigLoaded.value = true
    loadedStoreId = storeId
    if (fromLegacy) {
      // 旧版按平台配置只作为首次打开的初始值，随后固化为本店铺键，避免同平台店铺互相覆盖。
      await window.shopilot.settings.set(inviteConfigKey(storeId), state.inviteSnapshot())
    }
  }

  async function saveInviteConfig() {
    const storeId = currentStoreId.value
    if (!storeId || !inviteProfile.value) return
    inviteSaving.value = true
    const result = await window.shopilot.settings.set(inviteConfigKey(storeId), state.inviteSnapshot())
    inviteSaving.value = false
    if (result.ok) ws.toast('达人邀约配置已保存到当前店铺', 'success')
    else ws.toast(`保存邀约配置失败：${result.error.message}`, 'error')
  }

  watch(() => invite.scriptMode, (mode) => {
    if (mode === 'ai') void loadInviteAiStatus()
  })

  /** 防抖到期 / 卸载补写共用的落盘：守卫与到期回调一致，切店后挂起的定时器自动作废。 */
  function flushInviteConfigSave(storeId: string): void {
    if (currentStoreId.value !== storeId || !inviteConfigLoaded.value || loadedStoreId !== storeId) return
    void window.shopilot.settings.set(inviteConfigKey(storeId), state.inviteSnapshot())
  }

  /** 表单改动 500ms 后自动落盘；切店期间不写（避免把 A 店配置写到 B 店键）。 */
  watch(invite, () => {
    const storeId = currentStoreId.value
    if (!storeId || !inviteConfigLoaded.value || loadedStoreId !== storeId) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimerStoreId = storeId
    saveTimer = setTimeout(() => flushInviteConfigSave(storeId), 500)
  }, { deep: true })

  onBeforeUnmount(() => {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    // 卸载时还有挂起的防抖保存 → 同步补写一次：否则 500ms 内的最后一次编辑只存在于内存里，
    // 组件销毁后定时器被丢弃，这版修改就丢了。仍用定时器创建时的 storeId 守卫，
    // 切店后挂起的定时器本来就该作废（旧键已过期），不会误写。
    flushInviteConfigSave(saveTimerStoreId)
  })

  return { loadInviteConfig, saveInviteConfig, loadInviteAiStatus }
}
