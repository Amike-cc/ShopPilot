const fs = require('fs')
const path = require('path')
const main = fs.readFileSync('apps/desktop/out/main/index.js', 'utf8')
const dir = 'apps/desktop/out/renderer/assets'
const renderer = fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
const checks = [
  ['main: completedRounds', main.includes('completedRounds')],
  ['main: stopReason', main.includes('stopReason')],
  ['main: __scopeRoot', main.includes('__scopeRoot')],
  ['main: SCOPE_NOT_FOUND', main.includes('SCOPE_NOT_FOUND')],
  ['renderer: quick-filter-button-enums', renderer.includes('quick-filter-button-enums')],
  ['renderer: cascader popover', renderer.includes('quick-filter-cascader-popover')],
  ['renderer: loop step', renderer.includes("'loop'") || renderer.includes('"loop"')],
  ['renderer: 每批 X 位 label', renderer.includes('每批')]
]
for (const [k, v] of checks) console.log((v ? 'OK  ' : 'MISS') + '  ' + k)
