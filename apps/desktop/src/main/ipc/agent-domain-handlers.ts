import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { modelProfileInputSchema, modelProfileListQuerySchema } from '@shared/schemas/agent-domain'
import { assertTrustedRenderer as assertTrustedIpc } from '../services/renderer-trust'
import { AgentRuntimeError, deleteModelProfile, ensureAgentRuntimeBootstrap, listModelProfilesPage, setModelProfile, testModelProfile } from '../services/agent-runtime'
import { askConfirm } from '../services/password-dialog'

function requestId(): string { return `req_${randomUUID()}` }
function ok<T>(data: T, rid: string): IPCResult<T> { return { ok: true, data, requestId: rid } }
function fail(code: string, message: string, rid: string): IPCResult { return { ok: false, error: { code, message: String(message).slice(0, 500) }, requestId: rid } }

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  assertTrustedIpc(event, { forbiddenCode: 'AGENT_FORBIDDEN', feature: 'Agent' })
}

async function requireNativeConfirmation(title: string, detail: string): Promise<void> {
  const confirmed = await askConfirm({ title, detail, danger: true })
  if (!confirmed) throw new AgentRuntimeError('AGENT_CONFIRMATION_REQUIRED', '该设置需要用户确认')
}

function handleError(error: unknown, rid: string): IPCResult {
  if (error instanceof AgentRuntimeError) return fail(error.code, error.message, rid)
  if ((error as any)?.name === 'ZodError') return fail('AGENT_INVALID_INPUT', '参数校验失败', rid)
  const code = typeof (error as any)?.code === 'string' ? String((error as any).code) : 'AGENT_INTERNAL_ERROR'
  return fail(code, code === 'AGENT_INTERNAL_ERROR' ? 'Agent 设置失败' : String((error as any)?.message || code), rid)
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
// skills, plugins, commerce data, or organization state.
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
  // Bootstrap keeps the user's model configuration available. Job recovery
  // and the Agent job sweeper intentionally do not start in chat-only mode.
  ensureAgentRuntimeBootstrap()

  register(IPC_CHANNELS.AGENT_MODEL_LIST, (_event, raw) => listModelProfilesPage(modelProfileListQuerySchema.parse(raw || {})))
  register(IPC_CHANNELS.AGENT_MODEL_SET, async (_event, raw) => {
    const input = raw as any
    const profile = modelProfileInputSchema.parse(input.profile || input)
    await requireNativeConfirmation('保存模型 Profile？', `将保存模型「${String(profile.name || profile.model || '未命名')}」及其 Endpoint、预算和能力配置。`)
    return setModelProfile(profile, 'root-ceo')
  })
  register(IPC_CHANNELS.AGENT_MODEL_DELETE, async (_event, raw) => {
    await requireNativeConfirmation('删除模型 Profile？', `将删除模型 Profile「${String((raw as any).profileId || '')}」。`)
    deleteModelProfile(String((raw as any).profileId), 'root-ceo')
    return { success: true }
  })
  register(IPC_CHANNELS.AGENT_MODEL_TEST, (_event, raw) => testModelProfile(String((raw as any).profileId), 'root-ceo'))

  for (const channel of DISABLED_AGENT_DOMAIN_CHANNELS) {
    register(channel, () => rejectAgentOperation())
  }
}
