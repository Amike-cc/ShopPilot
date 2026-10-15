import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as pathResolve, join, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/**
 * B5（2026-10-15 全库审查）回归：生图保存的路径边界与 base64 校验。
 *
 * 背景：`ai:image:save` 的 outputPath 由渲染层提供，此前只补扩展名、没有任何边界校验——
 * 等于给渲染层一个"以用户权限写任意 *.png/jpg/webp"的落盘原语，而同类导出（诊断包）
 * 早就有 assertSafeExportPath（仅用户目录/临时目录）。base64 侧也有一个"宽松解码"坑：
 * `Buffer.from(x,'base64')` 对非法字符不抛错，会把乱码静默存成"图片"。
 *
 * 修复：新增 safe-image-save.assertSafeImageSavePath（与诊断导出同规则；非打包态额外放行
 * 应用根目录——设计/验收脚本写仓库 artifacts/ 用）；handler 先校验 base64 字符集。
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => `${process.cwd()}/fake-app-root`
  }
}))

const { assertSafeImageSavePath } = await import('../../apps/desktop/src/main/services/safe-image-save')

describe('B5 生图保存路径：边界校验', () => {
  it('放行临时目录与用户目录，并补扩展名；已有 .png（大小写不敏感）原样保留', () => {
    const t = join(tmpdir(), 'shopilot-img-test')
    expect(assertSafeImageSavePath(t, 'png')).toBe(t + '.png')
    const h = join(homedir(), 'Pictures', 'x.PNG')
    expect(assertSafeImageSavePath(h, 'png')).toBe(h)
  })

  it('开发态放行应用根目录（设计/验收脚本把留档写进仓库）', () => {
    const p = join(process.cwd(), 'fake-app-root', 'artifacts', 'maintenance', 'x.png')
    expect(assertSafeImageSavePath(p, 'png')).toBe(p)
  })

  it('拒绝相对路径、.. 跳过段、以及允许根之外的绝对路径', () => {
    expect(() => assertSafeImageSavePath('relative\\x', 'png')).toThrow(/AI_BAD_INPUT/)
    // 注意：不能用 join() 拼 '..'（它会被归一化掉）——用字符串拼接保留跳过段本身
    const dotdot = `${tmpdir()}${sep}..${sep}escape${sep}x`
    expect(() => assertSafeImageSavePath(dotdot, 'png')).toThrow(/跳过段/)
    // 挂到盘根的路径必然不在 用户目录/临时目录/应用目录 之下
    expect(() => assertSafeImageSavePath(pathResolve('/', 'outside-root', 'evil.png'), 'png')).toThrow(/必须位于用户目录/)
  })

  it('handler 集成（源码级）：outputPath 走校验；base64 先严格校验字符集', () => {
    const HANDLER = readFileSync(pathResolve('apps/desktop/src/main/ipc/ai-handlers.ts'), 'utf8')
    expect(HANDLER).toContain('assertSafeImageSavePath(targetPath, ext)')
    expect(HANDLER).toContain('cleaned.length % 4 === 1')
    expect(HANDLER).toContain("message.startsWith('AI_BAD_INPUT')")
  })
})
