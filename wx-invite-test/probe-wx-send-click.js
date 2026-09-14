/**
 * 真实点击表单页「发送邀约」，观察 3 秒内出现什么（弹窗/提示），
 * 只点「发送邀约」这一下，不点任何确认 —— 不会真实发送。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'

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
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    if (r.result?.value > 0) {
      return {
        send,
        ev: async (expr) => {
          const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
          if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 250))
          return res.result.value
        },
        close: () => ws.close()
      }
    }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const SNAPSHOT = [
  'var all=ENUM_ALL()',
  'var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var out={dialogs:[],sendBtns:[],bodyTail:""}',
  'for(var i=0;i<all.length;i++){var el=all[i];var o=own(el);var r=el.getBoundingClientRect();if(r.width<1||r.height<1)continue',
  '  if(/\\u786e\\u8ba4\\u53d1\\u9001\\u9080\\u7ea6|\\u786e\\u5b9a\\u53d1\\u9001|\\u53d1\\u9001\\u9080\\u7ea6\\u786e\\u8ba4/.test(o)&&o.length<40)out.dialogs.push({t:o,cls:String(el.className||"").slice(0,40),rect:[Math.round(r.left),Math.round(r.top)]})',
  '  if(o==="\\u53d1\\u9001\\u9080\\u7ea6")out.sendBtns.push({tag:el.tagName,cls:String(el.className||"").slice(0,44),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})',
  '}',
  'var bd=String(document.body?document.body.innerText:"").replace(/\\s+/g," ")',
  'out.bodyTail=bd.slice(-260)',
  'return JSON.stringify(out,null,1)'
].join('\n')

async function main() {
  const p = await pickLive('initiate-invite')
  if (!p) { console.log('没有打开的邀约表单页'); process.exit(0) }
  const before = JSON.parse(await p.ev(`${ENUM_DECL}\n;(function(){\n${SNAPSHOT}\n})()`))
  console.log('发送邀约 按钮:', JSON.stringify(before.sendBtns))
  console.log('点击前弹窗类元素:', JSON.stringify(before.dialogs))
  const btn = before.sendBtns.find(b => b.tag === 'BUTTON') || before.sendBtns[0]
  if (!btn) { console.log('没找到按钮'); process.exit(1) }
  const x = btn.rect[0] + Math.round(btn.rect[2] / 2)
  const y = btn.rect[1] + Math.round(btn.rect[3] / 2)
  console.log('真实点击 @', x, y)
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await sleep(250)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 6; i++) {
    await sleep(800)
    const s = JSON.parse(await p.ev(`${ENUM_DECL}\n;(function(){\n${SNAPSHOT}\n})()`))
    console.log(i * 0.8 + 's → 弹窗:', JSON.stringify(s.dialogs), '| 尾部文案:', JSON.stringify(s.bodyTail.slice(-90)))
    if (s.dialogs.length) break
  }
  p.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
