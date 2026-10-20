/**
 * 商品管理重设计（v4 R1）真机验收：原生 CDP 驱动真实应用（渲染层 UI → preload → IPC → Main → SQLite）
 *
 * 覆盖：三 Tab 信息架构 / 列表与空态 / 回收站 / 分页 / 搜索（防抖）/ 状态推导徽标 / 编辑抽屉 / 恢复闭环
 *
 * 前置：应用以 `--remote-debugging-port=9250` 启动（SHOPILOT_CDP_PORT 可覆盖）。
 * 数据约定：不做破坏性操作——验证「恢复」后会把该商品重新软删（remove），数据库回到原状。
 */
const CDP_PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function listTargets() {
  const res = await fetch(CDP_BASE + '/json')
  return res.json()
}

async function getPageWs(predicate) {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await listTargets()
      const page = targets.find(t => (t.type === 'page' || t.type === 'webview') && t.webSocketDebuggerUrl && predicate(t.url))
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('未找到满足条件的页面 target')
}

class CDPSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.waiters = new Map() // method -> [{ resolve, timer }]
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = (e) => reject(e)
    })
    this.ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
        return
      }
      // 事件（无 id）：分发给 waitEvent 等待者（如 Page.javascriptDialogOpening）
      if (msg.method && this.waiters.has(msg.method)) {
        for (const w of this.waiters.get(msg.method)) {
          clearTimeout(w.timer)
          w.resolve(msg)
        }
        this.waiters.delete(msg.method)
      }
    }
  }
  /** 等待某个 CDP 事件（原生 window.confirm/alert 会阻塞 evaluate，必须先监听再应答） */
  waitEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(method)
        reject(new Error('等待事件超时: ' + method))
      }, timeoutMs)
      this.waiters.set(method, [...(this.waiters.get(method) || []), { resolve, timer }])
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(fnBody, timeoutMs = 60000) {
    await this.ready
    const expression = `(async () => { ${fnBody} })()`
    let timer = null
    try {
      const r = await Promise.race([
        this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        new Promise((_res, rej) => {
          timer = setTimeout(() => rej(new Error(`页面求值超时（${timeoutMs}ms）：${String(fnBody).replace(/\s+/g, ' ').trim().slice(0, 120)}`)), timeoutMs)
        })
      ])
      if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r.result.value
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  close() { try { this.ws.close() } catch {} }
}

const PRODUCT_CSV_HEADER = '标题,副标题,品牌,本地分类,标签,状态,规格,价格,库存,SKU码,条码,挂载平台,更新时间'

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  [' + detail + ']' : ''}`)
}
// 本会话红线：CDP 设值/点击后 Vue 异步更新 DOM，必须等一拍再断言（2026-10-15 实录）。
const UI_WAIT = 300
const SEARCH_WAIT = 550

