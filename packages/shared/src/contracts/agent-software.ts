/**
 * Agent 软件动作的结构化领域回执。
 *
 * Renderer 可以把 safeMessage 展示给用户，但不能把它当作执行证据；
 * 领域动作必须同时返回稳定状态、原因码和最小脱敏证据摘要。
 */
import { z } from 'zod'

export const agentSoftwareResultStatusSchema = z.enum([
  'SUCCEEDED', 'PARTIAL', 'FAILED', 'LOGIN_REQUIRED', 'VERIFY_REQUIRED',
  'NOT_VERIFIED', 'WAITING_CONFIRMATION', 'RECOVERY_REQUIRED'
  , 'UNKNOWN'
])

export type AgentSoftwareResultStatus =
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'FAILED'
  | 'LOGIN_REQUIRED'
  | 'VERIFY_REQUIRED'
  | 'NOT_VERIFIED'
  | 'WAITING_CONFIRMATION'
  | 'RECOVERY_REQUIRED'
  | 'UNKNOWN'

export interface AgentSoftwareEvidence {
  source: string
  capturedAt: number
  runId?: string | null
  counts?: Record<string, number>
}

export interface AgentSoftwareActionResult {
  actionType: string
  status: AgentSoftwareResultStatus
  reasonCode: string
  safeMessage: string
  summary: Record<string, string | number | boolean | null>
  evidence?: AgentSoftwareEvidence
}

export const agentSoftwareActionResultSchema = z.object({
  actionType: z.string().min(1).max(80),
  status: agentSoftwareResultStatusSchema,
  reasonCode: z.string().min(1).max(120),
  safeMessage: z.string().max(1000),
  summary: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  evidence: z.object({
    source: z.string().min(1).max(120),
    capturedAt: z.number().int().nonnegative(),
    runId: z.string().max(160).nullable().optional(),
    counts: z.record(z.number().int().nonnegative()).optional()
  }).strict().optional()
}).strict()
