import { describe, expect, it } from 'vitest'
import { resolveAutoLearningTarget } from '../../packages/shared/src/agent-memory-learning'

describe('automatic Agent memory ownership', () => {
  it('keeps legacy and root jobs under root-ceo governance', () => {
    expect(resolveAutoLearningTarget({ assignedAgentId: null, storeId: null, currentMemoryWrite: false })).toEqual({ agentId: 'root-ceo', scope: 'shared' })
    expect(resolveAutoLearningTarget({ assignedAgentId: 'root-ceo', storeId: 'store-1', currentMemoryWrite: true })).toEqual({ agentId: 'root-ceo', scope: 'store' })
  })

  it('routes historical child store jobs to root-ceo store memory', () => {
    expect(resolveAutoLearningTarget({ assignedAgentId: 'operator-1', storeId: 'store-1', currentMemoryWrite: true, frozenMemoryWrite: true })).toEqual({ agentId: 'root-ceo', scope: 'store' })
  })

  it('routes a writable model-only job to root shared memory', () => {
    expect(resolveAutoLearningTarget({ assignedAgentId: 'operator-1', storeId: null, currentMemoryWrite: true, frozenMemoryWrite: true })).toEqual({ agentId: 'root-ceo', scope: 'shared' })
  })

  it('falls back when the frozen or current write boundary is revoked', () => {
    expect(resolveAutoLearningTarget({ assignedAgentId: 'operator-1', storeId: 'store-1', currentMemoryWrite: true, frozenMemoryWrite: false })).toEqual({ agentId: 'root-ceo', scope: 'store' })
    expect(resolveAutoLearningTarget({ assignedAgentId: 'operator-1', storeId: 'store-1', currentMemoryWrite: false, frozenMemoryWrite: true })).toEqual({ agentId: 'root-ceo', scope: 'store' })
  })

  it('falls back when the job store is outside either frozen or current scope', () => {
    expect(resolveAutoLearningTarget({ assignedAgentId: 'operator-1', storeId: 'store-2', currentMemoryWrite: true, frozenMemoryWrite: true, frozenMemoryStoreIds: ['store-1'], currentMemoryStoreIds: ['store-1'] })).toEqual({ agentId: 'root-ceo', scope: 'store' })
    expect(resolveAutoLearningTarget({ assignedAgentId: 'operator-1', storeId: 'store-1', currentMemoryWrite: true, frozenMemoryWrite: true, frozenStoreIds: ['store-1'], currentStoreIds: ['store-2'] })).toEqual({ agentId: 'root-ceo', scope: 'store' })
  })
})
