import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 2026-09-26 审计 P2「overview-service ⇄ ipc 成环」：
 * 原先 `services/overview-service.ts` import `ipc/profile-misc-handlers.ts`，而后者又 import 前者，
 * 形成 service → ipc → service 的循环 import（当时靠"两边顶层只有函数声明、会被提升"来说明安全）。
 * 现在取数 helper 已搬进 services，方向必须是单向的 `ipc → services`。
 *
 * 这个测试把方向锁死：services 层不得 import ipc 层（否则循环随时可能回来，且打包分块/单测
 * 加载顺序都会变得依赖"恰好没有顶层求值"这种脆弱前提）。
 */

const mainDir = fileURLToPath(new URL('../../apps/desktop/src/main/', import.meta.url))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('Main 进程的分层方向', () => {
  it('services / stores / tasks / browser / db 不得 import ipc 层', () => {
    const offenders: string[] = []
    for (const file of walk(mainDir)) {
      const rel = file.slice(mainDir.length).replace(/\\/g, '/')
      if (rel.startsWith('ipc/') || rel.startsWith('db/')) continue
      const text = readFileSync(file, 'utf8')
      // 只看向上层目录的 import（'../ipc/...' 或 './ipc/...'），同层 ipc 目录本身除外
      if (/from\s+'(?:\.\.\/)+ipc\//.test(text)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('ipc 层可以 import services（单向），且概览取数只有一处实现', () => {
    const handler = readFileSync(join(mainDir, 'ipc', 'profile-misc-handlers.ts'), 'utf8')
    expect(handler).toContain("from '../services/overview-service'")
    const service = readFileSync(join(mainDir, 'services', 'overview-service.ts'), 'utf8')
    expect(service).toContain('export function collectInvoiceRows')
    expect(service).toContain('export function collectEntities')
    expect(service).not.toContain("from '../ipc/")
    // 取数实现不得在 handler 里再留一份
    expect(handler).not.toContain('function collectInvoiceRows')
    expect(handler).not.toContain('function collectEntities')
  })
})
