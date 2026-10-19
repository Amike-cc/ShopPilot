/**
 * 主进程验收钩子门禁（Electron 适配层）。
 *
 * 判定规则与常量见 `@shared/acceptance-gate`（纯函数，单测覆盖）：
 *   · 开发态放行；
 *   · 打包态要求构建期常量 `__SHOPILOT_ACCEPTANCE_BUILD__ === true`（只有验收构建会注入）；
 *   · 运行期再要求 `SHOPILOT_ACCEPTANCE=1`；
 *   · 打包态一旦启用即写一条 warn，便于事后审计「这次导出为什么没有人工确认」。
 *
 * 生产构建（`pnpm dist`）里该常量为 false，门禁在最外层直接拒绝，环境变量无法打开。
 */
import { app } from 'electron'
import { ACCEPTANCE_BUILD_ENV, ACCEPTANCE_RUNTIME_ENV, isAcceptanceHookEnabled } from '@shared/acceptance-gate'
import { logMain } from './logger'

// electron.vite.config.ts 的 define 在构建期替换该标识符；
// vitest / tsc 直接跑源码时不存在该标识符，因此用 typeof 防御（默认 false = 生产安全）。
declare const __SHOPILOT_ACCEPTANCE_BUILD__: boolean

export const ACCEPTANCE_HOOKS_BUILT_IN: boolean =
  typeof __SHOPILOT_ACCEPTANCE_BUILD__ === 'boolean' ? __SHOPILOT_ACCEPTANCE_BUILD__ : false

let acceptanceHookLogged = false

/** 当前进程是否启用验收测试钩子（打包态会写一次审计 warn）。 */
export function acceptanceHooksEnabled(): boolean {
  const enabled = isAcceptanceHookEnabled({
    isPackaged: app.isPackaged,
    buildFlag: ACCEPTANCE_HOOKS_BUILT_IN,
    env: process.env
  })
  if (enabled && app.isPackaged && !acceptanceHookLogged) {
    acceptanceHookLogged = true
    logMain(
      'warn',
      `[acceptance] 打包态测试钩子已启用（构建期 ${ACCEPTANCE_BUILD_ENV}=1 + 运行期 ${ACCEPTANCE_RUNTIME_ENV}=1）：人工确认/密码对话框将被环境变量替代`
    )
  }
  return enabled
}
