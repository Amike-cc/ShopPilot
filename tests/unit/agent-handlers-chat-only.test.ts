import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/contracts/ipc'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  generateAgentChat: vi.fn(),
  getAgentUiState: vi.fn(),
  setAgentUiState: vi.fn(),
  writeAudit: vi.fn(),
  auditRequestId: vi.fn((requestId: string) => requestId)
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler))
  }
}))
vi.mock('../../apps/desktop/src/main/services/agent-chat-service', () => ({ generateAgentChat: mocks.generateAgentChat }))
vi.mock('../../apps/desktop/src/main/services/agent-service', () => ({
  getAgentUiState: mocks.getAgentUiState,
  setAgentUiState: mocks.setAgentUiState
}))
vi.mock('../../apps/desktop/src/main/services/audit-logger', () => ({ writeAudit: mocks.writeAudit, auditRequestId: mocks.auditRequestId }))
vi.mock('../../apps/desktop/src/main/services/renderer-trust', () => ({ assertTrustedRenderer: vi.fn() }))

import { registerAgentHandlers } from '../../apps/desktop/src/main/ipc/agent-handlers'

describe('Agent Main IPC in plain conversation mode', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    mocks.generateAgentChat.mockResolvedValue({ text: '普通文字回复', model: 'fixture', elapsedMs: 3 })
    mocks.getAgentUiState.mockReturnValue({ drawerOpen: false })
    mocks.setAgentUiState.mockImplementation(state => state)
    registerAgentHandlers()
  })

  it('offers one text chat handler and rejects legacy observation and execution handlers', async () => {
    const event = {} as Electron.IpcMainInvokeEvent
    const chat = await mocks.handlers.get(IPC_CHANNELS.AGENT_CHAT)?.(event, { message: '你好', history: [] })
    expect(chat).toMatchObject({ ok: true, data: { text: '普通文字回复' } })

    for (const channel of [
      IPC_CHANNELS.AGENT_PAGE_OBSERVE,
      IPC_CHANNELS.AGENT_PLAN_GENERATE,
      IPC_CHANNELS.AGENT_JOB_FOLLOW_UP,
      IPC_CHANNELS.AGENT_PLAN_VALIDATE,
      IPC_CHANNELS.AGENT_SOFTWARE_CONTEXT,
      IPC_CHANNELS.AGENT_SOFTWARE_VALIDATE,
      IPC_CHANNELS.AGENT_SOFTWARE_EXECUTE
    ]) {
      const result = await mocks.handlers.get(channel)?.(event, {})
      expect(result).toMatchObject({ ok: false, error: { code: 'AGENT_OPERATION_NOT_ALLOWED' } })
    }
    expect(mocks.generateAgentChat).toHaveBeenCalledTimes(1)
  })

  it('validates chat payloads and never forwards action or page context', async () => {
    const event = {} as Electron.IpcMainInvokeEvent
    const result = await mocks.handlers.get(IPC_CHANNELS.AGENT_CHAT)?.(event, {
      message: '帮我点击按钮',
      history: [],
      page: { url: 'https://shop.example' },
      actions: [{ type: 'click' }]
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'AGENT_INVALID_INPUT' } })
    expect(mocks.generateAgentChat).not.toHaveBeenCalled()
  })
})

