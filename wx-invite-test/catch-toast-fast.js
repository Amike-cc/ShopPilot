/** 读广场地址配置 + 点开始邀约后 200ms 粒度抓 toast；同时用 IPC 直接建一个"面板同款"任务看错误 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const app = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = async (expr) => (await new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  }))
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  console.log('广场地址配置:', await ev(`(async()=>{const r=await window.shopilot.settings.get('invite.squareUrls');return JSON.stringify(r.data)})()`))
  await ev(`(()=>{window.__lastToast='';const orig=window.shopilot;return 'ok'})()`)
  console.log('点击前文本快照长度:', await ev(`String(document.body.innerText||'').length`))
  await ev(`(()=>{document.querySelector('[data-test=invite-start]').click();return 'clicked'})()`)
  for (let i = 0; i < 15; i++) {
    await sleep(200)
    const hit = await ev(`(()=>{const t=String(document.body.innerText||'');const m=t.match(/[^\\n]{0,20}(失败|错误|不合法|无效|Invalid|required)[^\\n]{0,120}/);return m?m[0]:null})()`)
    if (hit) { console.log('（' + (i * 0.2).toFixed(1) + 's）页面出现提示:', JSON.stringify(hit)); break }
    if (i === 14) console.log('3 秒内页面无任何失败提示')
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
