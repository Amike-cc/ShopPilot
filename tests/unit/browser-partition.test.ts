import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFallbackUserAgent } from '../../apps/desktop/src/main/browser/ua-fallback'
import { partitionDirName, sumDirectorySize } from '../../apps/desktop/src/main/browser/partition-usage'

/** 浏览器审查修复的回归钉：UA 兜底无 Electron 痕迹 + 分区占用统计。 */

describe('buildFallbackUserAgent：兜底 UA', () => {
  it('与本机 Chromium 同版本、绝不含 Electron/应用标识', () => {
    const ua = buildFallbackUserAgent('132.0.6834.83')
    expect(ua).toContain('Chrome/132.0.6834.83')
    expect(ua).not.toContain('Electron')
    expect(ua).not.toContain('ShopPilot')
    expect(ua).toContain('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  })
  it('畸形版本回退 126.0.0.0', () => {
    expect(buildFallbackUserAgent('')).toContain('Chrome/126.0.0.0')
    expect(buildFallbackUserAgent('../../etc/passwd')).toContain('Chrome/126.0.0.0')
  })
})

describe('partitionDirName：persist 分区名映射', () => {
  it('persist:store_x → store_x；非持久/空名 → null', () => {
    expect(partitionDirName('persist:store_abc')).toBe('store_abc')
    expect(partitionDirName('tmp:store_abc')).toBeNull()
    expect(partitionDirName('persist:')).toBeNull()
  })
})

describe('sumDirectorySize：递归统计', () => {
  // 目录在 beforeAll 建好、afterAll 才删——describe 回调在收集期执行，
  // 写在 try/finally 里会在用例运行前就把目录删掉（2026-10-16 实录）
  const dir = join(mkdtempSync(join(tmpdir(), 'shoppilot-partition-')))
  beforeAll(() => {
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(100))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'b.bin'), Buffer.alloc(250))
    writeFileSync(join(dir, 'sub', 'c.txt'), Buffer.alloc(27))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('文件字节求和（嵌套目录计入）', () => {
    expect(sumDirectorySize(dir).bytes).toBe(377)
    expect(sumDirectorySize(dir).skipped).toBe(0)
  })
  it('不存在的目录返回 0 且记跳过（如实不猜）', () => {
    const r = sumDirectorySize(join(dir, 'not-exist'))
    expect(r.bytes).toBe(0)
    expect(r.skipped).toBe(1)
  })
  it('符号链接不跟随', () => {
    try {
      symlinkSync(join(dir, 'a.bin'), join(dir, 'link.bin'))
    } catch { /* Windows 无权限时跳过该断言 */ }
    // 链接本身不计字节（statSync 会跟随 symlink——实现里显式跳过）
    expect(sumDirectorySize(dir).bytes).toBe(377)
  })
})
