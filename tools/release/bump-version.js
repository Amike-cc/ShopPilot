const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '../..')
const file = path.join(root, 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const target = process.argv[2]
if (!target || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(target)) {
  console.error('用法: node bump-version.js <版本号>  例如 0.4.49（预发布 0.4.49-beta.1）')
  console.error('拒绝在未指定版本号时改写 package.json（防止把已升高的版本静默降回旧默认值）。')
  process.exit(1)
}
pkg.version = target
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('version ->', pkg.version)
