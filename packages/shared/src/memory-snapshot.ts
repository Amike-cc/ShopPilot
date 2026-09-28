/**
 * 记忆快照的摘要比对 - §35.2 / 2026-09-26 审计 P2
 *
 * 快照恢复是破坏性操作（把整库记忆按快照重写）。原先 `inspectMemorySnapshot` 把 sha256
 * 回传给界面，但 `restoreMemorySnapshot` **从不比对**——界面展示的摘要只用于显示，
 * 用户看到的是 A 文件、Main 恢复的可能是被换掉的 B 文件。
 *
 * 这里把"比对"抽成纯规则，便于单测：面板把自己展示过的摘要传回来，Main 与文件实际摘要
 * 不一致就拒绝恢复。未提供摘要时放行（兼容旧调用/首次使用），但审计里会记"未提供摘要"。
 */

export type SnapshotDigestVerdict =
  | { ok: true; verified: boolean }
  | { ok: false; code: 'AGENT_MEMORY_SNAPSHOT_INVALID'; message: string }

/** 十六进制摘要的归一化：小写、去空白（大小写不同不算不一致） */
function normalize(value: string): string {
  return String(value || '').trim().toLowerCase()
}

export function verifySnapshotDigest(expectedSha256: string | undefined | null, actualSha256: string): SnapshotDigestVerdict {
  const actual = normalize(actualSha256)
  const expected = normalize(expectedSha256 || '')
  if (!expected) return { ok: true, verified: false }
  if (expected.length !== 64 || !/^[0-9a-f]{64}$/.test(expected)) {
    return { ok: false, code: 'AGENT_MEMORY_SNAPSHOT_INVALID', message: '快照摘要格式不合法（应为 64 位十六进制）' }
  }
  if (expected !== actual) {
    return {
      ok: false,
      code: 'AGENT_MEMORY_SNAPSHOT_INVALID',
      message: `快照摘要不一致（界面展示 ${expected.slice(0, 12)}…，文件实际 ${actual.slice(0, 12)}…），已拒绝恢复`
    }
  }
  return { ok: true, verified: true }
}
