/** 更新 README 的版本号与相关行（用文件避免命令行中文编码问题）。 */
const fs = await import('fs')
let t = fs.readFileSync('README.md', 'utf8')
const before = t
t = t.replace('**版本**: v0.4.25', '**版本**: v0.4.26')
t = t.replace('| [RELEASE_NOTES.md](./docs/RELEASE_NOTES.md) | 0.4.25 变更说明与回滚方式 |', '| [RELEASE_NOTES.md](./docs/RELEASE_NOTES.md) | 0.4.26 变更说明与回滚方式 |')
t = t.replace('pnpm exec vitest run        # 单测 73 项', 'pnpm exec vitest run        # 单测 85 项')
// 发票中心描述里补一句：方向分"待办/无需操作"
t = t.replace(
  '采集是全只读步骤、不做任何开票动作。',
  '采集是全只读步骤、不做任何开票动作；方向分「待办」与「无需操作」（已提交/已通过、商家没有待办动作），只有待办计入待开票合计。'
)
fs.writeFileSync('README.md', t, 'utf8')
console.log('changed=' + (t !== before))
console.log('version line ok=' + t.includes('**版本**: v0.4.26'))
console.log('notes link ok=' + t.includes('0.4.26 变更说明与回滚方式'))
console.log('tests line ok=' + t.includes('单测 85 项'))
console.log('pending note ok=' + t.includes('待办」与「无需操作'))
