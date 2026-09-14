const fs = require('fs')
const L = fs.readFileSync('apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue', 'utf8').split(/\r?\n/)
let start = -1
L.forEach((l, i) => { if (/async function startInvite/.test(l)) start = i })
console.log(L.slice(start, start + 40).map((l, i) => (start + i + 1) + ': ' + l).join('\n'))
