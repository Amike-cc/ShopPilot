/**
 * Pure routing rules for automatic Job/feedback memory candidates.
 *
 * Main supplies both the current Agent permissions and the immutable Job
 * snapshot. Keeping the decision here makes the private-learning boundary
 * unit-testable without Electron, SQLite, or a live model provider.
 */

export type AutoLearningScope = 'private' | 'store' | 'shared'
export type AutoLearningTarget = { agentId: string; scope: AutoLearningScope }

export interface AutoLearningTargetInput {
  rootAgentId?: string
  assignedAgentId?: string | null
  storeId?: string | null
  currentMemoryWrite: boolean
  currentMemoryStoreIds?: readonly string[]
  frozenMemoryWrite?: boolean
  frozenMemoryStoreIds?: readonly string[]
  currentStoreIds?: readonly string[]
  frozenStoreIds?: readonly string[]
}

/**
 * Single-agent mode keeps automatic learning under root-ceo governance. The
 * historical permission/snapshot fields remain in the input so old Jobs can
 * still be evaluated and audited, but they never create a child-owned record.
 */
export function resolveAutoLearningTarget(input: AutoLearningTargetInput): AutoLearningTarget {
  const rootAgentId = input.rootAgentId || 'root-ceo'
  const storeId = input.storeId || null
  return { agentId: rootAgentId, scope: storeId ? 'store' : 'shared' }
}
