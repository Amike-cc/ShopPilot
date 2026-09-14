const fs = require('fs')
const p = 'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue'
const raw = fs.readFileSync(p, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const L = raw.split(/\r?\n/)

// 找到微信小店那段"逐个邀约"说明（旧文案 3 行 ① ② ③）
let start = -1
for (let i = 0; i < L.length; i++) {
  if (L[i].includes('微信小店按达人') && L[i].includes('逐个邀约')) { start = i; break }
}
if (start < 0) throw new Error('未找到微信说明起始行')
// 该说明块：从它的 <div class="env-note"> 开始到 </div> 结束
let divStart = start - 1
while (divStart > 0 && !L[divStart].includes('env-note')) divStart--
let divEnd = start
while (divEnd < L.length && !L[divEnd].includes('</div>')) divEnd++
console.log('replacing lines', divStart + 1, '-', divEnd + 1)

const indent = L[divStart].match(/^\s*/)[0]
const repl = [
  `${indent}<div class="env-note">`,
  `${indent}  微信小店按达人<b>逐个邀约</b>（每位达人一张独立表单，平台不支持批量），现在是<b>全自动连续邀约</b>：`,
  `${indent}  点「开始邀约」后软件自己完成每一轮——进广场 → 按上面的筛选挑达人 → 进详情页点「<b>邀请带货</b>」→ 代填联系方式与话术、按商品ID添加商品 → 点「发送邀约」→ 在平台确认弹窗上点「确认」；`,
  `${indent}  <b>一次一位、连续进行，直到「今日剩余邀请机会」用完或列表里没有更多达人为止</b>，然后自动停止。`,
  `${indent}  <b>没有人工二次确认</b>：点「开始邀约」即开始真实发送（单次运行上限 50 位，随时可点「停止邀约」）。{{ inviteProfile.dailyQuotaHint }}。`,
  `${indent}</div>`
]
L.splice(divStart, divEnd - divStart + 1, ...repl)
fs.writeFileSync(p, L.join(eol))
console.log('done')
