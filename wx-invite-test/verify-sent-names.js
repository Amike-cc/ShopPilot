/**
 * 点名复核：从最近一次邀约运行的 clickAll payload 里取达人昵称，
 * 在达人广场逐个搜出来，检查该行是否已「发过消息」且复选框禁用。
 * 用法：node verify-sent-names.js [取前 N 个] [搜索等待ms]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const TOPN = Number(process.argv[2] || 3)
const WAIT = Number(process.argv[3] || 3500)

async function connect(titleMatch) {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.title.includes(titleMatch) || x.url.includes(titleMatch))
  if (!t) throw new Error('找不到目标: ' + titleMatch)
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  return (expr) => new Promise((ok, err) => {
    const id = Math.floor(Math.random() * 1e9)
    const on = e => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      ws.removeEventListener('message', on)
      if (m.error) return err(new Error(JSON.stringify(m.error)))
      if (m.result?.exceptionDetails) return err(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)))
      ok(m.result?.result?.value)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const evApp = await connect('ShopPilot')
  const raw = await evApp(`(async () => {
    const r = await window.shopilot.task.list()
    const all = Array.isArray(r.data) ? r.data : []
    const t = all.filter(x => String(x.name || '').startsWith('\\u8fbe\\u4eba\\u9080\\u7ea6'))[0]
    const run = t.latestRun || (t.runs || [])[0] || {}
    const res = await window.shopilot.task.results(run.id)
    const steps = res.data.results || []
    const norm = (s) => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
    const ca = steps.map(norm).find(p => p.action === 'clickAll')
    const p = ca || {}
    return JSON.stringify({ runId: run.id, status: run.status, clicked: p.clicked, pageSelected: p.pageSelected, samples: p.samples || [] })
  })()`)
  const info = JSON.parse(raw)
  console.log('run', info.runId, 'status', info.status, 'clicked', info.clicked, 'pageSelected', info.pageSelected)

  const names = info.samples.map(s => String(s).split(/\s+/)[0]).filter(Boolean).slice(0, TOPN)
  console.log('抽查名单:', JSON.stringify(names))

  const evPage = await connect('daren-square')
  const out = []
  for (const name of names) {
    const r = await evPage(`(async () => {
      const NAME = ${JSON.stringify(name)}
      const inp = document.querySelector('input.auxo-input[type=search], input.auxo-input')
      if (!inp) return JSON.stringify({ name: NAME, err: 'NO_INPUT' })
      const proto = window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(inp, NAME)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new Event('change', { bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
      const btn = [...document.querySelectorAll('button')].find(b => String(b.innerText || '').replace(/\\s+/g, '') === '\\u641c\\u7d22')
      if (btn) btn.click()
      await new Promise(x => setTimeout(x, ${WAIT}))
      const rows = [...document.querySelectorAll('tbody tr')].filter(tr => tr.getAttribute('data-row-key'))
      const hit = rows.find(tr => String(tr.innerText || '').includes(NAME)) || rows[0]
      if (!hit) return JSON.stringify({ name: NAME, rows: rows.length, found: false })
      const t = String(hit.innerText || '').replace(/\\s+/g, ' ').trim()
      const cb = hit.querySelector('input[type=checkbox]')
      return JSON.stringify({
        name: NAME, rows: rows.length, found: String(hit.innerText || '').includes(NAME),
        rowText: t.slice(0, 80),
        sentBadge: /\\u53d1\\u8fc7\\u6d88\\u606f/.test(t), continueChat: /\\u7ee7\\u7eed\\u6c9f\\u901a/.test(t),
        checkboxDisabled: !!(cb && cb.disabled)
      })
    })()`)
    out.push(JSON.parse(r))
    console.log(JSON.stringify(JSON.parse(r)))
    await sleep(600)
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
