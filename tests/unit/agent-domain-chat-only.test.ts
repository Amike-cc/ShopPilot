import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/contracts/ipc'

const mocks = vi.hoisted(() => {
  class AgentRuntimeError extends Error {
    constructor(public code: string, message: string) { super(message); this.name = 'AgentRuntimeError' }
  }
  const handlers = new Map<string, (...args: any[]) => any>()
  const fn = () => vi.fn(() => ({}))
  return {
    handlers,
    AgentRuntimeError,
    runtimeFns: Object.fromEntries([
      'addJobFeedback', 'cancelAgentJob', 'deleteModelProfile', 'ensureAgentRuntimeBootstrap', 'getAgent', 'getAgentJob',
      'listAgentJobs', 'listAgentsPage', 'listModelProfilesPage', 'markRecoverableJobsOnStartup', 'qualityMetrics',
      'qualityReviewSummary', 'setModelProfile', 'testModelProfile', 'reviewAgentJobResult', 'startAgentRuntimeLeaseSweeper'
    ].map(key => [key, fn()])),
    memoryFns: Object.fromEntries([
      'buildApprovedMemoryContext', 'createMemorySnapshot', 'getMemoryLearningSettings', 'inspectMemorySnapshot', 'listMemories',
      'maintainMemories', 'rebuildMemoryIndex', 'restoreMemorySnapshot', 'reviewMemory', 'searchMemories',
      'setMemoryLearningSettings', 'writeMemory'
    ].map(key => [key, fn()])),
    serviceFns: Object.fromEntries([
      'createAgentSkillByUser', 'deleteAgentPluginByUser', 'deleteAgentSkill', 'exportAgentPack', 'importAgentPack',
      'listAgentSkillLibrary', 'updateAgentPluginByUser', 'updateAgentSkill'
    ].map(key => [key, fn()])),
    assertTrustedRenderer: vi.fn(),
    askConfirm: vi.fn(),
    getDatabase: vi.fn(() => ({ prepare: () => ({ get: () => ({}), all: () => [], run: () => ({ changes: 0 }) }) }))
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler)) }
}))
vi.mock('../../apps/desktop/src/main/browser/window-manager', () => ({ getBrowserHostWindow: vi.fn(() => null) }))
vi.mock('../../apps/desktop/src/main/services/renderer-trust', () => ({ assertTrustedRenderer: mocks.assertTrustedRenderer }))
vi.mock('../../apps/desktop/src/main/services/agent-runtime', () => ({ ...mocks.runtimeFns, AgentRuntimeError: mocks.AgentRuntimeError }))
vi.mock('../../apps/desktop/src/main/services/agent-memory', () => mocks.memoryFns)
vi.mock('../../apps/desktop/src/main/services/agent-service', () => mocks.serviceFns)
vi.mock('../../apps/desktop/src/main/services/commerce-action-ledger', () => ({ commerceActionLedgerFor: vi.fn(() => ({ list: vi.fn(() => []) })) }))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@shared/agent-tools', () => ({ listSkillStepTools: vi.fn(() => []) }))
vi.mock('../../apps/desktop/src/main/services/password-dialog', () => ({ askConfirm: mocks.askConfirm }))

import { registerAgentDomainHandlers } from '../../apps/desktop/src/main/ipc/agent-domain-handlers'

