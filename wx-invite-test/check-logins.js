/**
 * 检查各店铺后台登录状态（只读）：打开后台首页，判断是登录页还是已登录工作台。
 * 用法：node check-logins.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  return new Promise((ok, err) => {
    ws.onopen = () => {
      let seq = 0
      const pend = new Map()
      const send = (method, params = {}) => new Promise((ok2, err2) => { const id = ++seq; pend.set(id, m => m.error ? err2(new Error(JSON.stringify(m.error))) : ok2(m.result)); ws.send(JSON.stringify({ id, method, params })) })
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      ok({
        ev: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result.value },
        close: () => { try { ws.close() } catch { /* */ } }
      })
    }
    ws.onerror = err
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const TARGETS = [
  { name: '福气满满', platform: '快手小店', url: 'https://s.kwaixiaodian.com', host: 'kwaixiaodian' },
  { name: '慕么美', platform: '拼多多', url: 'https://mms.pinduoduo.com', host: 'pinduoduo' },
  { name: '微信小店测试', platform: '微信小店', url: 'https://store.weixin.qq.com', host: 'store.weixin' },
  { name: '1111', platform: '抖店', url: 'https://fxg.jinritemai.com', host: 'jinritemai' }
]

async function main() {
  const main = await connect((await targets()).find(t => t.title === 'ShopPilot'))
  const storeList = JSON.parse(await main.ev(`(async () => {
    const r = await window.shopilot.store.list()
    return JSON.stringify((r.data.stores || r.data).map(s => ({ id: s.id, name: s.name })))
  })()`))
  main.close()
  for (const t of TARGETS) {
    const s = storeList.find(x => x.name === t.name)
    if (!s) { console.log(`[${t.platform}] 店铺不存在，跳过`); continue }
    const m = await connect((await targets()).find(x => x.title === 'ShopPilot'))
    await m.ev(`(async () => {
      await window.shopilot.browser.open('${s.id}')
      const tl = await window.shopilot.browser.tab.list('${s.id}')
      const tabs = tl.data.tabs || tl.data
      const hit = tabs.find(x => String(x.url).includes('${t.host}'))
      if (hit) { await window.shopilot.browser.tab.activate('${s.id}', hit.id); await window.shopilot.browser.navigate('${s.id}', hit.id, '${t.url}') }
      else await window.shopilot.browser.tab.create('${s.id}', '${t.url}')
      return 1
    })()`)
    m.close()
    await sleep(9000)
    const page = (await targets()).find(x => x.url.includes(t.host))
    if (!page) { console.log(`[${t.platform}] 页面未出现`); continue }
    const c = await connect(page)
    const info = await c.ev(`(() => {
      const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
      const body = clean(document.body ? document.body.innerText : '')
      const loginish = /扫码登录|登录|请登录|立即登录|账号登录|二维码/.test(body) && body.length < 600
      return JSON.stringify({ url: location.href.slice(0, 70), title: document.title.slice(0, 20), bodyLen: body.length, loginish, head: body.slice(0, 120) })
    })()`)
    c.close()
    console.log(`[${t.platform}]`, info)
  }
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
