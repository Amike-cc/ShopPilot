/** 把实测的类目级联 JSON 转成可粘贴进 TS 的 categoryTree 片段。 */
const fs = require('fs')
const j = JSON.parse(fs.readFileSync('wx-invite-test/ks-category-tree.json', 'utf8'))
const lines = []
for (const [k, v] of Object.entries(j)) {
  const kids = v.filter(x => x !== '全部')
  lines.push(`  { name: '${k}', children: [${kids.map(x => `'${x}'`).join(', ')}] },`)
}
fs.writeFileSync('wx-invite-test/ks-tree-ts.txt', lines.join('\n'), 'utf8')
console.log('cats=' + Object.keys(j).length + ' lines=' + lines.length)
