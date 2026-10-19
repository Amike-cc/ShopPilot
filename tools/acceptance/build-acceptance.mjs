#!/usr/bin/env node
/**
 * 验收构建：与生产构建的唯一区别是主进程保留 SHOPILOT_ACCEPTANCE 测试钩子。
 *
 * 为什么需要单独一条命令（2026-10-19 审查整改）：
 *   生产安装包不应接受「运行期环境变量打开测试钩子」。因此 `pnpm dist` 在构建期把
 *   __SHOPILOT_ACCEPTANCE_BUILD__ 注入为 false，门禁直接拒绝；验收套件需要钩子时，
 *   必须用本脚本构建（构建期 SHOPILOT_BUILD_ACCEPTANCE=1），运行期仍要显式
 *   SHOPILOT_ACCEPTANCE=1。见 docs/ACCEPTANCE_HOOKS.md。
 *
 * 用法：
 *   node tools/acceptance/build-acceptance.mjs          # 完整构建（含 NSIS 安装包，M4 需要）
 *   node tools/acceptance/build-acceptance.mjs --dir    # 只出 release/win-unpacked（快，CDP 套件够用）
 */
import { spawnSync } from 'node:child_process'

const dirOnly = process.argv.includes('--dir')
const env = { ...process.env, SHOPILOT_BUILD_ACCEPTANCE: '1' }
const isWindows = process.platform === 'win32'
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm'

function run(args) {
  console.log(`[acceptance-build] ${pnpm} ${args.join(' ')}`)
  // 不用 shell:true（Node 会告警 DEP0190：args 与 shell 同时使用有注入风险）：
  // Windows 下显式经 cmd /c 执行 .cmd，其它平台直接 spawn。
  const result = isWindows
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [pnpm, ...args].join(' ')], {
        stdio: 'inherit',
        env
      })
    : spawnSync(pnpm, args, { stdio: 'inherit', env })
  if (result.error) {
    console.error('[acceptance-build] spawn failed:', result.error)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[acceptance-build] step failed with exit ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

run(['exec', 'electron-vite', 'build'])
run(['exec', 'electron-builder', '--win', '--x64', ...(dirOnly ? ['--dir'] : [])])

console.log(
  `[acceptance-build] done (SHOPILOT_BUILD_ACCEPTANCE=1${dirOnly ? ', --dir' : ', NSIS installer'}); ` +
    '运行期仍需显式 SHOPILOT_ACCEPTANCE=1'
)
