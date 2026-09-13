/** 汇总应用日志里的异常模式 */
const fs = require('fs')
const path = require('path')
const dir = 'C:/Users/15240/AppData/Roaming/shopilot/logs'
const files = fs.readdirSync(dir).filter(f => f.startsWith('app-'))
const buckets = {
  rendererGone: [], uncaught: [], unhandled: [], rendererErr: [], other: []
}
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)
  for (const l of lines) {
    if (!l || !/\[(error|warn)\]/.test(l)) continue
    const ts = l.slice(0, 19)
    if (/renderer gone/.test(l)) buckets.rendererGone.push(ts + ' ' + (l.match(/reason=\S+ exitCode=\S+/) || [''])[0])
    else if (/uncaughtException/.test(l)) buckets.uncaught.push(ts + ' ' + l.slice(0, 160))
    else if (/unhandledRejection/.test(l)) buckets.unhandled.push(ts + ' ' + l.slice(0, 160))
    else if (/renderer:/.test(l)) buckets.rendererErr.push(ts + ' ' + l.slice(0, 160))
    else buckets.other.push(f + ' ' + ts + ' ' + l.slice(0, 160))
  }
}
const uniq = (arr) => {
  const m = new Map()
  for (const x of arr) {
    const key = x.replace(/^\S+ /, '').slice(0, 120)
    if (!m.has(key)) m.set(key, { n: 0, first: x.slice(0, 19), last: x.slice(0, 19) })
    const e = m.get(key); e.n++; e.last = x.slice(0, 19)
  }
  return [...m.entries()].map(([k, v]) => `x${v.n} ${v.first}→${v.last} :: ${k}`)
}
for (const [name, arr] of Object.entries(buckets)) {
  console.log(`\n== ${name}: ${arr.length}`)
  for (const line of uniq(arr).slice(0, 14)) console.log('  ' + line)
}
