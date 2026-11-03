import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 达人邀约「独立功能 + 后端运行」的架构回归网（2026-10-19 重构 P0/P1 之后）。
 *
 * 这一版钉的不再是「task-runner 里有没有 creator_invite 分支」，而是边界：
 *   · 浏览器层只有通用 background-page，不认识任何业务；
 *   · 执行面、入队准备、终态释放、审计事件都在 task-kinds 注册表里；
 *   · 引擎只认 surface 与钩子。
 *
 * 行为本身（隐藏窗口能布局、能点、不占可见标签页）由打包冒烟
 * `tools/acceptance/creator-invite-smoke.js` 负责，两者互补。
 */
const read = (path: string) => readFileSync(resolve(path), 'utf8')

const EXECUTE = read('apps/desktop/src/main/tasks/task-runner-execute.ts')
const CONTROL = read('apps/desktop/src/main/tasks/task-runner-control.ts')
const LIFECYCLE = read('apps/desktop/src/main/tasks/task-runner-lifecycle.ts')
const KINDS = read('apps/desktop/src/main/tasks/task-kinds.ts')
const CORE = read('apps/desktop/src/main/browser/window-browser-core.ts')
const BACKGROUND = read('apps/desktop/src/main/browser/background-page.ts')
const PAGE = read('apps/desktop/src/renderer/src/features/invite/InvitePanelView.vue')
const HOOK = read('apps/desktop/src/renderer/src/features/workbench/use-creator-invite.ts')
const APPS = read('apps/desktop/src/renderer/src/features/workbench/UnifiedAppsPage.vue')
const DASHBOARD = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')
// 2026-10-20 P2 第二半：组合式函数已拆成 state + 5 个领域模块；这里按拆分后的真实位置断言。
const STATE = read('apps/desktop/src/renderer/src/features/invite/composables/invite-state.ts')
const RUN = read('apps/desktop/src/renderer/src/features/invite/composables/use-invite-run.ts')
const VIEW = read('apps/desktop/src/renderer/src/features/invite/InvitePanelView.vue')
const STEP_EXECUTOR = read('apps/desktop/src/main/tasks/task-step-executor.ts')
const STEP_DOM = read('apps/desktop/src/main/tasks/task-step-dom.ts')

describe('浏览器层：只有通用后台页，没有业务概念', () => {
  it('window-browser-core 不再出现邀约/creator_invite', () => {
    expect(CORE.toLowerCase()).not.toContain('invite')
    expect(CORE).toContain("from './background-page'")
  })

  it('通用后台页保留隐藏窗口的全部不变量', () => {
    expect(BACKGROUND).toContain('show: false')
    expect(BACKGROUND).toContain('skipTaskbar: true')
    expect(BACKGROUND).toContain('backgroundThrottling: false')
    expect(BACKGROUND).toContain('partition: getStorePartition(storeId)')
    expect(BACKGROUND).toContain('purpose')
    expect(BACKGROUND).toContain('window.open 已转入后台标签页')
    expect(BACKGROUND).toContain('destroyWindow')
  })

  it('worker 页对渲染层不可见：事件过滤、挂载拒绝、激活空操作', () => {
    expect(CORE).toMatch(/\.filter\(tab => tab\.worker !== true\)/)
    expect(CORE).toContain("if (tab.worker === true) throw new Error('IPC_FORBIDDEN: 后台工作页不接受渲染层挂载')")
    const activate = CORE.match(/export function activateTab[\s\S]*?\n\}/)![0]
    expect(activate).toContain('if (tab.internal === true)')
  })

  it('后台页参与店铺生命周期占用判定，最后一个关掉会回收 browserState', () => {
    expect(CORE).toContain('hasBackgroundPages(storeId)')
    expect(CORE).toContain('setBackgroundPageLifecycleHook')
  })
})

describe('任务类型注册表：引擎只认 surface 与钩子', () => {
  it('creator-invite 声明后台执行面与准备/释放/终态钩子', () => {
    expect(KINDS).toContain("const CREATOR_INVITE_KIND = 'creator_invite'")
    expect(KINDS).toContain("surface: 'background'")
    expect(KINDS).toContain('acquireBackgroundPage(storeId, { purpose: CREATOR_INVITE_KIND })')
    expect(KINDS).toContain('releaseBackgroundPages(storeId, CREATOR_INVITE_KIND)')
    expect(KINDS).toContain('recordInviteEvent')
    expect(KINDS).toContain('successReason')
  })

  it('执行器按 surface 取后台页，不再写具体 kind', () => {
    expect(EXECUTE).toContain("getTaskKindDefinition(run.taskKind)?.surface === 'background'")
    expect(EXECUTE).toContain('acquireBackgroundPage(run.storeId, { purpose: run.taskKind })')
    expect(EXECUTE).not.toContain("run.taskKind === 'creator_invite'")
  })

  it('入队/继续/重试统一走 kind.prepare', () => {
    expect(CONTROL).toContain('getTaskKindDefinition(task.kind)?.prepare?.(storeId)')
    const ensure = CONTROL.match(/function ensurePageForRun[\s\S]*?\n\}/)![0]
    expect(ensure).toContain("kind?.surface === 'background'")
    expect(ensure).toContain('kind.prepare?.(run.storeId)')
    expect(ensure).toContain("openStoreBrowser(run.storeId, { display: true, source: 'main' })")
  })

  it('终态释放与业务事件由 kind 钩子完成，paused 不释放', () => {
    const terminal = LIFECYCLE.match(/if \(isTerminalRunStatus\(to\)\) \{[\s\S]*?\n {2}\}/)![0]
    expect(terminal).toContain('kind?.release?.(run.storeId)')
    expect(terminal).toContain('kind?.onTerminal?.(run, to, reason)')
    expect(LIFECYCLE).not.toContain("run.taskKind === 'creator_invite'")
  })
})

