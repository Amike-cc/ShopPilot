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

function allowsStore(storeId: string | null, allowed: readonly string[] | undefined): boolean {
  const ids = (allowed || []).map(String).filter(Boolean)
  return !ids.length || (!!storeId && ids.includes(storeId))
}

/**
 * A child can learn only when both the frozen Job permission and the current
 * permission still grant memory writes and cover the target store. Otherwise
 * the candidate remains under root-ceo governance for compatibility and audit.
 */
export function resolveAutoLearningTarget(input: AutoLearningTargetInput): AutoLearningTarget {
  const rootAgentId = input.rootAgentId || 'root-ceo'
  const assignedAgentId = String(input.assignedAgentId || '')
  const storeId = input.storeId || null
  const rootTarget: AutoLearningTarget = { agentId: rootAgentId, scope: storeId ? 'store' : 'shared' }
  if (!assignedAgentId || assignedAgentId === rootAgentId) return rootTarget
  if (input.frozenMemoryWrite === false || !input.currentMemoryWrite) return rootTarget
  if (!allowsStore(storeId, input.frozenMemoryStoreIds) || !allowsStore(storeId, input.currentMemoryStoreIds)) return rootTarget
  if (!allowsStore(storeId, input.frozenStoreIds) || !allowsStore(storeId, input.currentStoreIds)) return rootTarget
  return { agentId: assignedAgentId, scope: storeId ? 'store' : 'private' }
}
