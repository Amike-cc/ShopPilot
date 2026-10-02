import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 「店铺页面真正嵌进主窗口」的边界回归测试（2026-09-28 用户实报"浏览器没有真正嵌入"）。
 *
 * 背景：旧实现把店铺页面画在主窗口的 `BrowserWindow.contentView` 上（WebContentsView），
 * 主窗口 Renderer 里只有一块透明占位 div。后果是 HTML 弹层/抽屉/右键菜单**永远盖不住**
 * 店铺页面，只能靠摘挂原生视图来"避让"；页面尺寸、圆角、overflow 也不受 DOM 约束。
 *
 * 修法：店铺页面改成主窗口 DOM 里真实的 Electron `<webview>`，主进程只持有**已注册的**
 * guest WebContents。下面把这条链路上"少一处就退回老毛病"的关键点焊死：
 *   · 主窗口必须开 webviewTag，并在 will-attach-webview 里剥掉 preload、锁死 guest 权限；
 *   · 只允许真实店铺自己的 persist:store_<id> 分区；
 *   · 注册入口必须校验 sender / 宿主窗口 / session 身份 / 重复占用；
 *   · 渲染层必须渲染真元素、按元素尺寸布局、隐藏时用 opacity 而不是 display/visibility；
 *   · 主进程不得再出现 contentView 挂载原生视图的老路径。
 *
 * 这些都是"源码级约定"，没有任何一个能靠运行时类型检查发现——删掉它们代码照样编译通过，
 * 但功能会静默退化回"没嵌入"。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')

const MAIN_INDEX = read('apps/desktop/src/main/index.ts')
const WINDOW_MANAGER = read('apps/desktop/src/main/browser/window-manager.ts')
const BROWSER_HANDLERS = read('apps/desktop/src/main/ipc/browser-handlers.ts')
const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')
const DASHBOARD_VIEW = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const VITE_CONFIG = read('electron.vite.config.ts')

