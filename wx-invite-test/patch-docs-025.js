const fs = require('fs')
// RELEASE_NOTES：确保 0.2.4 段落是「上一版」标题
let t = fs.readFileSync('RELEASE_NOTES.md', 'utf8')
t = t.replace(/^## 本次更新（0\.2\.4）.*$/m, '## 上一版（0.2.4）：卡死 / 闪退 / 崩溃专项排查与修复')
if (/^## 上一版（0\.2\.4）$/m.test(t)) t = t.replace(/^## 上一版（0\.2\.4）$/m, '## 上一版（0.2.4）：卡死 / 闪退 / 崩溃专项排查与修复')
fs.writeFileSync('RELEASE_NOTES.md', t)
// README：版本号与文档索引
let r = fs.readFileSync('README.md', 'utf8')
r = r.replace(/\*\*版本\*\*: v0\.2\.4/, '**版本**: v0.2.5')
r = r.replace(/0\.2\.4 变更说明与回滚方式/, '0.2.5 变更说明与回滚方式')
fs.writeFileSync('README.md', r)
console.log('docs updated')
