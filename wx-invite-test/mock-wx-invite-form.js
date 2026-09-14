/**
 * 微信邀约表单仿真页（ShadowRoot 版）：商品弹窗里每行显示「ID xxx」，
 * 用于验证 ensureRowsById（按商品ID匹配行 → 勾选 → 确认）的真实行为，不依赖登录态。
 * 用法：node mock-wx-invite-form.js [port]
 */
const http = require('http')
const PORT = Number(process.argv[2] || 8897)

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>邀约表单（仿真）</title>
<style>
 body{margin:0;font:13px system-ui,"Microsoft YaHei";background:#fff}
 .sec{padding:14px 20px}
 table{border-collapse:collapse;width:100%}
 td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}
 .dlg{position:fixed;inset:40px 80px;background:#fff;border:1px solid #ddd;box-shadow:0 8px 24px rgba(0,0,0,.18);display:none;padding:12px}
 .dlg.open{display:block}
 button{padding:4px 12px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer}
 .primary{border-color:#07c160;color:#07c160}
</style></head><body>
<h3 style="padding:12px 20px 0">邀约表单（仿真）</h3>
<div class="sec">
  <div style="display:flex;align-items:center;gap:12px">
    <b>邀约商品</b><span id="cnt" style="color:#888"></span>
    <button id="addBtn" style="margin-left:auto">添加商品</button>
  </div>
  <table><thead><tr><th>商品信息</th><th>商品价格</th></tr></thead><tbody id="picked"></tbody></table>
</div>
<div class="dlg" id="dlg">
  <h3 style="margin:0 0 8px">添加商品</h3>
  <table><thead><tr><th></th><th>商品信息</th><th>带货佣金率</th></tr></thead><tbody id="rows"></tbody></table>
  <div style="display:flex;align-items:center;gap:12px;margin-top:10px">
    <span id="selcnt" style="color:#888"></span>
    <button id="cancelBtn" style="margin-left:auto">取消</button>
    <button id="okBtn" class="primary">确认</button>
  </div>
</div>
<script>
const PRODUCTS = [
  { id: '10000687986401', name: '仿真商品 A' },
  { id: '10000687986402', name: '仿真商品 B' },
  { id: '10000687986403', name: '仿真商品 C' }
]
const picked = new Set()
const stage = document.createElement('div'); document.body.appendChild(stage)
const root = stage.attachShadow({ mode: 'open' })
root.innerHTML = '<div id="host"></div>'

function renderRows () {
  document.getElementById('rows').innerHTML = PRODUCTS.map(p =>
    '<tr data-row-key="' + p.id + '"><td><label class="weui-desktop-form__check-label">' +
    '<input type="checkbox" data-id="' + p.id + '"' + (picked.has(p.id) ? ' checked' : '') + '></label></td>' +
    '<td>' + p.name + '</td><td>ID ' + p.id + '</td></tr>').join('')
  document.querySelectorAll('#rows input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.getAttribute('data-id')
      if (cb.checked) picked.add(id); else picked.delete(id)
      document.getElementById('selcnt').textContent = '已选商品数量：' + picked.size + '/30'
    })
  })
  document.getElementById('selcnt').textContent = '已选商品数量：' + picked.size + '/30'
  // 主页面「邀约商品」表格
  document.getElementById('picked').innerHTML = PRODUCTS.filter(p => picked.has(p.id)).map(p =>
    '<tr data-row-key="' + p.id + '"><td>' + p.name + '</td><td>¥9.90</td></tr>').join('')
  document.getElementById('cnt').textContent = '已添加 ' + picked.size + ' 个'
}
document.getElementById('addBtn').addEventListener('click', () => {
  document.getElementById('dlg').classList.add('open')
  renderRows()
})
document.getElementById('cancelBtn').addEventListener('click', () => document.getElementById('dlg').classList.remove('open'))
document.getElementById('okBtn').addEventListener('click', () => {
  document.getElementById('dlg').classList.remove('open')
  renderRows()
})
renderRows()
</script>
</body></html>`

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' })
  res.end(PAGE)
}).listen(PORT, '127.0.0.1', () => console.log(`mock wx invite form on http://127.0.0.1:${PORT}/`))
