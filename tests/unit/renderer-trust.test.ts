import { describe, expect, it } from 'vitest'
import { evaluateRendererTrust } from '../../apps/desktop/src/main/services/renderer-trust-rules'

/**
 * 渲染层可信判定（审计 P1 的回归测试）。
 *
 * 这道检查原先只在两个 Agent handler 家族里各写一份，`ipc/ai-handlers.ts`（能改 AI 配置、
 * 能写/清 API Key）完全没有；现在收敛成一份纯规则，两个家族与 AI 家族共用。
 */

const HOST = 7

describe('evaluateRendererTrust', () => {
  it('主窗口 + 未锁定 → 放行', () => {
    expect(evaluateRendererTrust({ hostWebContentsId: HOST, senderWebContentsId: HOST, locked: false })).toEqual({ ok: true })
  })

  it('非主窗口（其它 webContents / 无 host / 取不到 sender）→ 拒绝', () => {
    for (const input of [
      { hostWebContentsId: HOST, senderWebContentsId: 99, locked: false },
      { hostWebContentsId: null, senderWebContentsId: HOST, locked: false },
      { hostWebContentsId: HOST, senderWebContentsId: null, locked: false },
      { hostWebContentsId: undefined, senderWebContentsId: undefined, locked: false }
    ]) {
      const verdict = evaluateRendererTrust(input)
      expect(verdict.ok, JSON.stringify(input)).toBe(false)
      expect(verdict.code).toBe('AGENT_FORBIDDEN')
    }
  })

  it('已锁定 → APP_LOCKED（优先于家族错误码，且不泄露"是否主窗口"）', () => {
    const verdict = evaluateRendererTrust({ hostWebContentsId: HOST, senderWebContentsId: HOST, locked: true })
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('APP_LOCKED')
    expect(verdict.message).toContain('解锁')
  })

  it('错误码与文案按家族区分（Agent / AI 配置 / 其它业务家族）', () => {
    const ai = evaluateRendererTrust({ hostWebContentsId: null, senderWebContentsId: HOST, locked: false, forbiddenCode: 'AI_FORBIDDEN', feature: 'AI 配置' })
    expect(ai.code).toBe('AI_FORBIDDEN')
    expect(ai.message).toBe('AI 配置 IPC 仅允许应用主窗口调用')
    const agent = evaluateRendererTrust({ hostWebContentsId: null, senderWebContentsId: HOST, locked: false })
    expect(agent.message).toBe('Agent IPC 仅允许应用主窗口调用')
    const store = evaluateRendererTrust({ hostWebContentsId: null, senderWebContentsId: HOST, locked: false, forbiddenCode: 'IPC_FORBIDDEN', feature: '店铺管理' })
    expect(store.code).toBe('IPC_FORBIDDEN')
    expect(store.message).toBe('店铺管理 IPC 仅允许应用主窗口调用')
  })

  /**
   * 审计 P2-C：店铺/浏览器/任务/设置等 8 个家族共 92 个通道也走这道检查。
   * 应用锁家族必须能在锁定状态下被调用（解锁、锁状态、设置/移除主密码），
   * 否则用户永远解不开锁——但它们仍只接受主窗口。
   */
  it('allowWhenLocked：锁定时仍放行主窗口，但其它 webContents 依旧拒绝', () => {
    expect(evaluateRendererTrust({ hostWebContentsId: HOST, senderWebContentsId: HOST, locked: true, allowWhenLocked: true })).toEqual({ ok: true })
    const foreign = evaluateRendererTrust({ hostWebContentsId: HOST, senderWebContentsId: 99, locked: true, allowWhenLocked: true, forbiddenCode: 'IPC_FORBIDDEN' })
    expect(foreign.ok).toBe(false)
    expect(foreign.code).toBe('IPC_FORBIDDEN')
  })
})
