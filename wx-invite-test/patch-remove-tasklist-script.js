/** 移除任务列表相关（脚本侧）：storeTasks / 步骤模板 / taskDialogOpen / taskTab / 相关函数 / 弹层列表引用 */
const fs = require('fs')
const p = 'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue'
let t = fs.readFileSync(p, 'utf8')
const orig = t.length

// storeTasks computed
const stStart = t.indexOf('const storeTasks = computed(')
if (stStart >= 0) {
  const stEnd = t.indexOf('\n\n', t.indexOf('))', stStart))
  t = t.slice(0, stStart) + t.slice(stEnd + 2)
}

// 步骤类型/字段/模板一整块（到 taskDialogOpen 声明前）
const blockStart = t.indexOf("const stepTypes = ['navigate'")
const blockEnd = t.indexOf('const taskDialogOpen = ref(false)')
if (blockStart >= 0 && blockEnd > blockStart) t = t.slice(0, blockStart) + t.slice(blockEnd)

// 声明
t = t.replace('const taskDialogOpen = ref(false)\n', '')
t = t.replace(/const taskTab = ref<'tasks' \| 'invite'>\('tasks'\)\n/, '')

// 函数块：openTaskDialog / applyTemplate / submitTask（连续）
const fnStart = t.indexOf('function openTaskDialog() {')
const fnEnd = t.indexOf('const detailTaskId = ref<string | null>(null)')
if (fnStart >= 0 && fnEnd > fnStart) t = t.slice(0, fnStart) + t.slice(fnEnd)

// 弹层遮挡列表
t = t.replace('ws.createDialogOpen || taskDialogOpen.value || ws.trashOpen', 'ws.createDialogOpen || ws.trashOpen')
t = t.replace('[ws.createDialogOpen, taskDialogOpen.value, ws.trashOpen', '[ws.createDialogOpen, ws.trashOpen')

fs.writeFileSync(p, t)
const leftovers = ['taskDialogOpen', 'taskTab', 'stepTemplates', 'storeTasks', 'openTaskDialog', 'applyTemplate', 'submitTask', 'fieldsOf', 'stepFieldMap', 'stepTypes']
  .map(k => k + '=' + (t.match(new RegExp(k, 'g')) || []).length).join(' ')
console.log('removed', orig - t.length, 'chars | 残留:', leftovers)
