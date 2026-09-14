const fs = require('fs')
const L = fs.readFileSync('apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue', 'utf8').split(/\r?\n/)
L.forEach((l, i) => { if (l.includes('data-test="invite-start"')) console.log((i + 1) + ': ' + l.trim()) })
console.log('--- inviteReady ---')
let s = -1
L.forEach((l, i) => { if (/const inviteReady = computed/.test(l)) s = i })
console.log(L.slice(s, s + 22).map((l, i) => (s + i + 1) + ': ' + l).join('\n'))
