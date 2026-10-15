import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { assertTrustedRenderer as assertTrustedIpc } from '../services/renderer-trust'
import { AgentRuntimeError, ensureAgentRuntimeBootstrap } from '../services/agent-runtime'
import { ipcOk as ok, ipcFail as fail, ipcErrFromUnknown } from './envelope'

function requestId(): string { return `req_${randomUUID()}` }

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  assertTrustedIpc(event, { forbiddenCode: 'AGENT_FORBIDDEN', feature: 'Agent' })
}

function handleError(error: unknown, rid: string): IPCResult {
  if (error instanceof AgentRuntimeError) return fail(error.code, error.message, rid)
  if ((error as any)?.name === 'ZodError') return fail('AGENT_INVALID_INPUT', '参数校验失败', rid)
  // 兜底走共享脱敏（P1-2）：非 AgentRuntimeError 的异常可能来自依赖内部，文案里可能带路径/错误码
  return ipcErrFromUnknown(error, rid, { fallback: 'Agent 设置失败' })
}

function rejectAgentOperation(): never {
  throw new AgentRuntimeError('AGENT_OPERATION_NOT_ALLOWED', 'Agent 当前仅支持普通文本对话，不提供软件操作功能')
}

function register<T>(channel: string, fn: (event: IpcMainInvokeEvent, raw: unknown) => T | Promise<T>): void {
  ipcMain.handle(channel, async (event, raw) => {
    const rid = requestId()
    try { assertTrustedRenderer(event); return ok(await fn(event, raw), rid) } catch (error) { return handleError(error, rid) }
  })
}

// Old Agent domain channels remain registered so stale renderers receive a
// controlled denial. They cannot inspect or operate jobs, stores, memory,
// skills, plugins, commerce data, organization state, or model profiles —
// chat resolves its model from the AI configuration via the synced main
// profile (syncMainAgentProfileFromAiConfig) and needs no admin surface.
const DISABLED_AGENT_DOMAIN_CHANNELS = [
  IPC_CHANNELS.AGENT_ORG_LIST,
  IPC_CHANNELS.AGENT_ORG_GET,
  IPC_CHANNELS.AGENT_ORG_CREATE,
  IPC_CHANNELS.AGENT_ORG_UPDATE,
  IPC_CHANNELS.AGENT_ORG_ACTIVATE,
  IPC_CHANNELS.AGENT_ORG_PAUSE,
  IPC_CHANNELS.AGENT_ORG_RESUME,
  IPC_CHANNELS.AGENT_ORG_RETIRE,
  IPC_CHANNELS.AGENT_HR_PREVIEW,
  IPC_CHANNELS.AGENT_MODEL_BIND,
  IPC_CHANNELS.AGENT_MODEL_LIST,
  IPC_CHANNELS.AGENT_MODEL_SET,
  IPC_CHANNELS.AGENT_MODEL_DELETE,
  IPC_CHANNELS.AGENT_MODEL_TEST,
  IPC_CHANNELS.AGENT_JOB_CREATE,
  IPC_CHANNELS.AGENT_JOB_DELEGATE,
  IPC_CHANNELS.AGENT_JOB_LIST,
  IPC_CHANNELS.AGENT_JOB_GET,
  IPC_CHANNELS.AGENT_JOB_RUN,
  IPC_CHANNELS.AGENT_JOB_CANCEL,
  IPC_CHANNELS.AGENT_JOB_APPROVE,
  IPC_CHANNELS.AGENT_JOB_RESULT_REVIEW,
  IPC_CHANNELS.AGENT_JOB_FEEDBACK,
  IPC_CHANNELS.AGENT_JOB_RESUME,
  IPC_CHANNELS.AGENT_MEMORY_LIST,
  IPC_CHANNELS.AGENT_MEMORY_SEARCH,
  IPC_CHANNELS.AGENT_MEMORY_WRITE,
  IPC_CHANNELS.AGENT_MEMORY_REVIEW,
  IPC_CHANNELS.AGENT_MEMORY_REBUILD,
  IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT,
  IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_INSPECT,
  IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_RESTORE,
  IPC_CHANNELS.AGENT_MEMORY_LEARNING_SETTINGS,
  IPC_CHANNELS.AGENT_MEMORY_MAINTENANCE,
  IPC_CHANNELS.AGENT_SKILL_LIST,
  IPC_CHANNELS.AGENT_SKILL_CREATE,
  IPC_CHANNELS.AGENT_SKILL_TOOLS,
  IPC_CHANNELS.AGENT_SKILL_DELETE,
  IPC_CHANNELS.AGENT_SKILL_UPDATE,
  IPC_CHANNELS.AGENT_PACK_EXPORT,
  IPC_CHANNELS.AGENT_PACK_IMPORT,
  IPC_CHANNELS.AGENT_PLUGIN_UPDATE,
  IPC_CHANNELS.AGENT_PLUGIN_DELETE,
  IPC_CHANNELS.AGENT_QUALITY_METRICS,
  IPC_CHANNELS.AGENT_QUALITY_REVIEW,
  IPC_CHANNELS.AGENT_COMMERCE_LEDGER_LIST
] as const

export function registerAgentDomainHandlers(): void {
  // Bootstrap keeps the main Agent's chat model profile (synced from the AI
  // configuration) available. Job recovery and the Agent job sweeper
  // intentionally do not start in chat-only mode.
  ensureAgentRuntimeBootstrap()

  for (const channel of DISABLED_AGENT_DOMAIN_CHANNELS) {
    register(channel, () => rejectAgentOperation())
  }
}
