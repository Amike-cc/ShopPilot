import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, EVENT_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { agentHrPreviewSchema, agentJobCreateSchema, agentJobFeedbackSchema, agentJobListQuerySchema, agentJobResultReviewSchema, agentMemoryListQuerySchema, agentMemoryReviewSchema, agentMemorySearchSchema, agentMemoryWriteSchema, agentMemorySnapshotRestoreSchema, agentOrgListQuerySchema, agentMemoryLearningSettingsSchema, modelProfileInputSchema, modelProfileListQuerySchema } from '@shared/schemas/agent-domain'
import { getBrowserHostWindow } from '../browser/window-manager'
import { assertTrustedRenderer as assertTrustedIpc } from '../services/renderer-trust'
import { AgentRuntimeError, activateAgent, addJobFeedback, bindAgentModel, cancelAgentJob, createAgent, createAgentJob, delegateAgentTask, deleteModelProfile, ensureAgentRuntimeBootstrap, getAgent, getAgentJob, listAgentJobs, listAgentsPage, listModelProfilesPage, markRecoverableJobsOnStartup, pauseAgent, previewHr, qualityMetrics, qualityReviewSummary, resumeAgent, resumeAgentJob, retireAgent, runAgentJob, setModelProfile, testModelProfile, updateAgent, approveAgentJob, reviewAgentJobResult, startAgentRuntimeLeaseSweeper } from '../services/agent-runtime'
import { buildApprovedMemoryContext, createMemorySnapshot, getMemoryLearningSettings, inspectMemorySnapshot, listMemories, maintainMemories, rebuildMemoryIndex, restoreMemorySnapshot, reviewMemory, searchMemories, setMemoryLearningSettings, writeMemory } from '../services/agent-memory'
import { createAgentSkillByUser, deleteAgentPluginByUser, deleteAgentSkill, exportAgentPack, importAgentPack, listAgentSkillLibrary, updateAgentPluginByUser, updateAgentSkill } from '../services/agent-service'
import { listSkillStepTools } from '@shared/agent-tools'
import { askConfirm } from '../services/password-dialog'

function requestId(): string { return `req_${randomUUID()}` }
function ok<T>(data: T, rid: string): IPCResult<T> { return { ok: true, data, requestId: rid } }
function fail(code: string, message: string, rid: string): IPCResult { return { ok: false, error: { code, message: String(message).slice(0, 500) }, requestId: rid } }

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  // 实现收敛到 services/renderer-trust.ts：这里原先自己写了一份，与 agent-handlers 的那份
  // 措辞/错误码并不一致（审计 P1）。Agent 家族沿用 AGENT_FORBIDDEN 保持既有契约。
  assertTrustedIpc(event, { forbiddenCode: 'AGENT_FORBIDDEN', feature: 'Agent' })
}

function sendEvent(channel: string, payload: unknown): void {
  try { getBrowserHostWindow()?.webContents.send(channel, payload) } catch { /* UI event is best effort */ }
}

function handleError(error: unknown, rid: string): IPCResult {
  if (error instanceof AgentRuntimeError) return fail(error.code, error.message, rid)
  if ((error as any)?.name === 'ZodError') return fail('AGENT_INVALID_INPUT', '参数校验失败', rid)
  const code = typeof (error as any)?.code === 'string' ? String((error as any).code) : 'AGENT_INTERNAL_ERROR'
  return fail(code, code === 'AGENT_INTERNAL_ERROR' ? 'Agent 操作失败' : String((error as any)?.message || code), rid)
}

function register<T>(channel: string, fn: (event: IpcMainInvokeEvent, raw: unknown) => T | Promise<T>): void {
  ipcMain.handle(channel, async (event, raw) => {
    const rid = requestId()
    try { assertTrustedRenderer(event); return ok(await fn(event, raw), rid) } catch (error) { return handleError(error, rid) }
  })
}

