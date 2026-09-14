/** 通用：按正则打印某文件的匹配行（行号+内容） */
const fs = require('fs')
const file = process.argv[2]
const pat = new RegExp(process.argv[3] || '.', 'i')
const lines = fs.readFileSync(file, 'utf8').split('\n')
console.log(`// ${file} 共 ${lines.length} 行`)
lines.forEach((l, i) => { if (pat.test(l)) console.log(String(i + 1).padStart(5) + ': ' + l.trim().slice(0, 170)) })
