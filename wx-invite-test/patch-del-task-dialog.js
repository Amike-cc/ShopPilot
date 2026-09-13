/** 按标记删除「新建任务对话框」模板块（保留其后的回收站抽屉） */
const fs = require('fs')
const p = 'apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue'
let t = fs.readFileSync(p, 'utf8')
const a = t.indexOf('    <!-- 新建任务对话框')
const b = t.indexOf('    <!-- 回收站抽屉 -->')
if (a < 0 || b < 0 || b < a) throw new Error('标记未找到 a=' + a + ' b=' + b)
t = t.slice(0, a) + t.slice(b)
fs.writeFileSync(p, t)
console.log('deleted', b - a, 'chars')
