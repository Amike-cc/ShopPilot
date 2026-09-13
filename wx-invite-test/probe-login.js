/**
 * 微信小店登录有效期长期探测（方案 B）。
 *
 * 阶段0：等扫码登录（每 30s 探一次，发现登录即记 SESSION_START 并快照 Cookie）。
 * 阶段1：每 15 分钟一次轻量探测（单次同源 fetch，看 SSR 页是否出现「登录超时」错误页），
 *        并经 CDP Network.getCookies 快照会话/持久 Cookie 数量。结果逐行追加 JSONL。
 *
 * 结论读法：
 *  - ok 一直连续 = 服务端票据在「持续轻活动」下仍有效；
 *  - kicked = 被服务端踢掉（看与上一条 ok 的时间差 = 服务端有效期）；
 *  - app-down = 应用没开/CDP 不通（会话 Cookie 随进程死亡，此时 kicked 不算服务端证据）。
 */
const PORT = '9250'
const OUT = require('path').join(__dirname, 'login-probe.jsonl')
const INTERVAL_MS = 15 * 60 * 1000
const WAIT_MS = 30 * 1000
const MARKER_OUT = '登录超时'

const fs = require('fs')
const append = (obj) => { fs.appendFileSync(OUT, JSON.stringify(obj) + '\n') }
const log = (obj) => { append(obj); console.log(new Date().toISOString().slice(11, 19), JSON.stringify(obj)) }

async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page' && t.url.includes('store.weixin.qq.com')) }
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  return new Promise((ok, err) => {
    ws.onopen = () => {
      let seq = 0
      const pend = new Map()
      const doSend = (method, params = {}) => new Promise((ok2, err2) => {
        const id = ++seq
        pend.set(id, m => m.error ? err2(new Error(method + ' ' + JSON.stringify(m.error))) : ok2(m.result))
        ws.send(JSON.stringify({ id, method, params }))
      })
      ws.onmessage = e => {
        const m = JSON.parse(e.data)
        if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      }
      ok({ send: doSend, close: () => { try { ws.close() } catch { /* */ } } })
    }
    ws.onerror = err
  })
}

async function probeOnce() {
  const list = await targets()
  if (!list.length) return { state: 'no-tab' }
  const c = await connect(list[0])
  try {
    await c.send('Runtime.enable')
    const r = await c.send('Runtime.evaluate', {
      expression: `fetch(location.origin + '/shop/findersquare/find', { credentials: 'include' })
        .then(r => r.text().then(t => ({ len: t.length, out: t.includes('${MARKER_OUT}') || t.includes('请重新登录') })))
        .catch(e => ({ err: String(e).slice(0, 80) }))`,
      awaitPromise: true, returnByValue: true
    })
    if (r.exceptionDetails) return { state: 'probe-error', detail: JSON.stringify(r.exceptionDetails).slice(0, 120) }
    const page = r.result.value || {}
    let cookies = null
    try {
      const ck = await c.send('Network.getCookies', { urls: ['https://store.weixin.qq.com'] })
      const list2 = ck.cookies || []
      cookies = {
        total: list2.length,
        session: list2.filter(x => x.session).length,
        persist: list2.filter(x => !x.session).length
      }
    } catch { /* 快照失败不影响主判据 */ }
    return { state: page.out ? 'kicked' : 'ok', pageLen: page.len, cookies }
  } finally { c.close() }
}

let seenLogin = false
let lastOkAt = null
let waitingLoggedAt = 0

;(async () => {
  log({ event: 'probe-start', out: OUT, intervalMin: INTERVAL_MS / 60000 })
  for (;;) {
    let rec = null
    try { rec = await probeOnce() } catch (e) { rec = { state: 'app-down', detail: String(e && e.message || e).slice(0, 120) } }
    const ts = new Date().toISOString()
    if (rec.state === 'ok') {
      if (!seenLogin) { seenLogin = true; rec.event = 'SESSION_START' }
      lastOkAt = ts
      waitingLoggedAt = 0
      log({ ts, ...rec })
    } else if (seenLogin) {
      // 曾登录过 → 这次失效：记 KICKED（lastOkAt 给出最后一次有效时间）
      rec.event = 'KICKED'
      rec.lastOkAt = lastOkAt
      seenLogin = false
      log({ ts, ...rec })
    } else {
      // 还没登录：等待扫码期间不刷屏——30 分钟最多记一条 waiting
      const now = Date.now()
      if (now - waitingLoggedAt > 30 * 60 * 1000) {
        waitingLoggedAt = now
        log({ ts, event: 'waiting-login', detail: rec.detail || rec.state })
      }
    }
    await new Promise(r => setTimeout(r, seenLogin ? INTERVAL_MS : WAIT_MS))
  }
})().catch(e => { console.error('probe fatal', e); process.exit(1) })
