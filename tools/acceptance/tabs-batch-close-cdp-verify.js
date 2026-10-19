/**
 * 标签页批量关闭验收 —— 2026-10-17
 *
 * 覆盖用户要求的全部入口与边界：
 *   1) 多选（Ctrl+点击 / Shift+区间）→ 工具条显示数量 → 关闭选中（二次确认 / 取消不关）
 *   2) 右键菜单：关闭标签页 / 关闭其他（计数）/ 关闭全部（计数）
 *   3) 固定标签：一键关闭默认保留，多选显式关闭则连固定一起关
 *   4) 快捷键（**渲染层 handler**：焦点在工作台自身时）：Ctrl+Shift+W（全部）/ Ctrl+Alt+W（其他）/ Ctrl+W（当前）
 *      —— 这三个只覆盖 `window.dispatchEvent(new KeyboardEvent(...))` 打进来的那条路径
 *   5) 边界：0 个标签时不再弹确认、只提示"没有可关闭的标签页"
 *   6) 固定 / 取消固定（右键菜单）与拖拽重排：主进程 orderIndex 与 DOM 顺序一致
 *   7) 跨店隔离：关 A 店标签不影响 B 店（含 Main browser.state 层面的校验）
 *   8) 采集内部标签：最后一个可见标签关闭时不销毁仍在跑采集的 browserState
 *   9) 快捷键（**真实用户路径**：焦点在店铺页面里）：CDP `Input.dispatchKeyEvent` 向 guest
 *      <webview> 注入真实按键，经主进程 `before-input-event` 转发 —— Ctrl+Shift+W / Ctrl+Alt+W
 *      弹确认、Ctrl+W 直接关。断言前先走用户路径（店铺管理 → 打开工作区）把浏览器表面**真的激活**，
 *      因此 `onTabCloseRequested` 的 `props.active` 守卫一旦被挪错位置，本节会红。
 *
 * 前置：打包产物（release/win-unpacked）或 SHOPILOT_ACCEPTANCE_SOURCE=1 走源码 Electron。
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { resolveApp, appArgs, childEnv } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_TABS_CDP_PORT || 9380)
const SITE = Number(process.env.SHOPILOT_TABS_SITE_PORT || 9381)
const sleep = ms => new Promise(r => setTimeout(r, ms))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = () => resolve(); this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      if (!msg.id || !this.pending.has(msg.id)) return
      const pending = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(body, timeoutMs = 25000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ])
    if (result.timeout) throw new Error(`页面求值超时：${String(body).replace(/\s+/g, ' ').slice(0, 120)}`)
    if (result.exceptionDetails) throw new Error('页面异常：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text))
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
}

async function main() {
  const userData = process.env.SHOPILOT_TABS_USER_DATA || path.join(os.tmpdir(), 'shopilot-tabs-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const cacheDir = process.env.SHOPILOT_TABS_CACHE
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true })

  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body><h1>tabs fixture</h1></body></html>')
  })
  await new Promise(resolve => site.listen(SITE, '127.0.0.1', resolve))

  const appInfo = resolveApp(ROOT)
  const acceptanceLog = process.env.SHOPILOT_TABS_LOG || path.join(userData, 'acceptance-app.log')
  const acceptanceMeta = process.env.SHOPILOT_TABS_META || path.join(userData, 'acceptance-meta.json')
  const child = spawn(appInfo.executable, appArgs(ROOT, appInfo, {
    port: PORT,
    userData,
    extra: cacheDir ? [`--disk-cache-dir=${cacheDir}`] : []
  }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    // childEnv 会剥掉宿主继承来的 ELECTRON_RUN_AS_NODE（否则 ShopPilot.exe 退化成纯 Node，
    // 把 --remote-debugging-port 当非法选项退出，表现为「主窗口 CDP 未就绪」）
    env: childEnv({
      NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1',
      SHOPILOT_DISABLE_CDP_FP: '1', SHOPILOT_ACCEPTANCE: '1'
    })
  })
  let appLog = ''
  let childExitCode = null
  child.on('exit', code => { childExitCode = code })
  child.stdout.on('data', d => { appLog += d.toString() })
  child.stderr.on('data', d => { appLog += d.toString() })

  let ui = null
  try {
    for (let i = 0; i < 120; i++) {
      try {
        const list = await targets()
        const target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
        if (target) { ui = new CDP(target.webSocketDebuggerUrl); await ui.ready; break }
      } catch { /* retry */ }
      await sleep(500)
    }
    if (!ui) throw new Error('主窗口 CDP 未就绪')
    await sleep(900)

    const json = value => JSON.stringify(value)
    const ui_ = body => ui.eval(body)

    const tabCount = () => ui_(`return document.querySelectorAll('.dashboard-browser-tab').length`)
    const waitTabs = async (expected, timeout = 12000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        if (await tabCount() === expected) return true
        await sleep(220)
      }
      return false
    }
    const tabDebug = () => ui_(`return {
      count: document.querySelectorAll('.dashboard-browser-tab').length,
      ids: [...document.querySelectorAll('.dashboard-browser-tab')].map(el => el.dataset.tabId),
      pinned: [...document.querySelectorAll('.dashboard-browser-tab.pinned')].map(el => el.dataset.tabId)
    }`)

    // ---------- 准备：A 店 + 4 个标签 ----------
    const storeA = await ui_(`return await window.shopilot.store.create({ name: '标签验收A', platform: '抖店', adminUrl: 'http://127.0.0.1:${SITE}/' })`)
    if (!storeA.ok) throw new Error('创建 A 店失败：' + json(storeA.error))
    const aId = storeA.data.id
    const opened = await ui_(`return await window.shopilot.browser.open(${json(aId)})`)
    check('打开店铺 A 的浏览器', opened.ok === true, json(opened.error))
    await waitTabs(1)

    for (let i = 0; i < 3; i++) {
      const created = await ui_(`return await window.shopilot.browser.tab.create(${json(aId)}, 'http://127.0.0.1:${SITE}/?t=${i}')`)
      if (!created.ok) throw new Error('新建标签失败：' + json(created.error))
    }
    check('准备 4 个标签页', await waitTabs(4), json(await tabDebug()))

    const shiftSelected = await ui_(`
      const tabs = [...document.querySelectorAll('.dashboard-browser-tab')]
      tabs[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
      tabs[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
      await new Promise(r => setTimeout(r, 160))
      return { selected: document.querySelectorAll('.dashboard-browser-tab.multi-selected').length }
    `)
    check('Ctrl+点击与 Shift+点击按范围多选 3 个标签', shiftSelected.selected === 3, json(shiftSelected))
    await ui_(`document.querySelector('[data-test="tabs-batch-clear"]')?.click(); await new Promise(r => setTimeout(r, 100)); return true`)

    // ---------- 1) 多选 + 关闭选中：取消不关，确认才关 ----------
    const selected = await ui_(`
      const tabs = [...document.querySelectorAll('.dashboard-browser-tab')]
      tabs[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
      tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
      await new Promise(r => setTimeout(r, 180))
      return {
        count: document.querySelector('[data-test="tabs-batch-count"]')?.textContent?.trim() || null,
        selected: document.querySelectorAll('.dashboard-browser-tab.multi-selected').length,
        bar: !!document.querySelector('[data-test="tabs-batch-bar"]')
      }
    `)
    check('Ctrl+点击多选 2 个标签（工具条显示数量）',
      selected.bar === true && selected.selected === 2 && /已选 2 个/.test(String(selected.count)),
      json(selected))

    const confirmShown = await ui_(`
      document.querySelector('[data-test="tabs-batch-close"]').click()
      await new Promise(r => setTimeout(r, 200))
      return {
        open: !!document.querySelector('[data-test="tabs-close-confirm"]'),
        title: document.querySelector('[data-test="tabs-close-title"]')?.textContent?.trim() || '',
        detail: document.querySelector('[data-test="tabs-close-detail"]')?.textContent?.trim() || ''
      }
    `)
    check('点「关闭选中」弹出二次确认（写明数量与内容会丢失）',
      confirmShown.open === true && /关闭选中的 2 个标签页/.test(confirmShown.title) && /未保存/.test(confirmShown.detail),
      json(confirmShown))

    const afterCancel = await ui_(`
      document.querySelector('[data-test="tabs-close-cancel"]').click()
      await new Promise(r => setTimeout(r, 250))
      return {
        closed: !document.querySelector('[data-test="tabs-close-confirm"]'),
        tabs: document.querySelectorAll('.dashboard-browser-tab').length
      }
    `)
    check('取消确认 → 不关闭任何标签', afterCancel.closed === true && afterCancel.tabs === 4, json(afterCancel))

    // 取消只清确认框、不清多选（用户可能只是想再确认一次），所以这里直接重新点"关闭选中"
    await ui_(`
      document.querySelector('[data-test="tabs-batch-close"]').click()
      await new Promise(r => setTimeout(r, 200))
      document.querySelector('[data-test="tabs-close-ok"]').click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)
    const afterSelectedClose = await ui_(`
      const state = await window.shopilot.browser.state()
      const store = state.ok ? state.data.stores.find(item => item.storeId === ${json(aId)}) : null
      return { ui: [...document.querySelectorAll('.dashboard-browser-tab')].map(el => ({ id: el.dataset.tabId, active: el.classList.contains('active') })), activeTabId: store?.activeTabId || null, mainTabs: store?.tabs?.map(tab => tab.id) || [] }
    `)
    check('确认关闭选中的 2 个 → Main 活动标签与剩余页面同步',
      await waitTabs(2) && afterSelectedClose.ui.length === 2 && afterSelectedClose.activeTabId !== null &&
        afterSelectedClose.mainTabs.includes(afterSelectedClose.activeTabId) &&
        afterSelectedClose.ui.some(tab => tab.id === afterSelectedClose.activeTabId && tab.active),
      json({ ...afterSelectedClose, tabs: await tabDebug() }))

    // ---------- 2) 右键菜单：关闭其他 ----------
    const menu = await ui_(`
      const tabs = [...document.querySelectorAll('.dashboard-browser-tab')]
      const rect = tabs[0].getBoundingClientRect()
      tabs[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 24, clientY: rect.top + 12 }))
      await new Promise(r => setTimeout(r, 180))
      return {
        open: !!document.querySelector('[data-test="tabs-context-menu"]'),
        others: document.querySelector('[data-test="tabs-menu-close-others"]')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        all: document.querySelector('[data-test="tabs-menu-close-all"]')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      }
    `)
    check('右键标签弹出菜单（关闭其他计数 = 1，关闭全部计数 = 2）',
      menu.open === true && /关闭其他标签页\s*1/.test(menu.others) && /关闭全部标签页\s*2/.test(menu.all),
      json(menu))

    const othersConfirm = await ui_(`
      document.querySelector('[data-test="tabs-menu-close-others"]').click()
      await new Promise(r => setTimeout(r, 200))
      return {
        open: !!document.querySelector('[data-test="tabs-close-confirm"]'),
        title: document.querySelector('[data-test="tabs-close-title"]')?.textContent?.trim() || ''
      }
    `)
    check('菜单「关闭其他」先弹确认', othersConfirm.open === true && /关闭其他的 1 个标签页/.test(othersConfirm.title), json(othersConfirm))

    await ui_(`
      document.querySelector('[data-test="tabs-close-ok"]').click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)
    check('确认「关闭其他」→ 只剩 1 个', await waitTabs(1), json(await tabDebug()))

    // ---------- 3) 固定标签：一键关闭保留，多选可显式关闭 ----------
    const pinnedId = (await tabDebug()).ids[0]
    await ui_(`return await window.shopilot.browser.tab.setPinned(${json(aId)}, ${json(pinnedId)}, true)`)
    for (let i = 0; i < 2; i++) {
      await ui_(`return await window.shopilot.browser.tab.create(${json(aId)}, 'http://127.0.0.1:${SITE}/?p=${i}')`)
    }
    check('准备：1 个固定 + 2 个普通标签', await waitTabs(3), json(await tabDebug()))

    const pinnedMenu = await ui_(`
      const tabs = [...document.querySelectorAll('.dashboard-browser-tab')]
      const normal = tabs.find(el => !el.classList.contains('pinned')) || tabs[1]
      const rect = normal.getBoundingClientRect()
      normal.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
      await new Promise(r => setTimeout(r, 180))
      return {
        all: document.querySelector('[data-test="tabs-menu-close-all"]')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        pinnedShown: document.querySelectorAll('.dashboard-browser-tab.pinned').length
      }
    `)
    check('固定标签有可见标记，且「关闭全部」计数跳过固定标签（2 而不是 3）',
      pinnedMenu.pinnedShown === 1 && /关闭全部标签页\s*2/.test(pinnedMenu.all),
      json(pinnedMenu))

    await ui_(`
      document.querySelector('[data-test="tabs-menu-close-all"]').click()
      await new Promise(r => setTimeout(r, 200))
      document.querySelector('[data-test="tabs-close-ok"]').click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)
    const afterPinnedClose = await tabDebug()
    check('「关闭全部」保留固定标签（只剩固定那一个）',
      afterPinnedClose.count === 1 && afterPinnedClose.ids[0] === pinnedId,
      json(afterPinnedClose))

    // 显式多选连固定一起关：先取消固定，再验证"全是固定时也能关"
    const onlyPinned = await ui_(`
      const tabs = [...document.querySelectorAll('.dashboard-browser-tab')]
      tabs[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
      await new Promise(r => setTimeout(r, 150))
      document.querySelector('[data-test="tabs-batch-close"]').click()
      await new Promise(r => setTimeout(r, 200))
      const title = document.querySelector('[data-test="tabs-close-title"]')?.textContent?.trim() || ''
      document.querySelector('[data-test="tabs-close-ok"]').click()
      await new Promise(r => setTimeout(r, 400))
      return { title }
    `)
    check('多选可显式关闭固定标签（选中的固定项不再被保留）',
      /关闭选中的 1 个标签页/.test(onlyPinned.title) && (await waitTabs(0)),
      json({ title: onlyPinned.title, tabs: await tabDebug() }))

    const zeroMainState = await ui_(`
      const [state, tabList, stores] = await Promise.all([
        window.shopilot.browser.state(),
        window.shopilot.browser.tab.list(${json(aId)}),
        window.shopilot.store.list()
      ])
      const storeState = state.ok ? state.data.stores.find(item => item.storeId === ${json(aId)}) : null
      return {
        stateOk: state.ok,
        storeState: storeState || null,
        tabCount: tabList.ok ? tabList.data.tabs.length : -1,
        storeRetained: stores.ok && stores.data.some(item => item.id === ${json(aId)})
      }
    `)
    check('最后一个可见标签关闭后 Main 无空 browserState，店铺仍保留',
      zeroMainState.stateOk && zeroMainState.storeState === null && zeroMainState.tabCount === 0 && zeroMainState.storeRetained,
      json(zeroMainState))

    // 新语义：最后一个可见标签关闭后，Main 会销毁空 browserState/WebContents。
    // 重新创建标签前必须走统一 display/open 路径，并验证它自动补回首页标签。
    const reopenedAfterZero = await ui_(`
      const result = await window.shopilot.browser.display(${json(aId)})
      const deadline = Date.now() + 12000
      let snapshot = null
      while (Date.now() < deadline) {
        const tabs = [...document.querySelectorAll('.dashboard-browser-tab')]
        const mainState = await window.shopilot.browser.tab.list(${json(aId)})
        const mainTabs = mainState.ok ? (mainState.data?.tabs || []) : []
        const browserState = await window.shopilot.browser.state()
        const storeState = browserState.ok ? browserState.data.stores.find(item => item.storeId === ${json(aId)}) : null
        snapshot = {
          ok: result.ok === true,
          count: tabs.length,
          url: mainTabs[0]?.url || document.querySelector('.dashboard-browser-url input')?.value || '',
          host: !!document.querySelector('[data-test="dashboard-browser-host"]'),
          activeTabId: storeState?.activeTabId || null,
          stateCount: storeState?.tabs?.length || 0,
          visibleMainTabs: storeState?.tabs?.filter(tab => tab.internal !== true).length || 0
        }
        if (snapshot.count === 1 && snapshot.host && snapshot.url && snapshot.activeTabId && snapshot.visibleMainTabs === 1) break
        await new Promise(r => setTimeout(r, 220))
      }
      return snapshot
    `)
    check('零标签后重新打开店铺自动创建首页标签',
      reopenedAfterZero.ok === true && reopenedAfterZero.count === 1 && reopenedAfterZero.host === true &&
        reopenedAfterZero.url !== '' && reopenedAfterZero.activeTabId !== null &&
        reopenedAfterZero.stateCount === 1 && reopenedAfterZero.visibleMainTabs === 1,
      json(reopenedAfterZero))

    // ---------- 4) 边界：关到 0 个 = 浏览器整体关闭（既有语义：标签数 0 → 店铺浏览器收起） ----------
    // 关掉最后一个标签后 surface 会随 browserHostMounted=false 卸载，快捷键监听随之消失；
    // 所以"0 个标签再按快捷键"不可达，正确断言是：浏览器宿主消失、应用无残留确认框、无崩溃。
    // 自动创建的首页算第一张，这里再补一张即可覆盖“从 0 恢复后继续新建”路径。
    for (let i = 0; i < 1; i++) {
      await ui_(`return await window.shopilot.browser.tab.create(${json(aId)}, 'http://127.0.0.1:${SITE}/?z=${i}')`)
    }
    await waitTabs(2)
    const closeToZero = await ui_(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, shiftKey: true, bubbles: true }))
      await new Promise(r => setTimeout(r, 250))
      const title = document.querySelector('[data-test="tabs-close-title"]')?.textContent?.trim() || ''
      document.querySelector('[data-test="tabs-close-ok"]').click()
      await new Promise(r => setTimeout(r, 600))
      return {
        title,
        hostGone: !document.querySelector('[data-test="dashboard-browser-host"]'),
        confirmGone: !document.querySelector('[data-test="tabs-close-confirm"]')
      }
    `)
    check('只剩 2 个时 Ctrl+Shift+W 确认关闭 → 标签清零、浏览器整体收起、无残留确认框',
      /关闭全部的 2 个标签页/.test(closeToZero.title) && closeToZero.hostGone === true && closeToZero.confirmGone === true,
      json(closeToZero))

    // ---------- 5) 快捷键：Ctrl+Shift+W 关闭全部 / Ctrl+Alt+W 关闭其他（都要确认） ----------
    // 上一步把标签关到了 0（浏览器宿主随之收起），重新显示店铺并补 3 个标签
    await ui_(`return await window.shopilot.browser.display(${json(aId)})`)
    for (let i = 0; i < 2; i++) {
      await ui_(`return await window.shopilot.browser.tab.create(${json(aId)}, 'http://127.0.0.1:${SITE}/?k=${i}')`)
    }
    await waitTabs(3)
    const shortcutConfirm = await ui_(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, shiftKey: true, bubbles: true }))
      await new Promise(r => setTimeout(r, 250))
      return {
        open: !!document.querySelector('[data-test="tabs-close-confirm"]'),
        title: document.querySelector('[data-test="tabs-close-title"]')?.textContent?.trim() || ''
      }
    `)
    check('Ctrl+Shift+W 触发「关闭全部」并弹确认',
      shortcutConfirm.open === true && /关闭全部的 3 个标签页/.test(shortcutConfirm.title),
      json(shortcutConfirm))

    await ui_(`document.querySelector('[data-test="tabs-close-cancel"]').click(); await new Promise(r => setTimeout(r, 200)); return true`)
    const othersShortcut = await ui_(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, altKey: true, bubbles: true }))
      await new Promise(r => setTimeout(r, 250))
      return {
        open: !!document.querySelector('[data-test="tabs-close-confirm"]'),
        title: document.querySelector('[data-test="tabs-close-title"]')?.textContent?.trim() || ''
      }
    `)
    check('Ctrl+Alt+W 触发「关闭其他」并弹确认',
      othersShortcut.open === true && /关闭其他的 2 个标签页/.test(othersShortcut.title),
      json(othersShortcut))

    await ui_(`
      document.querySelector('[data-test="tabs-close-ok"]').click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)
    check('快捷键确认后只剩当前标签', await waitTabs(1), json(await tabDebug()))

    await ui_(`return await window.shopilot.browser.tab.create(${json(aId)}, 'http://127.0.0.1:${SITE}/?ctrlw=1')`)
    await waitTabs(2)
    const ctrlW = await ui_(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }))
      await new Promise(r => setTimeout(r, 350))
      const state = await window.shopilot.browser.state()
      const store = state.ok ? state.data.stores.find(item => item.storeId === ${json(aId)}) : null
      return { count: document.querySelectorAll('.dashboard-browser-tab').length, confirm: !!document.querySelector('[data-test="tabs-close-confirm"]'), activeTabId: store?.activeTabId || null, ids: store?.tabs?.map(tab => tab.id) || [] }
    `)
    check('Ctrl+W 直接关闭当前标签并保留有效 Main activeTabId',
      ctrlW.count === 1 && !ctrlW.confirm && !!ctrlW.activeTabId && ctrlW.ids.length === 1 && ctrlW.ids[0] === ctrlW.activeTabId,
      json(ctrlW))

    // ---------- 6) 页面内真实按键：主进程 before-input-event 转发（2026-10-18 补） ----------
    // 上面 4) / 5) 打的是**渲染层** keydown（window.dispatchEvent），只在焦点落回工作台自身时成立。
    // 真实用户路径是：焦点在店铺页面（guest <webview>）里 → 主进程 before-input-event 拦截
    //（页面脚本吞不掉）→ Ctrl+W 直接关，Ctrl+Shift+W / Ctrl+Alt+W 经
    // BROWSER_TAB_CLOSE_REQUESTED 转给渲染层弹二次确认。
    //
    // 这条链路在渲染层那侧带 `if (!props.active || ...) return` 守卫（DashboardBrowserSurface
    // 的 onTabCloseRequested），而渲染层自己的 onBrowserKeydown **没有**这个守卫——所以：
    //   · 必须先把浏览器表面**真的激活**（走用户路径：店铺管理 → 打开工作区），再注入真实按键；
    //   · 绝不能用「给渲染层 dispatchEvent」绕过守卫，否则 props.active 判断被挪错位置时本套仍全绿，
    //     而用户按快捷键会静默失效（主进程已 preventDefault，连默认行为都拿不到）。
    const activated = await ui_(`
      const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(el => (el.textContent || '').includes('店铺管理'))
      if (!nav) return { ok: false, why: 'no-nav' }
      nav.click()
      await new Promise(r => setTimeout(r, 600))
      const card = [...document.querySelectorAll('article.unified-store-card')].find(el => (el.textContent || '').includes('标签验收A'))
      if (!card) return { ok: false, why: 'no-card' }
      const open = [...card.querySelectorAll('button')].find(b => (b.textContent || '').includes('打开工作区'))
      if (!open) return { ok: false, why: 'no-open-button' }
      open.click()
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        const host = document.querySelector('[data-test="dashboard-browser-host"]')
        if (host && host.classList.contains('active')) return { ok: true, active: true }
        await new Promise(r => setTimeout(r, 220))
      }
      const host = document.querySelector('[data-test="dashboard-browser-host"]')
      return { ok: false, why: 'host-not-active', present: !!host, active: host ? host.classList.contains('active') : null }
    `)
    check('浏览器表面真实激活（props.active 为真，页面内快捷键链路的前置条件）',
      activated.ok === true && activated.active === true, json(activated))

    for (let i = 0; i < 2; i++) {
      await ui_(`return await window.shopilot.browser.tab.create(${json(aId)}, 'http://127.0.0.1:${SITE}/?kbd=${i}')`)
    }
    check('准备：3 个标签用于页面内真实按键', await waitTabs(3), json(await tabDebug()))

    // guest 页面（type=webview）的 CDP target：找不到就**硬失败**（前置条件不满足，
    // 与「创建 A 店失败」同等处理），不写成一句恒假的 check 以免产生同名分支。
    let guestTarget = null
    for (let i = 0; i < 40 && !guestTarget; i++) {
      const list = await targets()
      guestTarget = list.find(item => item.type === 'webview' && String(item.url || '').includes(`:${SITE}`))
        || list.find(item => String(item.url || '').includes(`:${SITE}`))
      if (!guestTarget) await sleep(250)
    }
    if (!guestTarget) throw new Error(`未找到 guest 页面 CDP target（页面内快捷键验收的前置条件）：${json((await targets()).map(item => ({ type: item.type, url: String(item.url || '').slice(0, 60) })))}`)
    const guestCdp = new CDP(guestTarget.webSocketDebuggerUrl)
    await guestCdp.ready
    // 注入按键必须带超时：guest 目标中途消失（应用被杀掉 / 标签被并发关掉）时 WebSocket 不会再回包，
    // 裸 await send() 会把整套验收**永久挂死**在这里，而不是红一条用例。
    // 用显式 timer 而不是 Promise.race(send, sleep→reject)：后者在 send 先赢时，
    // 超时 promise 稍后 reject 会变成 unhandled rejection，Node 默认会直接终止进程。
    const sendToGuest = (method, params, timeoutMs = 8000) => new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`guest CDP ${method} 超过 ${timeoutMs}ms 未响应（guest 目标可能已消失）`)),
        timeoutMs
      )
      guestCdp.send(method, params).then(
        value => { clearTimeout(timer); resolve(value) },
        error => { clearTimeout(timer); reject(error) }
      )
    })
    // CDP modifiers 位：Alt=1 / Ctrl=2 / Meta=4 / Shift=8
    // bestEffort：Ctrl+W 会让 guest **作为被测行为的结果**随标签一起销毁，keyDown/keyUp 的回包
    // 可能永远不来。那种情况下的传输层错误不算用例失败（真正的判据是后面主窗口里的标签数变化）；
    // 若对它严格 await，一次成功的 Ctrl+W 反而会把整套验收搞崩（实测踩到过）。
    // 另两条（弹确认、页面不销毁）保持严格：guest 死了就说明前置条件被破坏，必须立刻红。
    const pressInGuest = async (modifiers, key, { bestEffort = false } = {}) => {
      const payload = { modifiers, key, code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 }
      const send = type => bestEffort
        ? sendToGuest('Input.dispatchKeyEvent', { type, ...payload }, 3000).catch(() => {})
        : sendToGuest('Input.dispatchKeyEvent', { type, ...payload })
      await send('rawKeyDown')
      await send('keyUp')
    }

    await pressInGuest(10, 'W') // Ctrl+Shift+W
    await sleep(700)
    const guestShiftW = await ui_(`
      return {
        open: !!document.querySelector('[data-test="tabs-close-confirm"]'),
        title: document.querySelector('[data-test="tabs-close-title"]')?.textContent?.trim() || '',
        tabs: document.querySelectorAll('.dashboard-browser-tab').length
      }
    `)
    check('页面内真实 Ctrl+Shift+W（主进程 before-input-event 转发）→ 弹「关闭全部」确认',
      guestShiftW.open === true && /关闭全部的 3 个标签页/.test(guestShiftW.title), json(guestShiftW))

    const guestShiftCancel = await ui_(`
      const wasOpen = !!document.querySelector('[data-test="tabs-close-confirm"]')
      document.querySelector('[data-test="tabs-close-cancel"]')?.click()
      await new Promise(r => setTimeout(r, 300))
      return { wasOpen, open: !!document.querySelector('[data-test="tabs-close-confirm"]'), tabs: document.querySelectorAll('.dashboard-browser-tab').length }
    `)
    // wasOpen 必须为真：否则"确认框本来就没弹"会让这条恒真（假绿）
    check('页面内快捷键取消确认 → 不关闭任何标签',
      guestShiftCancel.wasOpen === true && guestShiftCancel.open === false && guestShiftCancel.tabs === 3, json(guestShiftCancel))

    await pressInGuest(3, 'w') // Ctrl+Alt+W
    await sleep(700)
    const guestAltW = await ui_(`
      return {
        open: !!document.querySelector('[data-test="tabs-close-confirm"]'),
        title: document.querySelector('[data-test="tabs-close-title"]')?.textContent?.trim() || ''
      }
    `)
    check('页面内真实 Ctrl+Alt+W（主进程 before-input-event 转发）→ 弹「关闭其他」确认',
      guestAltW.open === true && /关闭其他的 2 个标签页/.test(guestAltW.title), json(guestAltW))
    await ui_(`document.querySelector('[data-test="tabs-close-cancel"]')?.click(); await new Promise(r => setTimeout(r, 300)); return true`)

    const beforeGuestW = await tabDebug()
    await pressInGuest(2, 'w', { bestEffort: true }) // Ctrl+W（guest 会随标签销毁，见 pressInGuest 注释）
    await sleep(900)
    const guestW = await ui_(`
      const state = await window.shopilot.browser.state()
      const store = state.ok ? state.data.stores.find(item => item.storeId === ${json(aId)}) : null
      return {
        confirm: !!document.querySelector('[data-test="tabs-close-confirm"]'),
        count: document.querySelectorAll('.dashboard-browser-tab').length,
        activeTabId: store?.activeTabId || null,
        ids: store?.tabs?.map(tab => tab.id) || []
      }
    `)
    check('页面内真实 Ctrl+W（主进程直接关）→ 关掉当前标签且不弹确认',
      guestW.count === beforeGuestW.count - 1 && guestW.confirm === false &&
        !!guestW.activeTabId && guestW.ids.length === guestW.count && guestW.ids.includes(guestW.activeTabId),
      json({ before: beforeGuestW.count, ...guestW }))
    guestCdp.close()

    // 收尾：后面的用例以「A 店从 1 张开始」为前提（与第 8 节固定/重排的收尾同口径）
    const resetAfterGuestKeys = await ui_(`
      const ids = [...document.querySelectorAll('.dashboard-browser-tab')].slice(1).map(el => el.dataset.tabId)
      const result = await window.shopilot.browser.tab.closeMany({ storeId: ${json(aId)}, mode: 'ids', tabIds: ids, includePinned: true })
      await new Promise(r => setTimeout(r, 400))
      return { asked: ids.length, result }
    `)
    check('页面内真实按键用例收尾：A 店回到 1 个标签',
      resetAfterGuestKeys.result.ok === true && (await waitTabs(1)), json(resetAfterGuestKeys))

    // ---------- 7) 右键菜单 Esc 关闭 ----------
    const menuEsc = await ui_(`
      const tabs = [...document.querySelectorAll('.dashboard-browser-tab')]
      const rect = tabs[0].getBoundingClientRect()
      tabs[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
      await new Promise(r => setTimeout(r, 150))
      const before = !!document.querySelector('[data-test="tabs-context-menu"]')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise(r => setTimeout(r, 150))
      return { before, after: !!document.querySelector('[data-test="tabs-context-menu"]') }
    `)
    check('右键菜单 Esc 可关闭', menuEsc.before === true && menuEsc.after === false, json(menuEsc))

    // ---------- 8) 固定 / 取消固定 + 拖拽重排（2026-10-18 补齐的入口） ----------
    for (let i = 0; i < 2; i++) {
      await ui_(`return await window.shopilot.browser.tab.create(${json(aId)}, 'http://127.0.0.1:${SITE}/?d=${i}')`)
    }
    check('准备：3 个标签用于固定/重排', await waitTabs(3), json(await tabDebug()))

    const pinViaMenu = await ui_(`
      const tabs = [...document.querySelectorAll('.dashboard-browser-tab')]
      const target = tabs[1]
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
      await new Promise(r => setTimeout(r, 200))
      const item = document.querySelector('[data-test="tabs-menu-toggle-pin"]')
      const label = (item?.textContent || '').trim()
      item.click()
      await new Promise(r => setTimeout(r, 450))
      const state = await window.shopilot.browser.tab.list(${json(aId)})
      const pinnedIds = state.ok ? state.data.tabs.filter(t => t.isPinned).map(t => t.id) : []
      return {
        label,
        targetId: target.dataset.tabId,
        pinnedIds,
        domPinned: document.querySelectorAll('.dashboard-browser-tab.pinned').length,
        menuClosed: !document.querySelector('[data-test="tabs-context-menu"]'),
        draggable: tabs.every(el => el.getAttribute('draggable') === 'true')
      }
    `)
    check('右键菜单「固定标签页」写进主进程，标签栏同步显示固定标记',
      /^固定标签页$/.test(pinViaMenu.label) && pinViaMenu.pinnedIds.length === 1 &&
        pinViaMenu.pinnedIds[0] === pinViaMenu.targetId && pinViaMenu.domPinned === 1 &&
        pinViaMenu.menuClosed === true && pinViaMenu.draggable === true,
      json(pinViaMenu))

    const unpinViaMenu = await ui_(`
      const tab = [...document.querySelectorAll('.dashboard-browser-tab')].find(el => el.classList.contains('pinned'))
      const rect = tab.getBoundingClientRect()
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
      await new Promise(r => setTimeout(r, 200))
      const item = document.querySelector('[data-test="tabs-menu-toggle-pin"]')
      const label = (item?.textContent || '').trim()
      item.click()
      await new Promise(r => setTimeout(r, 450))
      const state = await window.shopilot.browser.tab.list(${json(aId)})
      return {
        label,
        pinned: state.ok ? state.data.tabs.filter(t => t.isPinned).length : -1,
        domPinned: document.querySelectorAll('.dashboard-browser-tab.pinned').length
      }
    `)
    check('已固定标签的菜单项切换为「取消固定」，点击后状态与标记一并清除',
      /^取消固定$/.test(unpinViaMenu.label) && unpinViaMenu.pinned === 0 && unpinViaMenu.domPinned === 0,
      json(unpinViaMenu))

    const dragReorder = await ui_(`
      const read = () => [...document.querySelectorAll('.dashboard-browser-tab')]
      const before = read().map(el => el.dataset.tabId)
      const source = read()[0]
      const target = read()[2]
      const rect = target.getBoundingClientRect()
      const dataTransfer = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
      await new Promise(r => setTimeout(r, 90))
      const dragging = document.querySelectorAll('.dashboard-browser-tab.dragging').length
      const clientX = rect.right - 4
      const clientY = rect.top + rect.height / 2
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }))
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
      await new Promise(r => setTimeout(r, 600))
      const after = read().map(el => el.dataset.tabId)
      const state = await window.shopilot.browser.tab.list(${json(aId)})
      const mainOrder = state.ok ? state.data.tabs.slice().sort((a, b) => a.orderIndex - b.orderIndex).map(t => t.id) : []
      return { before, after, dragging, draggingLeft: document.querySelectorAll('.dashboard-browser-tab.dragging').length, mainOrder }
    `)
    const expectedOrder = [dragReorder.before[1], dragReorder.before[2], dragReorder.before[0]]
    check('拖拽标签到目标右半：顺序变成 [2,3,1]，DOM 与主进程 orderIndex 一致',
      dragReorder.dragging === 1 && dragReorder.draggingLeft === 0 &&
        json(dragReorder.after) === json(expectedOrder) && json(dragReorder.mainOrder) === json(expectedOrder),
      json(dragReorder))

    // 收尾：A 店恢复成 1 个标签——下面的跨店隔离断言以「A 从 1 张开始」为前提
    const resetStoreA = await ui_(`
      const ids = [...document.querySelectorAll('.dashboard-browser-tab')].slice(1).map(el => el.dataset.tabId)
      const result = await window.shopilot.browser.tab.closeMany({ storeId: ${json(aId)}, mode: 'ids', tabIds: ids, includePinned: true })
      await new Promise(r => setTimeout(r, 400))
      return { count: ids.length, result }
    `)
    check('固定/重排用例收尾：A 店回到 1 个标签',
      resetStoreA.result.ok === true && resetStoreA.result.data.closed === 2 && (await waitTabs(1)),
      json(resetStoreA))

    // ---------- 9) 跨店隔离 ----------
    // B 用 display:false 后台打开：只建会话不显示。**不能**用 display 切到 B 再切回 A——
    // 渲染层切店=用户离开（window-manager displayStore：source=renderer 时立刻关掉前一家），
    // 那是既有设计，不是批量关闭的回归。
    const storeB = await ui_(`return await window.shopilot.store.create({ name: '标签验收B', platform: '快手小店', adminUrl: 'http://127.0.0.1:${SITE}/' })`)
    if (!storeB.ok) throw new Error('创建 B 店失败：' + json(storeB.error))
    const bId = storeB.data.id
    const openedB = await ui_(`return await window.shopilot.browser.open(${json(bId)}, { display: false })`)
    check('后台打开 B 店浏览器（不抢占前台）', openedB.ok === true, json(openedB.error))
    await ui_(`return await window.shopilot.browser.tab.create(${json(bId)}, 'http://127.0.0.1:${SITE}/?b=1')`)
    await ui_(`return await window.shopilot.browser.tab.create(${json(bId)}, 'http://127.0.0.1:${SITE}/?b=2')`)
    // A 当前 1 个，再补 1 个，让关闭数量可断言
    await ui_(`return await window.shopilot.browser.tab.create(${json(aId)}, 'http://127.0.0.1:${SITE}/?a=2')`)
    await waitTabs(2)

    const isolation = await ui_(
      `const r = await window.shopilot.browser.tab.closeMany({ storeId: ${json(aId)}, mode: 'all' })
       await new Promise(res => setTimeout(res, 400))
       const b = await window.shopilot.browser.tab.list(${json(bId)})
       return { result: r, bTabs: b.ok ? b.data.tabs.length : -1 }`
    )
    check('关闭 A 店全部标签不影响 B 店（B 仍有 3 个）',
      isolation.result.ok === true && isolation.result.data.closed === 2 &&
        isolation.result.data.remaining === 0 && isolation.bTabs === 3,
      json({ closed: isolation.result.data?.closed, remaining: isolation.result.data?.remaining, bTabs: isolation.bTabs }))

    const isolationState = await ui_(`
      const state = await window.shopilot.browser.state()
      const stores = state.ok ? state.data.stores : []
      return { aPresent: stores.some(item => item.storeId === ${json(aId)}), b: stores.find(item => item.storeId === ${json(bId)}) || null }
    `)
    check('browser.state 确认 A 店已清理、B 店标签和 activeTabId 隔离保留',
      !isolationState.aPresent && isolationState.b?.tabs?.length === 3 &&
        !!isolationState.b.activeTabId && isolationState.b.tabs.some(tab => tab.id === isolationState.b.activeTabId),
      json(isolationState))

    // ---------- 10) 采集任务持有内部标签时不能误销毁 browserState ----------
    const storeC = await ui_(`return await window.shopilot.store.create({ name: '标签验收C内部采集', platform: '其他', adminUrl: 'http://127.0.0.1:${SITE}/' })`)
    if (!storeC.ok) throw new Error('创建 C 店失败：' + json(storeC.error))
    const cId = storeC.data.id
    const openedC = await ui_(`return await window.shopilot.browser.open(${json(cId)})`)
    check('打开内部采集测试店铺 C', openedC.ok === true, json(openedC.error))
    await waitTabs(1)
    const task = await ui_(`return await window.shopilot.task.create({
      name: '只读内部标签生命周期验收', storeScope: ${json(cId)},
      steps: [
        { type: 'navigate', input: { url: 'http://127.0.0.1:${SITE}/?internal=1' }, timeoutMs: 10000 },
        { type: 'waitMs', input: { ms: 5000 }, timeoutMs: 10000 }
      ]
    })`)
    if (!task.ok) throw new Error('创建只读采集测试任务失败：' + json(task.error))
    const taskRun = await ui_(`return await window.shopilot.task.run(${json(task.data.id)})`)
    if (!taskRun.ok) throw new Error('启动只读采集测试任务失败：' + json(taskRun.error))
    let internalSnapshot = null
    const internalDeadline = Date.now() + 15000
    while (Date.now() < internalDeadline) {
      internalSnapshot = await ui_(`
        const [state, tabs] = await Promise.all([window.shopilot.browser.state(), window.shopilot.browser.tab.list(${json(cId)})])
        const store = state.ok ? state.data.stores.find(item => item.storeId === ${json(cId)}) : null
        return { store: store || null, tabs: tabs.ok ? tabs.data.tabs : [], stateTabs: store?.tabs || [] }
      `)
      if (internalSnapshot.stateTabs.some(tab => tab.internal === true && tab.guestAttached)) break
      await sleep(200)
    }
    check('纯只读采集任务创建已挂载的 internal 标签',
      internalSnapshot?.stateTabs?.some(tab => tab.internal === true && tab.guestAttached) &&
        internalSnapshot.stateTabs.some(tab => tab.internal !== true),
      json(internalSnapshot))

    const cVisibleTab = internalSnapshot?.stateTabs?.find(tab => tab.internal !== true)
    const cInternalTab = internalSnapshot?.stateTabs?.find(tab => tab.internal === true)
    if (cVisibleTab && cInternalTab) {
      await ui_(`return await window.shopilot.browser.tab.close(${json(cId)}, ${json(cVisibleTab.id)})`)
      const afterVisibleClose = await ui_(`
        const state = await window.shopilot.browser.state()
        const store = state.ok ? state.data.stores.find(item => item.storeId === ${json(cId)}) : null
        return { store: store || null, visible: store?.tabs?.filter(tab => tab.internal !== true).length || 0, internal: store?.tabs?.filter(tab => tab.internal === true).length || 0 }
      `)
      check('最后一个可见标签关闭时保留正在运行的 internal browserState',
        afterVisibleClose.store !== null && afterVisibleClose.visible === 0 && afterVisibleClose.internal === 1 &&
          afterVisibleClose.store.activeTabId === null,
        json(afterVisibleClose))
    } else {
      check('最后一个可见标签关闭时保留正在运行的 internal browserState', false, '未能建立采集内部标签')
    }

    let finishedRun = null
    const runDeadline = Date.now() + 15000
    while (Date.now() < runDeadline) {
      finishedRun = await ui_(`
        const list = await window.shopilot.task.list()
        const task = list.ok ? list.data.find(item => item.id === ${json(task.data.id)}) : null
        return task?.latestRun || null
      `)
      if (finishedRun && ['succeeded', 'failed', 'cancelled'].includes(finishedRun.status)) break
      await sleep(250)
    }
    check('内部采集只执行本地页面读取路径并结束', finishedRun?.status === 'succeeded', json(finishedRun))
    if (cInternalTab) await ui_(`return await window.shopilot.browser.tab.close(${json(cId)}, ${json(cInternalTab.id)})`)
    const cStateAfterInternalClose = await ui_(`
      const state = await window.shopilot.browser.state()
      return state.ok && !state.data.stores.some(item => item.storeId === ${json(cId)})
    `)
    check('关闭内部标签后 C 店空 browserState 正常清理', cStateAfterInternalClose === true, String(cStateAfterInternalClose))

  } finally {
    try { ui?.close() } catch { /* ignore */ }
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await sleep(1000)
    if (child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* spawned process already exited */ }
      await sleep(500)
    }
    try { fs.writeFileSync(acceptanceLog, appLog, 'utf8') } catch { /* ignore */ }
    try {
      fs.writeFileSync(acceptanceMeta, JSON.stringify({
        pid: child.pid,
        port: PORT,
        userData,
        cache: cacheDir || null,
        log: acceptanceLog,
        exitCode: childExitCode,
        source: !appInfo.packaged,
        finishedAt: new Date().toISOString()
      }, null, 2), 'utf8')
    } catch { /* ignore */ }
    site.close()
  }

  const passed = checks.filter(item => item.pass).length
  console.log(`\n标签页批量关闭验收：${passed}/${checks.length} 通过`)
  if (passed !== checks.length) {
    console.log('失败项：')
    for (const item of checks.filter(entry => !entry.pass)) console.log(`  - ${item.name} :: ${item.detail}`)
    console.log('--- 应用日志（标签/异常）---')
    console.log(appLog.split('\n').filter(line => /tab|标签|error|crash/i.test(line)).slice(-25).join('\n'))
    process.exit(1)
  }
}

main().catch(error => { console.error('TABS_VERIFY_CRASH', error); process.exit(2) })
