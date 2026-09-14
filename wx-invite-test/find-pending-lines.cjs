/** 找渲染层里与"待办/历史"相关的行，便于核对文案与判定口径。 */
const fs = require('fs')
const t = fs.readFileSync('apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue', 'utf8')
const keys = ['pending === false', 'historyCount', 'historical', '有待办', '历史']
const out = []
t.split(/\r?\n/).forEach((l, i) => {
  if (keys.some(k => l.includes(k))) out.push(`${i + 1}: ${l.trim().slice(0, 150)}`)
})
fs.writeFileSync('renderer-hits.txt', out.join('\n'), 'utf8')
console.log('matches=' + out.length)
