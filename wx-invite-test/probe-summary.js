/** 汇总登录探测进度 */
const fs = require('fs')
const lines = fs.readFileSync('wx-invite-test/login-probe.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
const start = lines.find(l => l.event === 'SESSION_START')
const oks = lines.filter(l => l.state === 'ok')
const last = oks[oks.length - 1]
console.log('SESSION_START:', start ? start.ts : '(none)')
console.log('ok 次数:', oks.length, '| 最后一次 ok:', last ? last.ts : '-')
if (start && last) {
  const mins = Math.round((new Date(last.ts) - new Date(start.ts)) / 60000)
  console.log('持续有效（15 分钟一次轻活动）:', mins, '分钟 ≈', (mins / 60).toFixed(1), '小时')
}
const others = lines.filter(l => l.state && l.state !== 'ok')
console.log('非 ok 记录:', JSON.stringify(others.slice(-3)))
