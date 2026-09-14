/** 搜索仓库里含指定关键词的文件（排除构建产物） */
const fs = require('fs'), path = require('path')
const kw = new RegExp(process.argv[2] || '发票|invoice', 'i')
const skip = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.vite', 'coverage'])
const hits = []
const walk = (d, depth) => {
  if (depth > 5) return
  let es = []
  try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    if (skip.has(e.name)) continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, depth + 1)
    else if (/\.(ts|vue|sql|json|md|js)$/.test(e.name)) {
      let t = ''
      try { t = fs.readFileSync(p, 'utf8') } catch { }
      if (kw.test(t)) hits.push(p)
    }
  }
}
walk('.', 0)
console.log('含关键词的文件：')
for (const h of hits) console.log('  ' + h)
console.log('共 ' + hits.length + ' 个')
