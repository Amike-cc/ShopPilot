/** 诊断 PICK_SORT_FN 独立求值失败的原因。 */
const fs = require('fs')
const t = fs.readFileSync('apps/desktop/src/main/tasks/task-runner.ts', 'utf8')
const m = t.match(/const PICK_SORT_FN = `([\s\S]*?)`\n/)
if (!m) { console.log('没找到 PICK_SORT_FN'); process.exit(1) }
console.log('含 __narrow:', m[1].includes('__narrow'))
try {
  const fn = new Function(`${m[1]}; return { __narrow, __clickableScore, __pickBest };`)()
  console.log('求值成功; narrow("确 认") =', JSON.stringify(fn.__narrow('确 认')))
} catch (e) {
  console.log('求值失败:', e.message)
}
// 也确认导出名是否匹配（我导出的是 SCOPE_FN，PICK_SORT_FN 有没有 export？）
console.log('export const PICK_SORT_FN:', /export const PICK_SORT_FN/.test(t))
