const fs = require('fs')
const p = 'apps/desktop/src/main/tasks/task-runner.ts'
const raw = fs.readFileSync(p, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const L = raw.split(/\r?\n/)

let injected = false
let replaced = 0
for (let i = 0; i < L.length; i++) {
  if (!injected && L[i].includes('const within = input.within as')) {
    L.splice(i + 1, 0,
      '      // 找不到目标时的错误码（默认 TASK_SELECTOR_CHANGED）；批量循环里用它区分"页面改版"与"没有下一个候选"',
      "      const missingCode = input.missingCode ? String(input.missingCode) : 'TASK_SELECTOR_CHANGED'")
    injected = true
    i++
    continue
  }
  if (L[i].includes('TASK_SELECTOR_CHANGED: 页面上找不到文案为')) {
    L[i] = L[i].replace('`TASK_SELECTOR_CHANGED: 页面上找不到文案为', '`${missingCode}: 页面上找不到文案为')
    replaced++
  }
}
fs.writeFileSync(p, L.join(eol))
console.log('injected:', injected, '| replaced:', replaced)
