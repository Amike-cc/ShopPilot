import { computed } from 'vue'
import { isBatchProfile } from '@shared/constants/invite'
import { buildInviteTaskPayload, isCreatorInviteTask, parseInviteProductIds } from '@shared/invite-task'
import type { TaskView } from '@shared/schemas/task'
import type { InviteState } from './invite-state'

/** 运行日志行（TASK_PROGRESS 事件写入 taskLogs 的形状；字段都可选，读不到就如实降级展示） */
interface InviteRunLogEntry {
  at?: number
  message?: string
  phase?: string
  status?: string
}

/**
 * 运行面：任务列表、进度映射、启动与停止。
 *
 * 「启动」是唯一的写入口：独立页与侧栏共用，保证配置快照、7 天台账、黑名单、
 * 定时参数的口径完全一致。发送本身在主进程隐藏窗口里跑，这里不碰页面。
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
  function inviteStepLabel(step: TaskView['steps'][number]) { return ({ waitMs: '等待页面状态', navigate: '打开平台页面', click: '点击页面元素', input: '填写页面内容', screenshot: '保存页面截图', readText: '读取页面信息' } as Record<string, string>)[step?.type] || step?.type || '任务步骤' }
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
    if (!runId) return
    const result = await window.shopilot.task.cancel(runId)
    if (!result.ok) ws.toast(`停止邀约失败：${result.error.message}`, 'error')
    await ws.refreshTasks()
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
        ? Math.max(1, Number(invite.count) || 1)
        : Math.max(1, Number(invite.maxInvites) || 10)
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
            : '邀约已在后台启动，你可以继续使用浏览器；进度在「达人邀约」页查看', 'success')
      }
      await ws.refreshTasks()
      void ports.reloadQuota(storeId)
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
    startInvite
  }
}
