/**
 * 经营数据页锚点诊断（只读，开发者用）。
 *
 *   node tools/acceptance/sales-metrics-anchor-probe.js [平台名]
 *
 * 为什么需要它：Adapter 用的是 `BUSINESS_PROFILES` 里实测过的**标签文案**锚点。
 * 当真实页面读不到值时，只有两种可能——页面改了，或者读取算法没走到那一层。
 * 这个脚本把页面上"和锚点相关的那几个元素"原样列出来（标签、层级、卡片文本、尺寸），
 * 并截一张图存到 artifacts/sales-metrics/，用来判断是哪一种。
 *
 * 只做三件事：打开店铺浏览器、导航到已登记的页面、读 DOM + 截图。不改任何数据。
 * 输出里可能出现店铺经营数字（聚合值），因此只写本地 artifacts 目录，不进日志、不进诊断包。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.env.SHOPILOT_ANCHOR_PORT || 9303)
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const artifactsDir = path.join(ROOT, 'artifacts', 'sales-metrics')
const wantPlatform = process.argv.slice(2).find(arg => !arg.startsWith('-')) || null

const PROFILES = {
  微信小店: { pageUrl: 'https://store.weixin.qq.com/shop/home', marker: 'shop/home', period: '近7天', deep: true },
  快手小店: { pageUrl: 'https://syt.kwaixiaodian.com/zones/goodsManagement/goods_overview', marker: 'goods_overview', period: '近7日', deep: false },
  抖店: { pageUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index', marker: 'mshop/homepage', period: null, deep: false },
  拼多多: { pageUrl: 'https://mms.pinduoduo.com/', marker: '', period: null, deep: false }
}
const ANCHORS = {
  微信小店: ['成交金额', '成交订单数', '成交退款金额', '近7天'],
  快手小店: ['成交金额', '成交订单数', '成交件数', '退款金额(退款日)', '成交退款订单数', '近7日'],
  抖店: ['成交金额'],
  拼多多: ['成交金额']
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null)
  if (!response || !response.ok) return []
  return await response.json()
}

async function waitForCdp(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => null)
    if (response && response.ok) return true
    if (Date.now() >= deadline) return false
    await sleep(400)
  }
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('WS_ERROR')))
  })
  socket.addEventListener('message', event => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP_TIMEOUT ${method}`)) } }, 60000)
      })
    },
    async evaluate(body) {
      const result = await this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error('EVAL_EXCEPTION ' + JSON.stringify(result.exceptionDetails.text || result.exceptionDetails))
      if (!result.result) throw new Error('EVAL_NO_RESULT ' + JSON.stringify(result).slice(0, 300))
      if (result.result.value === undefined && result.result.type !== 'undefined') {
        throw new Error('EVAL_UNSERIALIZABLE type=' + result.result.type + ' desc=' + String(result.result.description || '').slice(0, 200))
      }
      return result.result.value
    },
    close() { try { socket.close() } catch { /* ignore */ } }
  }
}

function killTree(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ } }
async function stopApp(child) {
  if (!child) return
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  const deadline = Date.now() + 8000
  while (child.exitCode == null && Date.now() < deadline) await sleep(300)
  killTree(child.pid)
  await sleep(600)
}

