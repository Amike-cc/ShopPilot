/** 一次性：把两处「开始邀约」按钮块替换为 开始/停止 对 */
const fs = require('fs')
const p = 'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue'
let t = fs.readFileSync(p, 'utf8')
const oldStr = [
  '            <div class="cf-btns" style="margin-top:10px">',
  '              <button class="mini-btn primary" data-test="invite-start" :disabled="!inviteReady" @click="startInvite">开始邀约</button>',
  '            </div>'
].join('\n')
const newStr = [
  '            <div class="cf-btns" style="margin-top:10px">',
  '              <button v-if="!inviteRun" class="mini-btn primary" data-test="invite-start" :disabled="!inviteReady" @click="startInvite">开始邀约</button>',
  '              <template v-else>',
  '                <span class="row-sub" style="align-self:center">邀约进行中 · {{ statusLabel(inviteRun.status) }}</span>',
  '                <button class="mini-btn" data-test="invite-stop" @click="stopInvite">停止邀约</button>',
  '              </template>',
  '            </div>'
].join('\n')
const n = t.split(oldStr).length - 1
t = t.split(oldStr).join(newStr)
fs.writeFileSync(p, t)
console.log('replaced', n)
