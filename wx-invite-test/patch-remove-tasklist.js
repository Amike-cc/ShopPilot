/**
 * 一次性移除「任务列表」UI（逐行锚定 + 断言，防止再改坏）：
 *  1) 二级页签（任务列表/达人邀约）
 *  2) 任务列表模板块（含新建任务按钮）
 *  3) 达人邀约的 v-else
 *  4) 新建任务对话框模板
 *  5) 脚本侧：storeTasks / 步骤模板块 / taskDialogOpen / taskTab / openTaskDialog·applyTemplate·submitTask / 弹层引用
 */
const fs = require('fs')
const p = 'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue'
const src = fs.readFileSync(p, 'utf8')
const nl = src.includes('\r\n') ? '\r\n' : '\n'
let lines = src.split(/\r?\n/)
const before = lines.length

const findLine = (pred, from = 0) => {
  for (let i = from; i < lines.length; i++) if (pred(lines[i])) return i
  return -1
}
const del = (a, b) => { lines.splice(a, b - a) } // 删除 [a, b)
const assert = (cond, msg) => { if (!cond) throw new Error('断言失败: ' + msg) }

// 1) 二级页签
const iSub = findLine(l => l.includes('<div class="sub-tabs">') && lines[findLine(x => false)] === undefined ? l.includes('<div class="sub-tabs">') : false)
const iSubStart = findLine(l => l.trim() === '<div class="sub-tabs">')
assert(iSubStart > 0, '找不到 sub-tabs')
assert(lines[iSubStart + 1].includes('task-tab-tasks'), 'sub-tabs 下一行不是任务列表页签')
assert(lines[iSubStart + 3].trim() === '</div>', 'sub-tabs 结束行不符')
del(iSubStart, iSubStart + 5) // 含其后的空行

// 2) 任务列表模板块
const iListStart = findLine(l => l.includes("v-if=\"taskTab === 'tasks'\""))
assert(iListStart > 0, '找不到任务列表块')
const iInviteComment = findLine(l => l.includes('<!-- 达人邀约'), iListStart)
assert(iInviteComment > iListStart, '找不到达人邀约块起点')
del(iListStart, iInviteComment)

// 3) 达人邀约不再 v-else
const iInvite = findLine(l => l.includes('data-test="invite-panel"'))
assert(iInvite > 0, '找不到邀约面板')
lines[iInvite] = lines[iInvite].replace('<div v-else class="sub-pane"', '<div class="sub-pane"')

// 4) 新建任务对话框模板
const iDlg = findLine(l => l.includes('<!-- 新建任务对话框'))
const iTrash = findLine(l => l.includes('<!-- 回收站抽屉 -->'))
assert(iDlg > 0 && iTrash > iDlg, '找不到新建任务对话框')
del(iDlg, iTrash)

// 5a) storeTasks computed
const iSt = findLine(l => l.startsWith('const storeTasks = computed('))
assert(iSt > 0, '找不到 storeTasks')
const iStEnd = findLine(l => l.trim() === '))', iSt)
assert(iStEnd > iSt, '找不到 storeTasks 结束')
del(iSt, iStEnd + 2)

// 5b) 步骤模板块（stepTypes … 到 taskDialogOpen 声明前）
const iStep = findLine(l => l.startsWith("const stepTypes = ['navigate'"))
const iTdo = findLine(l => l.startsWith('const taskDialogOpen = ref(false)'))
assert(iStep > 0 && iTdo > iStep, '找不到步骤模板块')
del(iStep, iTdo)

// 5c) taskDialogOpen / taskTab 声明（含其上方的注释行）
const iTdo2 = findLine(l => l.startsWith('const taskDialogOpen = ref(false)'))
assert(iTdo2 > 0, '找不到 taskDialogOpen 声明')
let iTdo2Start = iTdo2
while (iTdo2Start > 0 && lines[iTdo2Start - 1].trim().startsWith('/**')) iTdo2Start -= 1
const iTab = findLine(l => l.startsWith("const taskTab = ref<"))
assert(iTab > iTdo2, '找不到 taskTab 声明')
del(iTdo2Start, iTab + 2)

// 5c-2) taskTab 上方的注释行（若有）
const iTabComment = lines.findIndex(l => l.includes('任务面板的二级页签'))
if (iTabComment >= 0 && lines[iTabComment].trim().startsWith('/*')) lines.splice(iTabComment, 1)

// 5d) openTaskDialog / applyTemplate / submitTask 三个函数
const iFn = findLine(l => l.startsWith('function openTaskDialog() {'))
const iDetail = findLine(l => l.startsWith('const detailTaskId = ref<string | null>(null)'))
assert(iFn > 0 && iDetail > iFn, '找不到任务对话框函数块')
del(iFn, iDetail)

// 5e) 弹层遮挡列表里的引用
lines = lines.map(l => l
  .replace('ws.createDialogOpen || taskDialogOpen.value || ws.trashOpen', 'ws.createDialogOpen || ws.trashOpen')
  .replace('[ws.createDialogOpen, taskDialogOpen.value, ws.trashOpen', '[ws.createDialogOpen, ws.trashOpen'))

const out = lines.join(nl)
fs.writeFileSync(p, out)
const leftovers = ['taskDialogOpen', 'taskTab', 'storeTasks', 'stepTemplates', 'stepTypes', 'fieldsOf', 'applyTemplate', 'submitTask', 'stepFieldMap']
  .map(k => k + '=' + (out.match(new RegExp(k, 'g')) || []).length).join(' ')
console.log(`lines ${before} → ${lines.length}（减少 ${before - lines.length}）`)
console.log('残留:', leftovers)
assert(out.match(/taskDialogOpen/g) === null, '仍残留 taskDialogOpen')
assert(out.match(/storeTasks/g) === null, '仍残留 storeTasks')
console.log('PATCH-OK')
