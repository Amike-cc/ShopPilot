import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, EVENT_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { agentHrPreviewSchema, agentJobCreateSchema, agentJobFeedbackSchema, agentJobListQuerySchema, agentJobResultReviewSchema, agentMemoryListQuerySchema, agentMemoryReviewSchema, agentMemorySearchSchema, agentMemoryWriteSchema, agentOrgListQuerySchema, modelProfileInputSchema, modelProfileListQuerySchema } from '@shared/schemas/agent-domain'
import { getBrowserHostWindow } from '../browser/window-manager'
import { isAppLocked } from '../services/security-manager'
import { AgentRuntimeError, activateAgent, addJobFeedback, bindAgentModel, cancelAgentJob, createAgent, createAgentJob, delegateAgentTask, deleteModelProfile, ensureAgentRuntimeBootstrap, getAgent, getAgentJob, listAgentJobs, listAgentsPage, listModelProfilesPage, markRecoverableJobsOnStartup, pauseAgent, previewHr, qualityMetrics, qualityReviewSummary, resumeAgent, resumeAgentJob, retireAgent, runAgentJob, setModelProfile, testModelProfile, updateAgent, approveAgentJob, reviewAgentJobResult, startAgentRuntimeLeaseSweeper } from '../services/agent-runtime'
import { buildApprovedMemoryContext, createMemorySnapshot, inspectMemorySnapshot, listMemories, rebuildMemoryIndex, restoreMemorySnapshot, reviewMemory, searchMemories, writeMemory } from '../services/agent-memory'
import { deleteAgentSkill, exportAgentPack, importAgentPack, listAgentSkillLibrary } from '../services/agent-service'

function requestId(): string { return `req_${randomUUID()}` }
function ok<T>(data: T, rid: string): IPCResult<T> { return { ok: true, data, requestId: rid } }
function fail(code: string, message: string, rid: string): IPCResult { return { ok: false, error: { code, message: String(message).slice(0, 500) }, requestId: rid } }

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const host = getBrowserHostWindow()
  if (!host || host.isDestroyed() || host.webContents !== event.sender) {
    throw new AgentRuntimeError('AGENT_FORBIDDEN', 'Agent IPC 仅允许应用主窗口调用')
  }
  if (isAppLocked()) throw new AgentRuntimeError('APP_LOCKED', '应用已锁定，请先解锁')
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
  register(IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_RESTORE, (_event, raw) => restoreMemorySnapshot({ path: String((raw as any)?.path || ''), actorAgentId: String((raw as any)?.actorAgentId || 'root-ceo'), confirmed: !!(raw as any)?.confirmed }))
  register(IPC_CHANNELS.AGENT_SKILL_LIST, () => listAgentSkillLibrary())
  register(IPC_CHANNELS.AGENT_SKILL_DELETE, (_event, raw) => deleteAgentSkill(String((raw as any)?.skillId || '')))
  register(IPC_CHANNELS.AGENT_PACK_EXPORT, (_event, raw) => exportAgentPack(raw || {}))
  register(IPC_CHANNELS.AGENT_PACK_IMPORT, (_event, raw) => importAgentPack(raw || {}))
  register(IPC_CHANNELS.AGENT_QUALITY_METRICS, () => qualityMetrics())
  register(IPC_CHANNELS.AGENT_QUALITY_REVIEW, () => qualityReviewSummary('root-ceo'))

  // Kept Main-only for future CEO review flows; no renderer endpoint returns
  // the full memory context by default.
  void buildApprovedMemoryContext
  void addJobFeedback
}
