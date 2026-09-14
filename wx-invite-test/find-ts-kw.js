/** 在指定目录里找含某关键词的 .ts 文件 */
const fs = require('fs'), path = require('path')
const dir = process.argv[2]
const kw = new RegExp(process.argv[3], 'i')
const hits = []
const walk = (d, depth) => {
  if (depth > 6) return
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, depth + 1)
    else if (/\.ts$/.test(e.name)) {
      let t = ''
      try { t = fs.readFileSync(p, 'utf8') } catch { }
      if (kw.test(t)) hits.push(p)
    }
  }
}
walk(dir, 0)
console.log(hits.join('\n') || '(无)')
