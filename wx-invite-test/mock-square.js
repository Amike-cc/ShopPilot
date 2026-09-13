/**
 * 抖店广场仿真站点（验证 loop 的"额度用完 → 干净停止"语义，不碰真实店铺）。
 *
 * 页面结构与真实广场同构（关键锚点一致）：
 *   - 主推类目快捷选项行 .quick-filter-button-enums + 展开按钮
 *   - 达人等级下拉（含同名"不限"项，用于验证 within 限定）
 *   - 级联弹层 .quick-filter-cascader-popover（点 chip 后出现，需再点叶子）
 *   - 「已筛选」标签行（clamp 后在父容器里出现 主推类目：X/不限）
 *   - 列表 tbody input[type=checkbox]（含已邀约禁用行）
 *   - 批量邀约带货 → 抽屉（textarea + 确认发送）→ 确认发送后抽屉关闭
 *   - 每日额度 QUOTA：每发送一批扣 BATCH 次；额度不足时「确认发送」为 disabled（=真实平台的额度用尽表现）
 *
 * 用法：node mock-square.js [port] [quota]
 *   访问 http://127.0.0.1:PORT/daren-square
 */
const http = require('http')
const PORT = Number(process.argv[2] || 8899)
const QUOTA = Number(process.argv[3] || 80)   // 总额度
const BATCH = 40                               // 每批消耗

let sent = 0            // 已发送人次
const state = { quotaUsed: 0, batches: 0, log: [] }
let serverUsed = 0                          // 服务端累计额度消耗（页面刷新不回血）
let serverBatches = 0
const serverSends = []                      // 每次发送的人次，便于断言"每批 40"

