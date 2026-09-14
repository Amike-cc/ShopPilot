/** 找渲染层里 cleanCell 的定义，核对它与 shared 的 normalizeCellText 口径一致。 */
const fs = require('fs')
const t = fs.readFileSync('apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue', 'utf8')
const L = t.split(/\r?\n/)
const out = []
L.forEach((l, i) => { if (/cleanCell|normalizeCellText/.test(l)) out.push(`${i + 1}: ${l.trim().slice(0, 160)}`) })
fs.writeFileSync('clean-cell-lines.txt', out.join('\n'), 'utf8')
console.log('matches=' + out.length)
