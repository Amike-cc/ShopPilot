/** 确认 0.2.4 启动后没有 EPIPE/未捕获异常 */
const fs = require('fs')
const p = 'C:/Users/15240/AppData/Roaming/shopilot/logs/app-2026-09-13.log'
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
const after = lines.filter(l => /^2026-09-13T10:(2[1-9]|[3-9]\d)/.test(l))
const count = re => after.filter(l => re.test(l)).length
console.log('0.2.4 启动后（10:21 起）日志行数:', after.length)
console.log('EPIPE:', count(/EPIPE/), '| uncaughtException:', count(/uncaughtException/), '| unresponsive:', count(/unresponsive/), '| renderer gone:', count(/renderer gone/))
console.log('--- 最后 6 行 ---')
console.log(after.slice(-6).join('\n'))
