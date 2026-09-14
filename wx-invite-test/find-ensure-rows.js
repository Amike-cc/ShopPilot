const fs = require('fs')
const s = fs.readFileSync('apps/desktop/src/main/tasks/task-runner.ts', 'utf8')
const L = s.split(/\r?\n/)
L.forEach((l, i) => {
  if (/case 'ensureRows'/.test(l) && i > 0) {
    for (let j = Math.max(0, i - 2); j < i + 140; j++) {
      console.log((j + 1) + ': ' + L[j])
    }
    process.exit(0)
  }
})
console.log('not found')