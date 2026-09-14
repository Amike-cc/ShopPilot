const fs = require('fs')
const p = 'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue'
const raw = fs.readFileSync(p, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const L = raw.split(/\r?\n/)
let n = 0
for (let i = 0; i < L.length; i++) {
  if (L[i].includes('finderCategory: invite.finderCategories[0]')) {
    L[i] = L[i].replace('finderCategory: invite.finderCategories[0] || \'\',', 'finderCategories: invite.finderCategories,')
    n++
  }
}
fs.writeFileSync(p, L.join(eol))
console.log('patched', n)
