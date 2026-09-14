const fs = require('fs')
const path = require('path')
function walk (d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'out', 'release'].includes(e.name)) continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|vue)$/.test(e.name)) {
      const s = fs.readFileSync(p, 'utf8')
      if (/errorHandler|warnHandler/.test(s)) console.log(p)
    }
  }
}
walk('apps/desktop/src')
console.log('--- done ---')
