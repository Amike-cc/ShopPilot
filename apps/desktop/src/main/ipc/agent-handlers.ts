import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { agentChatInputSchema, agentUiStateSchema } from '@shared/schemas/agent'
import { redactAgentText } from '@shared/agent-privacy'
import { writeAudit, auditRequestId } from '../services/audit-logger'
import { generateAgentChat } from '../services/agent-chat-service'
import { getAgentUiState, setAgentUiState } from '../services/agent-service'
import { assertTrustedRenderer as assertTrustedIpc } from '../services/renderer-trust'
import { ipcOk, ipcFail } from './envelope'

const noArgumentsSchema = z.tuple([])
const DISABLED_AGENT_OPERATION_CHANNELS = [
  IPC_CHANNELS.AGENT_PAGE_OBSERVE,
  IPC_CHANNELS.AGENT_PLAN_GENERATE,
  IPC_CHANNELS.AGENT_JOB_FOLLOW_UP,
  IPC_CHANNELS.AGENT_PLAN_VALIDATE,
  IPC_CHANNELS.AGENT_SOFTWARE_CONTEXT,
  IPC_CHANNELS.AGENT_SOFTWARE_VALIDATE,
  IPC_CHANNELS.AGENT_SOFTWARE_EXECUTE
] as const

const success = ipcOk

function failure(code: string, message: string, requestId: string): IPCResult {
  // 先过 Agent 文本脱敏（隐私字段），再走共享信封（内部路径/错误码脱敏，P1-2）
  return ipcFail(code, redactAgentText(message, 300), requestId)
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  assertTrustedIpc(event, { forbiddenCode: 'AGENT_FORBIDDEN', feature: 'Agent' })
}

function errorResponse(error: unknown, requestId: string, auditAction?: 'agent.ui.update' | 'agent.chat' | 'agent.operation.rejected'): IPCResult {
  let code = 'AGENT_INTERNAL_ERROR'
  let message = 'Agent 对话失败'
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    code = error.code
    message = String((error as { message?: string }).message || code).replace(/^[A-Z0-9_]+:\s*/, '')
  } else if ((error as any)?.name === 'ZodError') {
    code = 'AGENT_INVALID_INPUT'
    message = '参数校验失败'
  } else if (error instanceof Error) {
    message = error.message || message
  }
  if (auditAction) writeAudit(auditAction, 'failure', { requestId: auditRequestId(requestId, code) })
  return failure(code, message, requestId)
}

function rejectAgentOperation(event: IpcMainInvokeEvent, channel: string): IPCResult {
  const requestId = randomUUID()
  try {
    assertTrustedRenderer(event)
    // 谁还在调已下线的旧 Agent 接口，事后要能查到（2026-10-15 审查）。
    // 通道名放进 request_id 的 # 后缀（与 software.execute 记动作摘要同一槽位），
    // 前缀匹配可查全部被拒记录、带通道可精确匹配；不记参数。
    writeAudit('agent.operation.rejected', 'failure', { requestId: auditRequestId(requestId, `AGENT_OPERATION_NOT_ALLOWED:${channel}`) })
    return failure('AGENT_OPERATION_NOT_ALLOWED', `Agent 当前仅支持普通文本对话；已拒绝旧操作接口 ${channel}`, requestId)
  } catch (error) {
    return errorResponse(error, requestId)
  }
}

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_UI_GET, (event: IpcMainInvokeEvent, ...args: unknown[]): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrustedRenderer(event)
      noArgumentsSchema.parse(args)
      return success(getAgentUiState(), requestId)
    } catch (error) { return errorResponse(error, requestId) }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_UI_SET, (event: IpcMainInvokeEvent, raw: unknown): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrustedRenderer(event)
      const state = setAgentUiState(agentUiStateSchema.parse(raw))
      writeAudit('agent.ui.update', 'success', { requestId })
      return success(state, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.ui.update') }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_CHAT, async (event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const requestId = randomUUID()
    try {
      assertTrustedRenderer(event)
      const input = agentChatInputSchema.parse(raw)
      const result = await generateAgentChat(input)
      // 只记"发生过一次对话"（requestId），**不记内容**——审计要能查到，内容不能进日志
      writeAudit('agent.chat', 'success', { requestId })
      return success(result, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.chat') }
  })

  // Compatibility handlers intentionally reject older renderers. Hiding their
  // buttons is insufficient: Main remains the authority for Agent capability.
  for (const channel of DISABLED_AGENT_OPERATION_CHANNELS) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent): IPCResult => rejectAgentOperation(event, channel))
  }
}
