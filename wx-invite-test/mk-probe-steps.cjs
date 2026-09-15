/**
 * 给 ks-steps.json 的「选商品」段前后各插一个 screenshot，用于看清商品弹窗的真实样子。
 * 只改本地 JSON，不改产品代码。
 */
const fs = require('fs')
const steps = JSON.parse(fs.readFileSync('wx-invite-test/ks-steps.json', 'utf8'))
const inner = steps[0].input.steps
// 先去掉上一次插入的探针（紧贴「选择商品」的 screenshot）
for (let k = inner.length - 1; k >= 0; k--) {
  const s = inner[k]
  if (s.type !== 'screenshot') continue
  const prev = inner[k - 1], next = inner[k + 1]
  if ((prev && prev.type === 'clickByText' && prev.input.text === '选择商品') ||
      (next && next.type === 'requireQuota' && String(next.input.textIncludes || '').includes('已选择商品数'))) {
    inner.splice(k, 1)
  }
}
const i = inner.findIndex(s => s.type === 'clickByText' && s.input && s.input.text === '选择商品')
if (i < 0) { console.log('没有「选择商品」步骤'); process.exit(1) }
inner.splice(i, 0, { type: 'screenshot', input: {}, timeoutMs: 20000 })
// 商品计数断言之后再来一张（注意：必须是**找到**才插，找不到就跳过——
// 之前这里 j=-1 时 splice(0,...) 会把截图插到序列最开头，触发 CAPTURE_EMPTY）
const j = inner.findIndex(s => s.type === 'requireQuota' && String(s.input.textIncludes || '').includes('已选择商品数'))
if (j >= 0) inner.splice(j + 1, 0, { type: 'screenshot', input: {}, timeoutMs: 20000 })
fs.writeFileSync('wx-invite-test/ks-steps-probe.json', JSON.stringify(steps, null, 1), 'utf8')
console.log('已写入 ks-steps-probe.json，步骤数:', inner.length)
inner.forEach((s, n) => {
  const t = s.input && s.input.text ? ' "' + String(s.input.text).slice(0, 14) + '"' : ''
  const sel = s.input && s.input.selector ? ' ' + String(s.input.selector).slice(0, 34) : ''
  console.log(`  ${String(n).padStart(2)}. ${s.type}${t}${sel}`)
})
