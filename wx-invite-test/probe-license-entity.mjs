/**
 * 只读探针：在各平台**真实登录态**后台里找「店铺主体 / 资质信息（营业执照）」页面与可读锚点。
 *
 * 为什么要探针：平台适配层红线是**锚点必须实测、不猜选择器**。这一步只做「导航 + 读 DOM」，
 * 不点任何会改状态的东西（不提交、不修改资质）。
 *
 * 做法：用应用自己的 IPC 打开店铺浏览器，按**标签页精确 URL** 找到对应的 CDP 目标，
 * 再用 CDP Page.navigate 导航到候选页（相对 href 按当前 origin 补全），读页面上的「标签 + 值」。
 * 登录墙会被如实识别（落地地址里带 /login），不会拿登录页当"没有主体信息"。
 *
 * 用法：SHOPILOT_CDP_PORT=9250 node wx-invite-test/probe-license-entity.mjs [平台名…]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ONLY = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const listTargets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())

class Page {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pend = new Map()
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      const p = this.pend.get(m.id)
      if (p) { this.pend.delete(m.id); p(m) }
    }
  }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    return new Page(ws)
  }
  send(method, params = {}) {
    return new Promise((ok, err) => {
      const id = ++this.id
      this.pend.set(id, m => (m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async q(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) return 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200)
    return r.result?.value
  }
  nav(url) { return this.send('Page.navigate', { url }) }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const LABEL_DUMP = `(() => {
  const all = []
  const walk = r => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g,' ').trim()
  const out = []
  const seen = new Set()
  for (const el of all) {
    const t = own(el)
    if (!t || t.length > 60) continue
    if (!/主体|资质|执照|信用代码|纳税人|税号|经营者|企业名称|公司名称/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const sib = el.parentElement ? String(el.parentElement.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 200) : ''
    const k = t + '|' + sib
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t + '   ⇒   ' + (sib === t ? '(无同级值)' : sib))
  }
  const body = String(document.body.innerText || '').replace(/\\s+/g,' ')
  const codes = [...new Set((body.match(/[0-9A-Z]{15,18}/g) || []))]
  return JSON.stringify({ labels: out.slice(0, 30), codes: codes.slice(0, 10) }, null, 1)
})()`

const NAV_LINKS = `(() => {
  const all = []
  const walk = r => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const out = []
  const seen = new Set()
  for (const el of all) {
    const tag = el.tagName
    const href = el.getAttribute && el.getAttribute('href')
    const inner = String(el.innerText || '').replace(/\\s+/g,' ').trim()
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g,' ').trim()
    const label = own || (tag === 'A' ? inner : '')
    if (!label || label.length > 20) continue
    if (!/主体|资质|执照|信用代码|店铺信息|商家信息|认证|经营信息|企业|账户信息|基本资料/.test(label)) continue
    const k = label + '|' + href
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ label, href: href || null })
  }
  return JSON.stringify(out.slice(0, 30), null, 1)
})()`

async function main() {
  const uiTarget = (await listTargets()).find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!uiTarget) { console.log('没找到渲染层目标：确认应用是带 --remote-debugging-port 启动的'); process.exit(1) }
  const ui = await Page.attach(uiTarget.webSocketDebuggerUrl)

  const stores = await ui.q(`(async () => (await window.shopilot.store.list()).data.map(s => ({ id: s.id, name: s.name, platform: s.platform, adminUrl: s.adminUrl })))()`)
  const picked = stores.filter(s => !ONLY.length || ONLY.includes(s.platform))
  console.log('待探针店铺:', picked.map(s => `${s.platform}/${s.name}`).join('  '))

  for (const s of picked) {
    console.log('\n' + '='.repeat(70))
    console.log(`### ${s.platform} / ${s.name}`)
    await ui.q(`(async () => await window.shopilot.browser.open(${JSON.stringify(s.id)}))()`)
    await sleep(3500)
    const tabs = await ui.q(`(async () => (await window.shopilot.browser.tab.list(${JSON.stringify(s.id)})).data.tabs)()`)

    // 按"标签页精确 URL"找目标：同域名多个标签页时不会挑错
    let page = null
    for (const t of tabs) {
      const tg = (await listTargets()).find(x => x.type === 'page' && x.url === t.url)
      if (tg) { page = await Page.attach(tg.webSocketDebuggerUrl); break }
    }
    if (!page) { console.log('CDP 里找不到该店铺任何标签页目标，跳过'); continue }

    // 1) 回到平台后台首页（登录态用这一跳来判）
    console.log(`\n--- 打开后台首页: ${s.adminUrl}`)
    await page.nav(s.adminUrl)
    await sleep(7000)
    const home = { url: await page.q(`location.href`), title: await page.q(`document.title`) }
    console.log('  落地:', home.url, '|', home.title)
    const loginWall = /login|passport|signin/i.test(home.url)
    console.log('  登录态:', loginWall ? '❌ 未登录（登录墙）' : '✅ 已登录')
    console.log('--- 首页导航里的候选入口 ---')
    console.log(await page.q(NAV_LINKS))
    console.log('--- 首页上的主体类标签 ---')
    console.log(await page.q(LABEL_DUMP))

    // 2) 逐个候选页进去看（只读导航）
    const links = JSON.parse(await page.q(NAV_LINKS) || '[]')
    const origin = await page.q(`location.origin`)
    const hrefs = [...new Set(links.map(l => l.href).filter(Boolean).map(h => {
      try { return new URL(h, origin).href } catch { return null }
    }).filter(Boolean))].slice(0, 3)
    for (const url of hrefs) {
      console.log(`\n--- 打开候选: ${url}`)
      await page.nav(url)
      await sleep(7000)
      console.log('  落地:', await page.q(`location.href`), '|', await page.q(`document.title`))
      console.log(await page.q(LABEL_DUMP))
      // 3) 页面上还有「主体信息 / 资质证照」这类二级入口时，点进去（只读的视图切换）再看
      for (const text of ['主体信息', '资质证照', '主体资质', '营业执照', '企业信息', '店铺资质', '商家信息']) {
        const clicked = await page.q(`(() => {
          const all = []
          const walk = r => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
          walk(document)
          const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g,' ').trim()
          const hit = all.find(el => own(el) === ${JSON.stringify(text)} && el.getBoundingClientRect().width > 0)
          if (!hit) return false
          hit.scrollIntoView({ block: 'center' }); hit.click(); return true
        })()`)
        if (!clicked) continue
        await sleep(4000)
        console.log(`\n  --- 点开「${text}」后 (${await page.q(`location.href`)}) ---`)
        console.log(await page.q(LABEL_DUMP))
      }
    }

    // 还原：关掉店铺浏览器（探针前它本来就没开着）
    page.close()
    await ui.q(`(async () => await window.shopilot.browser.close(${JSON.stringify(s.id)}))()`)
    await sleep(800)
  }
  ui.close()
  console.log('\n探针结束（全程只导航 + 读 DOM，未做任何修改）')
}

main().catch(e => { console.error(e.stack || e); process.exit(1) })
