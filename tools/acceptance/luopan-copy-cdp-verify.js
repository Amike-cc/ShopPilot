/**
 * 罗盘下载器「复制链接」验收（CDP，2026-11-09 v2.7.3）
 *
 * 前置：
 *   1. 应用以 --remote-debugging-port=9412 启动（LUOPAN_CDP_PORT 可覆盖）；
 *   2. 插件中心已安装 luopan-downloader（覆盖升级后需要新开/刷新罗盘标签）；
 *   3. 该店铺会话已登录罗盘。
 *
 * 判据（每条都必须同时成立，避免把「按钮文案」或「storage 有值」单独当成功）：
 *   · 榜单行按钮出现 ≥ 1；
 *   · 点「复制链接」后按钮显示「已复制 N 条」，且 lpLastCopy 里每一行都是
 *     https://www.douyin.com/video/<纯数字>（ref 形式 k1.xxx 一律算失败）；
 *   · 详情页等到「N 条视频」且按钮 enabled 后再点「批量复制」，判据同上；
 *   · 详情行内「复制链接」同样必须产出纯数字链接（v2.7.2 这里是 ref，属回归重点）。
 *
 * 用法：node tools/acceptance/luopan-copy-cdp-verify.js
 */
const fs = require('fs')
const path = require('path')
const { CdpClient, waitForMainWindow, sleep } = require('./cdp-client')

const PORT = Number(process.env.LUOPAN_CDP_PORT || 9412)
const STORE_ID = process.env.LUOPAN_STORE_ID || 'store_485d9ec1e549231e555cc84bc5c59a81'
const KNOWN_PID = String(process.env.LUOPAN_PID || '')   // 榜单接口被限流时可直接指定竞品 id
const RANK_URL = 'https://compass.jinritemai.com/shop/chance/product-rank'
const REPORT = path.join(__dirname, '..', '..', 'artifacts', 'luopan-copy-report.json')
const OK_LINK = /^https:\/\/www\.douyin\.com\/video\/\d+$/

function json(v) { return JSON.stringify(v) }

async function findTarget(kind, urlPart, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const hit = list.find(item => item.type === kind && String(item.url || '').includes(urlPart))
      if (hit) {
        const c = new CdpClient(hit.webSocketDebuggerUrl)
        await c.ready
        return c
      }
    } catch { /* retry */ }
    await sleep(400)
  }
  return null
}

/** 在扩展的隔离世界里求值（storage 只有那里能读） */
const extCtxCache = new WeakMap()
async function extEval(guest, expression) {
  let ctxId = extCtxCache.get(guest)
  if (!ctxId) {
    const contexts = []
    const listener = ev => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context)
      } catch { /* ignore */ }
    }
    guest.ws.addEventListener('message', listener)
    await guest.send('Runtime.enable')
    await sleep(700)
    guest.ws.removeEventListener('message', listener)
    for (const c of contexts) {
      if (!(c.auxData && !c.auxData.isDefault && String(c.origin || '').indexOf('chrome-extension://') === 0)) continue
      try {
        const loaded = await guest.send('Runtime.evaluate', {
          expression: 'window.__lpLoaded === true', contextId: c.id, returnByValue: true
        }).then(r => r.result.value)
        if (loaded) { ctxId = c.id; break }
      } catch { /* next context */ }
    }
    if (!ctxId) return null
    extCtxCache.set(guest, ctxId)
  }
  try {
    const res = await guest.send('Runtime.evaluate', {
      expression, contextId: ctxId, awaitPromise: true, returnByValue: true
    })
    if (res.exceptionDetails) return null
    return res.result.value
  } catch {
    extCtxCache.delete(guest)
    return null
  }
}

/** 真鼠标点击（CDP Input 派发 isTrusted 事件，带 user activation，剪贴板写入才稳） */
async function trustedClick(guest, selector) {
  try { await guest.send('Page.bringToFront') } catch { /* webview 目标可能不支持 */ }
  const rect = await guest.eval(`const el = document.querySelector(${json(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`)
  if (!rect) return false
  await guest.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' })
  await guest.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await guest.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  return true
}

function readStorage(guest) {
  return extEval(guest, "new Promise(r => chrome.storage.local.get(['lpLastCopy','lpCopyErr'], r))")
}

function clearStorage(guest) {
  return extEval(guest, "new Promise(r => chrome.storage.local.remove(['lpLastCopy','lpCopyErr','lpCopyErrAt'], () => r(true)))")
}

