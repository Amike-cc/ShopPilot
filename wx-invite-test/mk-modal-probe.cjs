/**
 * 从 ks-steps.json 造一个"聚焦商品弹窗"的步骤序列：
 * 到填完表单为止不变，然后：点选择商品 → 等 → 截图 → clickAll → 等 → 截图 → 点确认 → 等 → 截图。
 * 用于看清弹窗到底有没有打开、复选框能不能勾上、确认后弹窗是否关闭。
 */
const fs = require('fs')
const steps = JSON.parse(fs.readFileSync('wx-invite-test/ks-steps.json', 'utf8'))
const inner = steps[0].input.steps
const idx = inner.findIndex(s => s.type === 'clickByText' && s.input && s.input.text === '选择商品')
if (idx < 0) { console.log('没有「选择商品」'); process.exit(1) }
// 选择器/skip 都从**步骤里已有的那一步**取，避免这里写死一份会和产品代码漂移的副本
const realBoxes = inner.find(s => s.type === 'clickAll' && String(s.input.selector).includes('modal-body'))
if (!realBoxes) { console.log('步骤里没有弹窗内的 clickAll'); process.exit(1) }
const focused = [
  ...inner.slice(0, idx),
  { type: 'clickByText', input: { text: '选择商品' }, timeoutMs: 20000 },
  { type: 'waitMs', input: { ms: 5000 }, timeoutMs: 15000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 },
  { type: 'clickAll', input: { ...realBoxes.input, max: 1 }, timeoutMs: 40000 },
  { type: 'waitMs', input: { ms: 2000 }, timeoutMs: 15000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: '确 认' }, timeoutMs: 20000 },
  { type: 'waitMs', input: { ms: 4000 }, timeoutMs: 15000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 }
]
steps[0].input.steps = focused
steps[0].input.maxRounds = 1
steps[0].input.stopOn = ['TASK_SELECTION_SHORTFALL']
fs.writeFileSync('wx-invite-test/ks-steps-probe.json', JSON.stringify(steps, null, 1), 'utf8')
console.log('聚焦序列步骤数:', focused.length)
focused.forEach((s, n) => {
  const t = s.input && s.input.text ? ' "' + String(s.input.text).slice(0, 12) + '"' : ''
  const sel = s.input && s.input.selector ? ' ' + String(s.input.selector).slice(0, 40) : ''
  const ms = s.input && s.input.ms ? ' ' + s.input.ms + 'ms' : ''
  console.log(`  ${String(n).padStart(2)}. ${s.type}${t}${sel}${ms}`)
})
