/** 列出该 run 的工件（截图）与其大小/时间——用来确认流程真的跑到了最后一步。 */
const fs = require('fs')
const path = require('path')
const dir = path.join(process.env.APPDATA, 'shopilot', 'stores', 'store_3856e71a3ae8499ebdbec1f4ccbb4394', 'artifacts')
if (!fs.existsSync(dir)) { console.log('工件目录不存在:', dir); process.exit(0) }
const files = fs.readdirSync(dir).map(f => {
  const st = fs.statSync(path.join(dir, f))
  return { f, size: st.size, mtime: new Date(st.mtimeMs).toLocaleString() }
}).sort((a, b) => b.mtime - a.mtime)
console.log('工件目录:', dir)
console.log('文件数:', files.length)
for (const x of files.slice(0, 12)) console.log(`  ${x.f}  ${x.size}B  ${x.mtime}`)
