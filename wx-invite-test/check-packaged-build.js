/** 校验安装包里的 app.asar 是否含本轮最新逻辑（确认发出去的包是修好的版本） */
const fs = require('fs')
const p = 'release/win-unpacked/resources/app.asar'
if (!fs.existsSync(p)) { console.log('找不到', p); process.exit(0) }
const s = fs.readFileSync(p).toString('latin1')
console.log('asar 大小:', (s.length / 1048576).toFixed(1), 'MB')
for (const m of ['unvisited', 'TASK_PAGE_EXHAUSTED', 'findersquare/find', 'useTab', 'followTab', 'TASK_PAGE_EXHAUSTED']) {
  console.log('  ', m, '→', s.includes(m) ? '有' : '无')
}
// 安装包本身
const exe = 'release/ShopPilot-Setup-0.4.15.exe'
if (fs.existsSync(exe)) {
  const st = fs.statSync(exe)
  console.log('安装包:', exe, (st.size / 1048576).toFixed(1), 'MB', st.mtime.toLocaleString())
}
const yml = fs.readFileSync('release/latest.yml', 'utf8')
console.log('latest.yml:\n' + yml)
