/**
 * 覆盖式链接仿真页：一行里「详情」按钮被同一行内的 <a> 覆盖（模拟微信广场整卡可点）。
 * 用于验证引擎的 viaBlocker：应点中覆盖链接（用户实际会做的事），而不是被判 COVERED 失败。
 * 用法：node mock-covered-button.js [port]
 */
const http = require('http')
const PORT = Number(process.argv[2] || 8896)

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>覆盖按钮仿真</title>
<style>
 body{margin:0;font:13px system-ui,"Microsoft YaHei"}
 table{border-collapse:collapse;width:100%}
 td{border-bottom:1px solid #eee;padding:8px}
 .row{position:relative}
 .detail{position:relative;z-index:1}
 .cover{position:absolute;inset:0;z-index:2;display:block;text-align:right;text-decoration:none;color:transparent}
 .hit{margin:10px;color:#07c160}
</style></head><body>
<h3 style="padding:12px 16px 0">覆盖按钮仿真（详情被同行内的链接覆盖）</h3>
<div class="hit" id="hit">未点击</div>
<table><tbody>
  <tr data-row-key="row-1"><td class="row">
    <button class="detail">详情</button>
    <a class="cover" href="#" data-cover="row-1">整卡链接</a>
  </td></tr>
  <tr data-row-key="row-2"><td class="row">
    <button class="detail">详情</button>
    <a class="cover" href="#" data-cover="row-2">整卡链接</a>
  </td></tr>
</tbody></table>
<script>
document.querySelectorAll('.cover').forEach(a => a.addEventListener('click', (e) => {
  e.preventDefault()
  document.getElementById('hit').textContent = '覆盖链接被点击: ' + a.getAttribute('data-cover')
}))
document.querySelectorAll('.detail').forEach(b => b.addEventListener('click', () => {
  document.getElementById('hit').textContent = '按钮被点击（说明没被遮挡）'
}))
</script></body></html>`

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' })
  res.end(PAGE)
}).listen(PORT, '127.0.0.1', () => console.log(`mock covered button on http://127.0.0.1:${PORT}/`))
