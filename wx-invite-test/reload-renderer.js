/** 重载 9251 临时实例的渲染层（接受 CDP 端口参数） */
const PORT = process.argv[2] || '9251'
async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
;(async () => {
  const list = await targets()
  const t = list.find(x => x.title === 'ShopPilot')
  if (!t) throw new Error('no ShopPilot target on ' + PORT)
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'location.reload()' } }))
  await new Promise(r => setTimeout(r, 400))
  ws.close()
  console.log('reloaded renderer on', PORT)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
