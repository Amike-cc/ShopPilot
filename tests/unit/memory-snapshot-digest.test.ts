import { describe, expect, it } from 'vitest'
import { verifySnapshotDigest } from '../../packages/shared/src/memory-snapshot'
import { agentMemorySnapshotRestoreSchema } from '../../packages/shared/src/schemas/agent-domain'

/**
 * 2026-09-26 审计 P2「快照恢复的 confirmed 由渲染层自报、digest 只回传不比对」：
 * 摘要比对抽成纯规则后在这里锁死；schema 侧同时要求输入严格（多余键拒绝）。
 */

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

describe('verifySnapshotDigest（面板展示的摘要必须与文件一致）', () => {
  it('一致 → 通过且标记已核对', () => {
    expect(verifySnapshotDigest(SHA_A, SHA_A)).toEqual({ ok: true, verified: true })
  })

  it('大小写/空白差异不算不一致', () => {
    expect(verifySnapshotDigest(` ${SHA_A.toUpperCase()} `, SHA_A)).toEqual({ ok: true, verified: true })
  })

  it('不一致 → 拒绝，并给出两个摘要的前缀便于排查', () => {
    const verdict = verifySnapshotDigest(SHA_A, SHA_B)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.code).toBe('AGENT_MEMORY_SNAPSHOT_INVALID')
      expect(verdict.message).toContain('aaaaaaaaaaaa')
      expect(verdict.message).toContain('bbbbbbbbbbbb')
      expect(verdict.message).toContain('拒绝恢复')
    }
  })

  it('未提供摘要 → 放行但不标记已核对（兼容旧调用，审计里会如实记"未提供摘要"）', () => {
    expect(verifySnapshotDigest(undefined, SHA_A)).toEqual({ ok: true, verified: false })
    expect(verifySnapshotDigest(null, SHA_A)).toEqual({ ok: true, verified: false })
    expect(verifySnapshotDigest('   ', SHA_A)).toEqual({ ok: true, verified: false })
  })

  it('摘要格式不合法（长度/字符不对）→ 拒绝，而不是当成"没提供"放行', () => {
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 'not-a-hash']) {
      const verdict = verifySnapshotDigest(bad, SHA_A)
      expect(verdict.ok, bad).toBe(false)
      if (!verdict.ok) expect(verdict.message).toContain('格式不合法')
    }
  })
})

describe('agentMemorySnapshotRestoreSchema（恢复通道的输入契约）', () => {
  it('最小输入：仅 path，actorAgentId 默认 root-ceo，确认值由 Main 产生', () => {
    const parsed = agentMemorySnapshotRestoreSchema.parse({ path: 'C:/x/snapshot-1.bin' })
    expect(parsed.actorAgentId).toBe('root-ceo')
    expect(parsed.confirmed).toBe(false)
    expect(parsed.expectedSha256).toBeUndefined()
  })

  it('expectedSha256 必须是 64 位小写十六进制', () => {
    expect(agentMemorySnapshotRestoreSchema.safeParse({ path: 'p', expectedSha256: SHA_A }).success).toBe(true)
    expect(agentMemorySnapshotRestoreSchema.safeParse({ path: 'p', expectedSha256: SHA_A.toUpperCase() }).success).toBe(false)
    expect(agentMemorySnapshotRestoreSchema.safeParse({ path: 'p', expectedSha256: 'abc' }).success).toBe(false)
  })

  it('兼容字段 confirmed 仍须为布尔，但不能通过字符串或多余键绕过契约', () => {
    expect(agentMemorySnapshotRestoreSchema.safeParse({ path: 'p', confirmed: 'yes' }).success).toBe(false)
    expect(agentMemorySnapshotRestoreSchema.safeParse({ path: 'p', confirmed: true, extra: 1 }).success).toBe(false)
    expect(agentMemorySnapshotRestoreSchema.safeParse({ path: '', confirmed: true }).success).toBe(false)
  })
})
