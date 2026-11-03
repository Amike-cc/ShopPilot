import type { InviteState } from './invite-state'

/**
 * 额度与「会自动跳过的人」：都只读，失败时降级为 0/null（不拦开跑、不编造数字）。
 */
export function useInviteQuota(state: InviteState) {
  const { inviteQuota, inviteBlacklistCount, inviteRecentCount } = state

  async function loadInviteQuota(storeId: string) {
    if (!storeId) { inviteQuota.value = null; return }
    try {
      const result = await window.shopilot.invite.quota({ storeId })
      inviteQuota.value = result.ok ? (result.data as typeof inviteQuota.value) : null
    } catch {
      inviteQuota.value = null
    }
  }

  async function loadBlacklistCount(storeId: string, platform: string) {
    if (!storeId || !platform) { inviteBlacklistCount.value = 0; return }
    try {
      const result = await window.shopilot.invite.creators.blacklisted({ storeId, platform })
      inviteBlacklistCount.value = result.ok ? ((result.data as { nicknames?: string[] })?.nicknames || []).length : 0
    } catch {
      inviteBlacklistCount.value = 0
    }
  }

  /**
   * 近 7 天已邀人数：打开面板就显示，而不是等用户点「开始邀约」后才有数字。
   * 读失败时保持 0（只影响提示，不拦开跑）。
   */
  async function loadInviteRecentCount(storeId: string) {
    if (!storeId) { inviteRecentCount.value = 0; return }
    try {
      const result = await window.shopilot.browser.recentInviteHistory({ storeId, days: 7 })
      inviteRecentCount.value = result.ok
        ? (((result.data as { nicknames?: string[] })?.nicknames || []).filter(Boolean).length)
        : 0
    } catch {
      inviteRecentCount.value = 0
    }
  }

  return { loadInviteQuota, loadBlacklistCount, loadInviteRecentCount }
}
