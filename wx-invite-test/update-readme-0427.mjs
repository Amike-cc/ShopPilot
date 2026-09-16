/** 更新 README 的版本号与邀约相关行（用文件避免命令行中文编码问题）。 */
const fs = await import('fs')
let t = fs.readFileSync('README.md', 'utf8')
const before = t
t = t.replace('**版本**: v0.4.26', '**版本**: v0.4.27')
t = t.replace('| [RELEASE_NOTES.md](./docs/RELEASE_NOTES.md) | 0.4.26 变更说明与回滚方式 |', '| [RELEASE_NOTES.md](./docs/RELEASE_NOTES.md) | 0.4.27 变更说明与回滚方式 |')
t = t.replace('pnpm exec vitest run        # 单测 85 项', 'pnpm exec vitest run        # 单测 108 项')
fs.writeFileSync('README.md', t, 'utf8')
console.log('changed=' + (t !== before))
console.log('version ok=' + t.includes('**版本**: v0.4.27'))
console.log('notes ok=' + t.includes('0.4.27 变更说明与回滚方式'))
console.log('tests ok=' + t.includes('单测 108 项'))
