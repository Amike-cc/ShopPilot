import { computed, onScopeDispose, ref, watch } from 'vue'
import { isBatchProfile } from '@shared/constants/invite'
import { inviteConfigKey } from '@shared/invite-config'
import { inviteStopReasonLabel } from '@shared/invite-notices'
import { buildInviteTaskPayload, isCreatorInviteTask, parseInviteProductIds } from '@shared/invite-task'
import type { InviteCampaignDetail, InviteCampaignView, InviteRecordView } from '@shared/invite-campaign'
import type { TaskRunView, TaskView } from '@shared/schemas/task'
import { inviteCampaignCountsText, inviteCampaignStatusLabel, inviteRecordLineText, inviteRecordToneClass } from './invite-run-labels'
import type { InviteState } from './invite-state'

/** 运行日志行（TASK_PROGRESS 事件写入 taskLogs 的形状；字段都可选，读不到就如实降级展示） */
interface InviteRunLogEntry {
  at?: number
  message?: string
  phase?: string
  status?: string
}

/**
 * 运行面：任务列表、进度映射、启动与停止，以及**从库里读回**的批次/逐人记录。
 *
 * 2026-10-25 之后侧栏是唯一入口，但它以前只看 `ws.tasks` + 内存事件：
 *   · 应用重启后（事件不补发）日志永远是「等待运行输出」；
 *   · 创建任务前就失败的批次根本没有 task，侧栏完全看不见；
 *   · 逐人结果只存在内存 log 里，切店/刷新/重启就没了。
 * 现在以批次（invite_campaigns）+ 逐人记录（invite_records）为准：
 * 任务只负责实时日志与停止，批次负责"这次到底发了多少、结果在哪"。
 */
export interface InviteRunPorts {
  /** 启动后刷新额度占用（运行中预留会变） */
  reloadQuota(storeId: string): void | Promise<void>
}

