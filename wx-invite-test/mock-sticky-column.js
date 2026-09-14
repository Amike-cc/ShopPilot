/**
 * 仿真「固定列副本」广场（复刻微信小店 weui 表格结构，端口 8895）：
 * - 表格宽 1640px 放进 1380px 视口 → 横向滚动；
 * - 右侧「操作」列被复制成 position:fixed 的镜像（.weui-desktop-table__right-shadow），
 *   镜像里的「详情」正好压住滚动区那份（真店实测的遮挡形态）；
 * - 两份「详情」都是 window.open('/finder-detail?row=N')——**列表页自身不跳转**；
 * - 详情页里的「邀请带货」同样 window.open('/initiate-invite?row=N')。
 * 用来真机验证引擎的 followTab（跟随新标签页）与"同文本副本"遮挡处理。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROWS = 12
const state = { detailOpened: [], inviteOpened: [] }

const SQUARE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>仿真带货者广场</title>
<style>
  body{margin:0;font:14px/1.6 system-ui,"Microsoft YaHei";color:#111}
  .topbar{position:sticky;top:0;height:48px;background:#f5f5f5;border-bottom:1px solid #e5e5e5;display:flex;align-items:center;padding:0 12px;gap:10px}
  .chip{padding:4px 10px;border:1px solid #ddd;border-radius:14px;background:#fff}
  .wrap{margin-top:8px;overflow-x:auto}
  table{border-collapse:collapse;width:1640px}
  th,td{border-bottom:1px solid #eee;padding:10px 8px;text-align:left;white-space:nowrap}
  td.op{text-align:right;padding-right:18px}
  a.w-full{display:block;width:100%;text-align:right;color:#07c160;text-decoration:none;cursor:pointer}
  /* 平台把右侧操作列做成固定镜像，压在滚动区之上 */
  .weui-desktop-table__right{position:fixed;top:56px;right:0;width:170px;background:#fff;box-shadow:-6px 0 8px rgba(0,0,0,.06);z-index:20}
  .weui-desktop-table__right .r{height:41px;display:flex;align-items:center;justify-content:flex-end;padding-right:18px;border-bottom:1px solid #eee}
</style></head><body>
  <div class="topbar"><span class="chip">全部带货者</span><span class="chip">直播带货者</span><span id="hint">仿真广场（固定列副本）</span></div>
  <div id="host"></div>
  <script>
    const ROWS = ${ROWS};
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    const rowsHtml = Array.from({ length: ROWS }, (_, i) => \`
      <tr><td>达人 \${i + 1} 号</td><td>ID v2_row_\${i + 1}</td><td>类目 A</td><td>1.2万</td>
      <td class="op"><a href="javascript:void(0)" class="w-full text-right" data-row="\${i + 1}">详情</a></td></tr>\`).join('')
    const mirrorHtml = Array.from({ length: ROWS }, (_, i) => \`
      <div class="r"><a href="javascript:void(0)" class="w-full text-right" data-row="\${i + 1}">详情</a></div>\`).join('')
    root.innerHTML = \`
      <div class="wrap"><table><thead><tr><th>达人</th><th>ID</th><th>带货类目</th><th>场均销售额</th><th>操作</th></tr></thead>
      <tbody>\${rowsHtml}</tbody></table></div>
      <div class="weui-desktop-table__right weui-desktop-table__right-shadow" id="mirror">\${mirrorHtml}</div>\`
    root.querySelectorAll('a.w-full').forEach(a => a.addEventListener('click', () => {
      const n = a.getAttribute('data-row');
      // 平台行为：列表页自身不跳转，新开标签页
      window.open('/finder-detail?row=' + n, '_blank');
    }))
  </script>
</body></html>`

const DETAIL = row => `<!doctype html><html><head><meta charset="utf-8"><title>达人详情 \${row}</title>
<style>body{margin:0;font:14px/1.6 system-ui,"Microsoft YaHei")} .box{padding:16px}</style></head>
<body><div class="box">
  <h3>达人详情页</h3>
  <div>达人第 <b id="row">\${row}</b> 号</div>
  <div style="margin-top:10px"><a href="javascript:void(0)" id="invite" class="invite-entry">邀请带货</a></div>
</div>
<script>
  document.getElementById('invite').addEventListener('click', () => window.open('/initiate-invite?row=\${row}', '_blank'))
</script></body></html>`.replace(/\$\{row\}/g, String(row))

const INVITE = row => `<!doctype html><html><head><meta charset="utf-8"><title>邀约表单 \${row}</title></head>
<body style="font:14px/1.6 system-ui,sans-serif;padding:16px">
  <h3>邀约表单（仿真）</h3>
  <div>今日剩余 <b id="quota">3</b> 次邀请机会</div>
  <div>达人第 <b id="row">\${row}</b> 号</div>
  <textarea placeholder="合作说明"></textarea>
  <div><button>发送邀约</button></div>
</body></html>`.replace(/\$\{row\}/g, String(row))

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:8895')
  console.log(new Date().toLocaleTimeString(), req.method, u.pathname + u.search)
  const send = (html, code = 200) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(html) }
  if (u.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(state))
  }
  if (u.pathname === '/mock-square') return send(SQUARE)
  if (u.pathname === '/finder-detail') {
    const row = Number(u.searchParams.get('row') || 0)
    state.detailOpened.push(row)
    return send(DETAIL(row))
  }
  if (u.pathname === '/initiate-invite') {
    const row = Number(u.searchParams.get('row') || 0)
    state.inviteOpened.push(row)
    return send(INVITE(row))
  }
  if (u.pathname === '/reset') { state.detailOpened = []; state.inviteOpened = []; res.writeHead(200); return res.end('ok') }
  send('<h1>404</h1>', 404)
}).listen(8895, '127.0.0.1', () => console.log('mock sticky-column square on http://127.0.0.1:8895/mock-square'))