describe('主窗口 DOM <webview> 嵌入边界', () => {
  it('主窗口开启 webviewTag，并保留隔离/沙箱（否则 guest 会继承主窗口业务 bridge）', () => {
    expect(MAIN_INDEX).toContain('webviewTag: true')
    expect(MAIN_INDEX).toContain('contextIsolation: true')
    expect(MAIN_INDEX).toContain('nodeIntegration: false')
    expect(MAIN_INDEX).toContain('sandbox: true')
  })

  it('will-attach-webview 必须剥掉 preload 并锁死 guest 权限（远程店铺页不得拿到业务 preload）', () => {
    expect(MAIN_INDEX).toContain("'will-attach-webview'")
    expect(MAIN_INDEX).toContain('delete webPreferences.preload')
    expect(MAIN_INDEX).toContain('delete params.preload')
    expect(MAIN_INDEX).toContain('webPreferences.nodeIntegration = false')
    expect(MAIN_INDEX).toContain('webPreferences.contextIsolation = true')
    expect(MAIN_INDEX).toContain('webPreferences.sandbox = true')
    // guest 里不允许再建 webview（否则任意远程页面可以继续开窗）
    expect(MAIN_INDEX).toContain('webPreferences.webviewTag = false')
    // 默认允许后台节流，窗口管理器按活动页/任务页动态解除，避免隐藏店铺持续占用资源。
    expect(MAIN_INDEX).toContain('webPreferences.backgroundThrottling = true')
    expect(WINDOW_MANAGER).toContain('setBackgroundThrottling')
  })

  it('只放行真实店铺自己的 persist:store_<id> 分区，非法附件一律 preventDefault', () => {
    expect(MAIN_INDEX).toContain('persist:store_')
    expect(MAIN_INDEX).toContain('getStore(storeId)')
    expect(MAIN_INDEX).toContain('event.preventDefault()')
  })

  it('注册入口校验「只有主窗口渲染层能注册」并映射出 BROWSER_NOT_READY', () => {
    expect(BROWSER_HANDLERS).toContain('BROWSER_REGISTER_WEBVIEW')
    expect(BROWSER_HANDLERS).toContain('event.sender !== host.webContents')
    expect(BROWSER_HANDLERS).toContain('BROWSER_NOT_READY')
    // 页面未注册不能报成"已关闭"：两者的处置完全相反
    expect(BROWSER_HANDLERS).toContain('waitForTabWebContents')
  })

  it('registerWebview 校验 session 身份与重复占用，并回报首个待导航地址', () => {
    expect(WINDOW_MANAGER).toContain('export async function registerWebview')
    expect(WINDOW_MANAGER).toContain('guest.hostWebContents !== hostWindow.webContents')
    // Electron 的 Session 类型不暴露 partition，只能比实例身份（同一个 persist 分区是同一个单例）
    expect(WINDOW_MANAGER).toContain('guest.session !== expectedSession')
    expect(WINDOW_MANAGER).toContain('guestTabs')
    expect(WINDOW_MANAGER).toContain('pendingUrl')
    expect(WINDOW_MANAGER).toContain('export async function waitForTabWebContents')
  })

  it('主进程不得再出现把原生视图挂到 contentView 的老路径（退回旧架构即等于"没嵌入"）', () => {
    expect(WINDOW_MANAGER).not.toContain('addChildView')
    expect(WINDOW_MANAGER).not.toContain('removeChildView')
    expect(WINDOW_MANAGER).not.toContain('new WebContentsView')
    expect(WINDOW_MANAGER).not.toMatch(/webContentsView/)
  })

  it('渲染层渲染的是真 <webview> 元素，带店铺分区，并在 did-attach 后注册 guest', () => {
    expect(SURFACE).toContain('<webview')
    expect(SURFACE).toMatch(/:partition="`persist:store_\$\{item\.storeId\}`"/)
    expect(SURFACE).toContain('@did-attach="handleWebviewAttach(item)"')
    expect(SURFACE).toContain('registerWebview')
    expect(SURFACE).toContain('getWebContentsId()')
    // 首次导航必须用主进程确认过的地址，且异步完成（session/代理/指纹先就绪）
    expect(SURFACE).toContain('pendingUrl')
    expect(SURFACE).toContain('loadURL')
  })

  it('<webview> 必须带 allowpopups，否则页面里 target=_blank/window.open 打不开新标签页', () => {
    // 2026-09-29 用户实报"浏览器不能打开新标签页"：Electron 的 <webview> 默认**禁止弹窗**，
    // 没有 allowpopups 时新窗口请求在 webview 层就被丢弃，主进程的 setWindowOpenHandler
    // 根本不会被调用（实测：真鼠标点 target=_blank 链接，页签数不变、日志里一条 window-open 都没有）。
    // allowpopups 只是"允许把请求交给主进程判断"，我们仍然在 handler 里 deny 掉原生弹窗、改成应用内标签页。
    expect(SURFACE).toMatch(/<webview[\s\S]*?allowpopups[\s\S]*?<\/webview>/)
  })

  it('window-open 失败必须留日志（不能把 createTab 的异常吞掉，否则表现为"点了没反应"）', () => {
    expect(WINDOW_MANAGER).toContain('setWindowOpenHandler')
    expect(WINDOW_MANAGER).toContain('createTab(tab.storeId, targetUrl)')
    // 失败分支要写 warn（旧实现是空 catch，现场只剩一个空白页，既没日志也没提示）
    expect(WINDOW_MANAGER).toMatch(/catch\s*\(error\)\s*\{[\s\S]{0,400}window-open\] 开新标签页失败/)
    expect(WINDOW_MANAGER).toContain('action: \'deny\'')
  })

  it('被隐藏的店铺/标签页用 opacity 隐藏而不是 display/visibility（否则平台页面停止渲染）', () => {
    const styleBlock = SURFACE.slice(SURFACE.lastIndexOf('<style'))
    expect(styleBlock).toMatch(/\.dashboard-browser-webview\s*\{[^}]*opacity:\s*0/)
    expect(styleBlock).toMatch(/\.dashboard-browser-webview\.active\s*\{[^}]*opacity:\s*1/)
    // display:none / visibility:hidden 会让 guest 自认不可见 —— 平台（微应用）会停摆
    expect(styleBlock).not.toMatch(/\.dashboard-browser-webview[^{]*\{[^}]*visibility:\s*hidden/)
    expect(styleBlock).not.toMatch(/\.dashboard-browser-webview[^{]*\{[^}]*display:\s*none/)
  })

  it('浏览器面板只为每家店铺的活动标签页渲染 guest，历史标签只保留元数据', () => {
    expect(SURFACE).toContain('const activeId = ws.activeTabIdByStore[storeId]')
    expect(SURFACE).toContain('const activeTab = tabs.find(tab => tab.id === activeId)')
    expect(SURFACE).not.toMatch(/for \(const tab of ws\.tabsByStore\[storeId\] \|\| \[\]\)/)
  })

  it('guest 宿主在离开浏览器页时只隐藏不销毁（销毁会丢页面状态与登录流程）', () => {
    expect(DASHBOARD_VIEW).toContain('browserHostMounted')
    expect(DASHBOARD_VIEW).toContain('dashboard-browser-host')
    expect(DASHBOARD_VIEW).toMatch(/dashboard-browser-host:not\(\.active\)\s*\{[^}]*opacity:\s*0/)
  })

  it('Vue 把 <webview> 当自定义元素编译（否则属性/事件绑定会被当成组件 props）', () => {
    expect(VITE_CONFIG).toContain('isCustomElement')
    expect(VITE_CONFIG).toContain("tag === 'webview'")
  })
})
