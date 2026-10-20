import type { InviteState } from './invite-state'

/**
 * 额度与「会自动跳过的人」：都只读，失败时降级为 0/null（不拦开跑、不编造数字）。
 */
export function useInviteQuota(state: InviteState) {
  const { inviteQuota, inviteBlacklistCount } = state

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

  return { loadInviteQuota, loadBlacklistCount }
}
