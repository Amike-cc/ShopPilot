/**
 * 微信带货者广场仿真页（ShadowRoot 版，模拟 micro-app 结构）
 * 用于验证 prepareInviteSquare 的「深度定位 → 受信任鼠标点击 → 勾选生效」链路，不依赖真实登录态。
 * 注意：innerHTML 里插入的 <script> 不会执行（实测踩过），因此渲染/事件绑定都放在外层脚本里，
 * 只把「内容在 ShadowRoot 内」这一关键结构保留下来。
 * 用法：node mock-wx-square.js [port]
 */
const http = require('http')
const PORT = Number(process.argv[2] || 8898)

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>微信带货者广场（仿真）</title>
<style>
 #stage{margin:0}
 body{margin:0;font:13px system-ui,"Microsoft YaHei";background:#fff}
 .tabs{display:flex;gap:24px;padding:16px 20px;border-bottom:1px solid #eee}
 .tab{color:rgba(0,0,0,.9);text-decoration:none;padding:4px 8px;border-radius:4px;cursor:pointer}
 .tab.on{color:#07c160;font-weight:600;background:rgba(7,193,96,.08)}
 .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 20px}
 .row-h{width:112px;color:rgba(0,0,0,.55)}
 .chip{display:inline-flex;align-items:center;gap:4px;border:1px solid #e5e5e5;border-radius:4px;padding:3px 8px;cursor:pointer}
 .chip.on{border-color:#07c160;color:#07c160}
 .tags{padding:8px 20px;color:#888}
 .list{padding:12px 20px;color:#333}
</style></head>
<body>
<div id="stage"></div>
<script>
const TYPES = ['全部带货者','直播带货者','短视频带货者','公众号带货者']
const CATS = ['文玩文创','母婴','美妆护肤','食品饮料','生鲜']
const OTHERS = ['可开发票','有联系方式']
let curType = '全部带货者'
const picked = new Set()

const host = document.getElementById('stage')
const root = host.attachShadow({ mode: 'open' })
root.innerHTML = '<div class="tabs" id="tabs"></div>' +
  '<div class="row"><span class="row-h">带货类目</span><span id="cats"></span></div>' +
  '<div class="row"><span class="row-h">其他筛选</span><span id="others"></span></div>' +
  '<div class="tags" id="tags"></div><div class="list" id="list"></div>'

function render() {
  root.querySelector('#tabs').innerHTML = TYPES.map(t =>
    '<a class="tab' + (t === curType ? ' on' : '') + '" data-t="' + t + '"><span>' + t + '</span></a>').join('')
  root.querySelector('#cats').innerHTML = CATS.map(c =>
    '<label class="chip' + (picked.has(c) ? ' on' : '') + '"><input type="checkbox" data-c="' + c + '"' +
    (picked.has(c) ? ' checked' : '') + '><span>' + c + '</span></label>').join('')
  root.querySelector('#others').innerHTML = OTHERS.map(o =>
    '<label class="chip' + (picked.has(o) ? ' on' : '') + '"><input type="checkbox" data-o="' + o + '"' +
    (picked.has(o) ? ' checked' : '') + '><span>' + o + '</span></label>').join('')
  const tags = []
  if (curType !== '全部带货者') tags.push('类型：' + curType)
  for (const c of CATS) if (picked.has(c)) tags.push('带货类目：' + c)
  for (const o of OTHERS) if (picked.has(o)) tags.push('其他筛选：' + o)
  root.querySelector('#tags').textContent = tags.length ? '已筛选 ' + tags.join('  ') : '（未筛选）'
  root.querySelector('#list').textContent = '达人列表：' + (curType === '全部带货者' ? '全部' : curType) +
    '｜类目 ' + (CATS.filter(c => picked.has(c)).join('、') || '不限') +
    '｜其他 ' + (OTHERS.filter(o => picked.has(o)).join('、') || '无')
  root.querySelectorAll('.tab').forEach(a => a.addEventListener('click', () => { curType = a.getAttribute('data-t'); render() }))
  root.querySelectorAll('#cats input').forEach(cb => cb.addEventListener('change', () => {
    const c = cb.getAttribute('data-c'); if (cb.checked) picked.add(c); else picked.delete(c); render()
  }))
  root.querySelectorAll('#others input').forEach(cb => cb.addEventListener('change', () => {
    const o = cb.getAttribute('data-o'); if (cb.checked) picked.add(o); else picked.delete(o); render()
  }))
}
render()
</script>
</body></html>`

http.createServer((req, res) => {
  // no-store：否则改了仿真页内容后浏览器仍用缓存（实测踩过：定位一直找不到元素）
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' })
  res.end(PAGE)
}).listen(PORT, '127.0.0.1', () => console.log(`mock wx square on http://127.0.0.1:${PORT}/`))
