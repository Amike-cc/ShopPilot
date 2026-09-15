/** 找 README 里达人邀约相关的行号（中文经命令行会乱码，用文件）。 */
const fs = require('fs')
const t = fs.readFileSync('README.md', 'utf8')
const keys = ['达人邀约', '批量勾选', '辅助填单', '独立于任务列表', '平台档案与流程']
const out = []
t.split(/\r?\n/).forEach((l, i) => {
  if (keys.some(k => l.includes(k))) out.push(`${i + 1}: ${l.trim().slice(0, 170)}`)
})
fs.writeFileSync('wx-invite-test/readme-invite-lines.txt', out.join('\n'), 'utf8')
console.log('n=' + out.length)
