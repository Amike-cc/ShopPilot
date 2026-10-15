import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * B7/B8（2026-10-15 全库审查）回归：两处服务层加固 + 注释一致性。
 *
 * B7：pruneBackups 以前"文件删不掉也把元数据行删掉"——残留的 .db 从此失去回收依据，
 *     永远留在备份目录里。修复：删文件失败就保留行，下一轮再试。
 * B8：update-manager 的失败审计去重（'error' 事件与 promise catch 各写一条）；
 *     retention 的孤儿分区注释与真实调度对齐（随维护循环执行，而非"只在启动时调"）。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const BACKUP = read('apps/desktop/src/main/services/backup-manager.ts')
const UPDATE = read('apps/desktop/src/main/services/update-manager.ts')
const RETENTION = read('apps/desktop/src/main/services/retention.ts')

describe('B7 pruneBackups：文件删不掉就保留元数据行', () => {
  it('删除失败时 continue（行保留、下轮重试），成功才 DELETE 并计数', () => {
    expect(BACKUP).toContain('if (!filesRemoved) continue')
    expect(BACKUP).toContain('保留元数据行')
    const failIdx = BACKUP.indexOf('filesRemoved = false')
    const contIdx = BACKUP.indexOf('if (!filesRemoved) continue')
    const delIdx = BACKUP.indexOf('DELETE FROM backups WHERE id = ?', contIdx)
    expect(failIdx).toBeGreaterThan(-1)
    expect(contIdx).toBeGreaterThan(failIdx)
    expect(delIdx).toBeGreaterThan(contIdx)
  })
})

describe('B8 审计去重与注释一致性', () => {
  it('update-manager：catch 只在错误事件未到达时补审计（wasCheck / wasDownload 判据）', () => {
    expect(UPDATE).toContain("if (wasCheck) audit('update.check', 'failure'")
    expect(UPDATE).toContain("if (wasDownload) audit('update.download', 'failure'")
  })

  it('retention：孤儿分区清理的注释与真实调度一致（随维护循环执行）', () => {
    expect(RETENTION).not.toContain('只在启动时调')
    expect(RETENTION).toContain('随维护循环执行')
  })
})