describe('Agent domain IPC is closed in plain conversation mode', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    registerAgentDomainHandlers()
  })

  it('rejects job execution, mutation, memory writes, skill and model management in Main', async () => {
    const event = {} as Electron.IpcMainInvokeEvent
    const blocked = [
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
      IPC_CHANNELS.AGENT_MEMORY_WRITE,
      IPC_CHANNELS.AGENT_MEMORY_REVIEW,
      IPC_CHANNELS.AGENT_MEMORY_LIST,
      IPC_CHANNELS.AGENT_MEMORY_SEARCH,
      IPC_CHANNELS.AGENT_MEMORY_REBUILD,
      IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT,
      IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_INSPECT,
      IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_RESTORE,
      IPC_CHANNELS.AGENT_MEMORY_LEARNING_SETTINGS,
      IPC_CHANNELS.AGENT_MEMORY_MAINTENANCE,
      IPC_CHANNELS.AGENT_ORG_LIST,
      IPC_CHANNELS.AGENT_ORG_GET,
      IPC_CHANNELS.AGENT_HR_PREVIEW,
      IPC_CHANNELS.AGENT_SKILL_CREATE,
      IPC_CHANNELS.AGENT_SKILL_LIST,
      IPC_CHANNELS.AGENT_SKILL_TOOLS,
      IPC_CHANNELS.AGENT_SKILL_DELETE,
      IPC_CHANNELS.AGENT_SKILL_UPDATE,
      IPC_CHANNELS.AGENT_PACK_EXPORT,
      IPC_CHANNELS.AGENT_PACK_IMPORT,
      IPC_CHANNELS.AGENT_PLUGIN_UPDATE,
      IPC_CHANNELS.AGENT_PLUGIN_DELETE,
      IPC_CHANNELS.AGENT_QUALITY_METRICS,
      IPC_CHANNELS.AGENT_QUALITY_REVIEW,
      IPC_CHANNELS.AGENT_COMMERCE_LEDGER_LIST,
      IPC_CHANNELS.AGENT_MODEL_BIND,
      IPC_CHANNELS.AGENT_MODEL_LIST,
      IPC_CHANNELS.AGENT_MODEL_SET,
      IPC_CHANNELS.AGENT_MODEL_DELETE,
      IPC_CHANNELS.AGENT_MODEL_TEST
    ]

    for (const channel of blocked) {
      const result = await mocks.handlers.get(channel)?.(event, {})
      expect(result, channel).toMatchObject({ ok: false, error: { code: 'AGENT_OPERATION_NOT_ALLOWED' } })
    }
    expect(mocks.runtimeFns.runAgentJob).toBeUndefined()
    expect(mocks.runtimeFns.createAgentJob).toBeUndefined()
    expect(mocks.runtimeFns.delegateAgentTask).toBeUndefined()
    expect(mocks.runtimeFns.markRecoverableJobsOnStartup).not.toHaveBeenCalled()
    expect(mocks.runtimeFns.startAgentRuntimeLeaseSweeper).not.toHaveBeenCalled()
    expect(mocks.runtimeFns.getAgentJob).not.toHaveBeenCalled()
    expect(mocks.runtimeFns.listAgentJobs).not.toHaveBeenCalled()
    expect(mocks.runtimeFns.listAgentsPage).not.toHaveBeenCalled()
    expect(mocks.memoryFns.listMemories).not.toHaveBeenCalled()
    expect(mocks.memoryFns.searchMemories).not.toHaveBeenCalled()
    expect(mocks.serviceFns.exportAgentPack).not.toHaveBeenCalled()
  })

  it('model Profile management is closed too (models live in AI 配置)', async () => {
    const event = {} as Electron.IpcMainInvokeEvent
    for (const channel of [IPC_CHANNELS.AGENT_MODEL_LIST, IPC_CHANNELS.AGENT_MODEL_SET, IPC_CHANNELS.AGENT_MODEL_DELETE, IPC_CHANNELS.AGENT_MODEL_TEST]) {
      const result = await mocks.handlers.get(channel)?.(event, {})
      expect(result, channel).toMatchObject({ ok: false, error: { code: 'AGENT_OPERATION_NOT_ALLOWED' } })
    }
    expect(mocks.runtimeFns.listModelProfilesPage).not.toHaveBeenCalled()
    expect(mocks.runtimeFns.setModelProfile).not.toHaveBeenCalled()
    expect(mocks.runtimeFns.deleteModelProfile).not.toHaveBeenCalled()
    expect(mocks.runtimeFns.testModelProfile).not.toHaveBeenCalled()
  })
})
