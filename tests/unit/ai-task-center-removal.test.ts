import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string) => readFileSync(resolve(path), 'utf8')
const DASHBOARD = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const APPS = read('apps/desktop/src/renderer/src/features/workbench/UnifiedAppsPage.vue')
const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')

describe('AI 任务中心用户界面移除', () => {
  it('主工作台不再提供任务中心导航、独立页面或命令面板入口', () => {
    expect(DASHBOARD).not.toContain('data-test="rail-tasks"')
    expect(DASHBOARD).not.toContain('UnifiedTaskPage')
    expect(DASHBOARD).not.toContain("label: 'AI 任务中心'")
    expect(DASHBOARD).not.toContain("navigateTo('tasks')")
  })

  it('应用中心不再展示 AI 任务中心卡片', () => {
    expect(APPS).not.toContain('AI 任务中心')
    expect(APPS).not.toContain("page: 'tasks'")
    expect(APPS).not.toContain('tasksAppIcon')
  })

  it('店铺右侧面板只保留达人邀约入口，内部任务引擎仍可用于邀约', () => {
    expect(SURFACE).toContain('label: \'达人邀约\'')
    expect(SURFACE).toContain('data-test="invite-panel"')
    expect(SURFACE).not.toContain('任务列表')
    expect(SURFACE).not.toContain('打开完整任务中心')
    expect(SURFACE).not.toContain('待开发能力')
    expect(SURFACE).toContain('window.shopilot.invite.startCampaign')
  })
})
