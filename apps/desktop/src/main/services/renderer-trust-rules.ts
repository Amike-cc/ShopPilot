/**
 * 渲染层可信判定的**纯规则**（不依赖 electron，可在 vitest 下直接测）。
 * electron 侧的取值/抛错在 `renderer-trust.ts`。
 */

export type RendererForbiddenCode = 'AGENT_FORBIDDEN' | 'AI_FORBIDDEN' | 'IPC_FORBIDDEN'

export interface RendererTrustVerdict {
  ok: boolean
  code?: RendererForbiddenCode | 'APP_LOCKED'
  message?: string
}

/**
 * 只有"应用主窗口的 webContents"且"应用未锁定"才允许调用 IPC。
 *
 * 用 webContents **id** 比较而不是对象身份：id 是稳定的整数，纯函数里可比、可测；
 * 上游取值前已确认窗口未销毁，语义等价。
 *
 * `allowWhenLocked`：应用锁家族（解锁、锁状态、设置/移除主密码）必须在锁定状态下仍可调用，
 * 否则用户永远解不开锁；它们只跳过"锁定"这一条，发送方仍必须是主窗口。
 */
export function evaluateRendererTrust(input: {
  hostWebContentsId: number | null | undefined
  senderWebContentsId: number | null | undefined
  locked: boolean
  /** 错误码按家族区分：Agent 家族沿用 AGENT_FORBIDDEN，AI 家族用 AI_FORBIDDEN，其余业务家族用 IPC_FORBIDDEN */
  forbiddenCode?: RendererForbiddenCode
  /** 用于文案，例如 "Agent" / "AI 配置" */
  feature?: string
  allowWhenLocked?: boolean
}): RendererTrustVerdict {
  const feature = String(input.feature || 'Agent')
  const host = input.hostWebContentsId
  const sender = input.senderWebContentsId
  if (host == null || sender == null || host !== sender) {
    return { ok: false, code: input.forbiddenCode || 'AGENT_FORBIDDEN', message: `${feature} IPC 仅允许应用主窗口调用` }
  }
  if (input.locked && !input.allowWhenLocked) return { ok: false, code: 'APP_LOCKED', message: '应用已锁定，请先解锁' }
  return { ok: true }
}
