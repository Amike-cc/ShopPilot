import { defineStore } from 'pinia'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import type {
  AgentPageObservation,
  AgentPlan,
  AgentSoftwareContext,
  AgentSoftwarePlan,
  AgentUiState
} from '@shared/schemas/agent'
import { AGENT_CONVERSATION_HISTORY_MAX, AGENT_UI_MESSAGE_TEXT_MAX, DEFAULT_AGENT_UI_STATE } from '@shared/schemas/agent'
import { describeAgentContextUsage } from '@shared/agent-context'
import type { TaskCreateInput } from '@shared/schemas/task'
import { statusForJob, planStatusForJob, type AgentUiStatus } from '../features/agent/job-status'

let initializePromise: Promise<void> | null = null

/**
 * UI 快照持久化用「单飞 + 最新值优先」的串行写：uiSet 是整份状态覆盖写，
 * 并发写会让旧快照后到并盖掉新快照（快速连续 addMessage/setOrbPosition/setDrawerOpen 时实测丢抽屉开合）。
 * 只在渲染层排队，不改 IPC 契约。模块级即可：store 是单例，与 initializePromise 同理。
 */
let uiWriteInFlight = false
let uiPendingSnapshot: AgentUiState | null = null

/**
 * 软件上下文的后台刷新节流窗口。
 * Job 进度事件会随日志刷屏，每条都打一次 IPC 既浪费又会让抽屉里的 Agent/待办计数来回跳。
 */
const SOFTWARE_CONTEXT_THROTTLE_MS = 2000
let softwareContextRefreshTimer: ReturnType<typeof setTimeout> | null = null
let softwareContextRefreshedAt = 0

type AgentMessage = { id: string; role: 'user' | 'assistant'; text: string; at: number; thought?: boolean; meta?: string }

