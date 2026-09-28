/**
 * 邀约配置"按店铺独立保存"的**真机验证**（真实 userData，只读+改一次数量再改回来，不发送任何邀约）。
 *
 * 验四件事：
 *  ① 老配置迁移：这家店还没有自己的键时，用旧版按平台的那份做初始值，并落成自己的键；
 *  ② 「保存配置」按钮立刻落库，且写的是**本店铺**的键；
 *  ③ 面板重载（= 重启应用的效果）后配置仍在；
 *  ④ 改动不会写进别的店铺的键（列出所有 invite.config.store.* 键做交叉检查）。
 *
 * 用法：node tools/acceptance/invite-config-real-verify.js
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '../..')
const PORT = process.env.SHOPILOT_REAL_CDP_PORT || '9251'
const STORE_NAME = process.env.SHOPILOT_DD_STORE || '1111'
const checks = []
const notes = []
function note(m) { notes.push(m); console.log('##', m) }
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function freePort(p) {
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${p}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(x => /^\d+$/.test(x)))
    for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* */ } }
  } catch { /* */ }
}
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map()
    this.ready = new Promise((ok, err) => { this.ws.onopen = ok; this.ws.onerror = err })
    this.ws.onmessage = e => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expr) {
    await this.ready
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  close() { try { this.ws.close() } catch { /* */ } }
}
async function connect(part) {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const t = list.find(x => (x.type === 'page' || x.type === 'webview') && x.url.includes(part))
    if (t) { const c = new CDP(t.webSocketDebuggerUrl); await c.ready; return c }
    await sleep(700)
  }
  throw new Error('no target ' + part)
}

const PANEL = `return {
  category: (document.querySelector('[data-test="invite-category"]') || {}).value,
  subcategory: (document.querySelector('[data-test="invite-subcategory"]') || {}).value,
  category3: (document.querySelector('[data-test="invite-category3"]') || {}).value,
  count: (document.querySelector('[data-test="invite-count"]') || {}).value,
  mainCategory: (document.querySelector('[data-test="invite-main-category"]') || {}).value,
  phone: (document.querySelector('[data-test="invite-batch-phone"]') || {}).value,
  wechat: (document.querySelector('[data-test="invite-batch-wechat"]') || {}).value,
  strengths: [...document.querySelectorAll('[data-test^="invite-strength-"]')].filter(x => x.checked).map(x => x.getAttribute('data-test').replace('invite-strength-','')),
  benefits: [...document.querySelectorAll('[data-test^="invite-benefit-"]')].filter(x => x.checked).map(x => x.getAttribute('data-test').replace('invite-benefit-','')),
  hasSaveBtn: !!document.querySelector('[data-test="invite-save-config"]')
}`

