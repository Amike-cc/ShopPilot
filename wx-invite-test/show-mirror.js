const fs = require('fs')
const L = fs.readFileSync('apps/desktop/src/main/tasks/task-runner.ts', 'utf8').split(/\r?\n/)
let s = -1
L.forEach((l, i) => { if (l.includes("case 'mirrorTabUrl'")) s = i })
if (s < 0) { console.log('not found'); process.exit(0) }
console.log(L.slice(s, s + 48).map((l, i) => (s + i + 1) + ': ' + l).join('\n'))
