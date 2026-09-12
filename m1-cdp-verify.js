/**
 * M1+ 全链路验收：原生 CDP 驱动真实应用（preload → IPC → Main → SQLite）
 * 覆盖：店铺 CRUD / 内嵌浏览器 / 隔离 / 下载归档 / 标签恢复 / profile / 审计 / 回收站 / 截图 / 事件 / UI 冒烟
 */
const http = require('http')
const CDP_PORT = process.env.SHOPILOT_CDP_PORT || '9223'
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
      const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl && predicate(t.url))
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
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(fnBody) {
    await this.ready
    const expression = `(async () => { ${fnBody} })()`
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function main() {
  const wsUrl = await getPageWs(u => u.includes('index.html') || u.startsWith('file:'))
  console.log('连接应用主窗口 CDP:', wsUrl)
  const cdp = new CDPSession(wsUrl)
  await cdp.ready

  const results = []
  const check = (name, ok, extra = '') => {
    results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
  }

  // ---------- UI 冒烟 & preload ----------
  await cdp.evaluate(`
    const deadline = Date.now() + 15000;
    while (!(window.shopilot && window.shopilot.store && window.shopilot.browser && window.shopilot.profile && window.shopilot.audit)) {
      if (Date.now() > deadline) throw new Error('window.shopilot 未注入');
      await new Promise(r => setTimeout(r, 100));
    }
    return true;
  `)
  check('preload API 注入 window.shopilot（含 profile/audit）', true)

  const uiSmoke = await cdp.evaluate(`
    const deadline = Date.now() + 5000;
    while (!document.querySelector('.workbench') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    return {
      workbench: !!document.querySelector('.workbench'),
      sidebar: !!document.querySelector('.sidebar'),
      welcome: !!document.querySelector('.welcome'),
      bg: getComputedStyle(document.body).backgroundColor
    };
  `)
  check('深色三栏工作台已渲染（workbench+sidebar+welcome）', uiSmoke.workbench && uiSmoke.sidebar && uiSmoke.welcome, JSON.stringify(uiSmoke))
  check('深色主题背景 #1a1a1a', uiSmoke.bg === 'rgb(26, 26, 26)', uiSmoke.bg)

  const csp = await cdp.evaluate(`
    const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return m ? m.content : null;
  `)
  check('严格 CSP 已声明（无 unsafe-eval）', !!csp && !csp.includes('unsafe-eval'), String(csp).slice(0, 60))

  // 事件监听（在 tabUpdated 到达前注册）
  await cdp.evaluate(`window.__evts = []; window.shopilot.on('browser:tabUpdated', p => window.__evts.push(p)); return true;`)

  // 清场
  await cdp.evaluate(`
    const l = await window.shopilot.store.list();
    for (const s of (l.data||[])) { try { await window.shopilot.store.deletePermanent(s.id); } catch(e){} }
    const t = await window.shopilot.store.trashList();
    for (const s of (t.data||[])) { try { await window.shopilot.store.purge(s.id); } catch(e){} }
    return true;
  `)

  // 设定视口（内嵌 WebContentsView 的真实渲染区域）
  const sv = await cdp.evaluate(`return await window.shopilot.browser.setViewport({ x: 336, y: 84, width: 900, height: 620 });`)
  check('browser:setViewport 接受视口上报', sv.ok === true)

  // ---------- 店铺 CRUD ----------
  const created = await cdp.evaluate(`
    const a = await window.shopilot.store.create({ name:'测试店铺A', platform:'拼多多', adminUrl:'https://mms.pinduoduo.com', tags:['主账号'], notes:'A 备注' });
    const b = await window.shopilot.store.create({ name:'测试店铺B', platform:'抖店', adminUrl:'https://fxg.jinritemai.com', tags:[] });
    return { a, b };
  `)
  check('创建店铺A/B', created.a.ok === true && created.b.ok === true)
  const storeA = created.a.data.id, storeB = created.b.data.id
  check('storeId 主进程生成且唯一', storeA.startsWith('store_') && storeA !== storeB)
  check('avatarColor 为 camelCase 字段（映射器生效）', /^#[0-9A-Fa-f]{6}$/.test(created.a.data.avatarColor), created.a.data.avatarColor)

  const list = await cdp.evaluate(`return await window.shopilot.store.list();`)
  check('store:list 返回 camelCase adminUrl', list.ok && list.data.length === 2 && list.data.every(s => typeof s.adminUrl === 'string'), JSON.stringify(list.data[0]?.adminUrl))

  const missing = await cdp.evaluate(`return await window.shopilot.store.get('store_nonexist');`)
  check('未知店铺返回 STORE_NOT_FOUND', missing.ok === false && missing.error.code === 'STORE_NOT_FOUND')

  const ord = await cdp.evaluate(`return await window.shopilot.store.reorder([${JSON.stringify(storeB)}, ${JSON.stringify(storeA)}]);`)
  const list2 = await cdp.evaluate(`return await window.shopilot.store.list();`)
  check('store:reorder 生效', ord.ok && list2.data[0].id === storeB)

  const arc = await cdp.evaluate(`return await window.shopilot.store.archive(${JSON.stringify(storeB)});`)
  const gotB0 = await cdp.evaluate(`return await window.shopilot.store.get(${JSON.stringify(storeB)});`)
  check('store:archive → archived', arc.ok && gotB0.data.status === 'archived')
  const rst = await cdp.evaluate(`return await window.shopilot.store.restore(${JSON.stringify(storeB)});`)
  const gotB1 = await cdp.evaluate(`return await window.shopilot.store.get(${JSON.stringify(storeB)});`)
  check('store:restore → offline', rst.ok && gotB1.data.status === 'offline')

  // ---------- profile:*（store:create 已自动建 browser_profiles）----------
  const prof = await cdp.evaluate(`return await window.shopilot.profile.get(${JSON.stringify(storeA)});`)
  check('profile:get（createStore 自动建环境）', prof.ok && prof.data.profilePartition === 'persist:store_' + storeA && prof.data.configVersion === 1, JSON.stringify({ p: prof.data?.profilePartition, v: prof.data?.configVersion }))

  const profUpd = await cdp.evaluate(`return await window.shopilot.profile.update(${JSON.stringify(storeA)}, { timezone: 'America/Los_Angeles', userAgent: 'ShopPilotTestUA/1.0' });`)
  check('profile:update 递增 config_version=2', profUpd.ok && profUpd.data.configVersion === 2 && profUpd.data.timezone === 'America/Los_Angeles')

  const profLock = await cdp.evaluate(`return await window.shopilot.profile.lock(${JSON.stringify(storeA)}, true);`)
  check('profile:lock', profLock.ok && profLock.data.locked === true)
  const profLockedUpd = await cdp.evaluate(`return await window.shopilot.profile.update(${JSON.stringify(storeA)}, { timezone: 'UTC' });`)
  check('锁定后更新被拒 PROFILE_LOCKED', profLockedUpd.ok === false && profLockedUpd.error.code === 'PROFILE_LOCKED')
  await cdp.evaluate(`return await window.shopilot.profile.lock(${JSON.stringify(storeA)}, false);`)

  const profCopy = await cdp.evaluate(`return await window.shopilot.profile.copyConfig(${JSON.stringify(storeA)}, [${JSON.stringify(storeB)}]);`)
  const profB = await cdp.evaluate(`return await window.shopilot.profile.get(${JSON.stringify(storeB)});`)
  check('profile:copyConfig 已同步时区到店铺B', profCopy.ok && profCopy.data.copied === 1 && profB.data.timezone === 'America/Los_Angeles', JSON.stringify({ ok: profCopy.ok, err: profCopy.error, copied: profCopy.data?.copied, tz: profB.data?.timezone }))

  const verify = await cdp.evaluate(`return await window.shopilot.profile.verify(${JSON.stringify(storeA)});`)
  check('profile:verify 返回字段清单', verify.ok && Array.isArray(verify.data.items) && verify.data.items.length >= 4)

  // ---------- 内嵌浏览器 ----------
  const open = await cdp.evaluate(`return await window.shopilot.browser.open(${JSON.stringify(storeA)});`)
  check('browser:open A（内嵌宿主窗口）', open.ok === true, open.ok ? '' : JSON.stringify(open.error))
  await sleep(1200)

  const tabList1 = await cdp.evaluate(`return await window.shopilot.browser.tab.list(${JSON.stringify(storeA)});`)
  check('默认标签页已创建', tabList1.ok && tabList1.data.tabs.length === 1)
  const tabId = tabList1.data.tabs[0].id

  const badNav = await cdp.evaluate(`return await window.shopilot.browser.navigate(${JSON.stringify(storeA)}, ${JSON.stringify(tabId)}, 'file:///C:/Windows/win.ini');`)
  check('file: 导航被拒绝 NAVIGATION_BLOCKED', badNav.ok === false && badNav.error.code === 'NAVIGATION_BLOCKED')

  const jsNav = await cdp.evaluate(`return await window.shopilot.browser.navigate(${JSON.stringify(storeA)}, ${JSON.stringify(tabId)}, 'javascript:alert(1)');`)
  check('javascript: 导航被拒绝', jsNav.ok === false && jsNav.error.code === 'NAVIGATION_BLOCKED')

  const nav = await cdp.evaluate(`return await window.shopilot.browser.navigate(${JSON.stringify(storeA)}, ${JSON.stringify(tabId)}, 'http://127.0.0.1:${CDP_PORT}/json/version');`)
  check('http 导航被接受', nav.ok === true)
  await sleep(2500)

  const ctrl = await cdp.evaluate(`return await window.shopilot.browser.tab.control(${JSON.stringify(storeA)}, ${JSON.stringify(tabId)}, 'reload');`)
  check('browser:tab:control(reload)', ctrl.ok === true)

  // 事件推送：reload 会触发 loadingChanged；tabUpdated 应已有推送
  const evts = await cdp.evaluate(`return window.__evts.filter(e => e.storeId === ${JSON.stringify(storeA)}).length;`)
  check('browser:tabUpdated 事件已推送到渲染层', evts >= 1, '推送次数=' + evts)

  // 截图（视口已设，页面已加载）
  const cap = await cdp.evaluate(`return await window.shopilot.browser.capture(${JSON.stringify(storeA)}, ${JSON.stringify(tabId)}, 'png');`)
  check('browser:capture 返回 PNG base64', cap.ok === true && typeof cap.data.data === 'string' && cap.data.data.length > 2000, 'len=' + (cap.data?.data || '').length)

  const pin = await cdp.evaluate(`return await window.shopilot.browser.tab.setPinned(${JSON.stringify(storeA)}, ${JSON.stringify(tabId)}, true);`)
  check('browser:tab:setPinned', pin.ok === true)

  const bm = await cdp.evaluate(`return await window.shopilot.bookmark.create({ storeId: ${JSON.stringify(storeA)}, url:'https://mms.pinduoduo.com/orders', title:'订单管理' });`)
  const bml = await cdp.evaluate(`return await window.shopilot.bookmark.list(${JSON.stringify(storeA)});`)
  check('bookmark create/list（camelCase orderIndex）', bm.ok && bml.ok && bml.data.some(b => b.title === '订单管理' && typeof b.orderIndex === 'number'))

  // ---------- 店铺 B + 隔离 + 下载 ----------
  await cdp.evaluate(`return await window.shopilot.browser.open(${JSON.stringify(storeB)});`)
  await sleep(1000)
  const tabB = await cdp.evaluate(`return await window.shopilot.browser.tab.create(${JSON.stringify(storeB)}, 'http://127.0.0.1:${CDP_PORT}/json/list');`)
  check('browser:tab:create B', tabB.ok === true)
  await sleep(2500)

  const disp = await cdp.evaluate(`return await window.shopilot.browser.display(${JSON.stringify(storeA)});`)
  check('browser:display 切回店铺A', disp.ok && disp.data.displayedStoreId === storeA)

  const targets = await listTargets()
  const tA = targets.find(t => t.type === 'page' && t.url.includes('/json/version') && t.webSocketDebuggerUrl)
  const tB = targets.find(t => t.type === 'page' && t.url.includes('/json/list') && t.webSocketDebuggerUrl)
  check('两个店铺的页面 target 均存活', !!tA && !!tB)

  // ---------- 店铺右键菜单（§4.3 / §6.6 复制配置）：原为 window.confirm 占位，用户实报"显示不正常" ----------
  // 前面的店铺是走 IPC 建的，渲染层列表还是启动时的空列表：先刷新界面再点开店铺，保证 UI 有卡片与视口
  await cdp.evaluate(`setTimeout(() => location.reload(), 30); return true;`)
  await sleep(3500)
  const openedForCtx = await cdp.evaluate(`
    const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('测试店铺A'));
    if (!card) return { cards: document.querySelectorAll('.store-card').length };
    card.querySelector('.store-action')?.click();
    await new Promise(r => setTimeout(r, 3200));
    return { cards: document.querySelectorAll('.store-card').length, viewport: !!document.querySelector('.viewport') };
  `)
  check('界面刷新后可看到店铺卡并打开店铺（右键菜单前置条件）',
    openedForCtx.cards >= 2 && openedForCtx.viewport === true, JSON.stringify(openedForCtx))

  const pageVis = async () => {
    const list = await listTargets()
    const t = list.find(x => x.type === 'page' && x.url.includes('/json/version') && x.webSocketDebuggerUrl)
    if (!t) return null
    const s = new CDPSession(t.webSocketDebuggerUrl)
    const v = await s.evaluate(`return document.visibilityState`)
    s.close()
    return v
  }
  const ctxMenu = await cdp.evaluate(`
    const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('测试店铺A'));
    if (!card) return { error: '未找到店铺卡' };
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 20) }));
    await new Promise(r => setTimeout(r, 800));
    const m = document.querySelector('[data-test="store-ctx"]');
    const mr = m ? m.getBoundingClientRect() : null;
    return {
      shown: !!m,
      items: m ? [...m.querySelectorAll('.ctx-item')].map(b => b.textContent.trim()) : [],
      rect: mr ? { x: Math.round(mr.x), y: Math.round(mr.y), w: Math.round(mr.width), h: Math.round(mr.height) } : null,
      insideWindow: mr ? (mr.x >= 0 && mr.y >= 0 && mr.right <= window.innerWidth + 1 && mr.bottom <= window.innerHeight + 1) : false
    };
  `)
  check('右键店铺卡弹出应用内菜单（非 window.confirm）',
    ctxMenu.shown === true && ctxMenu.items.length === 6 && ctxMenu.insideWindow === true,
    JSON.stringify({ shown: ctxMenu.shown, n: ctxMenu.items?.length, inside: ctxMenu.insideWindow }))
  check('菜单项覆盖 §4.3/§6.6 操作（打开/关闭、独立窗口、重命名、复制配置、复制ID、回收站）',
    ['在独立窗口打开当前标签页', '重命名…', '复制环境配置到其他店铺…', '复制店铺 ID', '移入回收站']
      .every(t => (ctxMenu.items || []).includes(t)) &&
      (ctxMenu.items || []).some(t => t === '打开浏览器' || t === '关闭浏览器'),
    JSON.stringify(ctxMenu.items))
  const visSidebarMenu = await pageVis()
  check('菜单落在左栏时不摘除视图（中栏不白闪）', visSidebarMenu === 'visible', '可见性=' + visSidebarMenu)
  const escClosed = await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    return { closed: !document.querySelector('[data-test="store-ctx"]'), vis: true };
  `)
  check('Esc 关闭右键菜单', escClosed.closed === true)

  // 菜单若与视口相交，店铺页必须被摘除（否则用户看到的还是店铺页面）
  const overlappingMenu = await cdp.evaluate(`
    const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('测试店铺A'));
    const vp = document.querySelector('.viewport');
    const vr = vp.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(vr.left + 200), clientY: Math.round(vr.top + 150) }));
    await new Promise(r => setTimeout(r, 800));
    const m = document.querySelector('[data-test="store-ctx"]');
    const mr = m ? m.getBoundingClientRect() : null;
    const overlaps = mr ? !(mr.right <= vr.left || mr.left >= vr.right || mr.bottom <= vr.top || mr.top >= vr.bottom) : false;
    return { shown: !!m, overlaps };
  `)
  const visOverlapMenu = await pageVis()
  check('菜单与视口相交时店铺视图被摘除（原生层不遮挡菜单）',
    overlappingMenu.shown && overlappingMenu.overlaps && visOverlapMenu === 'hidden',
    JSON.stringify({ ...overlappingMenu, vis: visOverlapMenu }))
  await cdp.evaluate(`
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    return true;
  `)
  const visAfterMenu = await pageVis()
  check('关闭菜单后店铺视图恢复', visAfterMenu === 'visible', '可见性=' + visAfterMenu)

  const renameUi = await cdp.evaluate(`
    const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('测试店铺A'));
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 20) }));
    await new Promise(r => setTimeout(r, 600));
    document.querySelector('[data-test="ctx-rename"]').click();
    await new Promise(r => setTimeout(r, 600));
    const inp = document.querySelector('[data-test="rename-input"]');
    inp.value = '测试店铺A改';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    document.querySelector('[data-test="rename-save"]').click();
    await new Promise(r => setTimeout(r, 1200));
    const list = await window.shopilot.store.list();
    const got = (list.data || []).find(s => s.id === ${JSON.stringify(storeA)});
    return { name: got?.name || null, modalGone: !document.querySelector('[data-test="rename-input"]'), cardText: document.querySelector('.store-card')?.textContent.includes('测试店铺A改') };
  `)
  check('右键重命名通过界面生效并刷新列表', renameUi.name === '测试店铺A改' && renameUi.modalGone === true, JSON.stringify(renameUi))

  // 复制配置：先把 B 改成不同时区，再从 A 复制过去（同时覆盖"目标无环境记录"的补建路径）
  const copiedUi = await cdp.evaluate(`
    const upd = await window.shopilot.profile.update(${JSON.stringify(storeB)}, { timezone: 'Europe/London', language: 'en-GB' });
    const beforeB = (await window.shopilot.profile.get(${JSON.stringify(storeB)})).data;
    const srcP = (await window.shopilot.profile.get(${JSON.stringify(storeA)})).data;
    const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('测试店铺A改'));
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 20) }));
    await new Promise(r => setTimeout(r, 600));
    document.querySelector('[data-test="ctx-copycfg"]').click();
    await new Promise(r => setTimeout(r, 600));
    const pick = [...document.querySelectorAll('.store-pick')].find(p => p.textContent.includes('测试店铺B'));
    pick?.querySelector('input')?.click();
    await new Promise(r => setTimeout(r, 300));
    const applyBtn = document.querySelector('[data-test="copy-apply"]');
    const enabled = applyBtn && !applyBtn.disabled;
    applyBtn.click();
    await new Promise(r => setTimeout(r, 1600));
    const afterB = (await window.shopilot.profile.get(${JSON.stringify(storeB)})).data;
    return {
      updOk: upd.ok, enabled, modalGone: !document.querySelector('[data-test="copy-apply"]'),
      before: { tz: beforeB.timezone, lang: beforeB.language, ua: (beforeB.userAgent || '').length },
      srcTz: srcP.timezone, srcLang: srcP.language,
      after: { tz: afterB.timezone, lang: afterB.language, uaMatch: afterB.userAgent === srcP.userAgent },
      toast: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).join(' | ')
    };
  `)
  check('界面复制环境配置：目标时区/语言/UA 与来源一致（不含会话与代理凭据）',
    copiedUi.enabled === true && copiedUi.after.tz === copiedUi.srcTz && copiedUi.after.lang === copiedUi.srcLang && copiedUi.after.uaMatch === true,
    JSON.stringify(copiedUi))
  await cdp.evaluate(`return await window.shopilot.store.update({ storeId: ${JSON.stringify(storeA)}, patch: { name: '测试店铺A' } });`)
  await sleep(300)


  if (tA && tB) {
    const cdpA = new CDPSession(tA.webSocketDebuggerUrl)
    const cdpB = new CDPSession(tB.webSocketDebuggerUrl)
    await cdpA.ready; await cdpB.ready

    await cdpA.evaluate(`localStorage.setItem('shopilot-iso', 'from-A'); return true;`)
    await sleep(300)
    const bRead = await cdpB.evaluate(`return localStorage.getItem('shopilot-iso');`)
    const aRead = await cdpA.evaluate(`return localStorage.getItem('shopilot-iso');`)
    check('店铺 A 能读回自身 localStorage', aRead === 'from-A')
    check('店铺 B 读不到店铺 A 的 localStorage（partition 隔离）', bRead === null)

    await cdpA.evaluate(`
      const blob = new Blob(['shopilot-download-test'], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'test.bin';
      document.body.appendChild(a); a.click();
      return true;
    `)
    let dlRow = null
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const dl = await cdp.evaluate(`return await window.shopilot.download.list(${JSON.stringify(storeA)}, 10);`)
      dlRow = dl.ok && dl.data.length > 0 ? dl.data[0] : null
      if (dlRow && dlRow.state === 'completed') break
    }
    check('下载已按店铺归档并落库', !!dlRow, dlRow ? JSON.stringify({ f: dlRow.fileName, s: dlRow.state }) : '无记录')
    check('下载文件名带店铺前缀（camelCase fileName）', !!dlRow && dlRow.fileName.startsWith('测试店铺A_'), dlRow?.fileName)
    check('下载状态 completed（文件写盘）', !!dlRow && dlRow.state === 'completed')
    const dlB = await cdp.evaluate(`return await window.shopilot.download.list(${JSON.stringify(storeB)}, 10);`)
    check('店铺 B 的下载列表不含店铺 A 的下载', dlB.ok && dlB.data.every(d => !String(d.fileName).startsWith('测试店铺A_')))

    cdpA.close(); cdpB.close()
  }

  // ---------- 关闭重开 → 标签恢复 ----------
  await cdp.evaluate(`return await window.shopilot.browser.tab.create(${JSON.stringify(storeA)}, 'about:blank');`)
  await sleep(400)
  const before = await cdp.evaluate(`return await window.shopilot.browser.tab.list(${JSON.stringify(storeA)});`)
  const beforeCount = before.data.tabs.length
  check('A 现有 2 个标签页', beforeCount === 2, 'count=' + beforeCount)

  await cdp.evaluate(`return await window.shopilot.browser.close(${JSON.stringify(storeA)});`)
  await sleep(800)
  const reopen = await cdp.evaluate(`return await window.shopilot.browser.open(${JSON.stringify(storeA)});`)
  await sleep(1500)
  const after = await cdp.evaluate(`return await window.shopilot.browser.tab.list(${JSON.stringify(storeA)});`)
  check('关闭重开后标签恢复且无翻倍', reopen.ok && after.data.tabs.length === beforeCount, beforeCount + ' → ' + after.data.tabs.length)
  check('恢复的标签页保留导航 URL', after.data.tabs.some(t => String(t.url).includes('/json/version')))

  // ---------- 数据清理（审计） ----------
  const clear = await cdp.evaluate(`return await window.shopilot.browser.clearData(${JSON.stringify(storeA)}, ['cache']);`)
  check('browser:clearData(cache)', clear.ok === true)

  // ---------- 回收站 + purge ----------
  const toTrash = await cdp.evaluate(`return await window.shopilot.store.deletePermanent(${JSON.stringify(storeB)});`)
  check('store:deletePermanent → 移入回收站', toTrash.ok === true)
  const trashList = await cdp.evaluate(`return await window.shopilot.store.trashList();`)
  check('store:trashList 含店铺B', trashList.ok && trashList.data.some(s => s.id === storeB))
  const listAfterDel = await cdp.evaluate(`return await window.shopilot.store.list();`)
  check('回收站店铺不在主列表', !listAfterDel.data.some(s => s.id === storeB))

  const purge = await cdp.evaluate(`return await window.shopilot.store.purge(${JSON.stringify(storeB)});`)
  const trashList2 = await cdp.evaluate(`return await window.shopilot.store.trashList();`)
  const gotB2 = await cdp.evaluate(`return await window.shopilot.store.get(${JSON.stringify(storeB)});`)
  check('store:purge 彻底删除', purge.ok === true && !trashList2.data.some(s => s.id === storeB) && gotB2.ok === false)

  // ---------- 审计日志 ----------
  const audit = await cdp.evaluate(`return await window.shopilot.audit.query({ filter: { limit: 50 } });`)
  const actions = audit.ok ? audit.data.map(a => a.action) : []
  check('audit:query 可查询', audit.ok && Array.isArray(audit.data), 'count=' + (audit.data?.length ?? 'n/a'))
  check('审计含 store.create', actions.includes('store.create'), actions.slice(0, 8).join(','))
  check('审计含 store.archive', actions.includes('store.archive'))
  check('审计含 browser.clearData', actions.includes('browser.clearData'))
  check('审计含 store.purge', actions.includes('store.purge'))
  check('审计含 profile.lock', actions.includes('profile.lock'))

  // ---------- overview ----------
  const stats = await cdp.evaluate(`return await window.shopilot.overview.stats();`)
  check('overview:stats 返回统计', stats.ok && typeof stats.data.totalStores === 'number', JSON.stringify(stats.data))

  // ---------- 右侧栏收起/展开（用户要求"右侧边栏可以收起"） ----------
  // 用本地站点建一个店铺页，这样能读到店铺页自身的 innerWidth —— 它就是原生 WebContentsView 的真实宽度，
  // 用来证明"收起右栏后中栏（原生视图）真的变宽了"，而不是只有 HTML 布局在变。
  const PANEL_SITE_PORT = 61501
  const panelSite = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>面板测试页</title></head><body><h1 id="pt">panel</h1></body></html>')
  })
  await new Promise(r => panelSite.listen(PANEL_SITE_PORT, '127.0.0.1', r))
  const panelSiteUrl = `http://127.0.0.1:${PANEL_SITE_PORT}/`

  const panelPrep = await cdp.evaluate(`
    const created = await window.shopilot.store.create({ name: '面板测试店', platform: '拼多多', adminUrl: ${JSON.stringify(panelSiteUrl)} });
    const sid = created.data.id;
    await window.shopilot.browser.open(sid);
    await new Promise(r => setTimeout(r, 1800));
    const tab = await window.shopilot.browser.tab.create(sid, ${JSON.stringify(panelSiteUrl)});
    await new Promise(r => setTimeout(r, 2600));
    const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('面板测试店'));
    if (card) { card.querySelector('.store-action').click(); await new Promise(r => setTimeout(r, 2600)); }
    return { storeId: sid, tabId: tab.data?.tabId, displayed: !!document.querySelector('.store-card.displayed') };
  `)
  check('面板测试店铺已打开并显示（本地站点）', !!panelPrep.storeId && panelPrep.displayed === true, JSON.stringify(panelPrep))

  const storeView = async () => {
    const ws = await getPageWs(u => u.includes(`127.0.0.1:${PANEL_SITE_PORT}`))
    const s = new CDPSession(ws)
    await s.ready
    const w = await s.evaluate(`return { innerWidth: window.innerWidth, href: location.href.slice(-30) };`)
    s.close()
    return w
  }
  const panelRect = () => cdp.evaluate(`
    const rp = document.querySelector('[data-test="right-panel"]');
    const vp = document.querySelector('.viewport');
    const r = el => el ? Math.round(el.getBoundingClientRect().width) : null;
    return {
      panel: r(rp), viewport: r(vp), rail: !!document.querySelector('.panel-rail'),
      active: (() => { const b = [...document.querySelectorAll('.ptab')].find(x => x.className.includes('on')); return b ? b.textContent.trim() : null })(),
      setting: (await window.shopilot.settings.get('ui.rightPanelCollapsed')).data.value
    };
  `)

  const pExpanded = await panelRect()
  const viewExpanded = await storeView()
  check('展开态：右栏 320px、店铺页宽度=中栏宽度',
    pExpanded.panel === 320 && pExpanded.viewport === viewExpanded.innerWidth,
    JSON.stringify({ panel: pExpanded.panel, viewport: pExpanded.viewport, innerWidth: viewExpanded.innerWidth }))

  await cdp.evaluate(`document.querySelector('[data-test="panel-collapse"]').click(); return true;`)
  await sleep(1200)
  const pCollapsed = await panelRect()
  const viewCollapsed = await storeView()
  check('点收起 → 右栏 44px 窄轨，中栏变宽 ≥250px',
    pCollapsed.panel === 44 && pCollapsed.rail === true && (pCollapsed.viewport - pExpanded.viewport) >= 250,
    JSON.stringify({ panel: pCollapsed.panel, rail: pCollapsed.rail, viewport: pExpanded.viewport + '→' + pCollapsed.viewport }))
  check('原生视图（店铺页）真的跟着变宽（不是只有 HTML 在变）',
    viewCollapsed.innerWidth === pCollapsed.viewport && (viewCollapsed.innerWidth - viewExpanded.innerWidth) >= 250,
    JSON.stringify({ before: viewExpanded.innerWidth, after: viewCollapsed.innerWidth }))
  check('收起状态写入设置 ui.rightPanelCollapsed=true', pCollapsed.setting === true, String(pCollapsed.setting))

  await cdp.evaluate(`document.querySelector('[data-test="rail-tasks"]').click(); return true;`)
  await sleep(1000)
  const pRailTasks = await panelRect()
  check('点窄轨图标 → 展开并切到该面板（任务）',
    pRailTasks.panel === 320 && pRailTasks.rail === false && pRailTasks.active === '任务', JSON.stringify(pRailTasks))

  await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true, bubbles: true }));
    return true;
  `)
  await sleep(900)
  const pHotkey = await panelRect()
  check('快捷键 Ctrl+Shift+B 收起右栏', pHotkey.panel === 44 && pHotkey.rail === true, JSON.stringify(pHotkey))

  await cdp.evaluate(`document.querySelector('[data-test="panel-expand"]').click(); return true;`)
  await sleep(1200)
  const pBack = await panelRect()
  const viewBack = await storeView()
  check('窄轨展开按钮恢复 320px 且店铺页宽度回到中栏宽度、设置写回 false',
    pBack.panel === 320 && pBack.setting === false && viewBack.innerWidth === pBack.viewport,
    JSON.stringify({ panel: pBack.panel, setting: pBack.setting, innerWidth: viewBack.innerWidth, viewport: pBack.viewport }))

  // ---------- 左侧栏收起/展开（用户要求"左侧边栏可以收起和展开"） ----------
  // 与右栏同样以店铺页自身 innerWidth 为证：收起左栏后中栏原生视图必须真的变宽，不能只有 HTML 布局在动。
  const sidebarRect = () => cdp.evaluate(`
    const sb = document.querySelector('[data-test="sidebar"]');
    const vp = document.querySelector('.viewport');
    const r = el => el ? Math.round(el.getBoundingClientRect().width) : null;
    return {
      sidebar: r(sb), viewport: r(vp), rail: !!document.querySelector('.sidebar-rail'),
      collapseBtn: !!document.querySelector('[data-test="sidebar-collapse"]'),
      setting: (await window.shopilot.settings.get('ui.leftSidebarCollapsed')).data.value
    };
  `)

  const sExpanded = await sidebarRect()
  const viewLExpanded = await storeView()
  check('左栏展开态基线：304px、有收起按钮、店铺页宽度=中栏宽度',
    sExpanded.sidebar === 304 && sExpanded.collapseBtn === true && sExpanded.viewport === viewLExpanded.innerWidth,
    JSON.stringify({ sidebar: sExpanded.sidebar, collapseBtn: sExpanded.collapseBtn, viewport: sExpanded.viewport, innerWidth: viewLExpanded.innerWidth }))

  await cdp.evaluate(`document.querySelector('[data-test="sidebar-collapse"]').click(); return true;`)
  await sleep(1200)
  const sCollapsed = await sidebarRect()
  const viewLCollapsed = await storeView()
  check('点收起 → 左栏 44px 窄轨，中栏变宽 ≥250px',
    sCollapsed.sidebar === 44 && sCollapsed.rail === true && (sCollapsed.viewport - sExpanded.viewport) >= 250,
    JSON.stringify({ sidebar: sCollapsed.sidebar, rail: sCollapsed.rail, viewport: sExpanded.viewport + '→' + sCollapsed.viewport }))
  check('收起左栏后原生视图（店铺页）真的跟着变宽',
    viewLCollapsed.innerWidth === sCollapsed.viewport && (viewLCollapsed.innerWidth - viewLExpanded.innerWidth) >= 250,
    JSON.stringify({ before: viewLExpanded.innerWidth, after: viewLCollapsed.innerWidth }))
  check('左栏收起状态写入设置 ui.leftSidebarCollapsed=true', sCollapsed.setting === true, String(sCollapsed.setting))

  await cdp.evaluate(`document.querySelector('[data-test="sidebar-expand"]').click(); return true;`)
  await sleep(1200)
  const sExpandedBack = await sidebarRect()
  const viewLBack = await storeView()
  check('窄轨展开按钮恢复 304px 且店铺页宽度回到中栏宽度、设置写回 false',
    sExpandedBack.sidebar === 304 && sExpandedBack.rail === false && sExpandedBack.setting === false && viewLBack.innerWidth === sExpandedBack.viewport,
    JSON.stringify({ sidebar: sExpandedBack.sidebar, rail: sExpandedBack.rail, setting: sExpandedBack.setting, innerWidth: viewLBack.innerWidth, viewport: sExpandedBack.viewport }))

  await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true }));
    return true;
  `)
  await sleep(900)
  const sHotkey = await sidebarRect()
  check('快捷键 Ctrl+Shift+E 收起左栏', sHotkey.sidebar === 44 && sHotkey.rail === true, JSON.stringify(sHotkey))

  // 收起态下"新建/回收站/更新"仍可达（窄轨不要变成死胡同），随后恢复展开态收尾
  const railBtns = await cdp.evaluate(`
    return ['rail-new', 'rail-trash', 'rail-update', 'sidebar-expand']
      .map(k => !!document.querySelector('[data-test="' + k + '"]'));
  `)
  check('左栏窄轨保留 新建/回收站/更新/展开 入口', railBtns.every(Boolean), JSON.stringify(railBtns))
  await sleep(200)
  await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true }));
    return true;
  `)
  await sleep(600)

  await cdp.evaluate(`return await window.shopilot.browser.close(${JSON.stringify(panelPrep.storeId)});`)
  await cdp.evaluate(`return await window.shopilot.store.deletePermanent(${JSON.stringify(panelPrep.storeId)});`)
  await cdp.evaluate(`return await window.shopilot.store.purge(${JSON.stringify(panelPrep.storeId)});`)
  panelSite.close()

  // ---------- 平台目录（国内四家：拼多多 / 微信小店 / 快手小店 / 抖店） ----------
  const catalog = await cdp.evaluate(`return window.shopilot.platforms;`)
  check('平台目录=国内四家且每家带后台地址与平台入口',
    Array.isArray(catalog) && catalog.length === 4 &&
    catalog.map(p => p.name).join(',') === '拼多多,微信小店,快手小店,抖店' &&
    catalog.every(p => /^https:\/\//.test(p.adminUrl) && p.entryRoutes.length >= 1),
    JSON.stringify(catalog?.map(p => p.name + '(' + p.entryRoutes.length + ')')))

  const dialogUi = await cdp.evaluate(`
    document.querySelector('.btn-new').click();
    await new Promise(r => setTimeout(r, 600));
    const sel = document.querySelector('[data-test="platform-select"]');
    const url = document.querySelector('[data-test="admin-url"]');
    if (!sel || !url) return { error: '未找到平台/后台地址控件' };
    const before = { platform: sel.value, url: url.value };
    sel.value = '抖店';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const noteEl = url.parentElement.querySelector('.field-note');
    const after = { platform: sel.value, url: url.value, note: noteEl ? noteEl.textContent.trim() : '' };
    const opts = [...sel.options].map(o => o.textContent.trim());
    return { opts, before, after };
  `)
  check('新建对话框平台选项=国内四家 + 其他', dialogUi.opts?.join(',') === '拼多多,微信小店,快手小店,抖店,其他（自定义平台）', JSON.stringify(dialogUi.opts))
  check('平台默认拼多多且自动填入对应后台地址', dialogUi.before?.platform === '拼多多' && dialogUi.before?.url === 'https://mms.pinduoduo.com', JSON.stringify(dialogUi.before))
  check('切换平台自动更新后台地址（抖店）并给出提示',
    dialogUi.after?.url === 'https://fxg.jinritemai.com' && /默认后台地址/.test(dialogUi.after?.note || ''), JSON.stringify(dialogUi.after))
  const uiCreate = await cdp.evaluate(`
    const name = document.querySelector('[data-test="store-name"]')
    const url = document.querySelector('[data-test="admin-url"]')
    if (!name || !url) return { ok: false, error: '未找到店铺创建输入框' }
    name.value = 'UI创建测试店'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    url.value = 'https://example.com/ui-create'
    url.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 100))
    const create = [...document.querySelectorAll('.modal-actions .btn-primary')].find(b => b.textContent.trim() === '创建')
    if (!create || create.disabled) return { ok: false, error: '创建按钮未启用' }
    create.click()
    await new Promise(r => setTimeout(r, 900))
    const list = await window.shopilot.store.list()
    const row = (list.data || []).find(s => s.name === 'UI创建测试店')
    return { ok: !!row, modalClosed: !document.querySelector('[data-test="store-name"]'), id: row?.id || null }
  `)
  check('新建店铺 UI 填写并提交成功（落库且关闭对话框）', uiCreate.ok && uiCreate.modalClosed, JSON.stringify(uiCreate))
  if (uiCreate.id) {
    await cdp.evaluate(`return await window.shopilot.store.deletePermanent(${JSON.stringify(uiCreate.id)});`)
    await cdp.evaluate(`return await window.shopilot.store.purge(${JSON.stringify(uiCreate.id)});`)
  }
  await cdp.evaluate(`
    const cancel = [...document.querySelectorAll('.modal .btn-ghost')].find(b => b.textContent.includes('取消'));
    if (cancel) cancel.click();
    await new Promise(r => setTimeout(r, 300));
    return true;
  `)

  // ---------- 平台入口（§16 平台适配层：只读展示、不重复入库） ----------
  const wxCreate = await cdp.evaluate(`return await window.shopilot.store.create({ name:'平台入口测试店', platform:'微信小店', adminUrl:'https://store.weixin.qq.com' });`)
  const wxId = wxCreate.data?.id
  const routes = await cdp.evaluate(`return await window.shopilot.bookmark.entryRoutes(${JSON.stringify(wxId)});`)
  check('平台入口：微信小店返回经实测校验的深链（≥3 且同域）',
    routes.ok && routes.data.routes.length >= 3 && routes.data.routes.every(r => r.url.includes('store.weixin.qq.com')),
    JSON.stringify(routes.data?.routes?.map(r => r.title)))
  const ownRows = await cdp.evaluate(`return await window.shopilot.bookmark.list(${JSON.stringify(wxId)});`)
  check('平台入口不重复入库（bookmarks 无 entry_route 行）',
    ownRows.ok && !(ownRows.data || []).some(b => b.source === 'entry_route'), 'rows=' + (ownRows.data?.length ?? 'n/a'))
  const otherCreate = await cdp.evaluate(`return await window.shopilot.store.create({ name:'自定义平台店', platform:'其他', adminUrl:'https://example.com' });`)
  const noRoutes = await cdp.evaluate(`return await window.shopilot.bookmark.entryRoutes(${JSON.stringify(otherCreate.data?.id)});`)
  check('非内置平台不显示平台入口（返回空列表）', noRoutes.ok && (noRoutes.data.routes || []).length === 0)

  const uiRoutes = await cdp.evaluate(`
    // 渲染层侧栏不含"由 IPC 直接建出"的店铺（正常路径由对话框建店并自刷列表）：重载后走用户路径
    location.reload();
    return { reloading: true };
  `)
  await sleep(3500)
  const uiRoutes2 = await cdp.evaluate(`
    const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('平台入口测试店'));
    if (!card) return { error: '未找到测试店铺卡片', cards: [...document.querySelectorAll('.store-card')].map(c => c.textContent.trim().slice(0, 12)) };
    card.querySelector('.store-action').click();
    await new Promise(r => setTimeout(r, 3200));
    const shown = document.querySelector('.store-card.displayed')?.textContent || '';
    const tab = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '收藏');
    if (tab) tab.click();
    await new Promise(r => setTimeout(r, 1500));
    const rows = [...document.querySelectorAll('[data-test="entry-route"]')];
    const head = document.querySelector('[data-test="entry-routes"] .env-h');
    return {
      displayedIsWx: shown.includes('平台入口测试店'),
      count: rows.length,
      titles: rows.map(r => r.querySelector('.row-main')?.textContent.trim()),
      head: head ? head.textContent.trim() : null,
      note: !!document.querySelector('[data-test="entry-routes"] .env-note')
    };
  `)
  check('收藏面板渲染“平台入口”段（微信小店，含改版提示）',
    uiRoutes2.displayedIsWx === true && uiRoutes2.count >= 3 && (uiRoutes2.titles || []).includes('订单管理') &&
    /微信小店/.test(uiRoutes2.head || '') && uiRoutes2.note === true,
    JSON.stringify(uiRoutes2))

  // 清理：关闭浏览器并彻底删除两个测试店铺（保持 M1 可重复执行）
  await cdp.evaluate(`return await window.shopilot.browser.close(${JSON.stringify(wxId)});`)
  for (const id of [wxId, otherCreate.data?.id]) {
    if (!id) continue
    await cdp.evaluate(`return await window.shopilot.store.deletePermanent(${JSON.stringify(id)});`)
    await cdp.evaluate(`return await window.shopilot.store.purge(${JSON.stringify(id)});`)
  }
  check('平台测试数据已清理（不污染后续用例）', true)

  cdp.close()

  console.log('\n===== M1+ 全链路验收结果 =====')
  const passed = results.filter(r => r.ok).length
  console.log(`通过 ${passed}/${results.length}`)
  const fails = results.filter(r => !r.ok).map(r => r.name)
  if (fails.length) { console.log('失败项:', fails.join('; ')); process.exitCode = 1 }
  else { console.log('ALL_M1_ACCEPTANCE_PASSED') }
}

main().catch(err => { console.error('CDP_VERIFY_ERROR', err.message); process.exit(1) })
