import type { InviteState } from './invite-state'

/** 话术库：列表 + 一键套用（话术模板与长度上限仍由平台档案约束）。 */
export function useInviteAssets(state: InviteState) {
  const { invite, inviteScripts, inviteScriptId } = state

  async function loadInviteScripts(storeId: string, platform: string) {
    if (!storeId || !platform) { inviteScripts.value = []; return }
    try {
      const result = await window.shopilot.invite.scripts.list({ storeId, platform })
      inviteScripts.value = result.ok ? ((result.data || []) as typeof inviteScripts.value) : []
    } catch {
      inviteScripts.value = []
    }
  }

  function applyInviteScript(id: string) {
    const script = inviteScripts.value.find(item => item.id === id)
    if (!script) return
    invite.script = script.template
    invite.scriptMode = script.mode
  }

  // inviteScriptId 由模板双向绑定，这里只保证「套用后选中项不丢」。
  return { loadInviteScripts, applyInviteScript, inviteScriptId }
}
