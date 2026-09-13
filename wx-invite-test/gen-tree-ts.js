const fs = require('fs')
const j = JSON.parse(fs.readFileSync('wx-invite-test/category-tree.json', 'utf8'))
const lines = []
for (const c of j.tree) {
  const kids = (c.children || []).filter(k => k.name !== '不限').map(k => k.name)
  lines.push('    { name: ' + JSON.stringify(c.name) + ', children: [' + kids.map(k => JSON.stringify(k)).join(', ') + '] }')
}
fs.writeFileSync('wx-invite-test/category-tree.ts.txt', '\n' + lines.join(',\n') + '\n')
console.log('written', lines.length, 'entries')