export function useInviteRun(state: InviteState, ports: InviteRunPorts) {
  const { ws, currentStoreId, inviteProfile, invite, inviteSubmitting, inviteRecentCount, inviteBlacklistCount } = state

  const inviteTasks = computed(() => ws.tasks.filter((task: TaskView) => isCreatorInviteTask(task) && (!task.storeScope || task.storeScope === currentStoreId.value)))

  function inviteRun(task: TaskView) { return task?.latestRun }
  function inviteRunId(task: TaskView) { return inviteRun(task)?.id || '' }
  function inviteStatus(task: TaskView) {
    const status = inviteRunId(task) ? ws.runLive[inviteRunId(task)]?.status || inviteRun(task)?.status : inviteRun(task)?.status
    return ({ running: '正在运行', queued: '排队中', waiting_confirmation: '等待确认', paused: '已暂停', succeeded: '已完成', failed: '执行失败', cancelled: '已取消' } as Record<string, string>)[status || ''] || '尚未运行'
  }
  function inviteActive(task: TaskView) {
    const run = inviteRun(task)
    const status = run?.id ? ws.runLive[run.id]?.status || run.status : run?.status
    return ['queued', 'running', 'waiting_confirmation', 'paused'].includes(status)
  }

  const inviteLatest = computed(() => {
    const rows = [...inviteTasks.value]
    const active = rows.filter(task => inviteActive(task)).sort((a, b) => Number(b.latestRun?.startedAt || b.updatedAt || b.createdAt || 0) - Number(a.latestRun?.startedAt || a.updatedAt || a.createdAt || 0))
    if (active[0]) return active[0]
    return rows.sort((a, b) => Number(b.latestRun?.finishedAt || b.updatedAt || b.createdAt || 0) - Number(a.latestRun?.finishedAt || a.updatedAt || a.createdAt || 0))[0] || null
  })

  // ---------------- 批次与逐人记录（库内真相） ----------------

  const inviteCampaigns = ref<InviteCampaignView[]>([])
  const inviteCampaignDetail = ref<InviteCampaignDetail | null>(null)
  const inviteCampaignError = ref('')
  /** 用户在「最近批次」里手动选中的批次；空 = 跟随活动/最新批次。 */
  const inviteSelectedCampaignId = ref('')
  /** 载入串行号：切店后旧请求晚到，不能把上一家店的批次写进当前面板。 */
  let campaignSerial = 0

  /**
   * 手动选中优先；否则展示"正在跑/等人确认"的批次；都没有才退回最新一条。
   * 这样既能回看历史批次，又不会在定时批次插进来时把用户正在看的运行顶掉。
   */
  const inviteCampaign = computed<InviteCampaignView | null>(() => {
    const selected = inviteCampaigns.value.find(item => item.id === inviteSelectedCampaignId.value)
    if (selected) return selected
    return inviteCampaigns.value.find(item => ['running', 'waiting', 'paused'].includes(item.status))
      || inviteCampaigns.value[0]
      || null
  })

  const inviteCampaignTask = computed<TaskView | null>(() => {
    const campaign = inviteCampaign.value
    const detail = inviteCampaignDetail.value
    if (!campaign || !detail || detail.campaign.id !== campaign.id) return null
    return detail.task ?? null
  })

  const inviteCampaignRun = computed<TaskRunView | null>(() => {
    const campaign = inviteCampaign.value
    const detail = inviteCampaignDetail.value
    if (!campaign || !detail || detail.campaign.id !== campaign.id) return null
    return detail.run ?? detail.task?.latestRun ?? null
  })

  const inviteCampaignRecords = computed<InviteRecordView[]>(() => {
    const campaign = inviteCampaign.value
    const detail = inviteCampaignDetail.value
    if (!campaign || !detail || detail.campaign.id !== campaign.id) return []
    return [...(detail.records || [])].sort((a, b) => Number(b.invitedAt || b.createdAt || 0) - Number(a.invitedAt || a.createdAt || 0))
  })

  /** 日志/停止仍以任务为对象；没有批次时退回旧的手动任务。 */
  const inviteDisplayTask = computed<TaskView | null>(() => inviteCampaign.value ? inviteCampaignTask.value : (inviteLatest.value ?? null))
  const inviteDisplayRun = computed<TaskRunView | null>(() => inviteCampaign.value ? inviteCampaignRun.value : (inviteDisplayTask.value?.latestRun ?? null))
  const inviteDisplayRunId = computed(() => {
    if (inviteCampaign.value) return inviteCampaignRun.value?.id || inviteCampaign.value.runId || ''
    return inviteDisplayTask.value?.latestRun?.id || ''
  })
  const inviteDisplayActive = computed(() => {
    const run = inviteDisplayRun.value
    const live = run?.id ? ws.runLive[run.id]?.status : ''
    if (['queued', 'running', 'waiting_confirmation', 'paused'].includes(live || run?.status || '')) return true
    return Boolean(inviteCampaign.value && ['running', 'waiting', 'paused'].includes(inviteCampaign.value.status))
  })
  const inviteDisplayStatus = computed(() => {
    if (inviteCampaign.value) return inviteCampaignStatusLabel(inviteCampaign.value.status)
    return inviteDisplayTask.value ? inviteStatus(inviteDisplayTask.value) : ''
  })
  const inviteDisplayTone = computed(() => {
    const status = inviteCampaign.value?.status || inviteDisplayRun.value?.status || ''
    if (status === 'failed') return 'fail'
    if (status === 'completed' || status === 'succeeded') return 'ok'
    if (['exhausted', 'stopped', 'cancelled'].includes(status)) return 'warn'
    if (['running', 'waiting', 'paused', 'queued', 'scheduled', 'ready'].includes(status)) return 'active'
    return ''
  })
  const inviteDisplayCounts = computed(() => inviteCampaign.value ? inviteCampaignCountsText(inviteCampaign.value) : '')

  /**
   * 失败/结束原因：批次级原因（排期取消、任务创建失败）+ 引擎停止码 + run 的 errorMessage。
   * 旧批次可能没有 status_reason，这里如实说明"旧记录未保存原因"，不编造。
   */
  const inviteDisplayReason = computed(() => {
    const parts: string[] = []
    const campaign = inviteCampaign.value
    if (campaign) {
      const stop = inviteStopReasonLabel(campaign.stopReason)
      if (stop) parts.push(`停止原因：${stop}`)
      if (campaign.statusReason) parts.push(campaign.statusReason)
      if (campaign.status === 'failed' && !campaign.taskId) parts.push('任务创建失败，未进入运行（旧记录可能未保存原因）')
    }
    const run = inviteDisplayRun.value
    if (run && ['failed', 'cancelled'].includes(run.status)) {
      const code = String(run.errorCode || '').trim()
      const message = String(run.errorMessage || run.statusReason || '').trim()
      const detail = code && message && !message.includes(code) ? `${code}：${message}` : (message || code)
      if (detail) parts.push(detail)
    }
    return [...new Set(parts)].join(' · ')
  })

  const inviteDisplaySummary = computed(() => {
    const task = inviteDisplayTask.value
    const records = inviteCampaignRecords.value
    if (inviteCampaign.value) {
      const live = task ? inviteLiveMessage(task) : ''
      if (inviteDisplayActive.value) return live || (records.length ? `已记录 ${records.length} 位，运行中…` : '正在运行，等待逐人结果…')
      if (records.length) return `本批次共记录 ${records.length} 位`
      if (inviteCampaign.value.status === 'scheduled') return '已排期，到点后自动在后台运行'
      return '本次运行没有逐人记录'
    }
    return task ? (inviteLiveMessage(task) || inviteStatus(task)) : ''
  })

  const inviteDisplayNoRecordHint = computed(() => {
    const campaign = inviteCampaign.value
    if (!campaign) return ''
    if (!campaign.taskId) return '（批次在创建任务前失败，没有进入运行）'
    if (campaign.status === 'scheduled') return '（到点运行后才会产生逐人结果）'
    if (campaign.status === 'exhausted') return '（候选不足或全部被跳过，没有可记录的人）'
    if (campaign.status === 'failed') return '（失败发生在产生逐人记录之前）'
    return ''
  })

  const inviteDisplayLogs = computed<InviteRunLogEntry[]>(() => inviteDisplayTask.value ? inviteLogs(inviteDisplayTask.value) : [])

  async function loadInviteCampaigns(storeIdArg?: string): Promise<void> {
    const storeId = String(storeIdArg || currentStoreId.value || '')
    const token = ++campaignSerial
    if (!storeId) {
      inviteCampaigns.value = []
      inviteCampaignDetail.value = null
      inviteCampaignError.value = ''
      return
    }
    try {
      const result = await window.shopilot.invite.campaigns({ storeId, limit: 8 })
      if (token !== campaignSerial || currentStoreId.value !== storeId) return
      if (!result.ok) {
        inviteCampaignError.value = result.error.message
        inviteCampaigns.value = []
        inviteCampaignDetail.value = null
        return
      }
      inviteCampaignError.value = ''
      inviteCampaigns.value = (Array.isArray(result.data) ? result.data : []) as InviteCampaignView[]
      if (inviteSelectedCampaignId.value && !inviteCampaigns.value.some(item => item.id === inviteSelectedCampaignId.value)) {
        inviteSelectedCampaignId.value = ''
      }
      const target = inviteCampaign.value
      if (!target) {
        inviteCampaignDetail.value = null
        return
      }
      const detail = await window.shopilot.invite.campaignDetail(target.id)
      if (token !== campaignSerial || currentStoreId.value !== storeId) return
      if (!detail.ok) {
        inviteCampaignError.value = detail.error.message
        inviteCampaignDetail.value = null
        return
      }
      const data = detail.data as InviteCampaignDetail | undefined
      if (data && data.campaign?.id === target.id) inviteCampaignDetail.value = data
      else {
        inviteCampaignDetail.value = null
        inviteCampaignError.value = '批次详情为空，无法读取逐人记录'
      }
    } catch (error) {
      if (token !== campaignSerial) return
      inviteCampaignError.value = error instanceof Error ? error.message : String(error)
      inviteCampaigns.value = []
      inviteCampaignDetail.value = null
    }
  }

  /** 手动切换要看的批次（回看历史结果）；详情会按当前选择重新加载。 */
  function selectInviteCampaign(campaignId: string): void {
    inviteSelectedCampaignId.value = String(campaignId || '')
    inviteCampaignDetail.value = null
    void loadInviteCampaigns()
  }

  async function refreshInviteData(): Promise<void> {
    await ws.refreshTasks()
    await loadInviteCampaigns()
  }

  function inviteRecordLine(record: InviteRecordView): string { return inviteRecordLineText(record) }
  function inviteRecordTone(record: InviteRecordView): string { return inviteRecordToneClass(record.status) }

  /**
   * 运行中每 5 秒刷新一次任务与批次：实时事件在应用重启后不补发，
   * 任务结束后也会靠这次刷新把批次从 running 推导成最终状态。
   */
  let pollTimer: ReturnType<typeof setInterval> | null = null
  watch(inviteDisplayActive, active => {
    if (active) {
      if (pollTimer) return
      pollTimer = setInterval(() => {
        void ws.refreshTasks()
        void loadInviteCampaigns()
      }, 5000)
      return
    }
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = null
    void loadInviteCampaigns()
  }, { immediate: true })
  watch(() => currentStoreId.value, storeId => {
    inviteCampaigns.value = []
    inviteCampaignDetail.value = null
    inviteCampaignError.value = ''
    inviteSelectedCampaignId.value = ''
    if (storeId) void loadInviteCampaigns(storeId)
  }, { immediate: true })
  onScopeDispose(() => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  })

  function inviteStepIndex(task: TaskView) {
    const run = inviteRun(task)
    return run?.id ? (ws.runLive[run.id]?.stepIndex ?? run.currentStep ?? null) : (run?.currentStep ?? null)
  }
  function inviteStuckText(task: TaskView) {
    const steps = task?.steps || []
    const index = inviteStepIndex(task)
    if (!inviteActive(task)) return `${inviteStatus(task)} · 共 ${steps.length} 步`
    if (index == null) return `正在准备邀约 · 共 ${steps.length} 步`
    const safeIndex = Math.min(Math.max(index, 0), Math.max(steps.length - 1, 0))
    const message = inviteLiveMessage(task)
    return `卡在第 ${safeIndex + 1}/${steps.length} 步${message ? `：${message}` : ''}`
  }
  function inviteStepIcon(task: TaskView, index: number) {
    const status = inviteRunId(task) ? ws.runLive[inviteRunId(task)]?.status || inviteRun(task)?.status : inviteRun(task)?.status
    const current = inviteStepIndex(task)
    if (status === 'succeeded') return '✅'
    if (status === 'failed' && current === index) return '❌'
    if (current != null && index < current) return '✅'
    if (current == null && index === 0 && inviteActive(task)) return '⏳'
    if (current === index && inviteActive(task)) return '⏳'
    return '○'
  }
  function toStepIndex(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
  }
  function inviteStepLabel(step: TaskView['steps'][number]) { return ({ waitMs: '等待页面状态', navigate: '打开平台页面', click: '点击页面元素', input: '填写页面内容', screenshot: '保存页面截图', readText: '读取页面信息', scrollNext: '列表向下滚动' } as Record<string, string>)[step?.type] || step?.type || '任务步骤' }
  function inviteStepInput(step: TaskView['steps'][number]) {
    const value = step?.input
    if (!value) return '等待真实运行结果'
    try { const text = JSON.stringify(value); return text.length > 90 ? `${text.slice(0, 87)}…` : text } catch { return '等待真实运行结果' }
  }
  function inviteLiveMessage(task: TaskView) { const runId = inviteRunId(task); return runId ? String(ws.runLive[runId]?.message || '') : '' }
  function inviteLogs(task: TaskView) { const runId = inviteRunId(task); return runId ? (ws.taskLogs[runId] || []) : [] }
  function inviteLogText(log: InviteRunLogEntry) { return `[${new Date(log.at || Date.now()).toLocaleTimeString()}] ${log.message || log.phase || log.status || '任务状态已更新'}` }
  async function stopInvite(task: TaskView) {
    const runId = inviteRunId(task)
    if (runId) await stopInviteRun(runId)
  }
  async function stopInviteRun(runId: string) {
    if (!runId) return
    const result = await window.shopilot.task.cancel(runId)
    if (!result.ok) ws.toast(`停止邀约失败：${result.error.message}`, 'error')
    await refreshInviteData()
  }

  /**
   * 创建并启动一轮邀约；传 scheduleAt 则只建批次与任务、到点由主进程调度器拉起。
   *
   * 与旧实现的差别（2026-10-19「后端运行」）：
   *   · 不再要求店铺浏览器处于打开/显示状态——主进程会为这家店建隐藏后台页；
   *   · 独立模块页和侧栏面板调用同一个函数，配置快照、7 天台账、黑名单口径完全一致；
   *   · 返回是否真的启动成功，调用方据此决定要不要收起配置面板。
   */
  async function startInvite(options: { scheduleAt?: number | null } = {}): Promise<boolean> {
    const storeId = currentStoreId.value
    if (inviteSubmitting.value || !inviteProfile.value || !storeId || !state.inviteReady.value) return false
    const scheduleAt = Number.isFinite(Number(options.scheduleAt)) && Number(options.scheduleAt) > 0
      ? Math.round(Number(options.scheduleAt))
      : null
    inviteSubmitting.value = true
    try {
      /**
       * 7 天内邀过的达人**不再重复邀约**（用户要求）：开跑前把台账里的昵称清单查出来塞进配置。
       * 广场列表行没有"已邀约"标记（真机实测），所以任务侧只能靠这份清单在点「详情」前跳过；
       * 清单没覆盖到的（手工邀过等）由平台的"7 天内不可再次邀请"兜底。
       */
      let recentlyInvited: string[] = []
      try {
        const history = await window.shopilot.browser.recentInviteHistory({ storeId, days: 7 })
        if (history.ok) {
          recentlyInvited = ((history.data as { nicknames?: string[] })?.nicknames || []).filter(Boolean)
          inviteRecentCount.value = recentlyInvited.length
        }
      } catch { /* 台账读不到不该拦住开跑：平台侧仍会拦重复邀约 */ }
      /**
       * 黑名单与 7 天台账走同一个 skipTexts 口径：在选人/点详情前直接跳过。
       * 黑名单来自达人库（人工维护），平台侧没有这个概念；这里不合并进 inviteRecentCount，
       * 避免把"黑名单"说成"近 7 天已邀"。
       */
      try {
        const blacklist = await window.shopilot.invite.creators.blacklisted({ storeId, platform: inviteProfile.value.platform })
        if (blacklist.ok) {
          const names = (blacklist.data as { nicknames?: string[] })?.nicknames || []
          inviteBlacklistCount.value = names.length
          recentlyInvited = [...new Set([...recentlyInvited, ...names])]
        }
      } catch { /* 黑名单读不到不拦开跑；平台侧仍会拦重复邀约 */ }
      const payload = buildInviteTaskPayload({
        profile: inviteProfile.value,
        storeId,
        squareUrl: state.inviteSquareUrl(),
        config: { ...state.inviteSnapshot(), recentlyInvited },
        source: 'panel'
      })
      if (!payload) { ws.toast('邀约配置不完整，无法创建任务', 'error'); return false }
      /**
       * v2：任务与批次由主进程同一条路径创建（INVITE_CAMPAIGN_START）。
       * 这样新模块页能按批次查看「目标/已发/跳过/停止原因」，而不是只能靠任务名前缀猜。
       * 任务构造器仍是同一份 buildInviteTaskPayload，面板/智能体不会各写一套配置。
       */
      const targetCount = isBatchProfile(inviteProfile.value)
        // 抖店逐人沟通：一位一轮，count 就是本次总量。
        // 快手批量：count 只是每批人数，整单上限是 totalCap（旧实现拿每批人数当总量，可放大 20 倍）。
        ? (inviteProfile.value.contactOnly === true
            ? Math.max(1, Number(invite.count) || 1)
            : Math.max(1, Math.min(500, Number(invite.totalCap) || 200)))
        : Math.max(1, Number(invite.maxInvites) || 10)
      /**
       * 配置有 500ms 防抖落盘：用户改完日上限/数量立刻点开始，主进程读到的还是旧值。
       * 启动前显式落盘一次，保证额度校验用的就是界面上的这份配置。
       */
      await window.shopilot.settings.set(inviteConfigKey(storeId), state.inviteSnapshot())
      const created = await window.shopilot.invite.startCampaign({
        task: payload,
        campaign: {
          storeId,
          targetCount,
          filters: state.inviteSnapshot(),
          scriptText: String(invite.script || ''),
          productIds: parseInviteProductIds(invite.productIds),
          createdBy: 'panel',
          ...(scheduleAt ? { scheduleAt } : {})
        }
      })
      if (!created.ok) { ws.toast(`创建邀约批次失败：${created.error.message}`, 'error'); return false }
      const started = created.data as { waitingForStore?: boolean; scheduledAt?: number | null } | undefined
      if (scheduleAt) {
        const when = new Date(scheduleAt)
        ws.toast(`已安排在 ${when.toLocaleString()} 启动；到点后会在后台自动运行，中途可以取消`, 'success')
      } else {
        ws.toast(started?.waitingForStore
          ? '邀约批次已创建，但后台页面未能就绪：请打开一次该店铺后会自动开始'
          : recentlyInvited.length
            ? `邀约已在后台启动：近 7 天已邀的 ${recentlyInvited.length} 位会自动跳过`
            : '邀约已在后台启动，你可以继续使用浏览器；进度在右侧「达人邀约」面板查看', 'success')
      }
      await ws.refreshTasks()
      void ports.reloadQuota(storeId)
      // 新批次启动后回到"跟随最新"：否则用户正在回看旧批次时看不到刚启动的这一单。
      inviteSelectedCampaignId.value = ''
      void loadInviteCampaigns(storeId)
      return true
    } catch (error) {
      // 上方已逐点处理已知的业务拒绝（history/blacklist 读失败、payload 不完整、created.ok === false）；
      // 这里只兜意外 throw/reject（如 IPC 通道异常）：不 catch 的话用户只看到按钮复位、没有任何提示。
      const message = error instanceof Error ? error.message : String(error)
      ws.toast(`启动邀约失败：${message || '未知错误'}`, 'error')
      return false
    } finally {
      inviteSubmitting.value = false
    }
  }

  return {
    inviteTasks,
    inviteLatest,
    inviteRun,
    inviteRunId,
    inviteStatus,
    inviteActive,
    inviteStepIndex,
    inviteStuckText,
    inviteStepIcon,
    toStepIndex,
    inviteStepLabel,
    inviteStepInput,
    inviteLiveMessage,
    inviteLogs,
    inviteLogText,
    stopInvite,
    stopInviteRun,
    startInvite,
    // 批次与逐人记录
    inviteCampaigns,
    inviteCampaign,
    inviteCampaignDetail,
    inviteCampaignTask,
    inviteCampaignRun,
    inviteCampaignRecords,
    inviteCampaignError,
    inviteSelectedCampaignId,
    selectInviteCampaign,
    inviteDisplayTask,
    inviteDisplayRun,
    inviteDisplayRunId,
    inviteDisplayActive,
    inviteDisplayStatus,
    inviteDisplayTone,
    inviteDisplayCounts,
    inviteDisplayReason,
    inviteDisplaySummary,
    inviteDisplayNoRecordHint,
    inviteDisplayLogs,
    inviteRecordLine,
    inviteRecordTone,
    loadInviteCampaigns,
    refreshInviteData
  }
}
