/** 找出邀约面板的挂载条件（v-if 链）与侧栏入口 */
const fs = require('fs')
const p = 'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue'
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
let at = -1
lines.forEach((l, i) => { if (at < 0 && l.includes('data-test="invite-panel"')) at = i })
console.log('invite-panel at line', at + 1)
for (let i = Math.max(0, at - 200); i < at; i++) {
  const l = lines[i]
  if (/v-if|v-else|panel-body|env-body|sub-pane/.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 140))
}
console.log('--- panel switch refs ---')
lines.forEach((l, i) => { if (/panel\b(?!=)|panelOpen|rightPanel|ws\.panel|showTasks|tasksOpen/.test(l) && /const |ref\(|function |@click|v-if/.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 140)) })
