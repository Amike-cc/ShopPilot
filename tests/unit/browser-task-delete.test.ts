import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SURFACE = readFileSync(resolve('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue'), 'utf8')
// 2026-10-19：配置/日志模板抽到独立视图，独立页与侧栏共用；锚点断言改到视图文件。
const INVITE_VIEW = readFileSync(resolve('apps/desktop/src/renderer/src/features/invite/InvitePanelView.vue'), 'utf8')

describe('浏览器右侧边栏移除 AI 任务中心', () => {
  it('不再渲染通用任务列表、运行、取消或删除控件', () => {
    expect(SURFACE).not.toContain('data-test="task-delete"')
    expect(SURFACE).not.toContain('data-test="task-cancel"')
    expect(SURFACE).not.toContain('data-test="task-new"')
    expect(SURFACE).not.toContain('taskRows = computed')
  })

  it('达人邀约仍使用任务引擎并保留人工确认与实时日志', () => {
    expect(SURFACE).toContain('InvitePanelView')
    expect(INVITE_VIEW).toContain('data-test="invite-panel"')
    expect(SURFACE).toContain('window.shopilot.task.confirm(runId, approved)')
    expect(INVITE_VIEW).toContain('data-test="invite-live-log"')
  })
})