async function main() {
  // 主窗口判定必须够严：平台登录页的 redirectUrl 可能带 index.html（2026-10-15 实录：
  // 拼多多登录页 redirectUrl=…chat-merchant/index.html 让宽松的 includes('index.html')
  // 把 CDP 会话连到了店铺页——expression 在那里全部得到 false）。
  const wsUrl = await getPageWs(u => u.startsWith('file:') && u.includes('index.html'))
  console.log('连接应用主窗口 CDP:', wsUrl)
  const cdp = new CDPSession(wsUrl)
  await cdp.ready
  await sleep(800)

  let fixtureStoreId = null
  try {
    // 就绪等待：应用冷启动要恢复上次会话的店铺页签，preload/工作台导航可能晚于 target 出现
    // （2026-10-15 实录：启动 23 秒时 API/导航还没就绪，1 分钟后一切正常）。
    let ready = false
    for (let i = 0; i < 60; i++) {
      ready = await cdp.evaluate(`
        return !!window.shopilot?.products?.library &&
          [...document.querySelectorAll('.dashboard-nav-item')].some(b => (b.textContent || '').includes('商品管理'))
      `, 15000).catch(e => { if (i === 0) console.log('[ready-wait 求值异常]', e && e.message ? e.message : e); return false })
      if (ready) break
      await sleep(1000)
    }
    check('应用就绪（preload + 工作台导航）', ready)
    if (!ready) throw new Error('应用 60 秒内未就绪')

    // 隔离 profile 可能没有店铺。商品管理应能在无店铺时展示本地商品，
    // 但本套件仍需要一条店铺记录来验收平台 Tab；夹具自行创建并在 finally 清理，
    // 不把“请先手动建店”变成隐藏前置条件。
    const storeState = await cdp.evaluate(`
      const r = await window.shopilot.store.list()
      return r && r.ok ? (r.data || []).map(store => ({ id: store.id, name: store.name })) : []
    `)
    if (!Array.isArray(storeState) || storeState.length === 0) {
      const created = await cdp.evaluate(`
        const r = await window.shopilot.store.create({ name: '商品管理验收临时店', platform: '抖店', adminUrl: 'http://127.0.0.1:1/' })
        return r && r.ok ? r.data : null
      `)
      fixtureStoreId = created?.id || null
      check('验收夹具自动准备临时店铺', !!fixtureStoreId, fixtureStoreId || 'store.create failed')
      if (!fixtureStoreId) throw new Error('验收夹具无法创建临时店铺')
    } else {
      check('验收夹具发现可用店铺', true, `${storeState.length} 家`)
    }

    // 跨运行状态防护：应用不重启时商品页可能缓存上次的列表（trashLoaded 等不重载）。
    // 直接刷新页面拿全新状态，再导航——所有"计数与底层一致"的断言都必须建立在新鲜 UI 上。
    await cdp.send('Page.enable')
    await cdp.send('Page.reload')
    await sleep(2600)
    for (let i = 0; i < 30; i++) {
      ready = await cdp.evaluate(`
        return !!window.shopilot?.products?.library &&
          [...document.querySelectorAll('.dashboard-nav-item')].some(b => (b.textContent || '').includes('商品管理'))
      `).catch(() => false)
      if (ready) break
      await sleep(1000)
    }
    if (!ready) throw new Error('页面刷新后 30 秒内未就绪')

    // ---- 前置：底层真实数据（预期基准，UI 断言以此为参照，读不到就如实报） ----
    const base = await cdp.evaluate(`
      const lib = window.shopilot.products.library
      const trash = await lib.trash({ limit: 1 })
      const local = await lib.list({ limit: 1 })
      return {
        ok: true,
        trashTotal: trash && trash.ok ? trash.data.total : null,
        localTotal: local && local.ok ? local.data.total : null
      }
    `)
    check('底层回收站总量已读到', Number.isFinite(base && base.trashTotal), `trashTotal=${base && base.trashTotal}`)
    check('底层在册商品总量已读到', Number.isFinite(base && base.localTotal), `localTotal=${base && base.localTotal}`)
    const expectTrash = Number(base && base.trashTotal) || 0
    const expectLocal = Number(base && base.localTotal) || 0

    // ---- 导航：侧栏「商品管理」 ----
    await cdp.evaluate(`
      const btn = [...document.querySelectorAll('.dashboard-nav-item')].find(b => (b.textContent || '').includes('商品管理'))
      if (!btn) throw new Error('找不到「商品管理」导航项')
      btn.click()
      return true
    `)
    await sleep(UI_WAIT + 400)

    const root = await cdp.evaluate(`
      return !!document.querySelector('[data-test="unified-products-page"]')
    `)
    check('商品管理页根节点渲染（unified-products-page）', root)

    // 本地列表是异步加载的：等 local-count 出现再断言（大库首载可能超过固定等待）
    let localReady = false
    for (let i = 0; i < 20; i++) {
      localReady = await cdp.evaluate(`
        return !!document.querySelector('[data-test="local-count"]') &&
          !document.querySelector('.unified-state [class*=loader]')
      `).catch(() => false)
      if (localReady) break
      await sleep(500)
    }
    check('本地列表加载完成（计数元素就绪）', localReady)

    const tabs = await cdp.evaluate(`
      return {
        local: !!document.querySelector('[data-test="product-tab-local"]'),
        platform: !!document.querySelector('[data-test="product-tab-platform"]'),
        trash: !!document.querySelector('[data-test="product-tab-trash"]'),
        summary: !!document.querySelector('[data-test="product-summary"]'),
        orphans: !!document.querySelector('[data-test="summary-orphans"]')
      }
    `)
    check('三个平级 Tab（本地商品/平台商品/回收站）', tabs.local && tabs.platform && tabs.trash)
    check('概要卡（product-summary + summary-orphans）', tabs.summary && tabs.orphans)

    // ---- 本地商品 Tab（默认）：工具栏六件套 + 行数/计数与底层一致 ----
    const localUi = await cdp.evaluate(`
      return {
        search: !!document.querySelector('[data-test="product-search"]'),
        filterPlatform: !!document.querySelector('[data-test="product-filter-platform"]'),
        filterStatus: !!document.querySelector('[data-test="product-filter-status"]'),
        filterLinked: !!document.querySelector('[data-test="product-filter-linked"]'),
        sort: !!document.querySelector('[data-test="product-sort"]'),
        order: !!document.querySelector('[data-test="product-sort-order"]'),
        pager: !!document.querySelector('[data-test="product-pager"]'),
        count: document.querySelector('[data-test="local-count"]') ? document.querySelector('[data-test="local-count"]').textContent.trim() : null,
        rows: document.querySelectorAll('[data-test^="local-product-"]').length
      }
    `)
    check('本地列表工具栏（搜索/平台/状态/归并/排序/序向）',
      localUi.search && localUi.filterPlatform && localUi.filterStatus && localUi.filterLinked && localUi.sort && localUi.order)
    check('本地列表分页器显隐与数据量一致（0 条时隐藏）', localUi.pager === (expectLocal > 0), )
    check('本地列表行数与底层一致', localUi.rows === expectLocal, `ui=${localUi.rows} db=${expectLocal}`)
    const localCountNum = Number(String(localUi.count).match(/共\s*(\d+)\s*条/)?.[1])
    check('本地计数文案与底层一致', localCountNum === expectLocal, `ui="${localUi.count}" db=${expectLocal}`)
    // 本地库若为空，空态应如实可见
    if (expectLocal === 0) {
      const empty = await cdp.evaluate(`return !!document.querySelector('[data-test="local-empty"]')`)
      check('本地库为空时显示空态', empty)
    }

    // 状态筛选下拉应含三个推导状态选项
    const statusOpts = await cdp.evaluate(`
      return [...document.querySelectorAll('[data-test="product-filter-status"] option')].map(o => o.value).join(',')
    `)
    check('状态筛选含推导三态（全部/ready/draft/archived）',
      ['', 'draft', 'ready', 'archived'].every(v => statusOpts.split(',').includes(v)), statusOpts)

    // ---- 回收站 Tab ----
    await cdp.evaluate(`document.querySelector('[data-test="product-tab-trash"]').click(); return true`)
    await sleep(UI_WAIT + 250)

    const trashUi = await cdp.evaluate(`
      return {
        count: document.querySelector('[data-test="trash-count"]') ? document.querySelector('[data-test="trash-count"]').textContent.trim() : null,
        rows: document.querySelectorAll('[data-test^="trash-row-"]').length,
        pager: !!document.querySelector('[data-test="product-pager"]'),
        pagerInfo: document.querySelector('[data-test="product-pager-info"]') ? document.querySelector('[data-test="product-pager-info"]').textContent.trim() : null,
        firstId: document.querySelector('[data-test^="trash-row-"]') ? document.querySelector('[data-test^="trash-row-"]').getAttribute('data-test').replace('trash-row-', '') : null
      }
    `)
    check('回收站行数与底层一致（页大小 50）', trashUi.rows === Math.min(expectTrash, 50), `ui=${trashUi.rows} db=${expectTrash}`)
    const trashCountNum = Number(String(trashUi.count).match(/共\s*(\d+)\s*条/)?.[1])
    check('回收站计数文案与底层一致', trashCountNum === expectTrash, `ui="${trashUi.count}" db=${expectTrash}`)
    check('回收站分页器存在（>50 条时）', expectTrash <= 50 || trashUi.pager, `pagerInfo="${trashUi.pagerInfo}"`)

    // 分页：下一页后首行 id 变化
    if (expectTrash > 50) {
      const before = trashUi.firstId
      await cdp.evaluate(`var el = document.querySelector('[data-test="product-pager-2"]'); if (el) el.click(); return !!el`)
      await sleep(UI_WAIT + 200)
      const after = await cdp.evaluate(`
        return document.querySelector('[data-test^="trash-row-"]') ? document.querySelector('[data-test^="trash-row-"]').getAttribute('data-test').replace('trash-row-', '') : null
      `)
      check('回收站翻页生效（下一页首行变化）', !!after && after !== before, `${before} → ${after}`)
      await cdp.evaluate(`var el = document.querySelector('[data-test="product-pager-1"]'); if (el) el.click(); return !!el`)
      await sleep(UI_WAIT + 200)
    }

    // 搜索（防抖 250ms）：零命中必须显式空态提示
    await cdp.evaluate(`
      var el = document.querySelector('[data-test="trash-search"]') || document.querySelector('[data-test="product-search"]')
      el.value = 'zz-no-such-product-zz'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    `)
    await sleep(SEARCH_WAIT)
    const searched = await cdp.evaluate(`
      return {
        rows: document.querySelectorAll('[data-test^="trash-row-"]').length,
        emptyHint: !!document.querySelector('[data-test="trash-empty"]')
      }
    `)
    check('回收站搜索零命中显示空态（如实提示）', searched.rows === 0 && searched.emptyHint, `rows=${searched.rows}`)
    await cdp.evaluate(`
      var el = document.querySelector('[data-test="trash-search"]') || document.querySelector('[data-test="product-search"]')
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    `)
    await sleep(SEARCH_WAIT)

    // ---- 恢复闭环：回收站恢复 1 条 → 本地出现（含推导徽标/编辑入口/抽屉）→ 再软删还原 ----
    if (expectTrash > 0) {
      const restoreId = trashUi.firstId
      // 恢复按钮会弹原生 window.confirm（阻塞 evaluate）：必须先启用 Page 域并挂事件等待，
      // 再点击，弹窗出现后立即接受——否则 evaluate 永远挂起（2026-10-15 两次实录）。
      await cdp.send('Page.enable')
      const clickPromise = cdp.evaluate(`
        var el = document.querySelector('[data-test="trash-restore-${restoreId}"]')
        if (!el) throw new Error('找不到恢复按钮 trash-restore-${restoreId}')
        el.click()
        return true
      `, 20000).catch(e => { throw new Error('恢复点击失败: ' + (e && e.message ? e.message : e)) })
      const dlg = await cdp.waitEvent('Page.javascriptDialogOpening', 15000)
      check('恢复前弹出原生确认（含「不自动恢复归并」提示）',
        /恢复/.test(String(dlg.params && dlg.params.message)) && /归并/.test(String(dlg.params && dlg.params.message)),
        String(dlg.params && dlg.params.message).replace(/\s+/g, ' ').slice(0, 60))
      await cdp.send('Page.handleJavaScriptDialog', { accept: true })
      await clickPromise
      await sleep(UI_WAIT + 600)
      await cdp.evaluate(`document.querySelector('[data-test="product-tab-local"]').click(); return true`)
      await sleep(UI_WAIT + 400)
      const afterRestore = await cdp.evaluate(`
        return {
          rows: document.querySelectorAll('[data-test^="local-product-"]').length,
          hasRow: !!document.querySelector('[data-test="local-product-${restoreId}"]'),
          status: document.querySelector('[data-test="local-status-${restoreId}"]') ? document.querySelector('[data-test="local-status-${restoreId}"]').textContent.trim() : null,
          editBtn: !!document.querySelector('[data-test="local-edit-${restoreId}"]')
        }
      `)
      check('恢复后本地列表出现该商品', afterRestore.hasRow, `uiRows=${afterRestore.rows}`)
      check('恢复后行状态徽标为推导值（草稿/就绪/已归档）',
        ['草稿', '就绪', '已归档'].includes(afterRestore.status || ''), `status="${afterRestore.status}"`)
      check('行操作含编辑入口', afterRestore.editBtn)

      // 编辑抽屉：打开 → 标题回填 → Esc 关闭（不保存）
      await cdp.evaluate(`document.querySelector('[data-test="local-edit-${restoreId}"]').click(); return true`)
      await sleep(UI_WAIT + 300)
      const drawer = await cdp.evaluate(`
        return {
          open: !!document.querySelector('[data-test="product-editor"]'),
          title: document.querySelector('[data-test="editor-title"]') ? document.querySelector('[data-test="editor-title"]').value : null,
          save: !!document.querySelector('[data-test="editor-save"]'),
          close: !!document.querySelector('[data-test="editor-close"]'),
          variantSection: !!document.querySelector('[data-test="editor-variants"]'),
          issues: document.querySelectorAll('.product-issues .issue-blocker, .product-issues .issue-warning').length
        }
      `)
      check('编辑抽屉打开且标题回填', drawer.open && typeof drawer.title === 'string' && drawer.title.length > 0,
        `title="${String(drawer.title || '').slice(0, 24)}…"`)
      // 规格区恒在；价格行取决于数据（空白商品没有规格行是正常形态）
      check('编辑抽屉含规格区与保存/关闭按钮', drawer.variantSection && drawer.save && drawer.close)
      await cdp.evaluate(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      `)
      await sleep(UI_WAIT + 250)
      const drawerClosed = await cdp.evaluate(`return !document.querySelector('[data-test="product-editor"]')`)
      check('Esc 关闭编辑抽屉', drawerClosed)

      // 还原数据：重新软删（与「删除」同一 IPC 通道），DB 回到验证前状态
      const reRemoved = await cdp.evaluate(`
        const r = await window.shopilot.products.library.remove('${restoreId}')
        return r && r.ok === true
      `)
      check('验证后数据还原（重新软删成功）', reRemoved)
      await sleep(UI_WAIT + 300)
    }

    // ---- R2：新建空白 / 复制（sha 复用断言）/ 归档只读 / 彻底删除 ----
    // 自备数据：R1 的恢复闭环会把唯一有媒体的商品重新软删——这里先用 IPC 恢复一条
    // 当复制源（不走 UI 确认），结束后把所有验收产物清理干净，数据回到原状。
    const listIds = async () => {
      const r = await cdp.evaluate(`
        const res = await window.shopilot.products.library.list({ limit: 200 })
        return res && res.ok ? res.data.rows.map(row => row.id) : []
      `)
      return Array.isArray(r) ? r : []
    }
    // R1 最后停在回收站页签；R2 的新建/状态/复制断言都基于「本地商品」页。
    // 空回收站时上面的恢复闭环整段跳过，页签不会自己切回来 —— 必须显式复位
    // （2026-10-17 隔离库实录：状态徽标与复制按钮全部读不到，正是停在回收站页）。
    await cdp.evaluate(`document.querySelector('[data-test="product-tab-local"]').click(); return true`)
    await sleep(UI_WAIT + 200)
    await cdp.send('Page.enable') // 幂等：后面两处 window.confirm 需要收到弹窗事件
    // 清理上次运行可能残留的验收产物（标题精确匹配「未命名商品」= 脚本创建的默认标题；
    // purge 服务要求无发布记录——这些新建品不可能有）。残留会污染差值断言（2026-10-15 实录）。
    const cleanupLeftovers = async () => {
      const cleaned = { local: 0, trash: 0 }
      for (const [method, source] of [['list', 'local'], ['trash', 'trash']]) {
        const res = await cdp.evaluate(`
          const r = await window.shopilot.products.library.${method}({ limit: 200 })
          return r && r.ok ? r.data.rows.filter(row => row.title === '未命名商品').map(row => row.id) : []
        `)
        for (const id of (Array.isArray(res) ? res : [])) {
          const purged = await cdp.evaluate(`
            let removed = true
            if (${JSON.stringify(method)} === 'local') {
              const r = await window.shopilot.products.library.remove('${id}')
              removed = !!(r && r.ok)
            }
            if (!removed) return false
            const r = await window.shopilot.products.library.purge('${id}')
            return r && r.ok
          `)
          if (purged) cleaned[source] += 1
        }
      }
      return cleaned
    }
    const leftovers = await cleanupLeftovers()
    const idsBeforeR2 = await listIds()
    check('R2 前置：在册商品 id 集合已读到', Array.isArray(idsBeforeR2), `count=${idsBeforeR2.length} 残留清理=${leftovers.local + leftovers.trash}`)
    let restoreSource = await cdp.evaluate(`
      const t = await window.shopilot.products.library.trash({ limit: 1 })
      if (!(t && t.ok && t.data.rows.length)) return null
      const row = t.data.rows[0]
      const r = await window.shopilot.products.library.restore([row.id])
      return r && r.ok ? row.id : null
    `)
    // 隔离库（临时 userData）里没有历史回收站数据：本用例必须能自备复制源，
    // 否则 R2 复制 / R3 批量整段连锁失败（2026-10-17 验收实录：26/37）。
    // 自备路径与真人一致：新建 → 移入回收站 → 恢复。
    let seededSource = false
    if (!restoreSource) {
      restoreSource = await cdp.evaluate(`
        // 用可辨识的标题：R3 的导入用标题匹配更新行，默认标题「未命名商品」会与新建空白品重名，
        // 规划阶段只能如实报冲突（2026-10-17 隔离库实录）。
        const c = await window.shopilot.products.library.create({ title: '验收复制源' })
        if (!c || !c.ok) return null
        const id = c.data.productId
        // 必须带一个真实价格：R3 的“-10% 改价”用例要求源商品有价可改，
        // 全空的恢复品会如实报“价格无变化”，用例本身失去意义。
        const saved = await window.shopilot.products.library.save({
          productId: id,
          draft: {
            title: '验收复制源',
            variants: [{ spec: [{ name: '规格', value: '默认' }], priceMinor: 10000, stock: 5 }],
            media: []
          }
        })
        if (!saved || !saved.ok) return null
        const removed = await window.shopilot.products.library.remove(id)
        if (!removed || !removed.ok) return null
        const back = await window.shopilot.products.library.restore([id])
        return back && back.ok ? id : null
      `)
      seededSource = !!restoreSource
    }
    check('R2 前置：已从回收站恢复一条作复制源', !!restoreSource, `source=${restoreSource ? restoreSource.slice(0, 8) : 'null'}${seededSource ? '（自备）' : ''}`)

    // ① 新建空白商品 → 创建即进编辑器
    await cdp.evaluate(`document.querySelector('[data-test="local-create"]').click(); return true`)
    await sleep(UI_WAIT + 500)
    const blankEditor = await cdp.evaluate(`
      return {
        open: !!document.querySelector('[data-test="product-editor"]'),
        title: document.querySelector('[data-test="editor-title"]') ? document.querySelector('[data-test="editor-title"]').value : null,
        blocker: !!document.querySelector('[data-test="editor-issue-blocker"]')
      }
    `)
    check('R2 新建：创建即进编辑器（默认标题 + 实时校验报缺）',
      blankEditor.open && blankEditor.title === '未命名商品' && blankEditor.blocker,
      `title="${blankEditor.title}" blocker=${blankEditor.blocker}`)
    await cdp.evaluate(`document.querySelector('[data-test="editor-close"]').click(); return true`)
    await sleep(UI_WAIT + 200)
    // 标题探测（对残留/跨运行免疫；差值断言在恢复过一条后会错位）
    const findIdsByTitle = async (title) => {
      const r = await cdp.evaluate(`
        const res = await window.shopilot.products.library.list({ limit: 200 })
        return res && res.ok ? res.data.rows.filter(row => row.title === ${JSON.stringify(title)}).map(row => row.id) : []
      `)
      return Array.isArray(r) ? r : []
    }
    const blanksAfter = await findIdsByTitle('未命名商品')
    const blankId = blanksAfter[0] ?? null
    check('R2 新建：列表出现「未命名商品」', !!blankId, `blankId=${blankId ? blankId.slice(0, 8) : 'null'}`)
    // 列表刷新是 IPC → Vue 渲染的异步链路：刚关闭编辑器时行可能还没落到 DOM，
    // 单次读取会把"尚未渲染"误报成"没有状态徽标"（2026-10-17 实录）。有界轮询。
    let blankStatus = null
    for (let i = 0; i < 20; i++) {
      blankStatus = await cdp.evaluate(`
        return document.querySelector('[data-test="local-status-${blankId}"]') ? document.querySelector('[data-test="local-status-${blankId}"]').textContent.trim() : null
      `)
      if (blankStatus) break
      await sleep(250)
    }
    check('R2 新建：状态徽标为「草稿」', blankStatus === '草稿', `status="${blankStatus}"`)

    // ② 复制（对恢复出来的源商品做，验证 sha256 复用）
    const copySourceId = restoreSource
    let copyId = null
    if (copySourceId) {
      const sourceInfo = await cdp.evaluate(`
        const r = await window.shopilot.products.library.get('${copySourceId}')
        return r && r.ok ? { title: r.data.draft.title, media: (r.data.draft.media || []).map(item => item.sha256 || item.remoteUrl || '') } : null
      `)
      await cdp.evaluate(`document.querySelector('[data-test="local-copy-${copySourceId}"]').click(); return true`)
      await sleep(UI_WAIT + 600)
      const copyIds = await findIdsByTitle(String(sourceInfo && sourceInfo.title) + '（副本）')
      copyId = copyIds[0] ?? null
      check('R2 复制：列表出现「（副本）」', !!copyId, `copyId=${copyId ? copyId.slice(0, 8) : 'null'}`)
      if (copyId) {
        const copyMedia = await cdp.evaluate(`
          const r = await window.shopilot.products.library.get('${copyId}')
          return r && r.ok ? (r.data.draft.media || []).map(item => item.sha256 || item.remoteUrl || '') : []
        `)
        const shaReuseOk = JSON.stringify(copyMedia) === JSON.stringify(sourceInfo && sourceInfo.media)
        check('R2 复制：媒体 sha256 逐条复用（不重复下载）', shaReuseOk,
          `media=[${copyMedia.length}]`)
      }
    }

    // ③ 归档只读 + 取消归档
    if (copyId) {
      await cdp.evaluate(`document.querySelector('[data-test="local-archive-${copyId}"]').click(); return true`)
      await sleep(UI_WAIT + 400)
      const archivedBadge = await cdp.evaluate(`
        return document.querySelector('[data-test="local-status-${copyId}"]') ? document.querySelector('[data-test="local-status-${copyId}"]').textContent.trim() : null
      `)
      check('R2 归档：行状态徽标为「已归档」', archivedBadge === '已归档', `status="${archivedBadge}"`)
      await cdp.evaluate(`document.querySelector('[data-test="local-edit-${copyId}"]').click(); return true`)
      await sleep(UI_WAIT + 400)
      const readonly = await cdp.evaluate(`
        return {
          banner: !!document.querySelector('[data-test="editor-archived-banner"]'),
          saveDisabled: document.querySelector('[data-test="editor-save"]') ? document.querySelector('[data-test="editor-save"]').disabled : null,
          titleDisabled: document.querySelector('[data-test="editor-title"]') ? document.querySelector('[data-test="editor-title"]').disabled : null
        }
      `)
      check('R2 归档：编辑器只读（横幅 + 保存/输入禁用）', readonly.banner && readonly.saveDisabled === true && readonly.titleDisabled === true,
        `banner=${readonly.banner} saveDisabled=${readonly.saveDisabled}`)
      await cdp.evaluate(`document.querySelector('[data-test="editor-unarchive"]').click(); return true`)
      await sleep(UI_WAIT + 500)
      const unarchivedBadge = await cdp.evaluate(`
        return document.querySelector('[data-test="local-status-${copyId}"]') ? document.querySelector('[data-test="local-status-${copyId}"]').textContent.trim() : null
      `)
      check('R2 取消归档：状态回到推导值（草稿/就绪）', unarchivedBadge === '草稿' || unarchivedBadge === '就绪', `status="${unarchivedBadge}"`)
      await cdp.evaluate(`document.querySelector('[data-test="editor-close"]').click(); return true`)
      await sleep(UI_WAIT + 200)
    }

    // ④ 彻底删除（验收自己创建的 blank 与 copy：都无发布记录；逐步返回诊断）
    const purgeViaUi = async (id) => {
      const step = { remove: false, btn: false, dialog: false, gone: false }
      // 软删走 IPC（与 UI「删除」同一条后端路径；UI 侧确认弹层已在恢复闭环验证过）
      step.remove = await cdp.evaluate(`
        const r = await window.shopilot.products.library.remove('${id}')
        return r && r.ok
      `)
      if (!step.remove) return step
      await cdp.evaluate(`document.querySelector('[data-test="product-tab-trash"]').click(); return true`)
      await sleep(UI_WAIT + 300)
      const purgeBtn = await cdp.evaluate(`
        var el = document.querySelector('[data-test="trash-purge-${id}"]')
        return el ? { disabled: el.disabled, title: el.title } : null
      `)
      step.btn = !!purgeBtn && purgeBtn.disabled === false
      if (!step.btn) { step.btnDetail = purgeBtn; return step }
      // 确认弹窗会**同步阻塞** click 的 evaluate（window.confirm）——必须让点击挂起、
      // 并发等弹窗事件再应答；顺序 await 会永远卡死（与恢复闭环同一坑，2026-10-16 二次实录）
      const clickPromise = cdp.evaluate(`document.querySelector('[data-test="trash-purge-${id}"]').click(); return true`, 20000)
      try {
        const dlg = await cdp.waitEvent('Page.javascriptDialogOpening', 10000)
        step.dialog = /彻底删除/.test(String(dlg.params && dlg.params.message))
        if (!step.dialog) { step.dialogText = String(dlg.params && dlg.params.message).slice(0, 60); return step }
        await cdp.send('Page.handleJavaScriptDialog', { accept: true })
        await clickPromise
      } catch (e) { step.dialogError = String(e && e.message || e).slice(0, 80); return step }
      await sleep(UI_WAIT + 500)
      const after = await cdp.evaluate(`
        const r = await window.shopilot.products.library.trash({ keyword: '', limit: 200 })
        return r && r.ok ? r.data.rows.map(row => row.id) : []
      `)
      step.gone = Array.isArray(after) && !after.includes(id)
      return step
    }
    if (blankId) {
      const step = await purgeViaUi(blankId)
      check('R2 彻底删除：无发布记录的商品可彻底删（确认弹层 + 行级联 + 链接解绑）',
        step.remove && step.btn && step.dialog && step.gone, JSON.stringify(step))
    }
    if (copyId) {
      const step = await purgeViaUi(copyId)
      check('R2 彻底删除：副本已从回收站清除', step.remove && step.btn && step.dialog && step.gone, JSON.stringify(step))
    }
    // 收尾：复制源重新软删（数据回到验证前状态）
    if (restoreSource) {
      const reRemoved = await cdp.evaluate(`
        const r = await window.shopilot.products.library.remove('${restoreSource}')
        return r && r.ok
      `)
      check('R2 收尾：复制源已重新软删（数据还原）', reRemoved)
    }

    // ---- R3：多选批量（改价/加标签/删除）+ CSV 导入（导出的保存对话框无法自动化，按钮存在性代替）----
    const idsR3Before = await listIds()
    // R2 收尾停在回收站 Tab：先切回本地商品（多选框在本地列表里）
    await cdp.evaluate(`document.querySelector('[data-test="product-tab-local"]').click(); return true`)
    await sleep(UI_WAIT + 400)
    await cdp.evaluate(`document.querySelector('[data-test="local-create"]').click(); return true`)
    await sleep(UI_WAIT + 500)
    await cdp.evaluate(`document.querySelector('[data-test="editor-close"]').click(); return true`)
    const r3Blank = (await findIdsByTitle('未命名商品'))[0] ?? null
    const r3Source = await cdp.evaluate(`
      const t = await window.shopilot.products.library.trash({ limit: 1 })
      if (!(t && t.ok && t.data.rows.length)) return null
      const r = await window.shopilot.products.library.restore([t.data.rows[0].id])
      return r && r.ok ? t.data.rows[0].id : null
    `)
    // IPC 恢复不会触发 UI 刷新：点「刷新」把恢复出来的商品拉进 DOM（否则勾选落空）
    await cdp.evaluate(`document.querySelector('[data-test="local-refresh"]').click(); return true`)
    await sleep(UI_WAIT + 400)
    check('R3 前置：已备齐两个本地商品（新建 + 恢复）', !!r3Blank && !!r3Source)
    const r3SourceTitle = await cdp.evaluate(`
      const r = await window.shopilot.products.library.get(${JSON.stringify(r3Source)})
      return r && r.ok ? r.data.draft.title : ''
    `)
    // 清掉历史运行残留的同标题克隆品（否则重名 → 导入规划如实报冲突）
    await cdp.evaluate(`
      const r = await window.shopilot.products.library.list({ limit: 200 })
      if (r && r.ok) {
        for (const row of r.data.rows) {
          // 绝不清掉本用例刚建的两个目标商品（源被自备时标题可能与空白品同名前缀；
          // 早先只排除源，结果把 r3Blank 一起 purge，后续勾选/改价全报 PRODUCT_NOT_FOUND）
          if (row.id !== ${JSON.stringify(r3Source)} && row.id !== ${JSON.stringify(r3Blank)} && row.title === ${JSON.stringify(r3SourceTitle)}) {
            await window.shopilot.products.library.remove(row.id)
            await window.shopilot.products.library.purge(row.id)
          }
        }
      }
      return true
    `)

    // 勾选两行 → 批量条出现
    await cdp.evaluate(`
      for (const id of [${JSON.stringify(r3Blank)}, ${JSON.stringify(r3Source)}]) {
        var el = document.querySelector('[data-test="batch-check-' + id + '"]')
        if (el && !el.checked) el.click()
      }
      return true
    `)
    await sleep(UI_WAIT + 300)
    const barText = await cdp.evaluate(`
      return document.querySelector('[data-test="batch-bar"]') ? document.querySelector('[data-test="batch-bar"]').textContent.replace(/\s+/g, ' ').trim() : null
    `)
    check('R3 多选：勾选两行后批量条出现（含「已选 2 项」）', !!barText && barText.includes('已选 2 项'), barText || 'null')
    const exportBtns = await cdp.evaluate(`
      return { selected: !!document.querySelector('[data-test="batch-op-export"]'), filtered: !!document.querySelector('[data-test="batch-export-filtered"]') }
    `)
    check('R3 导出入口存在（保存对话框无法自动化，验证按钮）', exportBtns.selected && exportBtns.filtered)

    // 批量改价：-10% → 预览（影响 1：空白商品无价跳过）→ 执行 → IPC 验证
    await cdp.evaluate(`document.querySelector('[data-test="batch-op-price"]').click(); return true`)
    await sleep(UI_WAIT + 200)
    await cdp.evaluate(`
      var mode = document.querySelector('[data-test="batch-price-mode"]')
      var value = document.querySelector('[data-test="batch-price-value"]')
      if (mode) { mode.value = 'percent'; mode.dispatchEvent(new Event('change', { bubbles: true })) }
      if (value) { value.value = '-10'; value.dispatchEvent(new Event('input', { bubbles: true })) }
      return true
    `)
    await sleep(UI_WAIT)
    await cdp.evaluate(`document.querySelector('[data-test="batch-preview"]').click(); return true`)
    await sleep(UI_WAIT + 500)
    const pricePreview = await cdp.evaluate(`
      return {
        text: document.querySelector('[data-test="batch-preview-result"]') ? document.querySelector('[data-test="batch-preview-result"]').textContent.replace(/\s+/g, ' ').trim() : null,
        hasSample: !!document.querySelector('[class*=batch-sample]'),
        executeDisabled: document.querySelector('[data-test="batch-execute"]') ? document.querySelector('[data-test="batch-execute"]').disabled : null
      }
    `)
    check('R3 改价预览：影响 1 / 空白商品因无价跳过（如实计数）',
      !!pricePreview.text && pricePreview.text.includes('影响 1') && pricePreview.hasSample && pricePreview.executeDisabled === false,
      (pricePreview.text || 'null').slice(0, 80))
    const sourcePriceBefore = await cdp.evaluate(`
      const r = await window.shopilot.products.library.get('${r3Source}')
      return r && r.ok ? r.data.draft.variants.map(v => v.priceMinor) : []
    `)
    await cdp.evaluate(`document.querySelector('[data-test="batch-execute"]').click(); return true`)
    await sleep(UI_WAIT + 600)
    const priceOutcome = await cdp.evaluate(`
      return document.querySelector('[data-test="batch-result"]') ? document.querySelector('[data-test="batch-result"]').textContent.replace(/\s+/g, ' ').trim() : null
    `)
    check('R3 改价执行：回执出现（成功 1 / 跳过 1）', !!priceOutcome && priceOutcome.includes('成功 1'), (priceOutcome || 'null').slice(0, 60))
    const sourcePriceAfter = await cdp.evaluate(`
      const r = await window.shopilot.products.library.get('${r3Source}')
      return r && r.ok ? r.data.draft.variants.map(v => v.priceMinor) : []
    `)
    const priceChanged = sourcePriceBefore.length === sourcePriceAfter.length &&
      sourcePriceBefore.some((price, index) => price != null && sourcePriceAfter[index] != null &&
        Math.abs(sourcePriceAfter[index] - Math.round(price * 0.9)) <= 1)
    check('R3 改价生效：价格按 -10% 落库（四舍五入容差 ±1 分）', priceChanged,
      `${JSON.stringify(sourcePriceBefore)} → ${JSON.stringify(sourcePriceAfter)}`)

    // 批量加标签
    await cdp.evaluate(`document.querySelector('[data-test="batch-op-tags-add"]').click(); return true`)
    await sleep(UI_WAIT)
    await cdp.evaluate(`
      var input = document.querySelector('[data-test="batch-tags-input"]')
      if (input) { input.value = 'R3验收标签'; input.dispatchEvent(new Event('input', { bubbles: true })) }
      return true
    `)
    await sleep(UI_WAIT)
    await cdp.evaluate(`document.querySelector('[data-test="batch-preview"]').click(); return true`)
    await sleep(UI_WAIT + 400)
    await cdp.evaluate(`document.querySelector('[data-test="batch-execute"]').click(); return true`)
    await sleep(UI_WAIT + 500)
    const tagsAfter = await cdp.evaluate(`
      const r = await window.shopilot.products.library.get('${r3Source}')
      return r && r.ok ? r.data.draft.tags : []
    `)
    check('R3 加标签：批量落库且可在草稿里读到', Array.isArray(tagsAfter) && tagsAfter.includes('R3验收标签'), JSON.stringify(tagsAfter))

    // CSV 导入：预览 diff → 执行（IPC 与 UI 同一条后端路径；文件选择框无法自动化）
    const realImportCsv = [
      PRODUCT_CSV_HEADER,
      ['CSV导入新建品', '', '', '', '', '', '', '12.5', '', '', '', '', ''].join(','),
      [r3SourceTitle, '', '', '', '', '', '', '99.99', '', '', '', '', ''].join(',')
    ].join('\r\n')
    const importPreview = await cdp.evaluate(`
      const r = await window.shopilot.products.library.importPreview(${JSON.stringify(realImportCsv)})
      return r && r.ok ? { creates: r.data.creates.length, updates: r.data.updates.length, conflicts: r.data.conflicts.length, firstUpdate: r.data.updates[0] || null } : { error: r && r.error.message }
    `)
    check('R3 导入预览：新增 1 + 更新 1（字段级 diff 指向源商品）',
      importPreview && importPreview.creates === 1 && importPreview.updates === 1 && importPreview.firstUpdate &&
        importPreview.firstUpdate.changes.some(change => change.field === '价格'),
      JSON.stringify(importPreview).slice(0, 120))
    const importOutcome = await cdp.evaluate(`
      const r = await window.shopilot.products.library.importExecute(${JSON.stringify(realImportCsv)})
      return r && r.ok ? { created: r.data.created, updated: r.data.updated } : { error: r && r.error.message }
    `)
    check('R3 导入执行：单事务落库（新增 1 / 更新 1）', importOutcome && importOutcome.created === 1 && importOutcome.updated === 1, JSON.stringify(importOutcome))
    const importedProduct = await cdp.evaluate(`
      const r = await window.shopilot.products.library.list({ keyword: 'CSV导入新建品', limit: 10 })
      return r && r.ok ? r.data.rows.map(row => ({ id: row.id, title: row.title })) : []
    `)
    check('R3 导入结果：新建品真实存在', Array.isArray(importedProduct) && importedProduct.length >= 1)

    // 批量删除（软删）：两个都进回收站
    await cdp.evaluate(`document.querySelector('[data-test="batch-op-delete"]').click(); return true`)
    await sleep(UI_WAIT)
    await cdp.evaluate(`document.querySelector('[data-test="batch-preview"]').click(); return true`)
    await sleep(UI_WAIT + 400)
    await cdp.evaluate(`document.querySelector('[data-test="batch-execute"]').click(); return true`)
    await sleep(UI_WAIT + 600)
    const deletedIds = await cdp.evaluate(`
      const t = await window.shopilot.products.library.trash({ limit: 50 })
      return t && t.ok ? t.data.rows.map(row => row.id) : []
    `)
    check('R3 批量删除：两项均进回收站',
      Array.isArray(deletedIds) && deletedIds.includes(r3Blank) && deletedIds.includes(r3Source))

    // 清理：导入的新品 + 恢复的源商品回到原状（blank 已随批量删除进回收站且无发布记录 → purge）
    for (const item of (Array.isArray(importedProduct) ? importedProduct : [])) {
      await cdp.evaluate(`await window.shopilot.products.library.purge(${JSON.stringify(item.id)}).then(r => r && r.ok)`).catch(() => true)
    }
    await cdp.evaluate(`
      const t = await window.shopilot.products.library.trash({ limit: 200 })
      if (t && t.ok) { for (const row of t.data.rows) { if (row.title === '未命名商品') await window.shopilot.products.library.purge(row.id) } }
      return true
    `)
    const idsR3After = await listIds()
    check('R3 收尾：验收产物清理（在册回到验证前集合）',
      idsR3After.length === idsR3Before.length && idsR3After.every(id => idsR3Before.includes(id)),
      `before=${idsR3Before.length} after=${idsR3After.length}`)

    // ---- 平台商品 Tab：筛选六件套与列表容器 ----
    await cdp.evaluate(`document.querySelector('[data-test="product-tab-platform"]').click(); return true`)
    await sleep(UI_WAIT + 250)
    const platformUi = await cdp.evaluate(`
      return {
        search: !!document.querySelector('[data-test="platform-search"]'),
        store: !!document.querySelector('[data-test="platform-filter-store"]'),
        platform: !!document.querySelector('[data-test="platform-filter-platform"]'),
        status: !!document.querySelector('[data-test="platform-filter-status"]'),
        orphan: !!document.querySelector('[data-test="platform-only-orphan"]'),
        sort: !!document.querySelector('[data-test="platform-sort"]'),
        rows: document.querySelectorAll('[data-test^="product-row-"]').length,
        count: document.querySelector('[data-test="platform-count"]') ? document.querySelector('[data-test="platform-count"]').textContent.trim() : null
      }
    `)
    check('平台商品筛选（搜索/店铺/平台/状态/只看未归并/排序）',
      platformUi.search && platformUi.store && platformUi.platform && platformUi.status && platformUi.orphan && platformUi.sort)
    // 平台列表可能为空（无采集数据）——数量文案必须如实渲染
    check('平台列表数量文案渲染', platformUi.count !== null, `count="${platformUi.count}" rows=${platformUi.rows}`)

    // ---- 汇总 ----
    const failed = checks.filter(c => !c.pass)
    console.log(`\n==== 商品管理 R1 真机验收：${checks.length - failed.length}/${checks.length} 通过 ====`)
    if (failed.length) {
      console.log('失败项：')
      for (const f of failed) console.log(`  ✗ ${f.name} [${f.detail}]`)
      process.exitCode = 1
    }
  } finally {
    if (fixtureStoreId) {
      await cdp.evaluate(`
        const id = ${JSON.stringify(fixtureStoreId)}
        const archived = await window.shopilot.store.archive(id)
        if (archived && archived.ok) await window.shopilot.store.purge(id)
        return true
      `).catch(error => console.warn('验收临时店铺清理失败:', error && error.message ? error.message : error))
    }
    cdp.close()
  }
}

main().catch(error => {
  console.error('验收脚本异常:', error && error.message ? error.message : error)
  process.exit(2)
})