/** 在店铺页面里跑：把与锚点相关的元素结构原样带回来（只读）。 */
function inspectScript(anchors, deep) {
  return `(() => {
    const __enumDeep = () => {
      const out = []
      const walk = (r) => { for (const el of r.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
      walk(document); return out
    }
    const __visible = (el) => { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' }
    const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
    const anchors = ${JSON.stringify(anchors)};
    const report = [];
    for (const label of anchors) {
      const hits = [];
      for (const el of scope) {
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        const inner = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!own.includes(label) && !inner.includes(label)) continue;
        if (!__visible(el)) continue;
        hits.push({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 60),
          own: own.slice(0, 60),
          inner: inner.slice(0, 120),
          ownLen: own.length,
          innerLen: inner.length,
          rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })()
        });
      }
      report.push({ label, hitCount: hits.length, hits: hits.slice(0, 12) });
    }
    // 页面里所有"看起来像周期切换"的短文案（帮助确认周期控件的真实文案）
    const shortTexts = new Set();
    for (const el of scope) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (own && own.length <= 12 && /日|天|周|月|今天|昨天/.test(own) && __visible(el)) shortTexts.add(own);
    }
    return { url: location.href, title: document.title, report, periodCandidates: [...shortTexts].slice(0, 30) };
  })()`
}

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true })
  const electronList = execSync('tasklist /FI "IMAGENAME eq electron.exe" /NH', { encoding: 'utf8' })
  if (/electron\.exe/i.test(electronList)) {
    console.log('已有 electron 实例在运行，停止（避免连到别的实例）')
    process.exit(2)
  }

  const child = spawn(electronExe, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } })
  child.stdout.on('data', () => { /* ignore */ })
  child.stderr.on('data', () => { /* ignore */ })

  let cdp = null
  try {
    if (!await waitForCdp()) throw new Error('CDP 未就绪')
    const renderer = (await listTargets()).find(item => item.type === 'page' && /index\.html/.test(item.url || ''))
    cdp = connect(renderer.webSocketDebuggerUrl)
    await cdp.ready
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate('return Boolean(window.shopilot && window.shopilot.salesMetrics);').catch(() => false)) break
      await sleep(500)
    }

    const storeList = await cdp.evaluate('return await window.shopilot.store.list();')
    const platforms = wantPlatform ? [wantPlatform] : Object.keys(PROFILES)
    const output = {}
    for (const platform of platforms) {
      const store = storeList.ok ? storeList.data.find(item => item.platform === platform) : null
      if (!store) { console.log(`${platform}: 没有该平台的店铺，跳过`); continue }
      console.log(`\n=== ${platform} / ${store.name} ===`)
      await cdp.evaluate(`return await window.shopilot.browser.open(${JSON.stringify(store.id)});`)
      await sleep(3500)
      const tabs = await cdp.evaluate(`return await window.shopilot.browser.tab.list(${JSON.stringify(store.id)});`)
      const tabId = tabs.ok && tabs.data.tabs.length ? tabs.data.tabs[0].id : null
      console.log(`  标签页：${tabId || '未取到'}  当前地址：${tabs.ok && tabs.data.tabs.length ? String(tabs.data.tabs[0].url).slice(0, 120) : ''}`)
      const host = new URL(PROFILES[platform].pageUrl).hostname

      let inspected = null
      // 平台首页是 SPA：首次进入常常只有外壳（实测抖店内容区全空）。
      // 这里有界重试：导航 → 等 → 看有没有锚点命中；连续不命中就再导航一次。
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (tabId) {
          const nav = await cdp.evaluate(`return await window.shopilot.browser.navigate(${JSON.stringify(store.id)}, ${JSON.stringify(tabId)}, ${JSON.stringify(PROFILES[platform].pageUrl)});`)
          console.log(`  第 ${attempt} 次导航：${nav && nav.ok ? 'ok' : JSON.stringify(nav && nav.error || nav)}`)
        }
        await sleep(attempt === 1 ? 10000 : 15000)
        const page = (await listTargets()).find(item => (item.type === 'page' || item.type === 'webview') && String(item.url || '').includes(host))
        if (!page) { console.log('  找不到店铺页面目标'); continue }
        const pageCdp = connect(page.webSocketDebuggerUrl)
        await pageCdp.ready
        // evaluate 的包装是 `(async () => { <body> })()`，body 必须显式 return，
        // 否则页面返回 undefined（这里踩过一次：整个诊断"失败"其实是漏了 return）。
        inspected = await pageCdp.evaluate('return ' + inspectScript(ANCHORS[platform] || [], PROFILES[platform].deep))
        const shape = await pageCdp.evaluate('return { url: location.href, bodyTextLen: String(document.body ? document.body.innerText : "").length, bodyHead: String(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 160) }')
        console.log(`  页面：${String(inspected.url).slice(0, 120)}  正文长度=${shape.bodyTextLen}  头部="${shape.bodyHead}"`)
        const hits = inspected.report.reduce((total, entry) => total + entry.hitCount, 0)
        // 先做截图与周期定位（都在连接内），最后再关连接。
        if (attempt === 3 || hits > 0) {
          try {
            const shot = await pageCdp.send('Page.captureScreenshot', { format: 'png' })
            const file = path.join(artifactsDir, `${platform}-page.png`)
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
            console.log(`  截图：${file}`)
          } catch (error) { console.log('  截图失败：' + String(error.message || error)) }
        }
        if (PROFILES[platform].period) {
          const locate = await pageCdp.evaluate('return ' + `(() => { try {
            const t0 = performance.now();
            const want = String(${JSON.stringify(PROFILES[platform].period)}).replace(/\\s+/g, '');
            const scope = ${PROFILES[platform].deep ? '(() => { const out = []; const walk = (r) => { for (const el of r.querySelectorAll("*")) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }; walk(document); return out })()' : 'document.querySelectorAll("*")'};
            const tEnum = performance.now();
            let ownMatches = 0;
            let visibleMatches = 0;
            const samples = [];
            for (const el of scope) {
              const own = String([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('')).replace(/\\s+/g, '');
              if (!own) continue;
              if (own !== want && !(own.includes(want) && own.length <= want.length + 6)) continue;
              ownMatches++;
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
              if (!visible) continue;
              visibleMatches++;
              if (samples.length < 3) samples.push({ tag: el.tagName, own, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
            }
            const tEnd = performance.now();
            return { ok: true, scope: scope.length, ownMatches, visibleMatches, samples, enumMs: Math.round(tEnum - t0), scanMs: Math.round(tEnd - tEnum) };
          } catch (error) { return { ok: false, error: String(error && error.message || error) } } })()`)
          console.log(`  周期定位：${JSON.stringify(locate)}`)
        }
        pageCdp.close()
        if (hits > 0) break
        console.log(`  第 ${attempt} 次仍无锚点命中（内容区可能还没渲染）`)
      }
      output[platform] = inspected
      for (const entry of inspected.report) {
        console.log(`  锚点「${entry.label}」命中 ${entry.hitCount} 个可见元素`)
        for (const hit of entry.hits.slice(0, 6)) {
          console.log(`     <${hit.tag}> ownLen=${hit.ownLen} innerLen=${hit.innerLen} rect=${hit.rect.join(',')} own="${hit.own}" inner="${hit.inner}" cls="${hit.cls}"`)
        }
      }
      console.log(`  周期候选文案：${inspected.periodCandidates.join(' | ')}`)

      await cdp.evaluate(`return await window.shopilot.browser.close(${JSON.stringify(store.id)});`)
      await sleep(1200)
    }
    fs.writeFileSync(path.join(artifactsDir, 'anchor-probe.json'), JSON.stringify(output, null, 2))
  } catch (error) {
    console.log('诊断失败：' + String(error && error.message || error))
  } finally {
    try { if (cdp) cdp.close() } catch { /* ignore */ }
    await stopApp(child)
  }
  process.exit(0)
}

main().catch(error => { console.error('ANCHOR_PROBE_FAILED', error); process.exit(1) })
