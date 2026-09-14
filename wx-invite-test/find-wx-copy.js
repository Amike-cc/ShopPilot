const fs = require('fs')
const L = fs.readFileSync('apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue', 'utf8').split(/\r?\n/)
for (let i = 495; i < 580; i++) {
  const l = L[i]
  if (!l) continue
  if (/env-note|inv-card-h|微信小店按达人|停下让你核对/.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 170))
}
