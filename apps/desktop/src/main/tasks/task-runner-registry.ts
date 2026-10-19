/**
 * 任务运行引擎的运行句柄与进程内状态（2026-10-19 P1 重构：由 task-runner.ts 等价搬迁）。
 *
 * 这里只回答"谁在队列里、谁在跑、每个店铺的运行标签页是哪一个"，
 * 不落库、不打日志、不发事件；上层模块共享同一份绑定。
 * `current` / `keepAliveTimer` 是 `let`，跨模块只能走下面的 get/set 口。
 */

import type { TaskStepDef } from '@shared/schemas/task'

export interface RunHandle {
  runId: string
  taskId: string
  taskName: string
  storeId: string
  /** 任务类型（迁移 v33 的显式列）：批量流据此决定是否回传完整勾选名单 */
  taskKind: string
  /** 达人邀约批次 ID（仅 kind=creator_invite 有意义） */
  campaignId: string | null
  /** 本轮 loop 的停止码与完成轮数：只用于运行终态文案/通知，不参与执行 */
  lastStopReason: string | null
  lastCompletedRounds: number
  steps: TaskStepDef[]
  startFrom: number
  skipDone: boolean
  resumeKind: 'new' | 'continue' | 'from-failed'
  status: string
  reason: string
  cancelRequested: boolean
  pauseRequested: boolean
  deniedByConfirm: boolean
  pendingConfirm: ((answer: 'approve' | 'deny' | 'cancel' | 'timeout') => void) | null
  tabId: string | null
  startedOnce: boolean
  /**
   * nth:'unvisited' 的去重集合：键 = `${步骤下标}:${行容器文本}`。
   * 微信广场每次加载都重新洗牌，"第几条"不能保证换人；这个集合保证同一位达人不会被重复邀约。
   * 只活在本次运行内（loop 整步不可恢复，重启后的行为不受影响）。
   */
  visitedRows: Set<string>
  /**
   * useTab 记住"本次运行已经选定的那个标签页"：key = tabId/path/urlIncludes 判据，value = 标签页 id。
   *
   * 为什么必须按**运行**记住，而不是每次重新按地址找（2026-10-03 真机实测抓到）：
   * 面板「打开达人广场」会先开一个广场页 P；点「开始邀约」时引擎又新建运行标签页 R，并在 R 上
   * 应用筛选。首轮 useTab 若按"地址匹配的第一个标签页"选，会选中 P —— 于是 ①带着筛选的 R 被
   * `closeCurrent` 关掉、②后续轮次在**没有筛选**的 P 上继续邀约，筛选静默丢失（会邀到不该邀的人）。
   * 记忆住 R 之后，整轮的"回广场"都回同一个带着筛选的页面。
   */
  useTabPick: { key: string; tabId: string } | null
  /**
   * 本轮点「详情」时选中的达人昵称（clickByText 的 recordRowText 回传）。
   * 本轮**真的发出邀约**后由 loop 写入 `invite_history`（7 天内不再重复邀约）。
   */
  pendingCreatorNickname: string | null
  /**
   * 批量流本轮实际勾选的完整昵称（clickAll 回传）。
   * 旧实现只回传 8 个 samples，且 recordInvite 只认辅助流的 pendingCreatorNickname，
   * 导致抖店/快手一轮 40 位一位都没进台账。本轮**发送成功后**会一次性写入逐人记录，
   * 失败/换人重开时在下一轮开头清空，绝不把没发出去的人记成已邀。
   */
  pendingInvitedNames: string[]
}

export const queue: RunHandle[] = []
export const live = new Map<string, RunHandle>()
let current: RunHandle | null = null
let keepAliveTimer: NodeJS.Timeout | null = null
/** 每个店铺的任务运行标签页（复用以防标签页/渲染进程堆积；浏览器关闭后 id 失效自动重建） */
export const runTabByStore = new Map<string, string>()
export const cancelSig = () => Object.assign(new Error('运行已取消'), { name: 'CancelSignal' })
export const pauseSig = () => Object.assign(new Error('运行已暂停'), { name: 'PauseSignal' })
/**
 * 失败运行句柄保留策略：`retryRunFromFailed` 需要 live 里的句柄才能「从失败恢复」原地续跑
 * （visitedRows 去重集只活在内存，重建会丢「已邀约」去重、可能对同一达人重复邀约），
 * 所以 failed 不能像 succeeded/cancelled 那样立即释放。但无人值守场景失败是常态，
 * 不设上限会慢性泄漏（每失败一次滞留一个持完整步骤数组的句柄）——用 FIFO 上限兜底：
 * 超限淘汰最旧的失败句柄，该运行退化为"请重新运行任务"（与跨进程恢复边界一致）。
 */
export const FAILED_HANDLE_KEEP = 20
export const failedHandles: string[] = []

/** 模块级 let 绑定的跨模块读写口（搬迁自原 task-runner.ts 的同名内联变量，语义不变） */
export const getCurrent = (): RunHandle | null => current
export const setCurrent = (value: RunHandle | null): void => { current = value }
export const getKeepAliveTimer = (): NodeJS.Timeout | null => keepAliveTimer
export const setKeepAliveTimer = (value: NodeJS.Timeout | null): void => { keepAliveTimer = value }
