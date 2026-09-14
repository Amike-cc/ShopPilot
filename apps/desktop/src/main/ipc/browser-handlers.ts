/**
 * 浏览器相关的 IPC 处理器
 * §6.2 浏览器和标签页接口
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as WindowManager from '../browser/window-manager'
import { clearStoreData } from '../browser/session-manager'
import { randomUUID } from 'crypto'

function generateRequestId(): string {
  return randomUUID()
}

function success<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

function error(code: string, message: string, requestId: string, details?: any): IPCResult {
  return {
    ok: false,
    error: { code, message, details },
    requestId
  }
}

/**
 * 注册所有浏览器相关的 IPC 处理器
 */
export function registerBrowserHandlers(): void {
  // browser:open
  ipcMain.handle(IPC_CHANNELS.BROWSER_OPEN, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.openStoreBrowser(input.storeId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:close
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLOSE, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.closeStoreBrowser(input.storeId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:create
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_CREATE, async (_event: IpcMainInvokeEvent, input: { storeId: string, url?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const tabId = WindowManager.createTab(input.storeId, input.url)
      return success({ tabId }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:activate
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_ACTIVATE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.activateTab(input.storeId, input.tabId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:close
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_CLOSE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.closeTab(input.storeId, input.tabId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:setPinned
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_SET_PINNED, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, pinned: boolean }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.setTabPinned(input.storeId, input.tabId, input.pinned)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:reorder
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_REORDER, async (_event: IpcMainInvokeEvent, input: { storeId: string, orderedTabIds: string[] }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.reorderTabs(input.storeId, input.orderedTabIds)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:navigate
  ipcMain.handle(IPC_CHANNELS.BROWSER_NAVIGATE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, url: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.navigateTab(input.storeId, input.tabId, input.url)
      return success({ success: true }, requestId)
    } catch (err: any) {
      if (err.message.includes('Navigation blocked')) {
        return error(ERROR_CODES.NAVIGATION_BLOCKED.code, ERROR_CODES.NAVIGATION_BLOCKED.message, requestId)
      }
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:prepareInviteSquare — 微信带货者广场筛选应用（用户仍需人工进入达人详情）
  ipcMain.handle(IPC_CHANNELS.BROWSER_PREPARE_INVITE_SQUARE, async (_event: IpcMainInvokeEvent, input: {
    storeId: string, url: string, finderType?: string, categories?: string[], otherFilters?: string[]
  }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const tabId = WindowManager.getActiveTabId(input.storeId)
      if (!tabId) return error(ERROR_CODES.INTERNAL_ERROR.code, '店铺没有当前标签页', requestId)
      const wc = WindowManager.getTabWebContents(input.storeId, tabId)
      if (!wc) return error(ERROR_CODES.BROWSER_CLOSED.code, '店铺标签页不可用', requestId)
      WindowManager.activateTab(input.storeId, tabId)
      await wc.loadURL(input.url)
      await new Promise(r => setTimeout(r, 2000))
      // 登录态检测：微信会话很短（实测数十分钟），过期时页面只渲染「登录超时，请重新登录」，
      // 此时筛选根本无从点起。必须明确报"登录已过期"，否则用户看到的是"筛选没生效"。
      const loginExpired = await wc.executeJavaScript(
        `(() => { const t = String(document.body ? document.body.innerText : ''); return /登录超时|请重新\\s*登录|扫码进入我的小店/.test(t) })()`
      ).catch(() => false)
      if (loginExpired) {
        return error(ERROR_CODES.INTERNAL_ERROR.code, '微信小店登录已过期：请在店铺窗口打开 store.weixin.qq.com 扫码重新登录后再试', requestId)
      }
      // 微应用（micro-app ShadowRoot）不吃合成 click：先定位元素坐标，再发**受信任鼠标事件**
      // （与微信表单必须 typeText 同理；实测合成 click 后筛选项勾选状态不变）
      // 注意：needle 必须注入进脚本字符串——直接引用会抛 ReferenceError，
      // 被 catch 成 null 后表现为"永远定位不到"（实测踩过）。
      //
      // 返回一个**未被遮挡**的可点坐标：窗口较窄时页面布局会重叠（实测 776px 宽下
      // 「美妆护肤」整块被另一个筛选块压住），按元素中心点会点在浮层上、勾选永不生效。
      // 因此在元素矩形内取多个采样点，用 elementFromPoint（穿 ShadowRoot）确认命中的
      // 是目标自身/其后代/同一 label，命中即用；全被遮挡则如实报告遮挡者。
      const locatePoint = (needle: string) => wc.executeJavaScript(`(() => {
        const NEEDLE = ${JSON.stringify(needle)}
        const out = []
        const walk = (root) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
        walk(document)
        const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
        const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner } return el }
        for (const el of out) {
          if (own(el) !== NEEDLE) continue
          const r = el.getBoundingClientRect()
          if (!(r.width > 0 && r.height > 0)) continue
          const cs = getComputedStyle(el)
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
          const labelEl = el.closest('label') || el.parentElement || el
          const xs = [0.12, 0.3, 0.5, 0.7, 0.88].map(f => Math.round(r.left + r.width * f))
          const ys = [0.5, 0.25, 0.75].map(f => Math.round(r.top + r.height * f))
          for (const x of xs) {
            for (const y of ys) {
              const hit = deepAt(x, y)
              if (hit && (hit === el || el.contains(hit) || hit.contains(el) || labelEl.contains(hit) || hit.contains(labelEl))) {
                return JSON.stringify({ ok: true, x, y })
              }
            }
          }
          const blocker = deepAt(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
          return JSON.stringify({ ok: false, coveredBy: blocker ? blocker.tagName + '.' + String(blocker.className || '').slice(0, 40) : 'unknown' })
        }
        return JSON.stringify({ ok: false, missing: true })
      })()`) as Promise<string>
      const realClick = (x: number, y: number) => {
        wc.sendInputEvent({ type: 'mouseMove', x, y })
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      }
      // 点完必须回读"是否真的选中"：真实页面点一下可能被遮挡/重排/自定义控件吃掉，
      // 不校验就会把"点过了"当成"筛上了"（实测 美妆护肤 点了没选上）。
      // 选中判定：最近 label 的 input.checked，或元素/父/祖父 class 带
      // on|active|current|checked|selected（微信类型页签的选中态是父 LI 的 nav_current）。
      const stateOf = (needle: string) => wc.executeJavaScript(`(() => {
        const NEEDLE = ${JSON.stringify(needle)}
        const out = []
        const walk = (root) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
        walk(document)
        const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
        const RE = /(^|[\\s_-])(on|active|current|checked|selected)([\\s_-]|$)/i
        for (const el of out) {
          if (own(el) !== NEEDLE) continue
          const r = el.getBoundingClientRect()
          if (!(r.width > 0 && r.height > 0)) continue
          const cs = getComputedStyle(el)
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
          const label = el.closest('label') || null
          const inp = label && label.querySelector('input')
          let on = !!(inp && inp.checked)
          let node: Element | null = el
          for (let i = 0; i < 3 && node && !on; i++, node = node.parentElement) {
            if (RE.test(String(node.className || ''))) on = true
          }
          return JSON.stringify({ selected: on, cls: String((label || el).className || '').slice(0, 60) })
        }
        return JSON.stringify({ selected: false, missing: true })
      })()`) as Promise<string>
      /** 点击并按回读结果校验，未选中则重试（最多 3 次）；返回是否**确认选中** */
      const clickAndVerify = async (needle: string): Promise<{ ok: boolean, reason?: string }> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const st = JSON.parse(await stateOf(needle).catch(() => '{"selected":false}'))
          if (st.selected) return { ok: true }
          const pt = JSON.parse(await locatePoint(needle).catch(() => '{"ok":false}'))
          if (!pt.ok) {
            if (pt.coveredBy) return { ok: false, reason: `被「${pt.coveredBy}」遮挡` }
            await new Promise(r => setTimeout(r, 500))
            continue
          }
          realClick(pt.x!, pt.y!)
          await new Promise(r => setTimeout(r, 900))
          const after = JSON.parse(await stateOf(needle).catch(() => '{"selected":false}'))
          if (after.selected) return { ok: true }
        }
        return { ok: false, reason: '点击后未确认选中' }
      }
      const typeRes = input.finderType ? await clickAndVerify(input.finderType) : { ok: true }
      const catRes: Array<{ name: string, ok: boolean, reason?: string }> = []
      for (const c of (input.categories || [])) catRes.push({ name: c, ...(await clickAndVerify(c)) })
      const otherRes: Array<{ name: string, ok: boolean, reason?: string }> = []
      for (const f of (input.otherFilters || [])) otherRes.push({ name: f, ...(await clickAndVerify(f)) })
      const allOk = typeRes.ok && catRes.every(x => x.ok) && otherRes.every(x => x.ok)
      return success({ tabId, applied: allOk, finderType: { name: input.finderType || '', ...typeRes }, categories: catRes, otherFilters: otherRes }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:clearData
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLEAR_DATA, async (_event: IpcMainInvokeEvent, input: { storeId: string, types: string[], origin?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      await clearStoreData(input.storeId, input.types, input.origin)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:capture - 真实截图（返回 base64 PNG/JPEG）
  ipcMain.handle(IPC_CHANNELS.BROWSER_CAPTURE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, format: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const dataUrl = await WindowManager.captureTab(input.storeId, input.tabId, input.format || 'png')
      return success({ format: input.format || 'png', data: dataUrl }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:tab:list - UI 读取当前店铺标签页
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_LIST, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const tabs = WindowManager.getStoreTabs(input.storeId).map(t => ({
        id: t.id, url: t.url, title: t.title, isPinned: t.isPinned, orderIndex: t.orderIndex
      }))
      return success({ tabs }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:openWindow - §14 独立窗口逃生入口
  ipcMain.handle(IPC_CHANNELS.BROWSER_OPEN_WINDOW, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.openStandaloneWindow(input.storeId, input.tabId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:display - 切换显示的店铺（§8.2）
  ipcMain.handle(IPC_CHANNELS.BROWSER_DISPLAY, async (_event: IpcMainInvokeEvent, input: { storeId: string | null }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.displayStore(input.storeId)
      return success({ success: true, displayedStoreId: WindowManager.getDisplayedStoreId() }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:setViewport - 渲染层上报 BrowserViewport 区域
  ipcMain.handle(IPC_CHANNELS.BROWSER_SET_VIEWPORT, async (_event: IpcMainInvokeEvent, input: { x: number, y: number, width: number, height: number }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.setViewportBounds({ x: input.x, y: input.y, width: input.width, height: input.height })
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:setViewsObscured - 渲染层弹层遮挡：摘除/恢复原生视图挂载
  ipcMain.handle(IPC_CHANNELS.BROWSER_SET_VIEWS_OBSCURED, async (_event: IpcMainInvokeEvent, input: { obscured: boolean }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.setBrowserViewsObscured(input?.obscured === true)
      return success({ obscured: input?.obscured === true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:tab:control - 地址栏 前进/后退/重载
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_CONTROL, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, action: 'back' | 'forward' | 'reload' }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.tabNavigationControl(input.storeId, input.tabId, input.action)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
}
