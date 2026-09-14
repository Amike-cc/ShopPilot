/** 稳健到达邀约表单页：点「详情」→ 找详情页 → 点「邀请带货」→ 确认 initiate-invite 打开 */
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
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) {
        return {
          send,
          ev: async (expr) => {
            const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
            if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 200))
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

/** 在页面上按文案真实点击（取未被遮挡的点） */
async function clickText(page, needle) {
  const raw = await page.ev(`${ENUM_DECL}
    ;(function(){
      var N=${JSON.stringify(needle)}
      var all=ENUM_ALL()
      var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}
      var deepAt=function(x,y){var el=document.elementFromPoint(x,y);while(el&&el.shadowRoot){var inner=el.shadowRoot.elementFromPoint(x,y);if(!inner||inner===el)break;el=inner}return el}
      var cands=[]
      for(var i=0;i<all.length;i++){var el=all[i];if(own(el)!==N)continue;var r=el.getBoundingClientRect();if(!(r.width>0&&r.height>0))continue;cands.push(el)}
      for(var c=0;c<cands.length;c++){var el2=cands[c];var r2=el2.getBoundingClientRect()
        var xs=[0.15,0.35,0.5,0.65,0.85].map(function(f){return Math.round(r2.left+r2.width*f)})
        var ys=[0.5,0.25,0.75].map(function(f){return Math.round(r2.top+r2.height*f)})
        for(var a=0;a<xs.length;a++)for(var b=0;b<ys.length;b++){var hit=deepAt(xs[a],ys[b]);if(hit&&(hit===el2||el2.contains(hit)||hit.contains(el2)))return JSON.stringify({ok:true,x:xs[a],y:ys[b],n:cands.length})}
      }
      return JSON.stringify({ok:false,n:cands.length})
    })()`, )
  const pt = JSON.parse(raw)
  if (!pt.ok) return false
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' })
  await sleep(200)
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  return true
}

async function main() {
  // 1) 点详情（最多 3 次）
  let detail = null
  for (let attempt = 1; attempt <= 3 && !detail; attempt++) {
    const sq = await pickLive('findersquare/find')
    if (sq) {
      const ok = await clickText(sq, '详情')
      console.log(`第 ${attempt} 次点「详情」:`, ok)
      sq.close()
      await sleep(7000)
    }
    detail = await pickLive('finder-detail')
  }
  if (!detail) { console.log('未进入详情页'); process.exit(1) }
  console.log('详情页:', await detail.ev('location.href.slice(0,90)'))
  // 2) 点邀请带货
  const ok = await clickText(detail, '邀请带货')
  console.log('点「邀请带货」:', ok)
  detail.close()
  await sleep(8000)
  // 3) 确认表单页
  const form = await pickLive('initiate-invite')
  if (!form) { console.log('未进入表单页'); process.exit(1) }
  console.log('表单页:', await form.ev('location.href.slice(0,90)'))
  form.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
