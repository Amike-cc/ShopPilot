/** 打印导出步骤的 type 与关键文案，确认发送步骤在。 */
const fs = require('fs')
const steps = JSON.parse(fs.readFileSync('wx-invite-test/ks-steps.json', 'utf8'))
const inner = steps[0].input.steps
console.log('外层:', steps.length, steps[0].type, 'maxRounds=', steps[0].input.maxRounds)
inner.forEach((s, i) => {
  const t = s.input && s.input.text ? ` text="${s.input.text}"` : ''
  const sel = s.input && s.input.selector ? ` sel="${s.input.selector}"` : ''
  const within = s.input && s.input.within ? ` within=${JSON.stringify(s.input.within)}` : ''
  const m = s.input && s.input.max ? ` max=${s.input.max}` : ''
  console.log(`${String(i).padStart(2)}. ${s.type}${t}${sel}${within}${m}`)
})
console.log('\n含「发送邀请」:', inner.some(s => s.input && s.input.text === '发送邀请'))
console.log('含 waitForGone:', inner.some(s => s.type === 'waitForGone'))