export const useAgentStore = defineStore('agent', {
  state: () => ({
    status: 'idle' as AgentUiStatus,
    initialized: false,
    uiLoaded: false,
    aiConfigured: null as boolean | null,
    ui: { ...DEFAULT_AGENT_UI_STATE, orbPosition: { ...DEFAULT_AGENT_UI_STATE.orbPosition }, messageSummaries: [] } as AgentUiState,
    messages: [] as AgentMessage[],
    observation: null as AgentPageObservation | null,
    softwareContext: null as AgentSoftwareContext | null,
    plan: null as AgentPlan | null,
    softwarePlan: null as AgentSoftwarePlan | null,
    pendingGoal: '' as string,
    busy: false,
    error: null as { code: string; message: string } | null,
    task: null as null | {
      id: string; jobId: string; executorName: string; name: string; runId: string | null; status: string; currentStep: number | null; totalSteps: number;
      message: string; errorCode: string | null; errorMessage: string | null; results: any | null; confirmation: any | null
    },
    completionAnnouncedRunId: '',
    recapAnnouncedJobId: '' as string,
    /** 最近一次用户目标（Job 结束后自动续办时带回去，让智能体知道要解决什么问题）。 */
    lastGoal: '' as string,
    /** 续办已触发标记（同一批 Job 只续办一次）。 */
    followUpInFlight: false,
    /** 已经完成或尝试过自动续办的批次，避免多个后台 watcher 重复派发。 */
    followUpCompletedKey: '' as string,
  }),

  getters: {
    stateLabel(state): string {
      return ({
        idle: '在线', thinking: '思考中', observing: '观察页面', plan_ready: '计划待确认', validating: '校验计划',
        creating_task: '执行中', executing_software: '操作软件中', running: '主 Agent 执行中', paused: '已暂停', waiting_confirmation: '等待人工确认',
        succeeded: '已完成', failed: '执行失败', cancelled: '已取消'
      } as Record<AgentUiStatus, string>)[state.status]
    },
    needsConfirmation(state): boolean { return state.status === 'waiting_confirmation' || !!state.task?.confirmation }
  },

  actions: {
    async initialize() {
      if (!this.initialized) {
        this.initialized = true
        window.shopilot.on(EVENT_CHANNELS.TASK_PROGRESS, (event: any) => { void this.onTaskProgress(event) })
        window.shopilot.on(EVENT_CHANNELS.TASK_CONFIRMATION_REQUIRED, (event: any) => this.onTaskConfirmation(event))
        window.shopilot.on(EVENT_CHANNELS.AGENT_JOB_PROGRESS, (event: any) => {
          void this.onJobProgress(event)
          // 所有 Job（不只当前 task 的）都会改变抽屉里的 Job/待办/未审核计数，统一走节流刷新。
          this.refreshSoftwareContextSoon()
        })
        // 组织状态变化（激活/暂停/恢复/退休、自动供给）后刷新软件上下文，抽屉里的 Agent 列表保持最新。
        window.shopilot.on(EVENT_CHANNELS.AGENT_STATUS_CHANGED, () => { void this.refreshSoftwareContext() })
      }
      if (!initializePromise) {
        const loading = (async () => {
          if (!this.uiLoaded) {
            const result = await window.shopilot.agent.uiGet()
            if (result.ok && result.data) {
              this.ui = result.data
              this.messages = result.data.messageSummaries.map((item, index) => ({ id: `restored-${item.at}-${index}`, role: item.role, text: item.summary, at: item.at }))
            }
            this.uiLoaded = true
          }
          if (this.aiConfigured === null) {
            const ai = await window.shopilot.ai.configGet()
            this.aiConfigured = !!(ai.ok && ai.data?.hasKey)
          }
          const context = await window.shopilot.agent.softwareContext()
          if (context.ok) this.softwareContext = context.data
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
      // 存正文而不是 200 字摘要：重载时这里会被用来重建 messages（见 initialize），
      // 存摘要等于每次重启都把旧轮次砍到 200 字，模型随即丢失指代对象。
      this.ui.messageSummaries = this.messages.slice(-AGENT_CONVERSATION_HISTORY_MAX).map(message => ({
        role: message.role, summary: message.text.slice(0, AGENT_UI_MESSAGE_TEXT_MAX), at: message.at
      }))
      // Store state and preload return values are Vue/ContextBridge proxies. Clone in Renderer
      // before crossing contextBridge; cloning inside preload is too late for proxy arguments.
      uiPendingSnapshot = JSON.parse(JSON.stringify(this.ui)) as AgentUiState
      // 单飞 + 最新值优先：写入进行中只更新 pending，写完后若有新值再写一次。
      // 快照是整份 UI 状态，丢掉中间态不会丢信息，但最后一次状态必须落库（否则抽屉开合/球位置回退）。
      if (!uiWriteInFlight) void this.flushUiWrites()
    },

    async flushUiWrites() {
      if (uiWriteInFlight) return
      uiWriteInFlight = true
      try {
        while (uiPendingSnapshot) {
          const snapshot = uiPendingSnapshot
          uiPendingSnapshot = null
          try {
            await window.shopilot.agent.uiSet(snapshot)
          } catch { /* 后台持久化失败不改对话状态：UI 仍可用，下一次写入会带上最新快照 */ }
        }
      } finally { uiWriteInFlight = false }
    },

    addMessage(role: AgentMessage['role'], text: string, options: { thought?: boolean; meta?: string } = {}) {
      this.messages.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, role, text: String(text).slice(0, 2000), at: Date.now(), thought: options.thought === true, meta: options.meta })
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

    async observePage() {
      if (this.busy) return
      this.status = 'observing'; this.busy = true; this.error = null
      try {
        const result = await window.shopilot.agent.observe()
        if (!result.ok) throw result.error
        this.observation = result.data as AgentPageObservation
        this.status = 'idle'
        this.addMessage('assistant', `已观察当前页面：${this.observation.pageTitle || this.observation.tabTitle || '无标题'}。可见 ${this.observation.buttons.length} 个按钮、${this.observation.inputs.length} 个输入框和 ${this.observation.tables.length} 个表格。`)
      } catch (error: any) {
        this.error = { code: error?.code || 'AGENT_OBSERVE_FAILED', message: error?.message || '页面观察失败' }
        this.status = 'failed'
        this.addMessage('assistant', `页面观察失败（${this.error.code}）：${this.error.message}`)
      } finally { this.busy = false }
    },

    async refreshSoftwareContext() {
      try {
        const result = await window.shopilot.agent.softwareContext()
        if (!result.ok) throw result.error
        this.softwareContext = result.data
        return result.data
      } catch (error: any) {
        this.error = { code: error?.code || 'AGENT_SOFTWARE_CONTEXT_FAILED', message: error?.message || '软件上下文读取失败' }
        this.addMessage('assistant', `软件上下文读取失败（${this.error.code}）：${this.error.message}`)
        return null
      }
    },

    /**
     * 节流刷新软件上下文：Job 进度、任务终态后调用（2 秒内最多一次 IPC）。
     *
     * 为什么尾部还要补一次：一串进度事件里最后一条往往正是「失败 / 等待人工确认 / 出现待审核证据」，
     * 只做首端节流的话这个窗口内的后续变化要等下一次事件才刷新，没事件就长期停在旧状态——
     * 那正是抽屉里「等待人工确认 / 失败 / 待办」过期的原因。
     * 为什么失败不写 this.error、不进对话：这是后台刷新，失败多半是瞬时抖动，
     * 写进对话会淹没真正的错误；用户点「查看软件」走 refreshSoftwareContext 仍能看到真实报错。
     */
    refreshSoftwareContextSoon() {
      const elapsed = Date.now() - softwareContextRefreshedAt
      if (elapsed >= SOFTWARE_CONTEXT_THROTTLE_MS) { void this.refreshSoftwareContextQuietly(); return }
      if (softwareContextRefreshTimer) return
      softwareContextRefreshTimer = setTimeout(() => {
        softwareContextRefreshTimer = null
        void this.refreshSoftwareContextQuietly()
      }, SOFTWARE_CONTEXT_THROTTLE_MS - elapsed)
    },

    async refreshSoftwareContextQuietly() {
      softwareContextRefreshedAt = Date.now()
      try {
        const result = await window.shopilot.agent.softwareContext()
        if (result.ok && result.data) this.softwareContext = result.data
      } catch { /* 见 refreshSoftwareContextSoon 的说明：后台失败不改状态 */ }
    },

    async generatePlan(goal: string, options: { echo?: boolean } = {}) {
      const trimmed = goal.trim()
      if (!trimmed || this.busy) return
      this.lastGoal = trimmed
      // Main 会按当前模型的上下文窗口压缩旧轮次；Renderer 保留更长的
      // 最近历史，让大窗口模型能够继续大型任务，低窗口模型仍能安全裁剪。
      const history = this.messages.filter(message => !message.thought).slice(-AGENT_CONVERSATION_HISTORY_MAX).map(message => ({ role: message.role, text: message.text.slice(0, 2000) }))
      if (options.echo !== false) this.addMessage('user', trimmed)
      this.error = null; this.status = 'thinking'; this.busy = true; this.plan = null; this.softwarePlan = null; this.pendingGoal = ''
      let autoRun: 'software' | 'dispatch' | null = null
      try {
        const result = await window.shopilot.agent.generatePlan(trimmed, history)
        if (!result.ok) throw result.error
        if (result.data.kind === 'chat') {
          this.status = 'idle'
          this.plan = null
          this.softwarePlan = null
          for (const thought of result.data.thoughts || []) this.addMessage('assistant', thought, { thought: true })
          this.addMessage('assistant', String(result.data.text || '当前没有打开的店铺页面。页面任务需要先打开店铺；打开后我可以生成计划并由主 Agent 执行。'), {
            meta: result.data.usage ? describeAgentContextUsage(result.data.usage) : undefined
          })
          if (Array.isArray(result.data.jobIds) && result.data.jobIds.length) void this.watchDelegatedJobs(result.data.jobIds.map(String), trimmed)
        } else if (result.data.kind === 'software') {
          if (result.data.thought) this.addMessage('assistant', result.data.thought, { thought: true })
          this.softwarePlan = result.data.plan
          this.softwareContext = result.data.context
          this.pendingGoal = String(result.data.pendingGoal || '')
          this.status = 'plan_ready'
          const auto = result.data.requiresApproval !== true
          this.addMessage('assistant', this.pendingGoal
            ? (auto ? '已定位目标店铺，正在打开并继续规划页面任务……' : '已定位目标店铺。该操作需要你确认后我再打开店铺并继续规划。')
            : (auto ? `已生成软件操作计划（${result.data.model}），按自治策略自动执行。` : `已生成软件操作计划（${result.data.model}）。该操作涉及资金或不可逆操作，请确认后执行。`))
          if (auto) autoRun = 'software'
        } else {
          this.plan = result.data.plan
          this.observation = result.data.observation
          this.status = 'plan_ready'
          const auto = result.data.requiresApproval !== true
          this.addMessage('assistant', auto
            ? `已生成任务计划（${result.data.model}，${result.data.elapsedMs} ms），按自治策略由主 Agent 自动执行。`
            : `已生成任务计划（${result.data.model}，${result.data.elapsedMs} ms）。涉及资金，确认后才会执行。` )
          if (auto) autoRun = 'dispatch'
        }
      } catch (error: any) {
        this.error = { code: error?.code || 'AGENT_PLAN_FAILED', message: error?.message || '计划生成失败' }
        this.status = 'failed'
        this.addMessage('assistant', `计划生成失败（${this.error.code}）：${this.error.message}`)
      } finally { this.busy = false }
      if (autoRun === 'software' && !this.error) await this.executeSoftwarePlan()
      else if (autoRun === 'dispatch' && !this.error) await this.validateCreate(true)
    },

    async executeSoftwarePlan() {
      if (!this.softwarePlan || this.busy) return
      this.error = null; this.status = 'validating'; this.busy = true
      let continueGoal = ''
      try {
        const serializablePlan = JSON.parse(JSON.stringify(this.softwarePlan)) as AgentSoftwarePlan
        const validated = await window.shopilot.agent.validateSoftwarePlan(serializablePlan)
        if (!validated.ok) throw validated.error
        const normalized = JSON.parse(JSON.stringify(validated.data)) as { plan: AgentSoftwarePlan; changed: boolean }
        this.softwarePlan = normalized.plan
        if (normalized.changed) {
          this.status = 'plan_ready'
          this.addMessage('assistant', '软件计划已由 Main 规范化，请再次点击执行确认。')
          return
        }
        this.status = 'executing_software'
        const executed = await window.shopilot.agent.executeSoftwarePlan(normalized.plan, normalized.plan.requiresConfirmation)
        if (!executed.ok) throw executed.error
        const data = JSON.parse(JSON.stringify(executed.data)) as { plan: AgentSoftwarePlan; context: AgentSoftwareContext; messages: string[]; jobIds?: string[] }
        this.softwarePlan = data.plan
        this.softwareContext = data.context
        this.status = 'succeeded'
        this.addMessage('assistant', `软件操作已完成。${(data.messages || []).join('；') || 'Main 已返回成功状态。'}`)
        if (Array.isArray(data.jobIds) && data.jobIds.length) void this.watchDelegatedJobs(data.jobIds.map(String), this.lastGoal)
        continueGoal = this.pendingGoal
      } catch (error: any) {
        this.error = { code: error?.code || 'AGENT_SOFTWARE_FAILED', message: error?.message || '软件操作失败' }
        this.status = 'failed'
        this.addMessage('assistant', `软件操作失败（${this.error.code}）：${this.error.message}`)
      } finally { this.busy = false }
      if (continueGoal && !this.error) {
        this.pendingGoal = ''
        this.addMessage('assistant', '店铺已打开，继续规划页面任务……')
        await this.generatePlan(continueGoal, { echo: false })
      }
    },

    async validateCreate(runAfterCreate: boolean) {
      if (!this.plan || this.busy) return
      this.error = null; this.status = 'validating'; this.busy = true
      try {
        const serializablePlan = JSON.parse(JSON.stringify(this.plan)) as AgentPlan
        const validated = await window.shopilot.agent.validatePlan(serializablePlan)
        if (!validated.ok) throw validated.error
        const normalized = JSON.parse(JSON.stringify(validated.data)) as { plan: AgentPlan; taskInput: TaskCreateInput; changed: boolean }
        this.plan = normalized.plan
        if (normalized.changed) {
          this.status = 'plan_ready'
          this.addMessage('assistant', '校验时补充或规范化了步骤（例如人工确认门禁）。请先检查更新后的计划，再次点击派发。')
          return
        }

        this.status = 'creating_task'
        // 单 Agent 模式：Main 将已校验的计划创建为 root-ceo Job，并由主 Agent 执行。
        const delegated = await window.shopilot.agentDomain.jobDelegate({
          actorAgentId: 'root-ceo',
          goal: normalized.plan.goal,
          storeId: normalized.plan.storeId,
          planId: normalized.plan.id,
          requiresConfirmation: normalized.plan.requiresConfirmation,
          run: runAfterCreate,
          browserTask: {
            name: normalized.taskInput.name,
            storeScope: normalized.plan.storeId,
            steps: normalized.taskInput.steps as unknown as Record<string, unknown>[]
          }
        })
        if (!delegated.ok) throw delegated.error
        const data = JSON.parse(JSON.stringify(delegated.data)) as { job: any; executor: { id: string; name: string; role: string } }
        this.plan.status = planStatusForJob(String(data.job.status))
        this.task = {
          id: String(data.job.browserTaskId || data.job.id), jobId: String(data.job.id), executorName: data.executor.name,
          name: String(data.job.goal || normalized.plan.name), runId: data.job.browserRunId ? String(data.job.browserRunId) : null,
          status: String(data.job.status), currentStep: null, totalSteps: normalized.taskInput.steps.length,
          message: runAfterCreate ? `已由主 Agent「${data.executor.name}」执行` : `已创建主 Agent Job「${data.executor.name}」，尚未运行`,
          errorCode: null, errorMessage: null, results: null, confirmation: null
        }
        this.addMessage('assistant', runAfterCreate
          ? `已由主 Agent「${data.executor.name}」执行（Job ${data.job.id}）。进度、证据和审核以 Agent Job 看板为准。`
          : `已创建主 Agent Job「${data.executor.name}」（Job ${data.job.id}），尚未运行。` )
        await this.refreshJob()
      } catch (error: any) {
        this.error = { code: error?.code || 'AGENT_TASK_FAILED', message: error?.message || '派单失败' }
        this.status = 'failed'
        if (this.task?.jobId) this.task.message = `派单失败：${this.error.message}`
        this.addMessage('assistant', `派单失败（${this.error.code}）：${this.error.message}`)
      } finally { this.busy = false }
    },

    /** 主 Agent 执行期间只读地跟踪 Job。 */
    async refreshJob() {
      const jobId = this.task?.jobId
      if (!jobId) return
      const result = await window.shopilot.agentDomain.jobGet(jobId)
      // 读取期间用户可能已经创建了另一项任务，旧 Job 的响应不能写回新卡片。
      if (this.task?.jobId !== jobId) return
      if (!result.ok) { this.task.errorCode = result.error.code; this.task.errorMessage = result.error.message; return }
      const job = JSON.parse(JSON.stringify(result.data)) as any
      const status = String(job.status || 'queued')
      const last = Array.isArray(job.events) && job.events.length ? job.events[job.events.length - 1] : null
      this.task.status = status
      if (job.browserRunId) this.task.runId = String(job.browserRunId)
      this.task.message = this.jobMessage(job, last)
      if (status === 'waiting_confirmation') {
        this.task.confirmation = { kind: 'job', id: job.confirmationId ? String(job.confirmationId) : null, message: '高风险动作等待人工确认；主 Agent 不会代替用户确认。' }
        this.status = 'waiting_confirmation'
        if (this.plan) this.plan.status = 'waiting_confirmation'
        return
      }
      if (this.task.confirmation?.kind === 'job') this.task.confirmation = null
      if (['succeeded', 'failed', 'cancelled'].includes(status)) {
        this.task.errorCode = status === 'failed' ? String(last?.evidence?.code || 'AGENT_JOB_FAILED') : null
        this.task.errorMessage = status === 'failed' ? this.task.message : null
        this.status = statusForJob(status)
        if (this.plan) this.plan.status = planStatusForJob(status)
        this.announceJobRecap(job, status, last)
        if (this.task.runId) await this.loadTaskResults(this.task.runId)
        // 终态才会产出「待审核证据」这类待办，计数必须以 Main 的最新数据为准（节流合并连发事件）。
        this.refreshSoftwareContextSoon()
        return
      }
      if (['blocked_permission', 'blocked_budget', 'recovery_required', 'expired'].includes(status)) {
        this.task.errorCode = String(last?.evidence?.code || status)
        this.task.errorMessage = this.task.message
        this.status = 'failed'
        if (this.plan) this.plan.status = 'failed'
        this.announceJobRecap(job, status, last)
        // 阻塞/失败会在待办区新增一条，同样刷新一次软件上下文。
        this.refreshSoftwareContextSoon()
        return
      }
      this.status = this.task.confirmation ? this.status : 'running'
      if (this.plan && this.plan.status !== 'waiting_confirmation') this.plan.status = 'running'
    },

    jobMessage(job: any, last: any): string {
      const status = String(job.status)
      if (status === 'queued') return 'Job 已进入队列，等待主 Agent 执行'
      if (status === 'accepted') return '主 Agent 已接受 Job'
      if (status === 'running') return '主 Agent 正在通过现有 TaskRunner 执行'
      if (status === 'succeeded') return '主 Agent 执行完成，证据已由 Main 落库；请到 Job 看板审核结果'
      if (status === 'cancelled') return 'Job 已取消'
      if (status === 'failed' || ['blocked_permission', 'blocked_budget', 'recovery_required', 'expired'].includes(status)) {
        return String(last?.reason || last?.evidence?.code || status)
      }
      return String(last?.reason || status)
    },

    async onJobProgress(event: any) {
      if (!this.task?.jobId || String(event?.jobId || '') !== this.task.jobId) return
      await this.refreshJob()
    },

    /** 多店任务/采集：派发后在后台轮询，逐个把执行结果汇总回对话；全部结束后让智能体自动续办（判断目标、给下一步）。 */
    async watchDelegatedJobs(jobIds: string[], goal = '') {
      const pending = new Set(jobIds)
      const unreadable = new Set<string>()
      const deadline = Date.now() + 60 * 60 * 1000
      // 续办前检查：用户在这批 Job 结束后没有再发新消息（发了就以新消息为准，不打扰）。
      const lastUserAt = [...this.messages].reverse().find(message => message.role === 'user')?.at || 0
      while (pending.size && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 3000))
        for (const jobId of [...pending]) {
          const result = await window.shopilot.agentDomain.jobGet(jobId)
           if (!result.ok) { pending.delete(jobId); unreadable.add(jobId); continue }
          const job = result.data
          if (!['succeeded', 'failed', 'cancelled', 'expired', 'blocked_budget', 'blocked_permission', 'recovery_required'].includes(job.status)) continue
          pending.delete(jobId)
          const jobGoal = String(job.goal || '')
          const storeName = /店铺：([^）)]+)/.exec(jobGoal)?.[1] || (jobGoal.includes('·') ? jobGoal.split('·').pop()!.trim() : jobGoal) || jobId
          const evidence = Array.isArray(job.results) ? job.results.length : 0
          if (job.status === 'succeeded') {
            const summaries = (job.results || []).map((item: any) => String(item.summary || '').slice(0, 60)).filter(Boolean)
            this.addMessage('assistant', `「${storeName}」执行完成：证据 ${evidence} 条${summaries.length ? `；${summaries.join('；')}` : ''}（Job ${jobId}）`)
          } else {
            const reason = job.events?.at(-1)?.reason || job.status
            this.addMessage('assistant', `「${storeName}」未完成（${job.status}）：${String(reason).slice(0, 100)}`)
          }
        }
      }
       if (!pending.size && !unreadable.size) this.addMessage('assistant', '多店任务已全部结束，详情和证据可在 Job 看板查看。')
       else if (!pending.size && unreadable.size) this.addMessage('assistant', `已停止轮询；有 ${unreadable.size} 个 Job 无法读取最新状态，请到 Job 看板核对。`)
       else this.addMessage('assistant', `还有 ${pending.size} 个 Job 超过 60 分钟未结束，已停止轮询；可在 Job 看板查看进度或恢复。`)
      // 自动续办：把结果交回智能体判断「目标是否达成 / 下一步怎么解决」（失败与成功都会续办一次）。
      // 仍有 Job 在运行时不能把未完成结果当成整批结果继续执行下一步。
       if (pending.size || unreadable.size || !goal || this.followUpInFlight) return
       const currentLastUserAt = [...this.messages].reverse().find(message => message.role === 'user')?.at || 0
       if (currentLastUserAt !== lastUserAt) return
       const followUpKey = `${goal}\u0000${[...jobIds].map(String).sort().join(',')}`
       if (this.followUpCompletedKey === followUpKey) return
       this.followUpCompletedKey = followUpKey
       this.followUpInFlight = true
      try {
        const history = this.messages.filter(message => !message.thought).slice(-AGENT_CONVERSATION_HISTORY_MAX).map(message => ({ role: message.role, text: message.text.slice(0, 2000) }))
        const result = await window.shopilot.agent.jobFollowUp(goal, jobIds.slice(0, 100), history)
        if (!result.ok) throw result.error
        if (result.data.kind === 'software') {
          if (result.data.thought) this.addMessage('assistant', result.data.thought, { thought: true })
          this.softwarePlan = result.data.plan
          this.softwareContext = result.data.context
          this.status = 'plan_ready'
          this.addMessage('assistant', result.data.requiresApproval === true
            ? '看完执行结果，我生成了下一步计划；这一步需要你确认后执行。'
            : '看完执行结果，我生成了下一步计划并自动执行。')
          if (result.data.requiresApproval !== true) await this.executeSoftwarePlan()
        } else {
          for (const thought of result.data.thoughts || []) this.addMessage('assistant', thought, { thought: true })
          this.addMessage('assistant', String(result.data.text || '执行结果已看完。'), {
            meta: result.data.usage ? describeAgentContextUsage(result.data.usage) : undefined
          })
        }
        await this.refreshSoftwareContextQuietly()
      } catch (error: any) {
        // 续办失败不影响已回报的结果；如实说明即可。
        this.addMessage('assistant', `执行结果已回报；自动续办失败（${error?.code || 'AGENT_JOB_FOLLOW_UP_FAILED'}）：${error?.message || '未知错误'}`)
      } finally {
        this.followUpInFlight = false
      }
    },

    /** Job 终态复盘：结果/失败原因/下一步建议；不代替人工审核，也不自动重派。 */
    announceJobRecap(job: any, status: string, last: any) {      if (!this.task?.jobId || this.recapAnnouncedJobId === this.task.jobId) return
      this.recapAnnouncedJobId = this.task.jobId
      const assigned = this.softwareContext?.agents.find(item => item.id === job.assignedAgentId)?.name || String(job.assignedAgentId || 'root-ceo')
      const results = Array.isArray(job.results) ? job.results.length : 0
      if (status === 'succeeded') {
        this.addMessage('assistant', `Job ${job.id} 已完成（主 Agent「${assigned}」，证据 ${results} 条）。请到 Job 看板审核结果；未审核的证据不会进入长期记忆。`)
        return
      }
      if (status === 'cancelled') {
        this.addMessage('assistant', `Job ${job.id} 已取消（主 Agent「${assigned}」）。`)
        return
      }
      const code = String(last?.evidence?.code || status)
      const hint = code === 'AGENT_MODEL_KEY_REQUIRED' ? '先在“设置 → AI 配置”补齐模型 Key'
         : code === 'AGENT_BUDGET_BLOCKED' || status === 'blocked_budget' ? '在“Agent 设置”调整模型 Profile 的日预算后重新运行'
        : code === 'AGENT_PERMISSION_DENIED' ? '检查目标店铺是否已打开、Agent 是否 active、权限快照是否变化'
         : code === 'AGENT_SINGLETON_ONLY' ? '当前系统仅保留 root-ceo 主 Agent，不支持子 Agent、HR 或按 Agent 绑定模型'
        : status === 'recovery_required' ? '在 Job 看板选择“安全恢复”或取消后重派'
        : '查看 Job 事件和证据后决定是否重新派发'
      this.addMessage('assistant', `Job ${job.id} ${status === 'failed' ? '执行失败' : `未完成（${status}）`}（${code}）：${this.task.message}。建议：${hint}。`)
    },

    async onTaskProgress(event: any) {
      if (!this.task || (event?.runId !== this.task.runId && event?.taskId !== this.task.id)) return
      this.task.status = String(event.status || this.task.status)
      this.task.currentStep = Number.isInteger(event.stepIndex) ? Number(event.stepIndex) : this.task.currentStep
      this.task.message = String(event.message || this.task.message)
      if (this.task.status !== 'waiting_confirmation') this.task.confirmation = null
      if (['succeeded', 'failed', 'cancelled'].includes(this.task.status)) {
        this.task.confirmation = null
        this.status = statusForJob(this.task.status)
        if (this.plan) this.plan.status = this.task.status as AgentPlan['status']
        // 浏览器运行先到终态，Job 需要显式刷新一次才会落终态并触发复盘。
        if (this.task.jobId) await this.refreshJob()
        await this.loadTaskResults(this.task.runId || undefined)
        // 任务终态同样会改变软件上下文里的任务/待办计数。
        this.refreshSoftwareContextSoon()
      } else {
        this.status = statusForJob(this.task.status)
        if (this.plan && this.task.status === 'waiting_confirmation') this.plan.status = 'waiting_confirmation'
        else if (this.plan && this.task.status !== 'paused') this.plan.status = 'running'
      }
    },

    onTaskConfirmation(event: any) {
      if (!this.task || event?.runId !== this.task.runId) return
      this.task.confirmation = { kind: 'task', id: null, message: String(event?.message || '请确认继续') }
      this.task.status = 'waiting_confirmation'
      this.task.message = '任务暂停在人工确认门禁，后续步骤尚未执行'
      this.status = 'waiting_confirmation'
    },

    async loadTaskResults(runId?: string) {
      const targetRunId = runId || this.task?.runId
      if (!targetRunId) return
      const result = await window.shopilot.task.results(targetRunId)
      // 结果读取期间可能已切换到另一项 TaskRun。
      const task = this.task
      if (!task || task.runId !== targetRunId) return
      if (!result.ok) {
        task.errorCode = result.error.code
        task.errorMessage = result.error.message
        return
      }
      task.results = result.data
      const failed = result.data?.run?.status === 'failed'
      task.errorCode = failed ? result.data?.run?.errorCode || 'TASK_FAILED' : null
      task.errorMessage = failed ? result.data?.run?.errorMessage || result.data?.run?.statusReason || null : null
      task.currentStep = result.data?.run?.currentStep ?? task.currentStep
      const actualStatus = String(result.data?.run?.status || '')
      if (['succeeded', 'failed', 'cancelled'].includes(actualStatus)) {
        task.status = actualStatus
        this.status = statusForJob(actualStatus)
        if (this.plan) this.plan.status = actualStatus as AgentPlan['status']
      }
      if (this.completionAnnouncedRunId !== targetRunId) {
        this.completionAnnouncedRunId = targetRunId
        if (task.status === 'succeeded') {
          const summaries = (result.data?.results || []).map((row: any) => {
            if (row.kind === 'text') return String(row.payload?.text || row.summary || '').slice(0, 240)
            if (row.kind === 'table') return `表格 ${Number(row.payload?.rowCount ?? 0)} 行${row.payload?.summaryOnly ? '（仅表头与行数）' : ''}`
            if (row.kind === 'screenshot') return `截图工件：${row.artifactPath || row.summary || '已生成'}`
            return String(row.summary || '').slice(0, 160)
          }).filter(Boolean)
          this.addMessage('assistant', `TaskRunner 报告成功。${summaries.join('；') || '任务步骤已完成。'}`)
        } else if (task.status === 'failed') {
          this.addMessage('assistant', `TaskRunner 报告失败（${task.errorCode || 'UNKNOWN'}）：${task.errorMessage || '无错误说明'}`)
        } else {
          this.addMessage('assistant', 'TaskRunner 报告任务已取消，后续步骤已停止。')
        }
      }
    },

    async cancelJob() {
      if (!this.task?.jobId || this.busy) return
      this.busy = true
      try {
        const result = await window.shopilot.agentDomain.jobCancel(this.task.jobId)
        if (!result.ok) throw result.error
        this.task.message = '取消请求已提交'
        await this.refreshJob()
      } catch (error: any) {
        this.error = { code: error?.code || 'AGENT_JOB_CANCEL_FAILED', message: error?.message || '取消 Job 失败' }
      } finally { this.busy = false }
    },

    async confirmTask(approved: boolean) {
      if (!this.task || !this.task.confirmation || this.busy) return
      this.busy = true
      const task = this.task
      const confirmation = task.confirmation
      const action = approved ? '确认' : '拒绝'
      try {
        if (confirmation.kind === 'job') {
          const result = await window.shopilot.agentDomain.jobApprove(task.jobId, approved, confirmation.id || undefined)
          if (!result.ok) throw result.error
          if (approved) {
            // jobApprove 只是放行门禁；真正继续执行要靠 jobRun，两者都成功才算整个确认流程成功。
            const started = await window.shopilot.agentDomain.jobRun(task.jobId)
            if (!started.ok) throw started.error
          }
          // 只有到这里（确认 + 启动都成功）才能清空确认卡：
          // 此前先清后跑，jobRun 失败时确认卡消失而 Job 仍停在等待确认，用户就再没有入口了。
          task.confirmation = null
          task.message = approved ? '已确认，主 Agent 继续执行' : '已拒绝，Job 已取消'
        } else {
          // task 门禁同样只在 confirm 成功后才清空；没有运行实例时按失败处理，保留确认态。
          if (!task.runId) throw Object.assign(new Error('任务还没有运行实例，确认无法送达 TaskRunner；请重新派发任务'), { code: 'AGENT_TASK_RUN_MISSING' })
          const result = await window.shopilot.task.confirm(task.runId, approved)
          if (!result.ok) throw result.error
          task.confirmation = null
          task.message = approved ? '已确认，TaskRunner 将继续' : '已拒绝，TaskRunner 将取消并停止后续步骤'
        }
        await this.refreshJob()
      } catch (error: any) {
        const failure = { code: String(error?.code || 'AGENT_CONFIRM_FAILED'), message: String(error?.message || `${action}失败`) }
        this.error = failure
        // 失败可能只发生在 jobRun/task.confirm 这一步（Job 仍停在等待确认），先按 Main 的最新状态
        // 重建一次：若 Job 真的还在等确认，确认卡会重新出现；若其实已放行/已取消，它会随之消失。
        // refreshJob 自身失败也不能让异常从 catch 里逃出去（会变成未处理的 rejected promise）。
        try { await this.refreshJob() } catch { /* refreshJob 已把失败写进 task.errorCode/errorMessage */ }
        if (this.task === task) {
          // 提示写在这里（而不是 refreshJob 之前）：refreshJob 会用 Job 真实状态重写 message。
          task.message = task.confirmation
            ? `${action}未完成（${failure.code}）：${failure.message}；可再次${action}`
            : `${action}未完成（${failure.code}）：${failure.message}；已按 Job 最新状态刷新，请到 Job 看板处理`
        }
      } finally { this.busy = false }
    },

    clearPlan() { this.plan = null; this.softwarePlan = null; this.pendingGoal = ''; this.status = 'idle'; this.error = null },
    newTask() { this.plan = null; this.softwarePlan = null; this.pendingGoal = ''; this.error = null; if (!this.task || ['succeeded', 'failed', 'cancelled', 'created'].includes(this.task.status)) this.status = 'idle' }
  }
})
