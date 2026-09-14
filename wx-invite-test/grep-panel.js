/** 打印 WorkbenchView.vue 里邀约相关行的行号与内容（定位逻辑，便于逐项测试） */
const fs = require('fs')
const p = 'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue'
const lines = fs.readFileSync(p, 'utf8').split('\n')
const pat = new RegExp(process.argv[2] || 'inviteReady|isAssist|inviteProducts|INVITE_CFG_KEY|loadInviteConfig|function openInvitePage|function startInvite|inviteProfiles|const invite =', 'i')
lines.forEach((l, i) => { if (pat.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 170)) })
