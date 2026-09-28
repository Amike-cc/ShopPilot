/**
 * 浏览器相关的 IPC 处理器
 * §6.2 浏览器和标签页接口
 */

import { familyHandle } from './family-handle'
import { IpcMainInvokeEvent, app } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { normalizeDouyinCategoryTree } from '@shared/douyin-category-tree'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as WindowManager from '../browser/window-manager'
import * as StoreManager from '../stores/store-manager'
import { clearStoreData } from '../browser/session-manager'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'

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
 * 浏览器层错误映射：window-manager 抛的是人话 Error，
 * 这里按关键字归到契约错误码，别一律 INTERNAL_ERROR。
 */
function browserError(err: any, requestId: string): IPCResult {
  const msg = String(err?.message || err)
  if (msg.includes('Navigation blocked')) {
    return error(ERROR_CODES.NAVIGATION_BLOCKED.code, ERROR_CODES.NAVIGATION_BLOCKED.message, requestId)
  }
  if (msg.includes('BROWSER_NOT_READY')) {
    return error('BROWSER_NOT_READY', msg.replace(/^BROWSER_NOT_READY:\s*/, '') || '店铺标签页尚未就绪', requestId)
  }
  if (msg.includes('IPC_FORBIDDEN')) {
    return error(ERROR_CODES.IPC_FORBIDDEN.code, '不允许注册该店铺页面', requestId)
  }
  if (msg.includes('Tab not found')) {
    return error(ERROR_CODES.TASK_INVALID_STEP.code, '标签页不存在（可能已被关闭）', requestId)
  }
  if (msg.includes('Browser not open') || msg.includes('Host window not available')) {
    return error(ERROR_CODES.BROWSER_CLOSED.code, '店铺浏览器未打开', requestId)
  }
  return error(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
}

/**
 * 注册所有浏览器相关的 IPC 处理器
 */
const handle = familyHandle('浏览器')

export function registerBrowserHandlers(): void {
  // browser:open
  handle(IPC_CHANNELS.BROWSER_OPEN, async (_event: IpcMainInvokeEvent, input: { storeId: string; display?: boolean }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      // display=false：批量采集/后台动作只要"店铺打开"（建 session、放行排队任务），
      // 不要把原生视图盖到用户当前所在的页面上（默认 true = 用户点开店，当然要显示）
      // source:'renderer'：这次显示是渲染层自己请求的，它不需要"跟随自己的动作再切页"
      WindowManager.openStoreBrowser(input.storeId, { display: input?.display !== false, source: 'renderer' })
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
  
  // browser:registerWebview - 由主窗口 Renderer 的 DOM <webview> did-attach 发起。
  // familyHandle 已校验 sender 是可信主窗口；这里再检查宿主 webContents，避免未来把该通道
  // 挪到别的 IPC 家族后失去 sender 边界。
  handle(IPC_CHANNELS.BROWSER_REGISTER_WEBVIEW, async (event: IpcMainInvokeEvent, input: { storeId: string; tabId: string; webContentsId: number }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const host = WindowManager.getBrowserHostWindow()
      if (!host || host.isDestroyed() || event.sender !== host.webContents) {
        return error(ERROR_CODES.IPC_FORBIDDEN.code, '只有主窗口渲染层可以注册店铺 webview', requestId)
      }
      if (!input || typeof input.storeId !== 'string' || typeof input.tabId !== 'string' || !Number.isInteger(input.webContentsId)) {
        return error(ERROR_CODES.INVALID_ARGUMENT.code, 'storeId、tabId 和 webContentsId 无效', requestId)
      }
      const data = await WindowManager.registerWebview(input.storeId, input.tabId, input.webContentsId)
      return success(data, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })

  // browser:close
  handle(IPC_CHANNELS.BROWSER_CLOSE, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.closeStoreBrowser(input.storeId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
  
  // browser:tab:create
  handle(IPC_CHANNELS.BROWSER_TAB_CREATE, async (_event: IpcMainInvokeEvent, input: { storeId: string, url?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const tabId = WindowManager.createTab(input.storeId, input.url)
      return success({ tabId }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
  
  // browser:tab:activate
  handle(IPC_CHANNELS.BROWSER_TAB_ACTIVATE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.activateTab(input.storeId, input.tabId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
  
  // browser:tab:close
  handle(IPC_CHANNELS.BROWSER_TAB_CLOSE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.closeTab(input.storeId, input.tabId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
  
  // browser:tab:setPinned
  handle(IPC_CHANNELS.BROWSER_TAB_SET_PINNED, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, pinned: boolean }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.setTabPinned(input.storeId, input.tabId, input.pinned)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
  
  // browser:tab:reorder
  handle(IPC_CHANNELS.BROWSER_TAB_REORDER, async (_event: IpcMainInvokeEvent, input: { storeId: string, orderedTabIds: string[] }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.reorderTabs(input.storeId, input.orderedTabIds)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
  
  // browser:navigate
  handle(IPC_CHANNELS.BROWSER_NAVIGATE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, url: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.navigateTab(input.storeId, input.tabId, input.url)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
  
  // browser:prepareInviteSquare — 微信带货者广场筛选应用（用户仍需人工进入达人详情）
  handle(IPC_CHANNELS.BROWSER_PREPARE_INVITE_SQUARE, async (_event: IpcMainInvokeEvent, input: {
    storeId: string, url: string, finderType?: string, categories?: string[], otherFilters?: string[],
    loadCategoryTree?: boolean
  }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const tabId = WindowManager.getActiveTabId(input.storeId)
      if (!tabId) return error(ERROR_CODES.INTERNAL_ERROR.code, '店铺没有当前标签页', requestId)
      // 页面句柄要等 guest 注册：店铺刚打开/渲染层刚重载时标签页存在但 webview 还没挂上，
      // 这时既不能当成"已关闭"（BROWSER_CLOSED），也不能静默跳过——等待或如实报未就绪。
      const wc = await WindowManager.waitForTabWebContents(input.storeId, tabId)
      WindowManager.activateTab(input.storeId, tabId)
      // input.url 来自渲染层，同样过协议白名单（与 navigateTab 一致）
      let safeUrl: string
      try {
        safeUrl = WindowManager.assertNavigableUrl(String(input.url))
      } catch (err: any) {
        return error(ERROR_CODES.NAVIGATION_BLOCKED.code, ERROR_CODES.NAVIGATION_BLOCKED.message, requestId)
      }
      await wc.loadURL(safeUrl)
      await new Promise(r => setTimeout(r, 2000))
      if (input.loadCategoryTree) {
        const pageState = await wc.executeJavaScript(`(() => {
          const text = String(document.body ? document.body.innerText : '')
          const login = /请选择您要登录的角色|登录商家工作台|账号未登录|请重新登录/.test(text) ||
            /roles-select|\\/login\\//.test(location.href)
          return { ok: !login, url: location.href }
        })()`) as { ok: boolean, url: string }
        if (!pageState.ok) {
          return error(
            ERROR_CODES.INTERNAL_ERROR.code,
            '抖店达人广场未登录：请在店铺窗口打开达人广场并完成商家工作台登录后重试',
            requestId,
            { url: pageState.url }
          )
        }
        const raw = await wc.executeJavaScript(`(async () => {
          const pathname = location.pathname || ''
          const currentPrefix = pathname.startsWith('/ffa/buyin') ? '/ffa/buyin' : ''
          const prefixes = [...new Set([currentPrefix, '/ffa/buyin', ''])]
          const suffixes = [
            '/square_doudian_pc_api/square/filter',
            '/square_pc_api/square/filter'
          ]
          const attempts = []
          for (const prefix of prefixes) {
            for (const suffix of suffixes) {
              const url = prefix + suffix + '?type=1&req_scene=1'
              try {
                const res = await fetch(url, {
                  method: 'GET',
                  credentials: 'include',
                  headers: { accept: 'application/json, text/plain, */*' }
                })
                const text = await res.text()
                let json = null
                try { json = JSON.parse(text) } catch { /* 非 JSON 多为登录/风控页，继续换入口 */ }
                attempts.push({ url, status: res.status, json, text: json ? '' : text.slice(0, 180) })
                if (json && json.code === 0) return { ok: true, attempts }
              } catch (err) {
                attempts.push({ url, error: String(err && err.message || err) })
              }
            }
          }
          return { ok: false, attempts }
        })()`) as { ok: boolean, attempts: any[] }
        if (!raw.ok) {
          const detail = raw.attempts?.map(a => `${a.url}: ${a.status || a.error || '非 JSON'}`).join('；') || '无响应'
          return error(ERROR_CODES.INTERNAL_ERROR.code, `读取抖店类目失败：${detail}`, requestId)
        }
        const payload = raw.attempts.find(a => a.json?.code === 0)?.json
        const categoryTree = normalizeDouyinCategoryTree(payload)
        if (!categoryTree.length) {
          return error(ERROR_CODES.INTERNAL_ERROR.code, '抖店筛选接口已返回，但未找到「主推类目」三级数据', requestId)
        }
        return success({ tabId, categoryTree }, requestId)
      }
      // 登录态检测：微信会话很短（实测数十分钟），过期时页面只渲染「登录超时，请重新登录」，
      // 此时筛选根本无从点起。必须明确报"登录已过期"，否则用户看到的是"筛选没生效"。
      const loginExpired = await wc.executeJavaScript(
        `(() => { const t = String(document.body ? document.body.innerText : ''); return /登录超时|请重新\\s*登录|扫码进入我的小店/.test(t) })()`
      ).catch(() => false)
      if (loginExpired) {
        return error(ERROR_CODES.INTERNAL_ERROR.code, '微信小店登录已过期：请在店铺窗口打开 store.weixin.qq.com 扫码重新登录后再试', requestId)
      }
      // 就绪等待：广场是 micro-app 微应用，导航回来那一刻外壳先到、**微应用还没挂载**。
      // 此时点筛选项会被丢弃（实测「直播带货者」三次重试都落在挂载前，类目却因为排在后面反而成功——
      // 表现成"类型没选上、类目选上了"）。等到列表真的渲染出来（出现「详情」链接）再动手。
      const readyExpr = `(() => {
        const out = []
        const walk = (root) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
        walk(document)
        const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
        for (const el of out) {
          if (own(el) !== '详情') continue
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) return true
        }
        return false
      })()`
      const readyDeadline = Date.now() + 25000
      for (;;) {
        const ready = await wc.executeJavaScript(readyExpr).catch(() => false)
        if (ready) break
        if (Date.now() >= readyDeadline) break // 超时也继续：后续每步都会如实报"找不到/没选中"
        await new Promise(r => setTimeout(r, 500))
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
      //
      // 注意：**同一段文案在页面上会出现多次**（页签本身 + 表格行里的类目文本 + 筛选摘要），
      // 只看第一个匹配元素会误判（实测「直播带货者」页签明明已选中，却因为先命中别处而报未选上）。
      // 因此遍历**所有可见匹配元素**，任一呈现选中态即算选中。
      const stateOf = (needle: string) => wc.executeJavaScript(`(() => {
        const NEEDLE = ${JSON.stringify(needle)}
        const out = []
        const walk = (root) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
        walk(document)
        const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
        const RE = /(^|[\\s_-])(on|active|current|checked|selected)([\\s_-]|$)/i
        let found = false
        for (const el of out) {
          if (own(el) !== NEEDLE) continue
          const r = el.getBoundingClientRect()
          if (!(r.width > 0 && r.height > 0)) continue
          const cs = getComputedStyle(el)
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
          found = true
          const label = el.closest('label') || null
          const inp = label && label.querySelector('input')
          let on = !!(inp && inp.checked)
          let node = el
          for (let i = 0; i < 3 && node && !on; i++, node = node.parentElement) {
            if (RE.test(String(node.className || ''))) on = true
          }
          if (on) return JSON.stringify({ selected: true, cls: String((label || el).className || '').slice(0, 60) })
        }
        return JSON.stringify({ selected: false, ...(found ? {} : { missing: true }) })
      })()`) as Promise<string>
      /** 点击并按回读结果校验，未选中则重试（最多 4 次）；返回是否**确认选中** */
      const clickAndVerify = async (needle: string): Promise<{ ok: boolean, reason?: string }> => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const st = JSON.parse(await stateOf(needle).catch(() => '{"selected":false}'))
          if (st.selected) return { ok: true }
          const pt = JSON.parse(await locatePoint(needle).catch(() => '{"ok":false}'))
          if (!pt.ok) {
            if (pt.coveredBy) return { ok: false, reason: `被「${pt.coveredBy}」遮挡` }
            // 还没渲染出来（missing）：多等一会儿再试，别把"没挂载"当成"点不动"
            await new Promise(r => setTimeout(r, 900))
            continue
          }
          realClick(pt.x!, pt.y!)
          await new Promise(r => setTimeout(r, 1100))
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
  handle(IPC_CHANNELS.BROWSER_CLEAR_DATA, async (_event: IpcMainInvokeEvent, input: { storeId: string, types: string[], origin?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()

    try {
      if (!StoreManager.getStore(input?.storeId)) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      }
      if (input.origin) {
        // 只接受合法的 http(s) origin：无效字符串原来直通 clearStorageData 静默无效
        let parsed: URL
        try { parsed = new URL(String(input.origin)) } catch {
          return error(ERROR_CODES.INVALID_ARGUMENT.code, 'origin 必须是合法的 http(s) 地址', requestId)
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return error(ERROR_CODES.INVALID_ARGUMENT.code, 'origin 必须是 http(s) 地址', requestId)
        }
      }
      await clearStoreData(input.storeId, input.types, input.origin)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
  
  // browser:capture - 真实截图：落盘到该店铺的 artifacts 目录，并回报真实路径。
  // 为什么在主进程写：渲染层此前用 <a download> 触发保存对话框，无论用户是否保存都会立刻
  // 提示"已截图并保存"（取消保存框也报成功）。写文件必须由拿到像素的一侧完成才能如实回报。
  handle(IPC_CHANNELS.BROWSER_CAPTURE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, format: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()

    try {
      // storeId 参与拼盘符目录（userData/stores/<id>/artifacts）：先确认店铺存在，
      // 否则任意字符串（含 ..\ 路径片段）都能在 userData 外递归建目录写文件
      if (!StoreManager.getStore(input?.storeId)) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      }
      const format = input.format === 'jpeg' ? 'jpeg' : 'png'
      const dataUrl = await WindowManager.captureTab(input.storeId, input.tabId, format)
      const base64 = String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '')
      const buf = Buffer.from(base64, 'base64')
      if (!buf.length) return error(ERROR_CODES.INTERNAL_ERROR.code, 'CAPTURE_EMPTY: 视口未渲染，截图为空', requestId)
      const dir = join(app.getPath('userData'), 'stores', input.storeId, 'artifacts')
      mkdirSync(dir, { recursive: true })
      // 扩展名跟着真实格式走（jpeg 写进 .png 会打不开）；文件名带随机后缀，
      // 否则同一毫秒连点两次会同名覆盖，而 savedPath 是"已保存"的唯一凭据
      const ext = format === 'jpeg' ? 'jpg' : 'png'
      const savedPath = join(dir, `capture_${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`)
      await writeFile(savedPath, buf)
      return success({ format, data: dataUrl, savedPath, bytes: buf.length }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })

  // browser:pickElement - 编排器「拾取元素」：在店铺页面上点一下取锚点（自定义任务用）
  handle(IPC_CHANNELS.BROWSER_PICK_ELEMENT, async (_event: IpcMainInvokeEvent, input: { storeId: string, mode: 'selector' | 'text' }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      if (!input?.storeId) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少 storeId', requestId)
      if (input.mode !== 'selector' && input.mode !== 'text') {
        return error(ERROR_CODES.INVALID_ARGUMENT.code, `非法的拾取模式: ${String(input.mode)}（应为 selector/text）`, requestId)
      }
      const result = await WindowManager.pickElementFromActiveTab(input.storeId, input.mode)
      return success(result, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })

  // browser:tab:list - UI 读取当前店铺标签页
  handle(IPC_CHANNELS.BROWSER_TAB_LIST, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const tabs = WindowManager.getStoreTabs(input.storeId).map(t => ({
        id: t.id, url: t.url, title: t.title, isPinned: t.isPinned, orderIndex: t.orderIndex,
        guestAttached: t.guestAttached === true && !!t.webContents && !t.webContents.isDestroyed()
      }))
      return success({ tabs }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })

  // browser:state - 只读：渲染层重载/崩溃恢复后据它补齐"哪些店铺已打开、各自的标签页与活动页、
  // 当前显示的是哪家"。此前没有这条通道，渲染层只能猜（猜错会把 welcome 页换掉、或让截图落到别的标签）
  handle(IPC_CHANNELS.BROWSER_STATE, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const stores = WindowManager.getOpenStoreIds().map(storeId => ({
        storeId,
        activeTabId: WindowManager.getActiveTabId(storeId),
        tabs: WindowManager.getStoreTabs(storeId).map(t => ({
          id: t.id, url: t.url, title: t.title, isPinned: t.isPinned, orderIndex: t.orderIndex,
          guestAttached: t.guestAttached === true && !!t.webContents && !t.webContents.isDestroyed()
        }))
      }))
      return success({ displayedStoreId: WindowManager.getDisplayedStoreId(), stores }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })

  // browser:openWindow - §14 独立窗口逃生入口
  handle(IPC_CHANNELS.BROWSER_OPEN_WINDOW, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.openStandaloneWindow(input.storeId, input.tabId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })

  // browser:display - 切换显示的店铺（§8.2）
  handle(IPC_CHANNELS.BROWSER_DISPLAY, async (_event: IpcMainInvokeEvent, input: { storeId: string | null }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      // source:'renderer'：渲染层自己请求的显示（ws.showStore/openStore 已经改过自己的状态），
      // 事件里带上来源，界面据此决定"要不要跟随切页"——跟随只对主进程单方面显示有意义
      WindowManager.displayStore(input.storeId, 'renderer')
      return success({ success: true, displayedStoreId: WindowManager.getDisplayedStoreId() }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })

  // browser:setViewport - 渲染层上报 BrowserViewport 区域
  handle(IPC_CHANNELS.BROWSER_SET_VIEWPORT, async (_event: IpcMainInvokeEvent, input: { x: number, y: number, width: number, height: number }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.setViewportBounds({ x: input.x, y: input.y, width: input.width, height: input.height })
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })

  // browser:setViewsObscured - 渲染层弹层遮挡：摘除/恢复原生视图挂载
  handle(IPC_CHANNELS.BROWSER_SET_VIEWS_OBSCURED, async (_event: IpcMainInvokeEvent, input: { obscured: boolean, reason?: 'modal' | 'agent' }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const obscured = input?.obscured === true
      const reason = input?.reason === 'agent' ? 'agent' : 'modal'
      WindowManager.setBrowserViewsObscured(obscured, reason)
      return success({ obscured, reason }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })

  // browser:tab:control - 地址栏 前进/后退/重载
  handle(IPC_CHANNELS.BROWSER_TAB_CONTROL, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, action: 'back' | 'forward' | 'reload' }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.tabNavigationControl(input.storeId, input.tabId, input.action)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return browserError(err, requestId)
    }
  })
}
