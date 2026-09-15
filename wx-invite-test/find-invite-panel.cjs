/** 找渲染层达人邀约面板里按平台分派的位置（invite panel 相关行）。 */
const fs = require('fs')
const t = fs.readFileSync('apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue', 'utf8')
const L = t.split(/\r?\n/)
const out = []
L.forEach((l, i) => {
  if (/inviteProfileFor|isBatchProfile|isAssistProfile|batch-list|assist-form|invite\.flow|INVITE_SUPPORTED|invite-platform|inviteProfile/.test(l)) {
    out.push(`${i + 1}: ${l.trim().slice(0, 170)}`)
  }
})
fs.writeFileSync('wx-invite-test/invite-panel-lines.txt', out.join('\n'), 'utf8')
console.log('matches=' + out.length)
