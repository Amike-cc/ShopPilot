/**
 * 验收测试钩子总开关（纯规则，主/渲共用、可脱离 Electron 单测）。
 *
 * 背景（2026-10-19 审查整改）：打包版此前只要外部设置 `SHOPILOT_ACCEPTANCE=1`，
 * 就能启用「自动确认 / 替代密码对话框 / 扩展目录注入 / 记忆故障注入」等测试钩子——
 * 对生产安装包来说这是一个可被环境变量单独打开的后门。
 *
 * 现规则（三层，全部满足才启用）：
 *   1) 开发态（app.isPackaged === false）始终允许，方便本地调试；
 *   2) 打包态必须使用**验收构建**（构建期 `SHOPILOT_BUILD_ACCEPTANCE=1`，
 *      经 electron.vite define 注入 `__SHOPILOT_ACCEPTANCE_BUILD__`）；生产构建注入 false，
 *      只改运行期环境变量无法打开；
 *   3) 运行期仍须显式 `SHOPILOT_ACCEPTANCE=1`，且主进程会写一条 warn 审计日志。
 *
 * 验收产物：`pnpm run dist:acceptance`（tools/acceptance/build-acceptance.mjs）。
 * 生产发布：`pnpm dist`（钩子被剥离，任何环境变量都不会生效）。
 */

/** 运行期开关（验收跑器显式注入） */
export const ACCEPTANCE_RUNTIME_ENV = 'SHOPILOT_ACCEPTANCE'
/** 构建期开关（只由验收构建脚本注入，生产构建不设置） */
export const ACCEPTANCE_BUILD_ENV = 'SHOPILOT_BUILD_ACCEPTANCE'

export interface AcceptanceGateInput {
  /** Electron app.isPackaged：打包态为 true */
  isPackaged: boolean
  /** 构建期常量 `__SHOPILOT_ACCEPTANCE_BUILD__`；缺省视为 false（生产安全默认） */
  buildFlag: boolean
  /** 环境变量表（默认 process.env，测试可注入） */
  env: Record<string, string | undefined>
}

/**
 * 判定测试钩子是否启用。副作用为零，便于单测与打包态自检复用。
 * 注意：调用方（主进程）负责写审计日志，本函数保持纯函数。
 */
export function isAcceptanceHookEnabled(input: AcceptanceGateInput): boolean {
  if (!input.isPackaged) return true
  if (input.buildFlag !== true) return false
  return input.env[ACCEPTANCE_RUNTIME_ENV] === '1'
}
