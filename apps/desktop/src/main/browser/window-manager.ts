/**
 * 浏览器视图管理器（主窗口内嵌模型）- §4.3 / §8.2
 *
 * 架构：
 * - 主窗口（工作台）是唯一宿主窗口；每个店铺标签页由 Renderer DOM 中受控的
 *   Electron `<webview>` 承载，主进程只保存并操作已注册的 guest WebContents。
 * - 同一时刻仅允许 displayedStoreId 的活动标签页接收交互；切换店铺/标签页由 Renderer
 *   控制 webview 的可见性，不再把原生 View 摘挂到 BrowserWindow.contentView。
 * - 未显示的标签页在温缓存/冷休眠策略内继续存活（后台加载、状态保留）；
 *   冷休眠只关闭 guest，标签页元数据持久化到 tabs 表，重开后恢复。
 * - WebContents 无 destroy()，销毁用 webContents.close()；Renderer reload 后必须重新注册 guest。
 *
 * 2026-10-19 P1 重构：本文件只保留**对外入口的薄 facade**，实现按职责拆到：
 *   ./window-state.ts        进程内状态、只读查询与事件广播原语
 *   ./window-browser-core.ts 店铺页面开关/显示、标签页与 guest 生命周期、菜单/快捷键、导航、元素拾取、独立窗口
 *   ./window-capture.ts      标签页截图
 *   ./window-diagnostics.ts  视图探针与内存诊断
 * 对外导出名与 `browser/window-manager` 这个 import 路径保持不变，调用方无需改动。
 */
export { assertNavigableUrl } from '@shared/navigation'
export { getActiveTabId, getCurrentStoreWebContents, getOpenStoreIds, getStandaloneWindowCount, getStoreTabs, getTabWebContents, onStoreBrowserOpened } from './window-state'
export { acquireCollectionTab, activateTab, borrowCollectionPage, borrowStorePage, closeStoreBrowser, closeTab, closeTabs, createTab, displayStore, emitToRenderer, getBrowserHostWindow, getCollectionTabId, getDisplayedStoreId, getStorePageLeaseSnapshot, isBrowserTabMounted, isBrowserTabReadableForAgent, isHostWindowFocused, navigateTab, openStandaloneWindow, openStoreBrowser, pickElementFromActiveTab, registerWebview, releaseCollectionTab, reorderTabs, setBrowserHostWindow, setBrowserViewsObscured, setBrowserViewsVisible, setStoreLifecycleBlock, setStoreTaskActivity, setTabPinned, setViewportBounds, tabNavigationControl, waitForStoreWebContents, waitForTabWebContents } from './window-browser-core'
export { captureTab } from './window-capture'
export { getMemoryDiagnostics } from './window-diagnostics'
export type { StoreLifecycleBlockReason, Tab, ViewportBounds } from './window-state'
export type { BrowserViewObscuredReason, CloseTabsInput, CloseTabsResult } from './window-browser-core'
export type { ViewProbe } from './window-diagnostics'
