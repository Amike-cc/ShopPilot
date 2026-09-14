/**
 * 微信带货者广场：探测筛选下拉选项（带货类目、其他筛选）+ 打开添加商品弹窗看结构
 * 用法：node probe-wx-filters.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_ALL = `function ENUM_ALL(){const o=[];const w=r=>{for(const e of r.querySelectorAll('*')){o.push(e);if(e.shadowRoot)w(e.shadowRoot)};if(r.shadowRoot)w(r.shadowRoot)};w(document);return o}`

async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  let target = null
  for (const t of list.filter(x => x.type === 'page' && (x.url.includes('findersquare/find') || x.url.includes('findersquare/initiate-invite')))) {
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
      if (r.result?.value > 0) { target = { send }; break }
    } catch {}
    ws.close()
  }
  if (!target) throw new Error('no live page')
  const ev = async (expr) => {
    const r = await target.send('Runtime.evaluate', {
      expression: `${ENUM_ALL}\n;(()=>{${expr}})()`,
      returnByValue: true, awaitPromise: true, userGesture: true
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  const click = async (x, y) => {
    await target.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await target.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await target.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const url = await ev('return location.href').catch(_ => '')

  if (url.includes('findersquare/find')) {
    // ----- 筛选页面 -----
    const DUMP = `const all=ENUM_ALL();const own=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
    const text=e=>String(e.innerText||'').replace(/\\s+/g,' ').trim();const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.x<1600&&r.y<900};
    const out=[];const seen=new Set();
    for(const el of all){
      if(el.tagName!=='LABEL'&&!(el.tagName==='INPUT'&&el.type==='checkbox')) continue
      if(!vis(el)) continue
      const t=text(el).slice(0,28);const key=el.tagName+'|'+(el.value||'')+'|'+t
      if(seen.has(key)) continue;seen.add(key)
      const r=el.getBoundingClientRect();out.push({tag:el.tagName,t:t||null,v:el.value||null,rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]})
    }
    return JSON.stringify(out.slice(0,40))`

    console.log('=== 带货类目 ===')
    await click(256, 334); await sleep(1200)
    console.log(await ev(DUMP))
    await click(256, 334); await sleep(800)

    console.log('=== 其他筛选 ===')
    await click(256, 550); await sleep(1200)
    console.log(await ev(DUMP))
    await click(256, 550); await sleep(800)

    // 类型页签选中态
    await click(360, 264); await sleep(1500)
    console.log('=== 类型页签(直播) ===')
    console.log(await ev(`const all=ENUM_ALL();const own=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
    const out=[];
    for(const el of all){const o=own(el);if(!/^(全部带货者|直播带货者|短视频带货者|公众号带货者)$/.test(o))continue;const r=el.getBoundingClientRect();if(!(r.width>0))continue;out.push({t:o,cls:String(el.className).slice(0,70),r:[Math.round(r.x),Math.round(r.y)]})}
    return JSON.stringify(out)`))

  } else if (url.includes('initiate-invite')) {
    // ----- 邀约表单（添加商品弹窗）-----
    console.log('=== 邀约表单页 ===')
    console.log(await ev(`const all=ENUM_ALL();const text=e=>String(e.innerText||'').replace(/\\s+/g,' ').trim();
    const own=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
    const out=[];const seen=new Set();
    for(const el of all){
      const o=own(el);if(!o||o.length>30)continue;const r=el.getBoundingClientRect();if(!(r.width>0))continue
      const key=o+'|'+Math.round(r.x);if(seen.has(key))continue;seen.add(key)
      out.push({tag:el.tagName,own:o.slice(0,30),cls:String(el.className).slice(0,40),rect:[Math.round(r.x),Math.round(r.y)]})
    }
    return JSON.stringify(out.slice(0,50))`))

    // 点添加商品看弹窗
    const addBtn = await ev(`const all=ENUM_ALL();const text=e=>String(e.innerText||'').replace(/\\s+/g,'').trim();return JSON.stringify(all.filter(e=>text(e)==='添加商品').slice(0,3).map(e=>{const r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}))`)
    const btns = JSON.parse(addBtn)
    if (btns.length) {
      console.log('=== 点添加商品 ===')
      await click(btns[0].x, btns[0].y); await sleep(2500)
      console.log(await ev(`const all=ENUM_ALL();const text=e=>String(e.innerText||'').replace(/\\s+/g,' ').trim();
      const own=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
      const out=[];const seen=new Set();
      for(const el of all){
        const r=el.getBoundingClientRect();if(!(r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.x<1600&&r.y<900))continue
        const o=own(el);if(!o||o.length>40||!o.trim())continue
        const key=o+'|'+Math.round(r.x);if(seen.has(key))continue;seen.add(key)
        out.push({tag:el.tagName,own:o.slice(0,40),cls:String(el.className).slice(0,40),rect:[Math.round(r.x),Math.round(r.y)]})
      }
      return JSON.stringify(out.slice(0,60))`))
    }
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })