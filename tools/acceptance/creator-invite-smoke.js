/**
 * 达人邀约 v2 冒烟验收（2026-10-19）
 *
 * 目标：在**真实 Electron 主窗口**里走一遍：
 *   应用中心 → 达人邀约卡片 → 独立模块页 → 页面数据 IPC。
 * 不触碰平台页面、不发送任何邀约；只验证路由、迁移 v33、preload/IPC 与空态。
 *
 * 用法：node tools/acceptance/creator-invite-smoke.js
 * 前置：pnpm build（source runner 读 apps/desktop/out）；打包产物存在时也可直接跑。
 */
const { spawn, execSync } = require('child_process')
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
      return { creatorsTab, creatorsEmpty, assetsTab, scriptInput, quota };
    `)
    checker.check('达人库页签可打开（无记录时如实空态）', tabs.creatorsTab === true && tabs.creatorsEmpty === true, JSON.stringify(tabs))
    checker.check('资产页签与额度 chip 渲染', tabs.assetsTab === true && tabs.scriptInput === true && tabs.quota === true, JSON.stringify(tabs))

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
    killTree(child)
    await sleep(500)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main()
