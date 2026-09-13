/** 检查探测记录（含时间戳） */
const fs = require('fs')
const lines = fs.readFileSync('wx-invite-test/login-probe.jsonl', 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log('总记录:', lines.length)
console.log('--- 最近 4 条 ---')
for (const r of lines.slice(-4)) console.log(JSON.stringify(r))
const starts = lines.filter(l => l.event === 'SESSION_START')
console.log('--- SESSION_START 共', starts.length, '次 ---')
for (const s of starts) console.log(' ', s.ts || '(无时间戳·旧版)', JSON.stringify(s.cookies || {}))
const oks = lines.filter(l => l.state === 'ok' && l.ts)
if (oks.length) {
  console.log('带时间戳的 ok 记录:', oks.length, '| 首:', oks[0].ts, '| 末:', oks[oks.length - 1].ts)
}
