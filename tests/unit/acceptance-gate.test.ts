import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_BUILD_ENV,
  ACCEPTANCE_RUNTIME_ENV,
  isAcceptanceHookEnabled
} from '@shared/acceptance-gate'

// 2026-10-19 审查整改：打包态测试钩子必须同时满足「验收构建 + 显式运行期开关」，
// 生产构建（buildFlag=false）下任何环境变量都不能打开。

describe('acceptance-hook gate', () => {
  it('开发态始终放行（不需要任何环境变量）', () => {
    expect(isAcceptanceHookEnabled({ isPackaged: false, buildFlag: false, env: {} })).toBe(true)
    expect(isAcceptanceHookEnabled({ isPackaged: false, buildFlag: true, env: {} })).toBe(true)
  })

  it('打包态 + 生产构建（buildFlag=false）：运行期变量无法打开', () => {
    expect(
      isAcceptanceHookEnabled({
        isPackaged: true,
        buildFlag: false,
        env: { [ACCEPTANCE_RUNTIME_ENV]: '1' }
      })
    ).toBe(false)
  })

  it('打包态 + 验收构建：必须显式运行期开关', () => {
    expect(isAcceptanceHookEnabled({ isPackaged: true, buildFlag: true, env: {} })).toBe(false)
    expect(
      isAcceptanceHookEnabled({
        isPackaged: true,
        buildFlag: true,
        env: { [ACCEPTANCE_RUNTIME_ENV]: '0' }
      })
    ).toBe(false)
    expect(
      isAcceptanceHookEnabled({
        isPackaged: true,
        buildFlag: true,
        env: { [ACCEPTANCE_RUNTIME_ENV]: '1' }
      })
    ).toBe(true)
  })

  it('环境变量名与文档一致（防止改名漂移）', () => {
    expect(ACCEPTANCE_RUNTIME_ENV).toBe('SHOPILOT_ACCEPTANCE')
    expect(ACCEPTANCE_BUILD_ENV).toBe('SHOPILOT_BUILD_ACCEPTANCE')
  })
})
