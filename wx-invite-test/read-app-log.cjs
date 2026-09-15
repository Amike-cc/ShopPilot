/** 取当日日志里与视图挂载/摘除相关的行（中文经 findstr 会乱码，用 Node 读）。 */
const fs = require('fs')
const path = require('path')
const dir = path.join(process.env.APPDATA, 'shopilot', 'logs')
const files = fs.readdirSync(dir).filter(f => f.includes('2026-09-15'))
const keys = ['弹层', '摘除', '视图', 'activateTab', 'tab', 'navigate']
for (const f of files) {
  const t = fs.readFileSync(path.join(dir, f), 'utf8')
  const lines = t.split(/\r?\n/).filter(l => keys.some(k => l.includes(k)))
  console.log(`--- ${f} 命中 ${lines.length} 行（末 40 行）---`)
  console.log(lines.slice(-40).join('\n'))
}
