import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 浏览器常用操作守卫（2026-11-14）。
 *
 * 这些能力都依赖真实 Electron/guest，单测只锁接线：收藏必须走 bookmark.create，
 * 新标签必须把焦点交回地址栏，常用快捷键必须真的在窗口/页面两条路径上绑定。
 */
const surface = readFileSync('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue', 'utf8')
const core = readFileSync('apps/desktop/src/main/browser/window-browser-core.ts', 'utf8')
const channels = readFileSync('packages/shared/src/contracts/ipc.ts', 'utf8')

describe('浏览器：地址栏与收藏', () => {
  it('地址栏聚焦即全选，支持 Ctrl+L 回到地址栏', () => {
    expect(surface).toContain('ref="urlInput"')
    expect(surface).toContain('@focus="selectAddress"')
    expect(surface).toContain('input.select()')
    expect(surface).toContain("if (key === 'l'")
    expect(surface).toContain('focusAddress()')
  })

  it('收藏当前页走 bookmark.create，并刷新收藏列表', () => {
    expect(surface).toContain('data-test="browser-bookmark"')
    expect(surface).toContain('window.shopilot.bookmark.create({')
    expect(surface).toContain('await ws.refreshBookmarks()')
    expect(surface).toContain("ws.toast('已收藏当前页', 'success')")
    expect(surface).toContain('currentBookmarked')
  })

  it('新标签页打开后地址栏直接可输入', () => {
    expect(surface).toContain('data-test="browser-new-tab"')
    expect(surface).toContain('async function newTabAndFocus()')
    expect(surface).toContain('await ws.newTab()')
    expect(surface).toContain('focusAddress()')
  })
})

describe('浏览器：快捷键与标签操作', () => {
  it('补全常用快捷键：新标签/刷新/查找/前进后退/切标签', () => {
    expect(surface).toContain("key === 't'")
    expect(surface).toContain("key === 'r'")
    expect(surface).toContain("key === 'tab'")
    expect(surface).toContain("event.key === 'F5'")
    expect(surface).toContain("event.key === 'ArrowLeft'")
    expect(surface).toContain("event.key === 'ArrowRight'")
    expect(surface).toContain('switchTabByOffset(')
    expect(surface).toContain('activateTabAt(')
  })

  it('中键关标签、双击标签栏空白新建标签、滚轮横滚标签栏', () => {
    expect(surface).toContain('@auxclick="onTabAuxClick(tab, $event)"')
    expect(surface).toContain('if (event.button !== 1) return')
    expect(surface).toContain('@dblclick.self="newTabAndFocus"')
    expect(surface).toContain('@wheel="onTabsWheel"')
    expect(surface).toContain('el.scrollLeft += event.deltaY')
  })

  it('焦点在店铺页面里时，快捷键由主进程 before-input-event 转发', () => {
    expect(channels).toContain("BROWSER_SHORTCUT: 'browser:shortcut'")
    expect(core).toContain('BROWSER_SHORTCUT')
    expect(core).toContain("emitShortcut('new-tab')")
    expect(core).toContain("emitShortcut('focus-address')")
    expect(core).toContain("emitShortcut('bookmark')")
    expect(core).toContain("emitShortcut('activate-tab'")
    expect(core).toContain("emitShortcut('back')")
    expect(surface).toContain('BROWSER_SHORTCUT, onBrowserShortcut')
    expect(surface).toContain("case 'new-tab'")
    expect(surface).toContain("case 'bookmark'")
  })
})