const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>达人广场（仿真）</title>
<style>
 body{font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:16px;background:#fff}
 .row{display:flex;gap:8px;align-items:center;margin:6px 0}
 .quick-filter-button-enums a{margin-right:6px;padding:2px 8px;border:1px solid #ddd;border-radius:4px;text-decoration:none;color:#333}
 .quick-filter-button-enums a.auxo-btn-secondary{border-color:#2b7de9;color:#2b7de9;font-weight:600}
 .quick-filter-cascader-popover{position:absolute;top:120px;left:120px;background:#fff;border:1px solid #ddd;box-shadow:0 4px 12px rgba(0,0,0,.12);display:none;z-index:9}
 .quick-filter-cascader-popover.open{display:block}
 .auxo-cascader-menu{list-style:none;margin:0;padding:4px 0;min-width:140px}
 .auxo-cascader-menu li{padding:4px 12px;cursor:pointer}
 .auxo-cascader-menu li:hover{background:#f2f6ff}
 .filtered{color:#888;margin:6px 0}
 table{border-collapse:collapse;width:100%}
 td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}
 .auxo-table-body{height:260px;overflow:scroll;border:1px solid #eee}
 .drawer{position:fixed;right:0;top:0;bottom:0;width:360px;background:#fff;border-left:1px solid #ddd;box-shadow:-4px 0 12px rgba(0,0,0,.1);padding:16px;display:none}
 .drawer.open{display:block}
 button{padding:4px 10px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer}
 button[disabled]{opacity:.5;cursor:not-allowed}
 .quota{margin:8px 0;color:#c00}
</style></head><body>
<h3>达人广场（仿真 · 仅用于验证引擎）</h3>
<div id="filterArea">
<div class="row">主推类目
  <span class="quick-filter-button-enums">
    <a class="auxo-btn auxo-btn-tertiary" data-cat="玩具乐器"><span class="auxo-space-item"><span>玩具乐器</span></span></a>
    <a class="auxo-btn auxo-btn-tertiary" data-cat="生鲜"><span class="auxo-space-item"><span>生鲜</span></span></a>
  </span>
  <a class="auxo-btn" id="expand">展开</a>
</div>
<div class="row">达人等级
  <button id="lvTrigger">达人等级</button>
  <span id="lvPanel" style="display:none">
    <span class="lv" data-lv="不限">不限</span>
    <span class="lv" data-lv="LV0">LV0</span>
    <span class="lv" data-lv="LV1">LV1</span>
  </span>
</div>
</div>
<script>
// ?late=1：前 4 秒隐藏筛选区——用于验证 clickByText 的 within 作用域会轮询等待
// （0.4.5 修的缺陷：导航刚完成时筛选区未渲染，曾因"立即报 SCOPE_NOT_FOUND"而整单失败）
if (location.search.includes('late=1')) {
  const fa = document.getElementById('filterArea')
  fa.style.display = 'none'
  setTimeout(() => { fa.style.display = '' }, 4000)
}
</script>
<div class="row">
  <input id="kw" placeholder="搜达人昵称" />
  <button id="search">搜索</button>
</div>
<div id="filteredBox"></div>
<div class="quota" id="quotaInfo"></div>
<div class="auxo-table-body">
  <table><thead><tr><th><input type="checkbox" id="all"></th><th>达人</th><th>类目</th></tr></thead>
  <tbody id="tbody"></tbody></table>
</div>
<div class="row"><button id="batchInvite">批量邀约带货</button></div>

<div class="quick-filter-cascader-popover" id="cascader">
  <ul class="auxo-cascader-menu">
    <li class="auxo-cascader-menu-item" data-leaf="不限">不限</li>
    <li class="auxo-cascader-menu-item auxo-cascader-menu-item-expand" data-leaf="副类目A">副类目A</li>
  </ul>
</div>

<div class="drawer" id="drawer">
  <h4>批量沟通</h4>
  <div id="goods">推荐商品：仿真商品 A / B</div>
  <textarea id="script" style="width:100%;height:80px" placeholder="邀约话术"></textarea>
  <div class="row">
    <button id="confirmSend">确认发送</button>
    <button id="cancelDrawer">取消</button>
  </div>
  <div id="drawerMsg" style="color:#c00"></div>
</div>

<script>
const QUOTA = ${QUOTA}, BATCH = ${BATCH};
let used = 0, batches = 0;
let selectedCat = '', selectedLeaves = [], selectedLevels = [];
const selected = new Set()      // 勾选状态自己记着：render 会重建行 DOM，不能让它把勾选冲掉
const rows = []
for (let i = 1; i <= 120; i++) rows.push({ i, name: '达人' + i, cat: i % 2 ? '生鲜' : '玩具乐器', invited: i % 7 === 0 })

// 额度在服务端（真实平台的额度不会因为刷新页面就回血）；页面加载后取一次
fetch('/state').then(r => r.json()).then(j => { used = j.used || 0; batches = j.batches || 0; render() }).catch(() => {})

function visibleRows() {
  return rows.filter(r => !selectedCat || r.cat === selectedCat)
}

/** 只重建行列表（勾选态从 selected 恢复） */
function renderList() {
  document.getElementById('tbody').innerHTML = visibleRows().map(r =>
    '<tr data-row-key="row' + r.i + '"><td><label class="cb"><input type="checkbox" ' +
    (r.invited ? 'disabled' : '') + (selected.has(r.i) ? ' checked' : '') + ' data-i="' + r.i + '">' +
    '</label></td><td>' + r.name + '</td><td>' + r.cat + '</td></tr>'
  ).join('')
  document.querySelectorAll('tbody input[type=checkbox]').forEach(cb => {
    // 原生 label 激活已经把 checked 翻好了，这里只记录状态、不动 DOM（重建会把后面的点击目标换掉）
    cb.addEventListener('click', () => {
      const i = Number(cb.dataset.i)
      if (cb.checked) selected.add(i); else selected.delete(i)
      refreshMeta()
    })
  })
  document.getElementById('all').onclick = () => {}
}

/** 只刷新额度提示与「确认发送」可用性（=真实平台的额度用尽表现） */
function refreshMeta() {
  document.getElementById('quotaInfo').textContent =
    '剩余额度 ' + Math.max(0, QUOTA - used) + ' 次 · 已发 ' + used + ' 人次 / ' + batches + ' 批'
  const tags = []
  if (selectedCat) tags.push('主推类目：' + selectedCat + '/' + (selectedLeaves[0] || '不限'))
  if (selectedLevels.length) tags.push('达人等级：' + selectedLevels.join('，'))
  document.getElementById('filteredBox').innerHTML = tags.length
    ? '<div class="auxo-row"><div class="auxo-col">已筛选</div><div class="auxo-col">' + tags.join(' ') + '</div></div>'
    : ''
  document.getElementById('confirmSend').disabled = !((QUOTA - used) >= 1 && selected.size > 0)
}
function render() { renderList(); refreshMeta() }
function selectedCount() { return selected.size }

// 类目 chip：点击后展开级联（叶子未选 → 筛选不生效，与真实平台一致）
document.querySelectorAll('.quick-filter-button-enums a[data-cat]').forEach(a => {
  a.addEventListener('click', () => {
    document.querySelectorAll('.quick-filter-button-enums a[data-cat]').forEach(x => x.className = 'auxo-btn auxo-btn-tertiary')
    a.className = 'auxo-btn auxo-btn-secondary'
    selectedCat = a.dataset.cat; selectedLeaves = []
    document.getElementById('cascader').classList.add('open')
    render()
  })
})
document.getElementById('expand').addEventListener('click', () => {})
document.querySelectorAll('#cascader li').forEach(li => {
  li.addEventListener('click', () => {
    selectedLeaves = [li.dataset.leaf]
    document.getElementById('cascader').classList.remove('open')
    render()
  })
})
document.getElementById('lvTrigger').addEventListener('click', () => {
  document.getElementById('lvPanel').style.display = 'inline'
})
document.querySelectorAll('.lv').forEach(el => {
  el.addEventListener('click', () => {
    const v = el.dataset.lv
    if (!selectedLevels.includes(v)) selectedLevels.push(v)
    render()
  })
})
document.getElementById('search').addEventListener('click', () => { render() })
document.getElementById('batchInvite').addEventListener('click', () => {
  refreshMeta()
  if (!selectedCount()) { document.getElementById('drawerMsg').textContent = '请先勾选达人'; return }
  document.getElementById('drawer').classList.add('open')
  document.getElementById('drawerMsg').textContent = ''
})
document.getElementById('cancelDrawer').addEventListener('click', () => {
  document.getElementById('drawer').classList.remove('open')
})
document.getElementById('confirmSend').addEventListener('click', () => {
  const n = selectedCount()
  if ((QUOTA - used) < 1) { document.getElementById('drawerMsg').textContent = '今日额度已用完'; return }
  used += n; batches++
  try { fetch('/report', { method: 'POST', body: JSON.stringify({ n }) }) } catch (e) {}
  document.getElementById('drawer').classList.remove('open')
  // 已邀约的行下次渲染时禁用（与真实平台一致）；本轮勾选清空
  for (const i of selected) { const r = rows.find(x => x.i === i); if (r) r.invited = true }
  selected.clear()
  renderList(); refreshMeta()
})
document.getElementById('all').addEventListener('click', () => {})
render()
</script>
</body></html>`

http.createServer((req, res) => {
  if (req.url.startsWith('/daren-square')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }
  if (req.url.startsWith('/report') && req.method === 'POST') {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}')
        const n = Number(j.n || 0)
        if (n > 0) { serverUsed += n; serverBatches++; serverSends.push(n) }
      } catch { /* ignore */ }
      res.writeHead(200); res.end('ok')
    })
    return
  }
  if (req.url.startsWith('/state')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ used: serverUsed, batches: serverBatches, sends: serverSends }))
    return
  }
  res.writeHead(404); res.end('nope')
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock square on http://127.0.0.1:${PORT}/daren-square (QUOTA=${QUOTA}, BATCH=${BATCH})`)
})
