import { defineStore } from 'pinia'
import type { AgentUiState } from '@shared/schemas/agent'
import { AGENT_CONVERSATION_HISTORY_MAX, AGENT_UI_MESSAGE_TEXT_MAX, DEFAULT_AGENT_UI_STATE } from '@shared/schemas/agent'

let initializePromise: Promise<void> | null = null
let uiWriteInFlight = false
let uiPendingSnapshot: AgentUiState | null = null

type AgentMessage = { id: string; role: 'user' | 'assistant'; text: string; at: number; meta?: string }

export const useAgentStore = defineStore('agent', {
  state: () => ({
    status: 'idle' as 'idle' | 'thinking' | 'failed',
    initialized: false,
    uiLoaded: false,
    aiConfigured: null as boolean | null,
    ui: { ...DEFAULT_AGENT_UI_STATE, orbPosition: { ...DEFAULT_AGENT_UI_STATE.orbPosition }, messageSummaries: [] } as AgentUiState,
    messages: [] as AgentMessage[],
    busy: false,
    error: null as { code: string; message: string } | null
  }),

  getters: {
    stateLabel(state): string {
      return state.status === 'thinking' ? '思考中' : state.status === 'failed' ? '对话失败' : '在线'
    }
  },

  actions: {
    async initialize() {
      if (!initializePromise) {
        const loading = (async () => {
          if (!this.uiLoaded) {
            const result = await window.shopilot.agent.uiGet()
            if (result.ok && result.data) {
              this.ui = result.data
              this.messages = result.data.messageSummaries.map((item, index) => ({
                id: `restored-${item.at}-${index}`,
                role: item.role,
                text: item.summary,
                at: item.at
              }))
            }
            this.uiLoaded = true
          }
          if (this.aiConfigured === null) {
            try {
              const ai = await window.shopilot.ai.configGet()
              this.aiConfigured = !!(ai.ok && ai.data?.hasKey)
            } catch {
              this.aiConfigured = false
            }
          }
          this.initialized = true
        })()
        initializePromise = loading
        try {
          await loading
        } catch (error) {
          if (initializePromise === loading) initializePromise = null
          throw error
        }
      } else await initializePromise
    },

    persistUi() {
      if (!this.uiLoaded) return
      this.ui.messageSummaries = this.messages.slice(-AGENT_CONVERSATION_HISTORY_MAX).map(message => ({
        role: message.role,
        summary: message.text.slice(0, AGENT_UI_MESSAGE_TEXT_MAX),
        at: message.at
      }))
      uiPendingSnapshot = JSON.parse(JSON.stringify(this.ui)) as AgentUiState
      if (!uiWriteInFlight) void this.flushUiWrites()
    },

    async flushUiWrites() {
      if (uiWriteInFlight) return
      uiWriteInFlight = true
      try {
        while (uiPendingSnapshot) {
          const snapshot = uiPendingSnapshot
          uiPendingSnapshot = null
          try { await window.shopilot.agent.uiSet(snapshot) } catch { /* UI remains usable if persistence is temporarily unavailable. */ }
        }
      } finally { uiWriteInFlight = false }
    },

    addMessage(role: AgentMessage['role'], text: string, meta?: string) {
      this.messages.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        text: String(text).slice(0, AGENT_UI_MESSAGE_TEXT_MAX),
        at: Date.now(),
        meta
      })
      this.messages = this.messages.slice(-AGENT_CONVERSATION_HISTORY_MAX)
      this.persistUi()
    },

    setOrbPosition(position: { x: number; y: number }) {
      this.ui.orbPosition = { x: Math.min(Math.max(position.x, 0), 1), y: Math.min(Math.max(position.y, 0), 1) }
      this.persistUi()
    },

    setDrawerOpen(open: boolean) {
      this.ui.drawerOpen = open
      this.persistUi()
    },

    async sendMessage(message: string) {
      const trimmed = message.trim()
      if (!trimmed || this.busy) return
      this.error = null
      this.status = 'thinking'
      this.busy = true
      this.addMessage('user', trimmed)
      const history = this.messages.slice(0, -1).map(item => ({ role: item.role, text: item.text }))

      try {
        const result = await window.shopilot.agent.chat(trimmed, history)
        if (!result.ok) throw result.error
        this.addMessage('assistant', result.data.text, `${result.data.model} · ${result.data.elapsedMs} ms`)
        this.aiConfigured = true
        this.status = 'idle'
      } catch (error: any) {
        this.error = {
          code: String(error?.code || 'AGENT_CHAT_FAILED'),
          message: String(error?.message || '对话请求失败')
        }
        this.status = 'failed'
      } finally {
        this.busy = false
      }
    }
  }
})
