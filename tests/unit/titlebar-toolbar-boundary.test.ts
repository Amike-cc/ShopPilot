import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 顶部工具栏与原生窗口按钮（WCO）的边界回归（2026-09-28 用户实报"右上角位置有问题"）。
 *
 * 背景：`titleBarOverlay` 保留的 − □ × 是**画在页面之上**的原生覆盖层，高 38px、宽约 140px，
 * 固定贴在窗口右上角。统一工作台里这一块正好落在 `.dashboard-toolbar` 上，于是有两个必须守住的约定：
 *   ① 工具栏右侧要留出 WCO 的宽度，否则头像/「ShopPilot Pro」/VIP 徽标会被按钮压住（实测被压住的就是它们）；
 *   ② overlay 底色由 App.vue 的 `titlebarOverlayColor()` 下发，**必须与工具栏实际底色完全相同**——
 *      overlay 是不透明的，色值对不上就会在右上角显示成一块多余的色块。
 *
 * ②是跨文件耦合（一个在 .vue 的 scoped style 里、一个在 App.vue 的 TS 常量里），
 * 改一处忘了另一处不会有任何编译/类型错误，只会让用户看到一块错色 —— 所以这里用测试钉住。
 */

const DASHBOARD = readFileSync(resolve('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue'), 'utf8')
const APP = readFileSync(resolve('apps/desktop/src/renderer/src/app/App.vue'), 'utf8')

describe('工具栏与原生窗口按钮（WCO）边界', () => {
  it('工具栏不得再画"假的"窗口控制按钮（真按钮就在同一位置）', () => {
    expect(DASHBOARD).not.toContain('class="window-controls"')
    expect(DASHBOARD).not.toContain('.window-controls')
  })

  it('工具栏右侧必须为 WCO 留白（≥138px = 三个 46px 按钮）', () => {
    const rule = /\.dashboard-toolbar\s*\{[^}]*padding:\s*([^;]+);/.exec(DASHBOARD)
    expect(rule, '没找到 .dashboard-toolbar 的 padding 规则').toBeTruthy()
    const parts = String(rule![1]).trim().split(/\s+/)
    const right = parts[1] || parts[0]
    const px = Number(String(right).replace('px', ''))
    expect(Number.isFinite(px), `解析不出右侧留白：${right}`).toBe(true)
    expect(px, '右侧留白不足以避开原生窗口按钮').toBeGreaterThanOrEqual(138)
  })

  it('窄屏媒体查询不得把这份留白取消掉（WCO 在窄窗口里照样在）', () => {
    const mediaBlocks = DASHBOARD.split('@media')[1] || ''
    const toolbarOverrides = mediaBlocks.split('\n').filter(line => line.includes('.dashboard-toolbar'))
    for (const line of toolbarOverrides) {
      expect(line, `窄屏里把工具栏右留白改小了，会重新压住头像：${line.trim()}`).not.toMatch(/padding-right:\s*\d+px/)
    }
  })

  it('overlay 底色与工具栏底色必须是同一个色值（跨文件耦合，改一处要改两处）', () => {
    const cssBg = /\.dashboard-toolbar\s*\{[^}]*background:\s*(#[0-9a-fA-F]{6})/.exec(DASHBOARD)
    expect(cssBg, '工具栏没有设固定底色（overlay 色值就无从对齐）').toBeTruthy()
    const tsConst = /const\s+TOOLBAR_BG\s*=\s*'(#[0-9a-fA-F]{6})'/.exec(APP)
    expect(tsConst, 'App.vue 里应有 TOOLBAR_BG 常量并在 titlebarOverlayColor() 里使用').toBeTruthy()
    expect(APP).toContain('return TOOLBAR_BG')
    expect(tsConst![1].toLowerCase()).toBe(cssBg![1].toLowerCase())
  })
})
