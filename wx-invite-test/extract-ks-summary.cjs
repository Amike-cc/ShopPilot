/** 抽取最终采集结果里与快手 / 合计相关的关键行，核对待办与无需操作的划分。 */
const fs = require('fs')
const t = fs.readFileSync('wx-invite-test/inv-ks-final3.txt', 'utf8')
const L = t.split(/\r?\n/)
const out = []
let inKs = false
for (const l of L) {
  if (l.includes('福气满满（快手小店）')) inKs = true
  else if (/^— /.test(l)) inKs = false
  if (inKs) out.push(l)
  if (/③ |=== /.test(l)) out.push(l)
}
fs.writeFileSync('wx-invite-test/ks-final-summary.txt', out.join('\n'), 'utf8')
console.log('lines=' + out.length)
