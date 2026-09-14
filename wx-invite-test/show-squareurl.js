const fs = require('fs')
const L = fs.readFileSync('apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue', 'utf8').split(/\r?\n/)
let s = -1
L.forEach((l, i) => { if (/function squareUrlFor/.test(l)) s = i })
console.log(L.slice(s - 2, s + 16).map((l, i) => (s - 2 + i + 1) + ': ' + l).join('\n'))
