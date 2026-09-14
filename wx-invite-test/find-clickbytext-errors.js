const fs = require('fs')
const L = fs.readFileSync('apps/desktop/src/main/tasks/task-runner.ts', 'utf8').split(/\r?\n/)
L.forEach((l, i) => { if (l.includes('TASK_SELECTOR_CHANGED: 页面上找不到文案为')) console.log((i + 1) + ': ' + l.trim().slice(0, 140)) })
