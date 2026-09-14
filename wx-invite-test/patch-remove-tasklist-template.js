/** 移除任务列表 UI（模板部分）：二级页签、任务列表块、达人邀约的 v-else */
const fs = require('fs')
const p = 'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue'
let t = fs.readFileSync(p, 'utf8')

// 1) 面板注释 + 二级页签整块删除
const tabsStart = t.indexOf('      <!-- 任务面板 - §4.4 / §6.6（二级页签：任务列表 / 达人邀约） -->')
const panelBody = t.indexOf('      <div class="panel-body env-body" v-else>')
if (tabsStart < 0 || panelBody < 0) throw new Error('找不到面板起始标记')
const subTabsEnd = t.indexOf('</div>', t.indexOf('<div class="sub-tabs">')) + '</div>'.length
if (subTabsEnd < 0) throw new Error('找不到 sub-tabs 结束')
let out = t.slice(0, tabsStart) +
  '      <!-- 任务面板 - §4.4 / §6.6（达人邀约是本面板唯一内容；邀约运行记录在面板内自带「邀约记录」） -->\n' +
  t.slice(panelBody, subTabsEnd === -1 ? panelBody : t.indexOf('\n', subTabsEnd) + 1) +
  t.slice(t.indexOf('\n', subTabsEnd) + 1)

// 2) 任务列表 template 块（从 <template v-if="taskTab === 'tasks'"> 到它对应的 </template>）整块删除
const listStart = out.indexOf('        <template v-if="taskTab === \'tasks\'">')
if (listStart < 0) throw new Error('找不到任务列表块')
const inviteComment = out.indexOf('        <!-- 达人邀约', listStart)
if (inviteComment < 0) throw new Error('找不到达人邀约块')
out = out.slice(0, listStart) + out.slice(inviteComment)

// 3) 达人邀约块不再需要 v-else
out = out.replace('<div v-else class="sub-pane" data-test="invite-panel">', '<div class="sub-pane" data-test="invite-panel">')

fs.writeFileSync(p, out)
console.log('ok; 剩余 taskTab 引用:', (out.match(/taskTab/g) || []).length, '| sub-tabs:', (out.match(/sub-tabs/g) || []).length)
