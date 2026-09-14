/** 分析重启后（0.2.4）日志构成，确认没有新的风暴 */
const fs = require('fs')
const p = 'C:/Users/15240/AppData/Roaming/shopilot/logs/app-2026-09-13.log'
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(l => /^2026-09-13T10:2\d/.test(l))
const m = new Map()
for (const l of lines) {
  const level = (l.match(/\[(info|warn|error)\]/) || [])[1] || '?'
  const body = l.replace(/^[^ ]+ /, '').replace(/\[(info|warn|error)\] /, '').slice(0, 90)
  const key = level + ' :: ' + body.replace(/\d+/g, 'N')
  m.set(key, (m.get(key) || 0) + 1)
}
console.log('10:20–10:29 日志行数:', lines.length)
for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(String(v).padStart(6), k)
