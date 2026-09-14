/** 抓 EPIPE 异常的完整堆栈与时间分布，定位未受保护的 console 调用点 */
const fs = require('fs')
const p = 'C:/Users/15240/AppData/Roaming/shopilot/logs/app-2026-09-13.log'
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
const idx = []
for (let i = 0; i < lines.length; i++) if (/^2026-09-13T10:2\d.*EPIPE/.test(lines[i])) idx.push(i)
console.log('EPIPE 行数:', idx.length)
if (idx.length) {
  console.log('首条时间:', lines[idx[0]].slice(0, 24), '| 末条时间:', lines[idx[idx.length - 1]].slice(0, 24))
  // 按分钟统计
  const perMin = new Map()
  for (const i of idx) { const k = lines[i].slice(11, 16); perMin.set(k, (perMin.get(k) || 0) + 1) }
  console.log('按分钟:', [...perMin.entries()].map(([k, v]) => k + '=' + v).join(' '))
  // 完整堆栈（第一条及其后 12 行）
  console.log('--- 第一条完整堆栈 ---')
  console.log(lines.slice(idx[0], idx[0] + 13).join('\n'))
  // 堆栈里出现的函数名汇总
  const stacks = new Map()
  for (const i of idx.slice(0, 200)) {
    const block = lines.slice(i, i + 8).join(' ')
    const m = /at ([A-Za-z0-9_$.]+) \(/.exec(block)
    const key = m ? m[1] : '(no-at)'
    stacks.set(key, (stacks.get(key) || 0) + 1)
  }
  console.log('--- 栈顶符号分布(前200条) ---')
  for (const [k, v] of [...stacks.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k)
}