async function waitButtonText(guest, selector, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    text = await guest.eval(`return (document.querySelector(${json(selector)}) || {}).textContent || 'gone'`)
    if (pattern.test(text)) return text
    await sleep(1000)
  }
  return text
}

/**
 * 点一次 → 等结果；若第一次写剪贴板失败（异步解析耗掉了 user activation），
 * 插件会把文本挂在按钮上，再点一次即可在手势内写入。
 */
async function copyAndRetry(guest, selector, timeoutMs) {
  let clicked = await trustedClick(guest, selector)
  let text = await waitButtonText(guest, selector, /已复制|解析失败|复制失败|暂无|无可复制/, timeoutMs)
  if (!/已复制/.test(text)) {
    await sleep(600)
    const again = await trustedClick(guest, selector)
    if (again) text = await waitButtonText(guest, selector, /已复制|解析失败|复制失败|暂无|无可复制/, timeoutMs)
    clicked = clicked && again
  }
  return { text: text, clicked: clicked }
}

async function main() {
  const report = { at: new Date().toISOString(), port: PORT, storeId: STORE_ID }
  const ui = await waitForMainWindow(PORT, { timeoutMs: 25000 })

  await ui.eval(`return await window.shopilot.browser.open(${json(STORE_ID)})`)
  const tabs = await ui.eval(`return await window.shopilot.browser.tab.list(${json(STORE_ID)})`)
  const tabId = tabs && tabs.data && tabs.data.tabs && tabs.data.tabs[0] && tabs.data.tabs[0].id
  if (!tabId) throw new Error('店铺没有可用标签页')
  const navUrl = `${RANK_URL}?lpv=${Date.now()}`
  await ui.eval(`return await window.shopilot.browser.navigate(${json(STORE_ID)}, ${json(tabId)}, ${json(navUrl)})`)
  await sleep(5000)

  let guest = await findTarget('webview', 'compass.jinritemai.com', 20000)
  if (!guest) throw new Error('找不到罗盘 webview')
  await guest.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  report.extVer = await extEval(guest, 'chrome.runtime.getManifest().version')

  await guest.eval(`const b = [...document.querySelectorAll('.aurora-tabs-tab-btn')].find(el => (el.textContent || '').trim() === '短视频榜'); if (b) b.click(); return true`)

  // ---- 榜单 ----
  const btnDeadline = Date.now() + 45000
  let btns = 0
  while (Date.now() < btnDeadline) {
    btns = await guest.eval("return document.querySelectorAll('.lp-rowbtns').length")
    if (btns > 0) break
    await sleep(1500)
  }
  report.rankButtons = btns
  report.rankChip = await guest.eval("return (document.querySelector('.lp-errchip') || {}).textContent || ''")

  if (btns > 0) {
    await clearStorage(guest)
    const rankCopy = await copyAndRetry(guest, '.lp-rowbtns [data-rowact="copy"]', 60000)
    report.rankClick = rankCopy.clicked
    report.rankCopyBtn = rankCopy.text
    await sleep(800)
    const st = await readStorage(guest)
    report.rankLastCopy = st && st.lpLastCopy ? String(st.lpLastCopy) : null
    report.rankCopyErr = st && st.lpCopyErr ? String(st.lpCopyErr) : null
    report.rankLines = report.rankLastCopy ? report.rankLastCopy.split('\n').filter(Boolean) : []
    report.rankLinksOk = report.rankLines.length > 0 && report.rankLines.every(l => OK_LINK.test(l))
    report.rankUnique = new Set(report.rankLines).size === report.rankLines.length
  }

  // ---- 详情（优先用页面自己最新的榜单请求，其次去掉签名参数重试） ----
  const pidProbe = KNOWN_PID ? { pid: KNOWN_PID, from: 'env' } : await guest.eval(`return (async () => {
    const entries = performance.getEntriesByType('resource').filter(e => e.name.indexOf('/product_rank/video_bring_good') >= 0)
    const last = entries[entries.length - 1]
    async function tryFetch(url) {
      try {
        const r = await fetch(url, { credentials: 'include' })
        const j = await r.json()
        const list = (j.data && j.data.data_result) || []
        return { st: j.st, msg: j.msg || '', count: list.length, pid: String((list[0] && list[0].product_info && list[0].product_info.id) || '') }
      } catch (e) { return { error: String((e && e.message) || e) } }
    }
    let out = last ? await tryFetch(last.name) : { error: 'no page request' }
    if (!out.pid) {
      const base = last ? last.name : (location.origin + '/compass_api/shop/product/product_rank/video_bring_good?industry_id=4&category_id=1000003282,1000009114&brand_type=-1&price_bin=%E4%B8%8D%E9%99%90&date_type=21&rank_data_type=1&activity_id=')
      const u = new URL(base)
      ;['msToken', 'a_bogus', 'verifyFp', 'fp'].forEach(k => u.searchParams.delete(k))
      u.searchParams.set('page_no', '1')
      u.searchParams.set('page_size', '10')
      out = await tryFetch(u.toString())
    }
    return out
  })()`)
  report.pidProbe = pidProbe
  const pid = pidProbe && pidProbe.pid
  report.pid = pid || ''

  if (pid) {
    await guest.eval(`location.href = ${json(`https://compass.jinritemai.com/shop/chance/rank-product/detail?product_id=${pid}&date_type=21`)}; return true`)
    await sleep(3500)
    guest = await findTarget('webview', 'compass.jinritemai.com', 20000)
    if (!guest) throw new Error('详情页 webview 丢失')
    await guest.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await guest.eval(`const b = [...document.querySelectorAll('[role=tab], .aurora-tabs-tab-btn')].find(el => (el.textContent || '').trim() === '视频分析'); if (b) b.click(); return true`)

    // 关键：等到真实数据条数 + 按钮 enabled，再点
    const dDeadline = Date.now() + 60000
    let ready = null
    while (Date.now() < dDeadline) {
      ready = await guest.eval(`return {
        info: (document.querySelector('.lp-dinfo') || {}).textContent || '',
        disabled: !!(document.querySelector('[data-dact="copy"]') || {}).disabled,
        rows: document.querySelectorAll('.lp-drowbtns').length,
        chip: (document.querySelector('.lp-errchip') || {}).textContent || ''
      }`)
      if (ready && /\d+ 条视频/.test(ready.info) && !ready.disabled) break
      await sleep(1500)
    }
    report.detailReady = ready

    if (ready && !ready.disabled) {
      await clearStorage(guest)
      const detailCopy = await copyAndRetry(guest, '[data-dact="copy"]', 120000)
      report.detailClick = detailCopy.clicked
      report.detailCopyBtn = detailCopy.text
      await sleep(800)
      const st = await readStorage(guest)
      report.detailLastCopy = st && st.lpLastCopy ? String(st.lpLastCopy) : null
      report.detailCopyErr = st && st.lpCopyErr ? String(st.lpCopyErr) : null
      report.detailLines = report.detailLastCopy ? report.detailLastCopy.split('\n').filter(Boolean) : []
      report.detailLinksOk = report.detailLines.length > 0 && report.detailLines.every(l => OK_LINK.test(l))
      report.detailUnique = new Set(report.detailLines).size === report.detailLines.length

      // 行内单行复制（v2.7.2 的回归点：这里曾直接复制 ref）
      const rowCount = await guest.eval("return document.querySelectorAll('.lp-drowbtns [data-drowact=\"copy\"]').length")
      report.detailRowButtons = rowCount
      if (rowCount > 0) {
        await clearStorage(guest)
        report.detailRowClick = await trustedClick(guest, '.lp-drowbtns [data-drowact="copy"]')
        report.detailRowBtn = await waitButtonText(guest, '.lp-drowbtns [data-drowact="copy"]', /已复制|解析失败|复制失败|暂无/, 30000)
        await sleep(800)
        const st2 = await readStorage(guest)
        report.detailRowLastCopy = st2 && st2.lpLastCopy ? String(st2.lpLastCopy) : null
        report.detailRowCopyErr = st2 && st2.lpCopyErr ? String(st2.lpCopyErr) : null
        report.detailRowLinkOk = !!report.detailRowLastCopy && OK_LINK.test(report.detailRowLastCopy.trim())
      }
    }
  }

  report.pass = !!(
    report.rankButtons > 0 &&
    /已复制/.test(report.rankCopyBtn || '') && report.rankLinksOk && report.rankUnique &&
    report.detailReady && !report.detailReady.disabled && report.detailLinksOk && report.detailUnique &&
    report.detailRowLinkOk
  )
  fs.mkdirSync(path.dirname(REPORT), { recursive: true })
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.pass ? 0 : 1)
}

main().catch(error => {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true })
  fs.writeFileSync(REPORT, JSON.stringify({ fatal: String((error && error.stack) || error) }, null, 2))
  console.error('LUOPAN_COPY_VERIFY_CRASH', error && error.message)
  process.exit(2)
})