export function registerAgentDomainHandlers(): void {
  // Bootstrap is idempotent and repairs a partially applied migration before
  // handlers become reachable.
  ensureAgentRuntimeBootstrap()
  markRecoverableJobsOnStartup()
  startAgentRuntimeLeaseSweeper()

  register(IPC_CHANNELS.AGENT_ORG_LIST, (_event, raw) => listAgentsPage(agentOrgListQuerySchema.parse(raw || {})))
  register(IPC_CHANNELS.AGENT_ORG_GET, (_event, raw) => getAgent(String((raw as any)?.agentId || '')))
  register(IPC_CHANNELS.AGENT_ORG_CREATE, (_event, raw) => {
    const input = raw as any
    return createAgent({ ...input, actorAgentId: String(input.actorAgentId || 'root-ceo') })
  })
  register(IPC_CHANNELS.AGENT_ORG_UPDATE, (_event, raw) => updateAgent(raw as any))
  register(IPC_CHANNELS.AGENT_ORG_ACTIVATE, (_event, raw) => { const agent = activateAgent(String((raw as any).agentId), String((raw as any).actorAgentId || 'root-ceo'), !!(raw as any).confirmed); sendEvent(EVENT_CHANNELS.AGENT_STATUS_CHANGED, { agentId: agent.id, status: agent.status }); return agent })
  register(IPC_CHANNELS.AGENT_ORG_PAUSE, (_event, raw) => { const agent = pauseAgent(String((raw as any).agentId), String((raw as any).actorAgentId || 'root-ceo'), !!(raw as any).confirmed); sendEvent(EVENT_CHANNELS.AGENT_STATUS_CHANGED, { agentId: agent.id, status: agent.status }); return agent })
  register(IPC_CHANNELS.AGENT_ORG_RESUME, (_event, raw) => { const agent = resumeAgent(String((raw as any).agentId), String((raw as any).actorAgentId || 'root-ceo'), !!(raw as any).confirmed); sendEvent(EVENT_CHANNELS.AGENT_STATUS_CHANGED, { agentId: agent.id, status: agent.status }); return agent })
  register(IPC_CHANNELS.AGENT_ORG_RETIRE, (_event, raw) => { const agent = retireAgent(String((raw as any).agentId), String((raw as any).actorAgentId || 'root-ceo'), !!(raw as any).confirmed); sendEvent(EVENT_CHANNELS.AGENT_STATUS_CHANGED, { agentId: agent.id, status: agent.status }); return agent })
  register(IPC_CHANNELS.AGENT_HR_PREVIEW, (_event, raw) => {
    const input = agentHrPreviewSchema.parse({ mode: 'hr', ...(raw as any) })
    return previewHr(input.role, input.actorAgentId, input.mode)
  })

  register(IPC_CHANNELS.AGENT_MODEL_LIST, (_event, raw) => listModelProfilesPage(modelProfileListQuerySchema.parse(raw || {})))
  register(IPC_CHANNELS.AGENT_MODEL_SET, (_event, raw) => {
    const input = raw as any
    const profile = modelProfileInputSchema.parse(input.profile || input)
    return setModelProfile(profile, String(input.actorAgentId || 'root-ceo'))
  })
  register(IPC_CHANNELS.AGENT_MODEL_DELETE, (_event, raw) => { deleteModelProfile(String((raw as any).profileId), String((raw as any).actorAgentId || 'root-ceo')); return { success: true } })
  register(IPC_CHANNELS.AGENT_MODEL_TEST, (_event, raw) => testModelProfile(String((raw as any).profileId), String((raw as any).actorAgentId || 'root-ceo')))
  register(IPC_CHANNELS.AGENT_MODEL_BIND, (_event, raw) => {
    const input = raw as any
    const rawProfileId = input?.modelProfileId
    const modelProfileId = rawProfileId == null || String(rawProfileId).trim() === '' ? null : String(rawProfileId)
    return bindAgentModel({ agentId: String(input?.agentId || ''), modelProfileId, actorAgentId: String(input?.actorAgentId || 'root-ceo') })
  })

  register(IPC_CHANNELS.AGENT_JOB_CREATE, (_event, raw) => agentJobCreateSchema.parse(raw) && createAgentJob(raw as any))
  register(IPC_CHANNELS.AGENT_JOB_DELEGATE, async (_event, raw) => {
    const result = await delegateAgentTask(raw)
    sendEvent(EVENT_CHANNELS.AGENT_JOB_PROGRESS, { jobId: result.job.id, status: result.job.status, version: result.job.version, executorAgentId: result.executor.id })
    return result
  })
  register(IPC_CHANNELS.AGENT_JOB_LIST, (_event, raw) => listAgentJobs(agentJobListQuerySchema.parse(raw || {})))
  register(IPC_CHANNELS.AGENT_JOB_GET, (_event, raw) => getAgentJob(String((raw as any)?.jobId || '')))
  register(IPC_CHANNELS.AGENT_JOB_RUN, async (_event, raw) => {
    const result = await runAgentJob(String((raw as any).jobId), String((raw as any).actorAgentId || 'root-ceo'))
    sendEvent(EVENT_CHANNELS.AGENT_JOB_PROGRESS, { jobId: result.id, status: result.status, version: result.version })
    return result
  })
  register(IPC_CHANNELS.AGENT_JOB_CANCEL, (_event, raw) => {
    const result = cancelAgentJob({ jobId: String((raw as any).jobId), actorAgentId: String((raw as any).actorAgentId || 'root-ceo') })
    sendEvent(EVENT_CHANNELS.AGENT_JOB_PROGRESS, { jobId: result.id, status: result.status, version: result.version })
    return result
  })
  register(IPC_CHANNELS.AGENT_JOB_APPROVE, (_event, raw) => {
    const input = raw as any
    const result = approveAgentJob({ jobId: String(input.jobId), actorAgentId: String(input.actorAgentId || 'root-ceo'), approved: !!input.approved, confirmationId: input.confirmationId == null ? undefined : String(input.confirmationId) })
    sendEvent(EVENT_CHANNELS.AGENT_JOB_PROGRESS, { jobId: result.id, status: result.status, version: result.version, confirmationApproved: result.confirmationApproved })
    return result
  })
  register(IPC_CHANNELS.AGENT_JOB_RESULT_REVIEW, (_event, raw) => {
    const result = reviewAgentJobResult(agentJobResultReviewSchema.parse(raw))
    sendEvent(EVENT_CHANNELS.AGENT_JOB_PROGRESS, { jobId: result.id, status: result.status, version: result.version, resultReviewed: true })
    return result
  })
  register(IPC_CHANNELS.AGENT_JOB_FEEDBACK, (_event, raw) => addJobFeedback(agentJobFeedbackSchema.parse(raw)))
  register(IPC_CHANNELS.AGENT_JOB_RESUME, (_event, raw) => {
    const result = resumeAgentJob({ jobId: String((raw as any).jobId), actorAgentId: String((raw as any).actorAgentId || 'root-ceo') })
    sendEvent(EVENT_CHANNELS.AGENT_JOB_PROGRESS, { jobId: result.id, status: result.status, version: result.version })
    return result
  })

  register(IPC_CHANNELS.AGENT_MEMORY_LIST, (_event, raw) => listMemories(agentMemoryListQuerySchema.parse(raw)))
  register(IPC_CHANNELS.AGENT_MEMORY_SEARCH, (_event, raw) => searchMemories(agentMemorySearchSchema.parse(raw)))
  register(IPC_CHANNELS.AGENT_MEMORY_WRITE, (_event, raw) => writeMemory(agentMemoryWriteSchema.parse(raw)))
  register(IPC_CHANNELS.AGENT_MEMORY_REVIEW, (_event, raw) => reviewMemory(agentMemoryReviewSchema.parse(raw)))
  register(IPC_CHANNELS.AGENT_MEMORY_REBUILD, () => rebuildMemoryIndex())
  register(IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT, () => createMemorySnapshot())
  register(IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_INSPECT, (_event, raw) => inspectMemorySnapshot(String((raw as any)?.path || '')))
  // 恢复是破坏性操作：strict schema 解析（含面板展示过的 expectedSha256，Main 会与文件实际摘要比对）。
  // confirmed 仍接受旧版 preload 的字段，但不再信任 Renderer 自报；确认必须
  // 在 Main 托管的原生确认窗中完成，取消时在任何备份/写库之前直接拒绝。
  register(IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_RESTORE, async (_event, raw) => {
    const input = agentMemorySnapshotRestoreSchema.parse(raw)
    const confirmed = await askConfirm({
      title: '恢复记忆快照？',
      detail: '当前记忆会先生成加密备份，冲突版本保留为待审核。',
      detail2: input.expectedSha256 ? `SHA-256：${input.expectedSha256.slice(0, 16)}…` : '未提供面板摘要，将按文件实际摘要记录。',
      danger: true
    })
    if (!confirmed) throw new AgentRuntimeError('AGENT_CONFIRMATION_REQUIRED', '恢复记忆快照需要用户确认')
    return restoreMemorySnapshot({ ...input, confirmed: true })
  })
  register(IPC_CHANNELS.AGENT_MEMORY_LEARNING_SETTINGS, (_event, raw) => raw == null ? getMemoryLearningSettings() : setMemoryLearningSettings(agentMemoryLearningSettingsSchema.parse(raw)))
  register(IPC_CHANNELS.AGENT_MEMORY_MAINTENANCE, () => maintainMemories())
  register(IPC_CHANNELS.AGENT_SKILL_LIST, () => listAgentSkillLibrary())
  register(IPC_CHANNELS.AGENT_SKILL_CREATE, (_event, raw) => createAgentSkillByUser(raw || {}))
  // 面板表单的工具下拉数据源：只返回能写进技能的工具（与校验同一判定），用户选不到会被拒的步骤。
  register(IPC_CHANNELS.AGENT_SKILL_TOOLS, () => ({ tools: listSkillStepTools() }))
  register(IPC_CHANNELS.AGENT_SKILL_DELETE, (_event, raw) => deleteAgentSkill(String((raw as any)?.skillId || '')))
  register(IPC_CHANNELS.AGENT_SKILL_UPDATE, (_event, raw) => updateAgentSkill(raw || {}))
  register(IPC_CHANNELS.AGENT_PACK_EXPORT, (_event, raw) => exportAgentPack(raw || {}))
  register(IPC_CHANNELS.AGENT_PACK_IMPORT, (_event, raw) => importAgentPack(raw || {}))
  // 插件的改/删与技能一样只改声明式定义：删插件不删成员技能，只解除归属。
  register(IPC_CHANNELS.AGENT_PLUGIN_UPDATE, (_event, raw) => updateAgentPluginByUser(raw || {}))
  register(IPC_CHANNELS.AGENT_PLUGIN_DELETE, (_event, raw) => deleteAgentPluginByUser(raw || {}))
  register(IPC_CHANNELS.AGENT_QUALITY_METRICS, () => qualityMetrics())
  register(IPC_CHANNELS.AGENT_QUALITY_REVIEW, () => qualityReviewSummary('root-ceo'))

  // Kept Main-only for future CEO review flows; no renderer endpoint returns
  // the full memory context by default.
  void buildApprovedMemoryContext
  void addJobFeedback
}
