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
import { writeAudit } from '../services/audit-logger'
import { AgentObservationError, observeCurrentPage } from '../services/agent-observer'
import { AgentPlanningError } from '../services/agent-planner'
import {
  AgentSoftwareError,
  executeAgentSoftwarePlan,
  generateAgentPlan,
  getAgentSoftwareContext,
  getAgentUiState,
  setAgentUiState,
  validateAgentPlanForCurrentPage,
  validateAgentSoftwarePlan
} from '../services/agent-service'
import { getBrowserHostWindow } from '../browser/window-manager'
import { isAppLocked } from '../services/security-manager'

const noArgumentsSchema = z.tuple([])

function success<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

function failure(code: string, message: string, requestId: string): IPCResult {
  return { ok: false, error: { code, message: redactAgentText(message, 300) }, requestId }
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const host = getBrowserHostWindow()
  if (!host || host.isDestroyed() || host.webContents !== event.sender) {
    const error = new Error('Agent IPC 仅允许应用主窗口调用')
    ;(error as any).code = 'AGENT_FORBIDDEN'
    throw error
  }
  if (isAppLocked()) {
    const error = new Error('应用已锁定，请先解锁')
    ;(error as any).code = 'APP_LOCKED'
    throw error
  }
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
  if (auditAction) writeAudit(auditAction, 'failure', { storeId, requestId: code })
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
      writeAudit('agent.ui.update', 'success', { requestId: 'agent.ui.update' })
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
      writeAudit('agent.observe', 'success', { storeId, requestId: 'agent.observe' })
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
      writeAudit('agent.plan', 'success', { storeId, requestId: 'agent.plan' })
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
      writeAudit('agent.plan.validate', 'success', { storeId, requestId: 'agent.plan.validate' })
      return success(result, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.plan.validate', storeId) }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SOFTWARE_CONTEXT, (event: IpcMainInvokeEvent, ...args: unknown[]): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrustedRenderer(event)
      noArgumentsSchema.parse(args)
      const context = getAgentSoftwareContext()
      writeAudit('agent.software.context', 'success', { requestId: 'agent.software.context' })
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
      writeAudit('agent.software.validate', 'success', { storeId, requestId: 'agent.software.validate' })
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
        requestId: JSON.stringify({
          actions: input.plan.steps.map(step => step.action.type),
          confirmed: input.confirmed === true
        })
      })
      return success(result, requestId)
    } catch (error) { return errorResponse(error, requestId, 'agent.software.execute', storeId) }
  })
}
