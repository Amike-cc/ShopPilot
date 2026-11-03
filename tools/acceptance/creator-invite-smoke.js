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
    /**
     * 抖店逐人沟通的本地替身：一个「在线沟通」按钮 + 永远停在底部的滚动容器。
     * 用来验证 clickByText(recordRowText+nth) → scrollNext 到底 → 按预期收工 这条链，
     * 不登录、不触达任何平台页面。
     */
    if (String(req.url || '').startsWith('/invite-list')) {
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>广场</title>
<style>body{margin:0;font:14px/1.4 sans-serif}#sc{height:220px;overflow:auto;border:1px solid #ddd}#inner{height:260px;position:relative}table{width:100%;border-collapse:collapse;position:absolute;bottom:0}td{padding:6px}</style>
</head><body><div id="sc"><div id="inner"><table><tbody>
<tr><td><span class="truncate">达人甲</span></td><td>美妆</td><td><button>在线沟通</button></td></tr>
</tbody></table></div></div>
<script>b=document.getElementById('sc');setInterval(()=>{b.scrollTop=b.scrollHeight},80);</script>
</body></html>`)
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

    /**
     * 应用中心已下线达人邀约（2026-10-25 用户要求：只保留店铺浏览器右侧边栏）。
     * 断言：应用中心不再出现该卡片。
     */
    const apps = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 60; i++) {
        if (document.querySelector('[data-test="dashboard-home"]')) break;
        await wait(250);
      }
      const item = [...document.querySelectorAll('.dashboard-nav-item')].find(el => String(el.textContent || '').includes('应用中心'));
      if (!item) return { ok: false, reason: 'no-apps-nav', text: document.body.innerText.slice(0, 400) };
      item.click();
      await wait(700);
      const cards = [...document.querySelectorAll('[data-test^="apps-card-"]')].map(el => el.getAttribute('data-test'));
      return {
        ok: true,
        hasInvite: !!document.querySelector('[data-test="apps-card-invite"]'),
        cards
      };
    `)
    checker.check('应用中心已下线「达人邀约」入口', apps.ok === true && apps.hasInvite === false, JSON.stringify(apps))

    /**
     * 唯一入口：店铺浏览器右侧「达人邀约」面板。
     * 用 IPC 建店 → 重载页面 → 点店铺卡打开浏览器 → 点右栏 rail-invite。
     */
    const sidebarStoreId = await client.eval(`
      const created = await window.shopilot.store.create({ name: '冒烟侧栏店', platform: '抖店', adminUrl: 'https://example.com/' });
      return created && created.ok ? String(created.data.id) : '';
    `)
    checker.check('侧栏测试店铺创建成功', typeof sidebarStoreId === 'string' && sidebarStoreId.length > 0, JSON.stringify({ sidebarStoreId }))
    await client.eval('location.reload()').catch(() => {})
    for (let i = 0; i < 40; i++) {
      const ready = await client.eval(`!!document.querySelector('[data-test="dashboard-home"]')`).catch(() => false)
      if (ready) break
      await sleep(250)
    }
    const sidebar = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const card = document.querySelector('[data-test="store-card"][data-store-id="${sidebarStoreId}"]');
      if (!card) return { ok: false, reason: 'no-store-card', text: document.body.innerText.slice(0, 300) };
      card.click();
      for (let i = 0; i < 80; i++) {
        if (document.querySelector('[data-test="dashboard-browser-host"].active')) break;
        await wait(250);
      }
      await wait(900);
      const rail = document.querySelector('[data-test="rail-invite"]');
      if (rail) rail.click();
      await wait(700);
      const panel = document.querySelector('[data-test="invite-panel"]');
      const exists = sel => !!(panel && panel.querySelector(sel));
      const visible = sel => {
        const el = panel && panel.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return {
        ok: !!panel,
        rail: !!rail,
        panel: !!panel,
        steps: panel ? panel.querySelectorAll('[data-test="invite-panel-steps"] .invite-panel-step').length : 0,
        category: visible('[data-test="invite-category"]'),
        startExists: exists('[data-test="invite-start"]'),
        backendNote: exists('[data-test="invite-backend-note"]'),
        contactNote: exists('[data-test="invite-contact-flow-note"]'),
        quota: exists('[data-test="invite-quota"]')
      };
    `)
    checker.check('右侧边栏打开达人邀约面板（唯一入口）', sidebar.ok === true && sidebar.panel === true, JSON.stringify(sidebar))
    // 抖店是逐人沟通（没有受众/话术页），导航只保留「目标 → 启动」两步；其余平台仍是四步。
    const expectedSteps = sidebar.contactNote ? 2 : 4
    checker.check('侧栏步骤导航与抖店配置字段渲染',
      sidebar.steps === expectedSteps && sidebar.category === true && sidebar.startExists === true && sidebar.backendNote === true,
      JSON.stringify({ steps: sidebar.steps, expectedSteps, category: sidebar.category, start: sidebar.startExists, backendNote: sidebar.backendNote }))
    checker.check('抖店显示「逐人沟通」说明（不再要求话术/联系方式）', sidebar.contactNote === true, JSON.stringify({ contactNote: sidebar.contactNote }))

    /**
     * 上面为了验证侧栏入口，真的打开了这家店的浏览器（会产生 1 个可见标签页）。
     * 后面的"后台运行不占可见标签页"断言必须从干净状态起算：先把这家店关掉。
     */
    await client.eval(`window.shopilot.browser.close(${JSON.stringify(sidebarStoreId)})`).catch(() => {})
    await sleep(800)

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

    /**
     * 抖店逐人沟通链路（2026-10-25）：建批次 → 点「在线沟通」→ 列表到底收工 → 记账。
     *
     * 两条曾经的事故都在这条链上：
     *   ① scrollNext 只加进了 TASK_STEP_TYPES/引擎，漏登记 stepInputSchemas →
     *      `validateStepInput` 抛「未登记的步骤类型」→ 侧栏点开始 100% 失败；
     *   ② clickByText 不带 nth 时引擎不走"按行取人"分支 → rowNickname 恒空 →
     *      点过的人一条记录都不写（额度/7 天去重全失真），且 skipTexts 静默失效。
     */
    const doudianFlow = await client.eval(`
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const store = await window.shopilot.store.create({ name: '抖店逐人测试店', platform: '抖店', adminUrl: 'http://127.0.0.1:${localPort}/invite-list' });
      if (!store.ok) return { ok: false, stage: 'store', error: store.error };
      const started = await window.shopilot.invite.startCampaign({
        task: {
          name: '达人邀约 · 抖店 · 逐人沟通',
          storeScope: store.data.id,
          kind: 'creator_invite',
          source: 'panel',
          steps: [
            { type: 'navigate', input: { url: 'http://127.0.0.1:${localPort}/invite-list' }, timeoutMs: 20000 },
            { type: 'waitForPage', input: { urlIncludes: '/invite-list' }, timeoutMs: 12000 },
            {
              type: 'loop',
              input: {
                label: '逐人沟通 · 最多 5 位',
                maxRounds: 5,
                stopOn: ['TASK_LIST_EXHAUSTED'],
                recordStatus: 'inviting',
                recordStatusReason: '已发起在线沟通，平台未回读结果',
                steps: [
                  { type: 'clickByText', input: { text: '在线沟通', mode: 'real', nth: 'unvisited', recordRowText: true, markSendAttempt: true }, timeoutMs: 20000 },
                  { type: 'waitMs', input: { ms: 600 } },
                  { type: 'scrollNext', input: { text: '在线沟通' }, timeoutMs: 10000 }
                ]
              },
              timeoutMs: 120000
            }
          ]
        },
        campaign: { storeId: store.data.id, targetCount: 5, filters: {}, scriptText: '', createdBy: 'panel' }
      });
      if (!started.ok) return { ok: false, stage: 'start', error: started.error };
      let status = null, stopReason = null;
      for (let i = 0; i < 80; i++) {
        const detail = await window.shopilot.invite.campaignDetail(started.data.campaignId);
        const c = detail && detail.ok ? detail.data.campaign : null;
        status = c ? c.status : null;
        stopReason = c ? c.stopReason : null;
        if (status && !['running', 'queued', 'paused', 'waiting', 'ready', 'scheduled'].includes(status)) break;
        await wait(300);
      }
      await wait(600);
      // 记录列表 IPC 的 data 就是数组（不是 { records }），按数组读，别把"读不到"当成"没记账"
      const rec = await window.shopilot.invite.records({ campaignId: started.data.campaignId, limit: 10 });
      const rows = rec && rec.ok ? (rec.data.records || rec.data || []) : [];
      return {
        ok: true, status, stopReason,
        count: rows.length,
        names: rows.map(r => r.nickname),
        firstStatus: rows[0] && rows[0].status,
        recordCampaignId: rows[0] && rows[0].campaignId
      };
    `)
    checker.check('抖店逐人沟通：建任务不再被白名单拒绝，且能跑完', doudianFlow.ok === true && doudianFlow.status === 'exhausted', JSON.stringify(doudianFlow))
    checker.check('抖店逐人沟通：列表到底按预期收工（候选不足，不是失败）', doudianFlow.stopReason === 'TASK_LIST_EXHAUSTED', JSON.stringify({ stopReason: doudianFlow.stopReason }))
    checker.check('抖店逐人沟通：点过的那位已记账并归属本批次，昵称取自行内', doudianFlow.count === 1 && doudianFlow.names[0] === '达人甲' && !!doudianFlow.recordCampaignId, JSON.stringify({ count: doudianFlow.count, names: doudianFlow.names, campaignId: doudianFlow.recordCampaignId }))
    checker.check('抖店逐人沟通：记录为「邀请中」（平台不回读，不伪造已发送）', doudianFlow.firstStatus === 'inviting', JSON.stringify({ firstStatus: doudianFlow.firstStatus }))

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
