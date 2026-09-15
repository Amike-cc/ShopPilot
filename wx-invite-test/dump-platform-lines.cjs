/** dump 平台目录里与快手/达人广场地址相关的行。 */
const fs = require('fs')
const t = fs.readFileSync('packages/shared/src/constants/platforms.ts', 'utf8')
const out = []
t.split(/\r?\n/).forEach((l, i) => {
  if (/name:|adminUrl|kwaixiaodian|squareUrl|darenSquare|达人广场/.test(l)) out.push(`${i + 1}: ${l.trim().slice(0, 150)}`)
})
fs.writeFileSync('plat-lines.txt', out.join('\n'), 'utf8')
console.log('n=' + out.length)