describe('入口收敛：只剩店铺浏览器右侧边栏（2026-10-25）', () => {
  it('应用中心不再有达人邀约卡片与路由', () => {
    expect(APPS).not.toContain("page: 'creator-invite'")
    expect(DASHBOARD).not.toContain('CreatorInvitePage')
    expect(DASHBOARD).not.toContain("navigateTo('creator-invite')")
  })

  it('右侧边栏保留邀约面板，并暴露给通知/外部入口', () => {
    expect(SURFACE).toContain("key: 'invite'")
    expect(SURFACE).toContain("openPanel('invite')")
    expect(SURFACE).toContain('defineExpose({ openInvitePanel })')
    expect(PAGE).toContain('data-test="invite-panel"')
    expect(PAGE).toContain('data-test="invite-start"')
  })

  it('通知点击打开对应店铺的侧栏面板，而不是已删除的独立页', () => {
    expect(DASHBOARD).toContain('openInvitePanel(item.storeId')
    expect(DASHBOARD).not.toContain('creator-invite')
  })

  it('启动使用当前店铺（显式 storeId），不跟随浏览器当前店铺', () => {
    expect(HOOK).toContain('const currentStoreId = options.storeId ?? computed(() => ws.displayedStoreId)')
    expect(STATE).toContain('const currentStoreId = context.storeId')
    const fn = RUN.match(/async function startInvite[\s\S]*?\n {2}\}/)![0]
    expect(fn).toContain('const storeId = currentStoreId.value')
    expect(fn).toContain('window.shopilot.invite.startCampaign')
  })

  it('界面明确告知"后台运行、不影响浏览"', () => {
    expect(VIEW).toContain('data-test="invite-backend-note"')
    expect(VIEW).toContain('不会打开或切换你的浏览器页面')
  })

  it('禁用态候选先记入已访问再报错：loop 的 advance 才能换下一位而不是原地打转', () => {
    const block = STEP_EXECUTOR.match(/if \(hit\.reason === 'DISABLED'\) \{[\s\S]*?\n\s*\}/)?.[0] || ''
    expect(block).toContain('unvisited && hit.rowKey')
    expect(block).toContain('run.visitedRows.add(hit.rowKey)')
    // 「当前页都处理过」必须有自己的码，才能交给 onCode 滚动后重试
    expect(STEP_EXECUTOR).toContain('const allVisitedCode')
    expect(STEP_EXECUTOR).toContain('${allVisitedCode}: 当前页的候选都已处理过')
    // 禁用原因优先：额度用完必须收工，已邀过必须跳过，不能一律按 disabledCode 处理
    expect(STEP_EXECUTOR).toContain('const noticeKind = classifyInviteBlockNotice(hit.disabledReason)')
    expect(STEP_EXECUTOR).toContain("noticeKind === 'quota-exhausted'")
    expect(STEP_EXECUTOR).toContain("noticeKind === 'already-invited'")
    // 页面滚动恢复不是"跳过某位达人"，不能把批次 skipped 计数打高
    expect(STEP_EXECUTOR).toContain('const pageRecovery')
    expect(STEP_EXECUTOR).toContain('if (!pageRecovery) run.inviteSkipped++')
    // 滚动换屏连续 50 屏无新候选时干净收尾，而不是按平台故障失败
    expect(STEP_EXECUTOR).toContain('连续滚动 ${recovered} 屏仍没有新的可沟通候选')
  })

  it('7 天/黑名单支持按昵称相等匹配（抖店短昵称不再误杀）', () => {
    expect(STEP_DOM).toContain("skipTextsMatch !== 'exact-nickname'")
    expect(STEP_DOM).toContain('normalizeNick(nicknameOf(e.el))')
    expect(STEP_DOM).toContain('own === normalizeNick(t)')
    // 固定列镜像行必须先归一到主表行，否则同一达人会有两个 rowKey（重复点击风险）
    expect(STEP_DOM).toContain('const mainRowOf')
    expect(STEP_DOM).toContain('mainRowOf(rowOf(el))')
  })
})
