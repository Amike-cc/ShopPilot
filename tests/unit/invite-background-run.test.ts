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
const PAGE = read('apps/desktop/src/renderer/src/features/invite/CreatorInvitePage.vue')
const HOOK = read('apps/desktop/src/renderer/src/features/workbench/use-creator-invite.ts')
// 2026-10-20 P2 第二半：组合式函数已拆成 state + 5 个领域模块；这里按拆分后的真实位置断言。
const STATE = read('apps/desktop/src/renderer/src/features/invite/composables/invite-state.ts')
const RUN = read('apps/desktop/src/renderer/src/features/invite/composables/use-invite-run.ts')
const VIEW = read('apps/desktop/src/renderer/src/features/invite/InvitePanelView.vue')

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

describe('独立页：就地配置并启动，不再跳回店铺浏览器', () => {
  it('页面里有启动面板、店铺下拉与共享视图，不再调用 emit(open-config)', () => {
    expect(PAGE).toContain('data-test="invite-v2-launcher"')
    expect(PAGE).toContain('data-test="invite-v2-launcher-store"')
    expect(PAGE).toContain('<InvitePanelView')
    expect(PAGE).not.toContain("emit('open-config'")
  })

  it('启动使用页面自己的店铺（显式 storeId），不跟随浏览器当前店铺', () => {
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
})
