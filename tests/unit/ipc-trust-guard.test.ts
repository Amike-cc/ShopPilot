import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 审计 P2-C 的守卫：业务 IPC 通道必须逐个经过可信渲染层校验。
 *
 * 背景：店铺、浏览器、任务、店铺配置、代理备份、会话安全、书签下载、应用更新这 8 个家族
 * 共 92 个通道原先都是裸 `ipcMain.handle`，只有 Agent / AI 两个家族带校验。今天能执行脚本的
 * 渲染层只有应用主窗口（store 视图与密码弹窗都没有业务 preload），但**新增一个 preload
 * 或视图类型就会静默多出一批高危可达通道**（改店铺凭据、清 Cookie、恢复备份、改设置）。
 *
 * 因此这里把"统一入口"变成可测的契约：
 *   · 通道注册要么用 `familyHandle(...)`（业务家族），要么显式调用 assertTrustedRenderer；
 *   · 除 `family-handle.ts` 外不允许出现裸 `ipcMain.handle(`。
 */

const IPC_DIR = 'apps/desktop/src/main/ipc'
const GUARD_MODULE = 'family-handle.ts'
/** 家族内逐通道自查（Agent 家族要按家族给不同错误码，所以保留裸 handle + 每个 handler 自行断言） */
const TRUST_ASSERT_RE = /assertTrustedRenderer\(|assertTrustedIpc\(|assertTrusted\(/

function handlerFiles(): string[] {
  return readdirSync(IPC_DIR).filter(name => name.endsWith('-handlers.ts')).sort()
}

function sourceOf(name: string): string {
  return readFileSync(join(IPC_DIR, name), 'utf8')
}

describe('IPC 可信校验：每个业务通道都过统一入口', () => {
  it('存在 handler 家族文件（防止路径写错导致断言空转）', () => {
    expect(handlerFiles().length).toBeGreaterThanOrEqual(10)
  })

  it('裸 ipcMain.handle( 只允许出现在 family-handle.ts 或自带断言的文件里，且断言数不少于通道数', () => {
    const offenders: string[] = []
    for (const name of readdirSync(IPC_DIR)) {
      if (!name.endsWith('.ts') || name === GUARD_MODULE) continue
      const source = sourceOf(name)
      const rawHandles = (source.match(/\bipcMain\.handle\(/g) || []).length
      if (!rawHandles) continue
      const asserts = (source.match(new RegExp(TRUST_ASSERT_RE.source, 'g')) || []).length
      if (asserts < rawHandles) {
        offenders.push(`${name}: 裸 handle ${rawHandles} 个，断言只有 ${asserts} 个`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('每个 handler 家族都有可信校验来源（familyHandle 或逐通道断言）', () => {
    const missing: string[] = []
    for (const name of handlerFiles()) {
      const source = sourceOf(name)
      if (!source.includes('familyHandle(') && !TRUST_ASSERT_RE.test(source)) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  /**
   * 锁定态放行只允许两处：①会话/安全家族（解锁、锁状态、设置/移除主密码——否则用户永远解不开锁）；
   * ②标题栏底色这一个纯装饰通道（App.vue 在 appLocked 变化时要把标题栏刷成锁屏底色）。
   * 其余任何通道都必须照常拒绝。
   */
  it('锁定态放行只允许会话/安全家族与标题栏底色通道', () => {
    const security = sourceOf('session-security-handlers.ts')
    expect(security).toContain('allowWhenLocked: true')
    // profile-misc 里**只有**标题栏底色这一个通道放行锁定态：取该通道注册段（到下一次注册为止）判断
    const misc = sourceOf('profile-misc-handlers.ts')
    const start = misc.indexOf('WINDOW_SET_TITLEBAR_OVERLAY')
    expect(start, 'profile-misc 必须注册标题栏通道').toBeGreaterThan(-1)
    const next = misc.indexOf('handle(IPC_CHANNELS.', start + 1)
    const segment = misc.slice(start, next === -1 ? misc.length : next)
    expect(segment).toContain('allowWhenLocked: true')
    expect((misc.match(/allowWhenLocked: true/g) || []).length).toBe(1)
    // 其它家族不得跳过锁定校验
    for (const name of handlerFiles()) {
      if (name === 'session-security-handlers.ts' || name === 'profile-misc-handlers.ts') continue
      expect(sourceOf(name), name).not.toContain('allowWhenLocked')
    }
  })

  it('每个用 familyHandle 的家族都在注册通道（不是只 import 不接线）', () => {
    for (const name of handlerFiles()) {
      const source = sourceOf(name)
      if (!source.includes('familyHandle(')) continue
      const registered = (source.match(/^\s*handle\(IPC_CHANNELS\./gm) || []).length
      expect(registered, `${name} 应通过 handle(...) 注册通道`).toBeGreaterThan(0)
      expect(source, `${name} 不应再直接调用 ipcMain.handle`).not.toMatch(/\bipcMain\.handle\(/)
    }
  })
})
