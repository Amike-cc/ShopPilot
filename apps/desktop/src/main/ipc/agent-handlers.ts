import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import {
  agentPlanSchema,
  agentPlanGenerateInputSchema,
  agentSoftwareExecuteInputSchema,
  agentSoftwarePlanSchema,
  agentUiStateSchema
} from '@shared/schemas/agent'
import { redactAgentText } from '@shared/agent-privacy'
import { writeAudit, auditRequestId } from '../services/audit-logger'
import { AgentObservationError, observeCurrentPage } from '../services/agent-observer'
import { AgentPlanningError } from '../services/agent-planner'
import {
  AgentSoftwareError,
  executeAgentSoftwarePlan,
  followUpAgentJob,
  generateAgentPlan,
  getAgentSoftwareContext,
  getAgentUiState,
  setAgentUiState,
  validateAgentPlanForCurrentPage,
  validateAgentSoftwarePlan
} from '../services/agent-service'
import { assertTrustedRenderer as assertTrustedIpc } from '../services/renderer-trust'

const noArgumentsSchema = z.tuple([])

function success<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

function failure(code: string, message: string, requestId: string): IPCResult {
  return { ok: false, error: { code, message: redactAgentText(message, 300) }, requestId }
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  // 实现收敛到 services/renderer-trust.ts（原本与 agent-domain-handlers 各写一份，措辞/错误码不一致）。
  assertTrustedIpc(event, { forbiddenCode: 'AGENT_FORBIDDEN', feature: 'Agent' })
}

function errorResponse(error: unknown, requestId: string, auditAction?: 'agent.observe' | 'agent.plan' | 'agent.plan.validate' | 'agent.ui.update' | 'agent.software.context' | 'agent.software.validate' | 'agent.software.execute', storeId?: string): IPCResult {
  let code = 'AGENT_INTERNAL_ERROR'
  let message = 'Agent 操作失败'
  if (error instanceof AgentObservationError || error instanceof AgentPlanningError || error instanceof AgentSoftwareError) {
    code = error.code
    message = error.message
  } else if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    code = error.code
    message = String((error as { message?: string }).message || code).replace(/^[A-Z0-9_]+:\s*/, '')
  } else if ((error as any)?.name === 'ZodError') {
    code = 'AGENT_INVALID_INPUT'
    message = String((error as Error).message || '参数校验失败')
  } else if (error instanceof Error) {
    message = error.message || message
  }
  if (auditAction) writeAudit(auditAction, 'failure', { storeId, requestId: auditRequestId(requestId, code) })
  return failure(code, message, requestId)
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
      const input = agentUiStateSchema.parse(raw)
      const state = setAgentUiState(input)
      writeAudit('agent.ui.update', 'success', { requestId })
      return success(state, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.ui.update') }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_PAGE_OBSERVE, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IPCResult> => {
    const requestId = randomUUID()
    let storeId: string | undefined
    try {
      assertTrustedRenderer(event)
      noArgumentsSchema.parse(args)
      const observation = await observeCurrentPage()
      storeId = observation.storeId
      writeAudit('agent.observe', 'success', { storeId, requestId })
      return success(observation, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.observe', storeId) }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_PLAN_GENERATE, async (event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const requestId = randomUUID()
    let storeId: string | undefined
    try {
      assertTrustedRenderer(event)
      const input = agentPlanGenerateInputSchema.parse(raw)
      const result = await generateAgentPlan(input)
      storeId = result.kind === 'task' ? result.plan.storeId
        : result.kind === 'software' ? (result.context.displayedStoreId || undefined)
        : undefined
      writeAudit('agent.plan', 'success', { storeId, requestId })
      return success(result, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.plan', storeId) }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_JOB_FOLLOW_UP, async (event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const requestId = randomUUID()
    let storeId: string | undefined
    try {
      assertTrustedRenderer(event)
      const result = await followUpAgentJob(raw)
      storeId = result.kind === 'software' ? (result.context.displayedStoreId || undefined) : undefined
      writeAudit('agent.plan', 'success', { storeId, requestId })
      return success(result, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.plan', storeId) }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_PLAN_VALIDATE, async (event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const requestId = randomUUID()
    let storeId: string | undefined
    try {
      assertTrustedRenderer(event)
      const planInput = agentPlanSchema.parse(raw)
      storeId = planInput.storeId
      const result = await validateAgentPlanForCurrentPage(planInput)
      if (result.plan.storeId !== storeId) {
        const error = new Error('计划所属店铺已变化，请重新观察当前页面')
        ;(error as any).code = 'AGENT_CONTEXT_CHANGED'
        throw error
      }
      writeAudit('agent.plan.validate', 'success', { storeId, requestId })
      return success(result, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.plan.validate', storeId) }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SOFTWARE_CONTEXT, (event: IpcMainInvokeEvent, ...args: unknown[]): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrustedRenderer(event)
      noArgumentsSchema.parse(args)
      const context = getAgentSoftwareContext()
      writeAudit('agent.software.context', 'success', { requestId })
      return success(context, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.software.context') }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SOFTWARE_VALIDATE, (event: IpcMainInvokeEvent, raw: unknown): IPCResult => {
    const requestId = randomUUID()
    let storeId: string | undefined
    try {
      assertTrustedRenderer(event)
      const plan = agentSoftwarePlanSchema.parse(raw)
      const firstAction = plan.steps[0]?.action as any
      storeId = firstAction?.storeId
      const result = validateAgentSoftwarePlan(plan)
      writeAudit('agent.software.validate', 'success', { storeId, requestId })
      return success(result, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.software.validate', storeId) }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SOFTWARE_EXECUTE, async (event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const requestId = randomUUID()
    let storeId: string | undefined
    try {
      assertTrustedRenderer(event)
      const input = agentSoftwareExecuteInputSchema.parse(raw)
      const firstAction = input.plan.steps[0]?.action as any
      storeId = firstAction?.storeId
      const result = await executeAgentSoftwarePlan(input)
      writeAudit('agent.software.execute', 'success', {
        storeId,
        requestId: auditRequestId(requestId, input.plan.steps.map(step => step.action.type).join('+'))
      })
      return success(result, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.software.execute', storeId) }
  })
}
