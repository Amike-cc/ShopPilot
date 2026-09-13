/**
 * 微信小店「邀请带货」表单页的本地仿真（引擎验收用，不碰真实平台）。
 * 结构按 2026-09-13 实测复刻：micro-app ShadowRoot + weui 表单/弹窗 + placeholder 锚点 +
 * 类名禁用态发送按钮 + 添加商品弹窗（tbody 复选框）+ 确认发送邀约弹窗 + 今日剩余额度文案。
 *
 * 端口 8765；/wx-mock/initiate-invite?finderUsername=xxx 返回表单页。
 * 行为：
 *  - 发送邀约仅在 联系人 && (微信||手机) && 话术 && 商品行 ≥1 时可点（类名禁用态）；
 *  - 弹窗确认把勾选商品加进邀约表格；「确认发送邀约」弹窗确认后额度 -1 并记 window.__sentCount。
 */
const http = require('http')

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>微信小店 带货邀约</title></head><body>
<div id="app"></div>
<script>
const host = document.getElementById('app')
const root = host.attachShadow({ mode: 'open' })
root.innerHTML = \`
<div class="windows-system">
  <div class="page">
    <h2>带货邀约</h2>
    <div class="weui-desktop-form__form">
      <label>邀约联系人</label>
      <input id="contact" class="weui-desktop-form__input" placeholder="填写商家侧邀约联系人" />
      <label>微信号</label>
      <input id="wechat" class="weui-desktop-form__input" placeholder="填写微信号" />
      <label>手机号码</label>
      <input id="phone" class="weui-desktop-form__input" placeholder="填写手机号码" />
      <label>合作说明</label>
      <textarea id="script" class="weui-desktop-form__textarea" placeholder="填写合作说明，比如告知带货者：商品价格可与您协商，并支持在直播为其实时改价"></textarea>
      <span id="counter">0/200</span>
    </div>
    <div class="goods-sec">
      <div>邀约商品
        <button id="add-last" class="link-like">添加上次邀约商品</button>
        <button id="add-goods" class="weui-desktop-btn weui-desktop-btn_default">添加商品</button>
      </div>
      <table class="weui-desktop-table__core-table">
        <thead><tr><th>商品信息</th><th>商品价格</th><th>带货佣金率</th><th>操作</th></tr></thead>
        <tbody id="goods-body"></tbody>
      </table>
    </div>
    <div class="bottom-bar">
      <span id="quota">今日剩余200次邀请机会</span>
      <button id="cancel" class="weui-desktop-btn weui-desktop-btn_default">取消</button>
      <button id="send" class="weui-desktop-btn weui-desktop-btn_primary weui-desktop-btn_disabled">发送邀约</button>
    </div>
  </div>

  <div id="goods-dialog" class="weui-desktop-dialog__wrp" style="display:none">
    <div class="weui-desktop-dialog">
      <div class="weui-desktop-dialog__title">添加商品</div>
      <div class="weui-desktop-dialog__bd">
        <table class="weui-desktop-table__core-table">
          <thead><tr><th><label class="weui-desktop-form__check-label"><input type="checkbox" id="check-all" class="weui-desktop-form__checkbox" /><i class="weui-desktop-icon-checkbox"></i></label></th><th>商品信息</th><th>商品价格</th><th>带货佣金率</th></tr></thead>
          <tbody>
            <tr><td><label class="weui-desktop-form__check-label"><input type="checkbox" class="weui-desktop-form__checkbox row-check" data-name="半自动打蛋器搅拌棒厨房按压式旋转工具" data-price="¥9.90" data-rate="50%" /><i class="weui-desktop-icon-checkbox"></i></label></td><td>半自动打蛋器搅拌棒厨房按压式旋转工具 ID 10000687986563</td><td>¥9.90</td><td>50%</td></tr>
            <tr><td><label class="weui-desktop-form__check-label"><input type="checkbox" class="weui-desktop-form__checkbox row-check" data-name="家用收纳盒三件套" data-price="¥19.90" data-rate="30%" /><i class="weui-desktop-icon-checkbox"></i></label></td><td>家用收纳盒三件套 ID 10000687986564</td><td>¥19.90</td><td>30%</td></tr>
          </tbody>
        </table>
      </div>
      <div class="weui-desktop-dialog__ft">已选商品数量：<span id="pick-count">0</span>/30
        <button id="dlg-cancel" class="weui-desktop-btn weui-desktop-btn_default">取消</button>
        <button id="dlg-ok" class="weui-desktop-btn weui-desktop-btn_primary">确认</button>
      </div>
    </div>
  </div>

  <div id="confirm-dialog" class="weui-desktop-dialog__wrp" style="display:none">
    <div class="weui-desktop-dialog">
      <div class="weui-desktop-dialog__title">确认发送邀约</div>
      <div class="weui-desktop-dialog__bd">若带货者同意后，你可以查看带货者的联系方式，并在「我的邀约」里看到反馈结果。</div>
      <div class="weui-desktop-dialog__ft">
        <button id="cf-cancel" class="weui-desktop-btn weui-desktop-btn_default">取消</button>
        <button id="cf-ok" class="weui-desktop-btn weui-desktop-btn_primary">确认</button>
      </div>
    </div>
  </div>
</div>\`

const $ = (id) => root.getElementById(id)
const sendBtn = $('send')
const state = { sent: 0 }

function goodsRowCount () { return $('goods-body').querySelectorAll('tr').length }
function refresh () {
  const ok = $('contact').value.trim() && ($('wechat').value.trim() || $('phone').value.trim()) && $('script').value.trim() && goodsRowCount() > 0
  sendBtn.className = 'weui-desktop-btn weui-desktop-btn_primary' + (ok ? '' : ' weui-desktop-btn_disabled')
  $('counter').textContent = $('script').value.length + '/200'
}
for (const id of ['contact', 'wechat', 'phone', 'script']) $(id).addEventListener('input', refresh)
$('script').addEventListener('input', refresh)

$('add-goods').addEventListener('click', () => { $('goods-dialog').style.display = 'flex' })
$('dlg-cancel').addEventListener('click', () => { $('goods-dialog').style.display = 'none' })
$('dlg-ok').addEventListener('click', () => {
  for (const tr of root.querySelectorAll('.row-check')) {
    if (tr.checked && !tr.dataset.added) {
      tr.dataset.added = '1'
      const row = document.createElement('tr')
      row.innerHTML = '<td>' + tr.dataset.name + '</td><td>' + tr.dataset.price + '</td><td>' + tr.dataset.rate + '</td><td>删除</td>'
      $('goods-body').appendChild(row)
    }
  }
  $('goods-dialog').style.display = 'none'
  refresh()
})
root.querySelectorAll('.row-check').forEach(c => c.addEventListener('change', () => {
  $('pick-count').textContent = String(root.querySelectorAll('.row-check:checked').length)
}))
$('send').addEventListener('click', () => {
  if (sendBtn.className.includes('disabled')) return
  $('confirm-dialog').style.display = 'flex'
})
$('cf-cancel').addEventListener('click', () => { $('confirm-dialog').style.display = 'none' })
$('cf-ok').addEventListener('click', () => {
  state.sent++
  window.__sentCount = state.sent
  $('quota').textContent = '今日剩余' + (200 - state.sent) + '次邀请机会'
  $('confirm-dialog').style.display = 'none'
  refresh()
})
window.__mockReady = true
</script></body></html>`

const server = http.createServer((req, res) => {
  if (req.url && req.url.includes('/initiate-invite')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  res.writeHead(404); res.end('not found')
})
server.listen(8765, '127.0.0.1', () => console.log('mock invite page on http://127.0.0.1:8765/wx-mock/initiate-invite'))
