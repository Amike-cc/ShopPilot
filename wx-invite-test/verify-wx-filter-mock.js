/** 在仿真微信广场上验证 prepareInviteSquare：类型/类目/其他筛选是否真的被受信任鼠标点中并生效 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const WX_STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
// 带时间戳绕开浏览器缓存（同一 URL 的旧仿真页会被复用，实测定位不到元素）
const MOCK = `http://127.0.0.1:8898/?v=${Date.now()}`

async function pickLive(urlPart) {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let s = 0
    const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++s
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) {
        return {
          ev: async (expr, awaitP = true) => {
            const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP, userGesture: true })
            if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 250))
            return res.result.value
          },
          close: () => ws.close()
        }
      }
    } catch { /* next */ }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const READ_MOCK = `(function(){
  var host=document.getElementById('stage'); var root=host&&host.shadowRoot; if(!root) return JSON.stringify({err:'no shadow',title:document.title,hostFound:!!host})
  var tabs=[].map.call(root.querySelectorAll('.tab'),function(a){return {t:a.textContent.trim(),on:a.className.indexOf('on')>=0}})
  var cats=[].map.call(root.querySelectorAll('#cats input'),function(cb){return {c:cb.getAttribute('data-c'),checked:cb.checked}})
  var others=[].map.call(root.querySelectorAll('#others input'),function(cb){return {o:cb.getAttribute('data-o'),checked:cb.checked}})
  var tags=root.getElementById?root.getElementById('tags').textContent:String(root.querySelector('#tags').textContent)
  var list=String(root.querySelector('#list').textContent)
  return JSON.stringify({tabs:tabs,cats:cats,others:others,tags:tags,list:list},null,1)
})()`

async function main() {
  const app = await pickLive('index.html')
  if (!app) throw new Error('no app page')
  // 先确保微信店铺窗口/标签页存在（prepareInviteSquare 作用于当前标签页）
  console.log('open store:', await app.ev(`(async()=>{const r=await window.shopilot.browser.open('${WX_STORE}');return r.ok})()`))
  await sleep(3500)
  const tabsInfo = await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${WX_STORE}');return JSON.stringify((r.data.tabs||[]).map(t=>t.id))})()`)
  console.log('tabs:', tabsInfo)
  // 直接调 IPC：把微信店铺的当前标签页导到仿真页并应用筛选
  const res = await app.ev(`(async () => {
    const r = await window.shopilot.browser.prepareInviteSquare('${WX_STORE}', {
      url: ${JSON.stringify(MOCK)},
      finderType: '直播带货者',
      categories: ['母婴', '美妆护肤'],
      otherFilters: ['有联系方式']
    })
    return JSON.stringify(r)
  })()`)
  console.log('IPC result (含被遮挡的 美妆护肤):', res)
  // 整块被遮挡的项：应如实报告遮挡者，而不是假装点成功
  const covered = await app.ev(`(async () => {
    const r = await window.shopilot.browser.prepareInviteSquare('${WX_STORE}', {
      url: ${JSON.stringify(MOCK + '&t=2')},
      finderType: '全部带货者',
      categories: ['生鲜'],
      otherFilters: []
    })
    return JSON.stringify(r)
  })()`)
  console.log('IPC result (整块被遮挡的 生鲜):', covered)
  app.close()
  await sleep(1500)

  const sq = await pickLive('127.0.0.1:8898')
  if (!sq) { console.log('no live mock page'); process.exit(1) }
  await sleep(500)
  const state = await sq.ev(READ_MOCK, false)
  console.log('mock state:', state)
  sq.close()
  // 断言
  try {
    const s = JSON.parse(state)
    const typeOn = (s.tabs || []).find(t => t.on && t.on === true)
    const catOk = ['母婴', '美妆护肤'].every(c => (s.cats || []).some(x => x.c === c && x.checked))
    const otherOk = (s.others || []).some(x => x.o === '有联系方式' && x.checked)
    const pass = !!typeOn && typeOn.t === '直播带货者' && catOk && otherOk
    console.log(pass ? 'FILTERS APPLIED OK' : 'FILTERS NOT APPLIED')
    process.exit(pass ? 0 : 1)
  } catch (e) {
    console.log('parse err', e.message)
    process.exit(1)
  }
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
