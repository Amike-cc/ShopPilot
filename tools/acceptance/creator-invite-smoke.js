/**
 * 达人邀约 v2 冒烟验收（2026-10-19）
 *
 * 目标：在**真实 Electron 主窗口**里走一遍：
 *   应用中心 → 达人邀约卡片 → 独立模块页 → 页面数据 IPC → 就地配置面板。
 * 不触碰平台页面、不发送任何邀约；只验证路由、迁移 v33、preload/IPC、空态，
 * 以及「邀约在后端隐藏窗口运行、不占用户标签页」这条产品红线。
 *
 * 用法：node tools/acceptance/creator-invite-smoke.js
 * 前置：pnpm build（source runner 读 apps/desktop/out）；打包产物存在时也可直接跑。
 */
const { spawn, execSync } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { resolveApp, appArgs, childEnv } = require('./app-launch')
const { waitForMainWindow, createChecker, sleep } = require('./cdp-client')

const root = path.resolve(__dirname, '../..')
const app = resolveApp(root)
const port = process.env.SHOPILOT_CDP_PORT || '9257'
const userData = path.join(os.tmpdir(), 'shopilot-invite-smoke-' + Date.now())
const checker = createChecker()

function killTree(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 已退出 */ }
}

async function main() {
  fs.mkdirSync(userData, { recursive: true })
  console.log('=== 启动 Electron（独立 userData） ===')
  console.log('app:', app.executable, 'packaged:', app.packaged, 'userData:', userData)
  const child = spawn(app.executable, appArgs(root, app, {
    port,
    userData,
    extra: ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows']
  }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1' })
  })
  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  /**
   * 本地静态页：用真实浏览器步骤验证"后台隐藏窗口里 DOM 能布局、能点"。
   * 不依赖平台登录，也不发任何邀约——只走 navigate / waitForText / clickByText。
   */
  const localServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (String(req.url || '').startsWith('/detail')) {
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>详情</title></head><body><h1>详情页就绪</h1></body></html>')
      return
    }
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>后台页</title></head><body><h1>后台就绪</h1><button onclick="document.getElementById(\'out\').textContent=\'已点击\'">点我</button><div id="out"></div><a href="/detail" target="_blank">查看详情</a></body></html>')
  })
  await new Promise(resolve => localServer.listen(0, '127.0.0.1', resolve))
  const localPort = localServer.address().port

  let client = null
  try {
    client = await waitForMainWindow(port, { timeoutMs: 60000 })
    checker.check('主窗口 CDP 就绪', !!client)
    if (!client) throw new Error('主窗口未就绪')

    const nav = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 60; i++) {
        if (document.querySelector('[data-test="dashboard-home"]')) break;
        await wait(250);
      }
      const item = [...document.querySelectorAll('.dashboard-nav-item')].find(el => String(el.textContent || '').includes('应用中心'));
      if (!item) return { ok: false, reason: 'no-apps-nav', text: document.body.innerText.slice(0, 400) };
      item.click();
      await wait(600);
      const card = document.querySelector('[data-test="apps-card-invite"]');
      return { ok: !!card, card: !!card, text: card ? String(card.innerText || '').slice(0, 160) : document.body.innerText.slice(0, 400) };
    `)
    checker.check('应用中心存在「达人邀约」卡片', nav.ok === true, JSON.stringify(nav))

    const page = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const card = document.querySelector('[data-test="apps-card-invite"]');
      if (!card) return { ok: false, reason: 'no-card' };
      card.click();
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('[data-test="creator-invite-page"]')) break;
        await wait(200);
      }
      await wait(900);
      const root = document.querySelector('[data-test="creator-invite-page"]');
      return {
        ok: !!root,
        page: !!root,
        kpi: !!document.querySelector('[data-test="invite-v2-kpi"]'),
        tabs: !!document.querySelector('[data-test="invite-v2-tab-tasks"]'),
        empty: !!document.querySelector('[data-test="invite-v2-empty"]'),
        text: root ? String(root.innerText || '').slice(0, 300) : document.body.innerText.slice(0, 400)
      };
    `)
    checker.check('应用中心卡片进入独立模块页', page.page === true, JSON.stringify(page))
    checker.check('工作台 KPI 与页签渲染', page.kpi === true && page.tabs === true, JSON.stringify({ kpi: page.kpi, tabs: page.tabs }))
    checker.check('无店铺/无批次时显示如实空态', page.empty === true, JSON.stringify({ empty: page.empty }))

    const ipc = await client.eval(`
      const summary = await window.shopilot.invite.summary({});
      const campaigns = await window.shopilot.invite.campaigns({ limit: 5 });
      const records = await window.shopilot.invite.records({ limit: 5 });
      return {
        summaryOk: summary && summary.ok === true,
        campaignsOk: campaigns && campaigns.ok === true,
        recordsOk: records && records.ok === true,
        summary: summary && summary.data ? summary.data : null,
        campaignCount: campaigns && Array.isArray(campaigns.data) ? campaigns.data.length : -1,
        recordCount: records && Array.isArray(records.data) ? records.data.length : -1
      };
    `)
    checker.check('邀约汇总 IPC 可用', ipc.summaryOk === true, JSON.stringify(ipc))
    checker.check('批次/记录 IPC 可用', ipc.campaignsOk === true && ipc.recordsOk === true, JSON.stringify({ campaigns: ipc.campaignsOk, records: ipc.recordsOk }))
    checker.check('新库汇总为零（不补假数）', ipc.summary && ipc.summary.total === 0, JSON.stringify(ipc.summary))

    /**
     * 批次创建链路：用 waitMs 任务（不碰平台页面、不发送任何邀约）验证
     * INVITE_CAMPAIGN_START → tasks.kind/campaign_id → 批次列表/详情。
     */
    const campaign = await client.eval(`
      const store = await window.shopilot.store.create({ name: '冒烟测试店', platform: '抖店', adminUrl: 'https://example.com/' });
      if (!store.ok) return { ok: false, stage: 'store', error: store.error };
      const task = {
        name: '达人邀约 · 抖店 · 冒烟 · 最多 1 位',
        storeScope: store.data.id,
        kind: 'creator_invite',
        source: 'panel',
        steps: [{ type: 'waitMs', input: { ms: 500 }, timeoutMs: 3000 }]
      };
      const started = await window.shopilot.invite.startCampaign({
        task,
        campaign: { storeId: store.data.id, targetCount: 1, filters: { category: '美妆' }, scriptText: '冒烟话术' }
      });
      if (!started.ok) return { ok: false, stage: 'start', error: started.error };
      const list = await window.shopilot.invite.campaigns({ storeId: store.data.id, limit: 5 });
      const detail = await window.shopilot.invite.campaignDetail(started.data.campaignId);
      return {
        ok: true,
        campaignId: started.data.campaignId,
        taskKind: started.data.task && started.data.task.kind,
        taskCampaignId: started.data.task && started.data.task.campaignId,
        listOk: list.ok,
        listCount: list.ok && Array.isArray(list.data) ? list.data.length : -1,
        detailOk: detail.ok,
        detailName: detail.ok ? detail.data?.campaign?.name : null,
        filters: detail.ok ? detail.data?.campaign?.filters : null
      };
    `)
    checker.check('批次创建链路可用（task.kind/campaignId 已落库）',
      campaign.ok === true && campaign.taskKind === 'creator_invite' && campaign.taskCampaignId === campaign.campaignId,
      JSON.stringify(campaign))
    checker.check('批次列表/详情可读', campaign.listOk === true && campaign.listCount === 1 && campaign.detailOk === true && campaign.detailName === '达人邀约 · 抖店 · 冒烟 · 最多 1 位', JSON.stringify(campaign))

    const tabs = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const click = async sel => { const el = document.querySelector(sel); if (el) { el.click(); await wait(350); } return !!el; };
      // 冒烟直接走 IPC 建店，ws.stores 不会自动刷新；点一次页面刷新让它发现新店并选中
      await click('[data-test="invite-v2-refresh"]');
      const creatorsTab = await click('[data-test="invite-v2-tab-creators"]');
      const creatorsEmpty = !!document.querySelector('[data-test="invite-v2-creators-empty"]');
      const assetsTab = await click('[data-test="invite-v2-tab-assets"]');
      const scriptInput = !!document.querySelector('[data-test="invite-v2-script-name"]');
      const quota = !!document.querySelector('[data-test="invite-v2-quota"]');

      // 页签拆分后的独立组件：任务列表 → 详情抽屉 → 说明页 → 记录页
      await click('[data-test="invite-v2-tab-tasks"]');
      const row = document.querySelector('[data-test="invite-v2-campaign-row"]');
      if (row) { row.click(); await wait(900); }
      const drawer = document.querySelector('[data-test="invite-v2-campaign-detail"]');
      const drawerTitle = drawer ? String((drawer.querySelector('h2') || {}).textContent || '') : '';
      const drawerKpis = drawer ? drawer.querySelectorAll('.invite-detail-kpis span').length : 0;
      const closeBtn = drawer ? [...drawer.querySelectorAll('button')].find(b => String(b.textContent || '').trim() === '关闭') : null;
      if (closeBtn) { closeBtn.click(); await wait(300); }
      const drawerClosed = !document.querySelector('[data-test="invite-v2-campaign-detail"]');

      await click('[data-test="invite-v2-tab-about"]');
      const aboutText = String((document.querySelector('.invite-about') || {}).innerText || '');
      await click('[data-test="invite-v2-tab-records"]');
      const recordsEmpty = !!document.querySelector('[data-test="invite-v2-records-empty"]');

      return { creatorsTab, creatorsEmpty, assetsTab, scriptInput, quota,
        drawer: !!drawer, drawerTitle, drawerKpis, drawerClosed,
        about: aboutText.includes('配置入口在哪') && aboutText.includes('后端隐藏窗口执行'),
        recordsEmpty };
    `)
    checker.check('达人库页签可打开（无记录时如实空态）', tabs.creatorsTab === true && tabs.creatorsEmpty === true, JSON.stringify(tabs))
    checker.check('资产页签与额度 chip 渲染', tabs.assetsTab === true && tabs.scriptInput === true && tabs.quota === true, JSON.stringify(tabs))
    checker.check('任务页签打开批次详情抽屉并可关闭',
      tabs.drawer === true && tabs.drawerTitle.includes('冒烟') && tabs.drawerKpis >= 4 && tabs.drawerClosed === true,
      JSON.stringify({ drawer: tabs.drawer, drawerTitle: tabs.drawerTitle, drawerKpis: tabs.drawerKpis, drawerClosed: tabs.drawerClosed }))
    checker.check('说明页与记录页（拆分组件）渲染', tabs.about === true && tabs.recordsEmpty === true, JSON.stringify({ about: tabs.about, recordsEmpty: tabs.recordsEmpty }))

    /**
     * 独立页就地配置：以前「新建邀约」会跳到店铺浏览器侧栏；现在必须留在本页，
     * 因为发送改由主进程隐藏窗口负责，不再需要用户先打开店铺。
     */
    const launcher = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const click = async sel => { const el = document.querySelector(sel); if (el) { el.click(); await wait(400); } return !!el; };
      await click('[data-test="invite-v2-tab-tasks"]');
      const opened = await click('[data-test="invite-v2-open-config"]');
      for (let i = 0; i < 30; i++) {
        if (document.querySelector('[data-test="invite-v2-launcher"]')) break;
        await wait(200);
      }
      await wait(600);
      const box = document.querySelector('[data-test="invite-v2-launcher"]');
      return {
        opened,
        launcher: !!box,
        panel: !!(box && box.querySelector('[data-test="invite-panel"]')),
        start: !!(box && box.querySelector('[data-test="invite-start"]')),
        storeSelect: !!(box && box.querySelector('[data-test="invite-v2-launcher-store"]')),
        storeOptions: box ? box.querySelectorAll('[data-test="invite-v2-launcher-store"] option').length : 0,
        storeValue: box ? String((box.querySelector('[data-test="invite-v2-launcher-store"]') || {}).value || '') : '',
        backendNote: !!(box && box.querySelector('[data-test="invite-backend-note"]')),
        stillOnPage: !!document.querySelector('[data-test="creator-invite-page"]')
      };
    `)
    checker.check('独立页就地打开配置面板（不跳店铺浏览器）',
      launcher.opened === true && launcher.launcher === true && launcher.panel === true && launcher.start === true && launcher.stillOnPage === true,
      JSON.stringify(launcher))
    checker.check('面板明确标注后台运行', launcher.backendNote === true, JSON.stringify({ backendNote: launcher.backendNote }))
    checker.check('配置面板可指定店铺（店铺下拉已接入）',
      launcher.storeSelect === true && launcher.storeOptions >= 1 && launcher.storeValue.length > 0,
      JSON.stringify({ storeSelect: launcher.storeSelect, storeOptions: launcher.storeOptions, storeValue: launcher.storeValue }))

    /**
     * 四步向导（2026-10-20）：目标 → 受众 → 话术 → 确认。
     * 断言步骤按钮存在、可切换，且切到第 4 步时「开始邀约」与定时输入都在同一屏。
     */
    const wizard = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const box = () => document.querySelector('[data-test="invite-v2-launcher"]');
      const steps = box() ? box().querySelectorAll('[data-test="invite-v2-steps"] .invite-step') : [];
      const clickStep = async n => {
        const el = box() && box().querySelector('[data-test="invite-v2-step-' + n + '"]');
        if (el) { el.click(); await wait(320); }
        return !!el;
      };
      const visible = sel => {
        const el = box() && box().querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // 同一选择器可能有多个（不同步骤里的 chip）：只要"有一个可见"就算这一步渲染了。
      const anyVisible = sel => [...(box() ? box().querySelectorAll(sel) : [])].some(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const step1Category = visible('[data-test="invite-category"]');
      const ok2 = await clickStep(2);
      const step2Chip = anyVisible('.inv-chip');
      const step1HiddenOn2 = !visible('[data-test="invite-category"]');
      const ok3 = await clickStep(3);
      const step3Script = visible('[data-test="invite-script"]') ?? visible('[data-test="invite-step3-noop"]');
      const ok4 = await clickStep(4);
      const step4Start = visible('[data-test="invite-start"]');
      return { steps: steps.length, ok2, ok3, ok4, step1Category, step1HiddenOn2, step2Chip, step3Script: !!step3Script, step4Start };
    `)
    checker.check('四步向导可切换（目标/受众/话术/确认）',
      wizard.steps === 4 && wizard.ok2 && wizard.ok3 && wizard.ok4 && wizard.step1Category === true &&
      wizard.step1HiddenOn2 === true && wizard.step2Chip === true && wizard.step3Script === true && wizard.step4Start === true,
      JSON.stringify(wizard))

    /**
     * 定时邀约（2026-10-20）：排期批次不入队，状态为 scheduled；取消后变 stopped。
     * 这里用 IPC 直接建（不点 UI 的 datetime-local，避免依赖本机时区格式），
     * 验证的是主进程排期语义与取消路径——真正到点拉起由单测覆盖。
     */
    const scheduled = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const store = await window.shopilot.store.create({ name: '定时邀约测试店', platform: '抖店', adminUrl: 'https://example.com/' });
      if (!store.ok) return { ok: false, stage: 'store', error: store.error };
      const at = Date.now() + 30 * 60 * 1000;
      const started = await window.shopilot.invite.startCampaign({
        task: { name: '达人邀约 · 抖店 · 定时', storeScope: store.data.id, steps: [{ type: 'waitMs', input: { ms: 120 }, timeoutMs: 3000 }] },
        campaign: { storeId: store.data.id, targetCount: 1, filters: {}, scriptText: '', scheduleAt: at }
      });
      if (!started.ok) return { ok: false, stage: 'start', error: started.error };
      const detail = await window.shopilot.invite.campaignDetail(started.data.campaignId);
      const row = detail.ok ? detail.data.campaign : null;
      const cancel = await window.shopilot.invite.cancelScheduled(started.data.campaignId);
      const after = await window.shopilot.invite.campaignDetail(started.data.campaignId);
      const cancelAgain = await window.shopilot.invite.cancelScheduled(started.data.campaignId);
      const past = await window.shopilot.invite.startCampaign({
        task: { name: '达人邀约 · 抖店 · 过去时间', storeScope: store.data.id, steps: [{ type: 'waitMs', input: { ms: 120 }, timeoutMs: 3000 }] },
        campaign: { storeId: store.data.id, targetCount: 1, scheduleAt: Date.now() - 60000 }
      });
      return {
        ok: true,
        status: row ? row.status : null,
        scheduledAt: row ? row.scheduledAt : null,
        runId: row ? row.runId : null,
        cancelOk: cancel.ok === true,
        afterStatus: after.ok ? after.data.campaign.status : null,
        cancelAgainOk: cancelAgain.ok === true,
        pastRejected: past.ok === false,
        pastMessage: past.ok === false ? past.error.message : ''
      };
    `)
    checker.check('定时邀约：建批次后状态=scheduled 且没有 run（不立即发送）',
      scheduled.ok === true && scheduled.status === 'scheduled' && scheduled.scheduledAt > 0 && !scheduled.runId,
      JSON.stringify(scheduled))
    checker.check('定时邀约：取消排期 → stopped，重复取消被拒绝',
      scheduled.cancelOk === true && scheduled.afterStatus === 'stopped' && scheduled.cancelAgainOk === false,
      JSON.stringify({ cancelOk: scheduled.cancelOk, afterStatus: scheduled.afterStatus, cancelAgainOk: scheduled.cancelAgainOk }))
    checker.check('定时邀约：过去时间被拒绝（不静默改成立即发送）',
      scheduled.pastRejected === true && String(scheduled.pastMessage).includes('1 分钟'),
      JSON.stringify({ pastRejected: scheduled.pastRejected, message: scheduled.pastMessage }))

    /**
     * 后端运行：waitMs 任务的批次必须真的跑到 succeeded（说明隐藏工作页建得起来、页面句柄可用），
     * 同时浏览器状态里**不能**出现任何可见标签页——运行不该替用户打开店铺。
     */
    const background = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const campaignId = ${JSON.stringify(campaign && campaign.campaignId ? campaign.campaignId : '')};
      let status = null;
      let last = null;
      for (let i = 0; i < 30; i++) {
        const detail = await window.shopilot.invite.campaignDetail(campaignId);
        last = detail && detail.ok ? detail.data : null;
        status = last && last.campaign ? last.campaign.status : null;
        if (status === 'completed' || status === 'failed' || status === 'cancelled') break;
        await wait(300);
      }
      const state = await window.shopilot.browser.state();
      const visibleTabs = state && state.ok ? (state.data.stores || []).reduce((sum, s) => sum + (s.tabs || []).filter(t => t.internal !== true).length, 0) : -1;
      return { status, visibleTabs, campaignId, runStatus: last && last.campaign ? last.campaign.status : null };
    `)
    checker.check('后台工作页可用：批次跑到终态（completed）', background.status === 'completed', JSON.stringify(background))
    checker.check('运行没有打开任何可见标签页（不占用户浏览器）', background.visibleTabs === 0, JSON.stringify({ visibleTabs: background.visibleTabs }))

    /**
     * 真实页面步骤（本地 HTTP）：证明隐藏窗口不是"只占个位"——
     * waitForText 依赖 getBoundingClientRect>0，如果窗口没布局会直接失败。
     */
    const local = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const store = await window.shopilot.store.create({ name: '后台页测试店', platform: '抖店', adminUrl: 'https://example.com/' });
      if (!store.ok) return { ok: false, stage: 'store', error: store.error };
      const started = await window.shopilot.invite.startCampaign({
        task: {
          name: '达人邀约 · 抖店 · 后台页',
          storeScope: store.data.id,
          kind: 'creator_invite',
          source: 'panel',
          steps: [
            { type: 'navigate', input: { url: 'http://127.0.0.1:${localPort}/' }, timeoutMs: 20000 },
            { type: 'waitForText', input: { text: '后台就绪' }, timeoutMs: 12000 },
            { type: 'clickByText', input: { text: '点我' }, timeoutMs: 12000 },
            { type: 'waitForText', input: { text: '已点击' }, timeoutMs: 12000 },
            // window.open / target=_blank → 主进程隐藏子页：followTab 必须能跟过去，且仍不产生可见标签页
            { type: 'clickByText', input: { text: '查看详情', mode: 'real', followTab: { urlIncludes: '/detail' } }, timeoutMs: 12000 },
            { type: 'waitForPage', input: { urlIncludes: '/detail' }, timeoutMs: 12000 },
            { type: 'waitForText', input: { text: '详情页就绪' }, timeoutMs: 12000 }
          ]
        },
        campaign: { storeId: store.data.id, targetCount: 1, filters: {}, scriptText: '' }
      });
      if (!started.ok) return { ok: false, stage: 'start', error: started.error };
      let status = null;
      for (let i = 0; i < 60; i++) {
        const detail = await window.shopilot.invite.campaignDetail(started.data.campaignId);
        status = detail && detail.ok && detail.data.campaign ? detail.data.campaign.status : null;
        if (status === 'completed' || status === 'failed' || status === 'cancelled') break;
        await wait(300);
      }
      const state = await window.shopilot.browser.state();
      const visibleTabs = state && state.ok ? (state.data.stores || []).reduce((sum, s) => sum + (s.tabs || []).filter(t => t.internal !== true).length, 0) : -1;
      const detail = await window.shopilot.invite.campaignDetail(started.data.campaignId);
      const diag = await window.shopilot.browser.memoryDiagnostics();
      const backgroundPages = diag && diag.ok && Array.isArray(diag.data.backgroundPages) ? diag.data.backgroundPages.length : -1;
      return {
        ok: true, status, visibleTabs, backgroundPages,
        stopReason: detail && detail.ok && detail.data.campaign ? detail.data.campaign.stopReason : null,
        storeId: store.data.id
      };
    `)
    checker.check('后台隐藏窗口能真实布局并点击（本地页面）', local.ok === true && local.status === 'completed', JSON.stringify(local))
    checker.check('真实页面步骤也没有打开可见标签页', local.visibleTabs === 0, JSON.stringify({ visibleTabs: local.visibleTabs }))
    checker.check('终态释放后台页（诊断里 backgroundPages=0，无隐藏窗口泄漏）', local.backgroundPages === 0, JSON.stringify({ backgroundPages: local.backgroundPages }))

    const ok = checker.summary('达人邀约 v2 冒烟')
    if (!ok) {
      console.log('\n--- app log tail ---\n' + log.slice(-4000))
      process.exitCode = 1
    }
  } catch (error) {
    console.error('冒烟失败：', error)
    console.log('\n--- app log tail ---\n' + log.slice(-4000))
    process.exitCode = 1
  } finally {
    try { client?.close() } catch { /* ignore */ }
    try { localServer.close() } catch { /* ignore */ }
    killTree(child)
    await sleep(500)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main()
