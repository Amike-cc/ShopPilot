/** 验证：① Esc 关掉浮层后 美妆护肤 是否可点中 ② 类型页签选中态怎么判定 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'

const POINT_AT = (x, y) => `(function(){
  var deep=document.elementFromPoint(${x},${y})
  while(deep&&deep.shadowRoot){var inner=deep.shadowRoot.elementFromPoint(${x},${y});if(!inner||inner===deep)break;deep=inner}
  var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}
  var lab=deep?deep.closest('label'):null
  return JSON.stringify({tag:deep?deep.tagName:null,cls:deep?String(deep.className||'').slice(0,46):null,own:deep?own(deep).slice(0,20):null,labelCls:lab?String(lab.className||'').slice(0,50):null,labelInput:lab&&lab.querySelector('input')?!!lab.querySelector('input').checked:null})
})()`

const CAT_STATE = `(function(){
  var all=ENUM_ALL()
  var text=function(e){return String(e.innerText||'').replace(/\\s+/g,' ').trim()}
  var out={}
  for(var i=0;i<all.length;i++){var el=all[i];if(el.tagName!=='INPUT'||el.type!=='checkbox')continue;var lab=el.closest('label');if(!lab)continue;var t=text(lab);if(t==='\\u6bcd\\u5a74'||t==='\\u7f8e\\u5986\\u62a4\\u80a4'||t==='\\u6709\\u8054\\u7cfb\\u65b9\\u5f0f')out[t]=!!el.checked}
  return JSON.stringify(out)
})()`

const TABS = `(function(){
  var all=ENUM_ALL()
  var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}
  var out=[]
  for(var i=0;i<all.length;i++){var el=all[i];var o=own(el);if(o!=='\\u76f4\\u64ad\\u5e26\\u8d27\\u8005')continue;out.push({tag:el.tagName,cls:String(el.className||'').slice(0,60),parentCls:el.parentElement?String(el.parentElement.className||'').slice(0,60):null,gpCls:el.parentElement&&el.parentElement.parentElement?String(el.parentElement.parentElement.className||'').slice(0,60):null})}
  return JSON.stringify(out.slice(0,4))
})()`

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
const key = async (sq, k, code, vk) => {
  await sq.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await sq.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}

async function main() {
  const sq = await pickLive('findersquare/find')
  if (!sq) throw new Error('no live square')
  console.log('cats before:', await sq.ev(`${ENUM_DECL}\n;${CAT_STATE}`))
  console.log('point 美妆护肤 before Esc:', await sq.ev(POINT_AT(587, 414)))
  await key(sq, 'Escape', 'Escape', 27)
  await sleep(900)
  console.log('point 美妆护肤 after  Esc:', await sq.ev(POINT_AT(587, 414)))
  // 真实点击 美妆护肤
  await sq.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 587, y: 414, button: 'none' })
  await sleep(250)
  await sq.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 587, y: 414, button: 'left', clickCount: 1 })
  await sq.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 587, y: 414, button: 'left', clickCount: 1 })
  await sleep(1500)
  console.log('cats after click:', await sq.ev(`${ENUM_DECL}\n;${CAT_STATE}`))
  console.log('tabs now:', await sq.ev(`${ENUM_DECL}\n;${TABS}`))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