;(async () => {
  freePort(PORT)
  let app = null
  const report = { startedAt: new Date().toISOString(), checks, notes }
  try {
    app = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
      ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox',
       '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
      { cwd: root, stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } })
    for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch { /* */ } await sleep(400) }
    await sleep(2500)
    try { execSync(`powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; for ($i=0;$i -lt 20;$i++){ if ($w.AppActivate(${app.pid})) { break }; Start-Sleep -Milliseconds 300 }"`, { stdio: 'ignore', timeout: 20000 }) } catch { /* */ }
    let ui = await connect('/renderer/index.html')
    await ui.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot`)

    const storeId = await ui.eval(`
      const r = await window.shopilot.store.list();
      const s = (r.data || []).find(x => x.name === ${JSON.stringify(STORE_NAME)});
      return s ? s.id : null;
    `)
    check('找到真实抖店店铺', !!storeId, String(storeId))
    const storeKey = 'invite.config.store.' + storeId
    const legacyKey = 'invite.config.抖店'
    const readSetting = key => ui.eval(`const r = await window.shopilot.settings.get(${JSON.stringify(key)}); return r.ok ? r.data.value : null;`)
    const before = { store: await readSetting(storeKey), legacy: await readSetting(legacyKey) }
    note('打开前：本店铺键=' + (before.store ? '有' : '无') + ' / 旧平台键=' + (before.legacy ? JSON.stringify(before.legacy).slice(0, 120) : '无'))

    const openPanel = async () => {
      for (let i = 0; i < 25; i++) {
        const st = await ui.eval(`
          const cards = [...document.querySelectorAll('.store-card')];
          if (!cards.length) return { step: 'no-cards' };
          const card = cards.find(x => x.textContent.includes(${JSON.stringify(STORE_NAME)}));
          if (!card) return { step: 'no-card', cards: cards.length };
          (card.querySelector('.store-action') || card).click();
          await new Promise(r => setTimeout(r, 1200));
          const taskTab = [...document.querySelectorAll('.ptab')].find(x => x.textContent.trim() === '任务');
          if (taskTab) taskTab.click();
          await new Promise(r => setTimeout(r, 500));
          const inv = document.querySelector('[data-test="task-tab-invite"]');
          if (inv) inv.click();
          await new Promise(r => setTimeout(r, 900));
          // 就绪判据必须落到**面板内容**上：panel 容器在两个分支里都有，
          // 只看它会误判成"就绪"（店铺还没选中时是"平台暂不支持"那一支）。
          return {
            step: 'done',
            ready: !!document.querySelector('[data-test="invite-save-config"]'),
            category: (document.querySelector('[data-test="invite-category"]') || {}).value || null
          };
        `)
        if (st && st.step === 'done' && st.ready) { await sleep(900); return true }
        note('面板未就绪，重试：' + JSON.stringify(st))
        await sleep(900)
      }
      return false
    }
    await ui.eval(`await window.shopilot.browser.open(${JSON.stringify(storeId)}); return true;`)
    await sleep(3000)
    const opened = await openPanel()
    check('打开店铺的邀约面板', opened)
    if (!opened) throw new Error('邀约面板未就绪（店铺没选中？）——后续断言无意义，直接停')

    // 方案A视觉验收：面板截两张图（配置齐态 / 缺项态），存 artifacts 备查
    const shotDir = path.join(root, 'artifacts', 'invite-ui-design')
    fs.mkdirSync(shotDir, { recursive: true })
    const shotEl = async (sel, file) => {
      const box = await ui.eval(`
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      `)
      if (!box) return null
      const png = await ui.send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: Math.min(box.width, 480), height: Math.min(box.height, 1400), scale: 1 } })
      const out = path.join(shotDir, file)
      fs.writeFileSync(out, Buffer.from(png.data, 'base64'))
      return out
    }
    const shot1 = await shotEl('[data-test="invite-panel"]', 'real-panel-filled.png')
    note('配置齐态截图：' + shot1)
    // 缺项态：把手机号清空 → 缺项清单与灰按钮应该出现
    await ui.eval(`
      const el = document.querySelector('[data-test="invite-batch-phone"]');
      const proto = HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 900));
      return true;
    `)
    const missingState = await ui.eval(`return {
      missing: [...document.querySelectorAll('[data-test="invite-missing"] li')].map(x => x.textContent.trim()),
      startDisabled: (document.querySelector('[data-test="invite-start"]') || {}).disabled,
      danger: (document.querySelector('[data-test="invite-no-confirm"]') || {}).textContent || null,
      overview: (document.querySelector('[data-test="invite-overview"]') || {}).innerText || null
    };`)
    check('缺项清单：手机号清空后列出缺项、开始按钮变灰',
      missingState.missing.some(t => t.includes('手机号')) && missingState.startDisabled === true,
      JSON.stringify(missingState.missing))
    check('红色警示条常驻（无二次确认）', /无二次确认/.test(missingState.danger || ''), JSON.stringify(missingState.danger))
    check('步骤总览三行都在（选人/内容/运行）', /1 选人/.test(missingState.overview || '') && /2 内容/.test(missingState.overview || '') && /3 运行/.test(missingState.overview || ''),
      JSON.stringify((missingState.overview || '').slice(0, 160)))
    const shot2 = await shotEl('[data-test="invite-panel"]', 'real-panel-missing.png')
    note('缺项态截图：' + shot2)
    // 恢复手机号（界面自动保存会写回，值与原来一致，不污染配置）
    await ui.eval(`
      const el = document.querySelector('[data-test="invite-batch-phone"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '15057937334');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 900));
      return true;
    `)

    const panel1 = await ui.eval(PANEL)
    check('面板有「保存配置」按钮', panel1.hasSaveBtn === true, JSON.stringify(panel1.hasSaveBtn))
    const afterOpen = await readSetting(storeKey)
    check('① 迁移：本店铺键从旧平台存档落成（此后各店独立）',
      !!afterOpen && afterOpen.batchPhone === (before.legacy && before.legacy.batchPhone) && afterOpen.category === '个护家清',
      JSON.stringify({ store: afterOpen && { category: afterOpen.category, sub: afterOpen.subcategory, count: afterOpen.count, phone: afterOpen.batchPhone }, legacy: before.legacy && { category: before.legacy.category, count: before.legacy.count } }))
    check('面板展示的配置与存档一致（类目/三级/主营/联系方式/优势/权益）',
      panel1.category === '个护家清' && panel1.subcategory === '家清纸品' && panel1.category3 === '纸品' &&
        panel1.mainCategory === '个护家清/家清纸品' && panel1.phone === '15057937334' &&
        panel1.strengths.length === 3 && panel1.benefits.length === 2,
      JSON.stringify(panel1))

    // ② 改数量 + 点「保存配置」→ 立刻落库（写本店铺键）
    const countNow = Number(panel1.count || 1)
    const changed = countNow === 1 ? 2 : 1
    await ui.eval(`
      const el = document.querySelector('[data-test="invite-count"]');
      const proto = HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(changed))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const b = document.querySelector('[data-test="invite-save-config"]');
      b.click();
      await new Promise(r => setTimeout(r, 1200));
      return true;
    `)
    const savedAfter = await readSetting(storeKey)
    const legacyAfter = await readSetting(legacyKey)
    check('② 「保存配置」把改动写进本店铺键', !!savedAfter && savedAfter.count === changed,
      JSON.stringify({ count: savedAfter && savedAfter.count }))
    check('旧平台键保持不动（迁移只读它、不再写它）',
      JSON.stringify(legacyAfter) === JSON.stringify(before.legacy),
      JSON.stringify({ legacyCount: legacyAfter && legacyAfter.count }))

    // ③ 重载 UI（= 重启应用的效果）→ 配置仍在
    await ui.eval(`location.reload(); return true;`)
    await sleep(3500)
    try { execSync(`powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; $w.AppActivate(${app.pid}) | Out-Null"`, { stdio: 'ignore', timeout: 15000 }) } catch { /* */ }
    ui = await connect('/renderer/index.html')
    await ui.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot`)
    const reopened = await openPanel()
    const panel2 = await ui.eval(PANEL)
    check('③ 重载（等价重启）后配置仍在：面板恢复成本店存档',
      reopened && panel2.count === String(changed) && panel2.category === '个护家清' && panel2.phone === '15057937334' &&
        panel2.mainCategory === '个护家清/家清纸品',
      JSON.stringify(panel2))

    // ④ 交叉检查：其它店铺的键没有被这次改动污染
    const allStoreKeys = await ui.eval(`
      const r = await window.shopilot.store.list();
      const out = [];
      for (const s of (r.data || [])) {
        const k = 'invite.config.store.' + s.id;
        const v = await window.shopilot.settings.get(k);
        out.push({ name: s.name, platform: s.platform, key: k, value: v.ok ? v.data.value : null });
      }
      return out;
    `)
    const others = allStoreKeys.filter(x => x.key !== storeKey && x.value)
    note('其它店铺的邀约配置：' + JSON.stringify(others.map(o => ({ name: o.name, count: o.value.count, category: o.value.category }))))
    check('④ 本店改动没有写进别的店铺的键',
      others.every(o => o.value.count !== changed || o.value.batchPhone !== '15057937334'),
      JSON.stringify(others.map(o => ({ name: o.name, count: o.value && o.value.count }))))

    // 收尾：把数量改回原值，别把测试用的值留在真实配置里
    await ui.eval(`
      const el = document.querySelector('[data-test="invite-count"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(countNow))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      document.querySelector('[data-test="invite-save-config"]').click();
      await new Promise(r => setTimeout(r, 1200));
      return true;
    `)
    const restored = await readSetting(storeKey)
    check('收尾：数量改回原值并已保存', !!restored && restored.count === countNow, JSON.stringify({ count: restored && restored.count }))
    ui.close()
  } catch (err) {
    check('实测未中断', false, String(err && err.stack || err))
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'artifacts', 'invite-config-real-report.json'), JSON.stringify(report, null, 2), 'utf8')
    try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }) } catch { /* */ }
  }
  const failed = checks.filter(c => !c.ok)
  console.log(`\n通过 ${checks.length - failed.length}/${checks.length}`)
  if (failed.length) { console.log('失败项：' + failed.map(f => f.name).join(' | ')); process.exitCode = 1 }
})().catch(e => { console.error('RUNNER_ERROR', e); process.exit(1) })
