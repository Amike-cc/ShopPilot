import { describe, it, expect, vi } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * 导出/导入路径校验（§10.1 / §16）单测。
 *
 * 这里**不起 Electron**：只测纯函数式的 assertSafeExportPath，electron 用一个最小 mock
 * 替代（diagnostics 的其余部分需要 app.getPath，本文件不触发）。
 */
vi.mock('electron', async () => {
  const os = await import('node:os')
  return { app: { getPath: () => os.tmpdir() }, session: {}, BrowserWindow: {}, safeStorage: {} }
})

const { assertSafeExportPath } = await import('../../apps/desktop/src/main/services/diagnostics')

const EXTS = ['.zip', '.json']

describe('导出路径校验', () => {
  it('放行系统临时目录下的白名单扩展名（验收脚本就传 TEMP 路径）', () => {
    const p = join(tmpdir(), 'shopilot-check-1.zip')
    expect(assertSafeExportPath(p, EXTS, '诊断包导出')).toBe(resolve(p))
  })

  it('放行用户目录下的白名单扩展名', () => {
    const p = join(homedir(), 'shopilot-check-2.json')
    expect(assertSafeExportPath(p, EXTS, '诊断包导出')).toBe(resolve(p))
  })

  it('拒绝相对路径', () => {
    expect(() => assertSafeExportPath('shopilot-check-3.zip', EXTS, '诊断包导出')).toThrow(/INVALID_ARGUMENT.*绝对路径/)
  })

  it('拒绝空路径', () => {
    expect(() => assertSafeExportPath('', EXTS, '诊断包导出')).toThrow(/INVALID_ARGUMENT/)
    expect(() => assertSafeExportPath('   ', EXTS, '诊断包导出')).toThrow(/INVALID_ARGUMENT/)
  })

  it('拒绝包含 .. 跳过段的路径（两种分隔符都拦；不先归一化，模拟渲染层原样传入）', () => {
    expect(() => assertSafeExportPath(`${tmpdir()}${sep}..${sep}shopilot-check-4.zip`, EXTS, '诊断包导出')).toThrow(/\.\./)
    expect(() => assertSafeExportPath(`${tmpdir()}/../shopilot-check-5.zip`, EXTS, '诊断包导出')).toThrow(/\.\./)
  })

  it('拒绝用户目录/临时目录之外的路径', () => {
    const outside = join(sep, 'shopilot-outside-root', 'x.zip')
    expect(() => assertSafeExportPath(outside, EXTS, '诊断包导出')).toThrow(/INVALID_ARGUMENT.*用户目录或系统临时目录/)
  })

  it('拒绝白名单外的扩展名', () => {
    expect(() => assertSafeExportPath(join(tmpdir(), 'shopilot-check-6.txt'), EXTS, '诊断包导出')).toThrow(/扩展名不被允许/)
  })

  it('大小写不敏感地放行用户目录（Windows 路径大小写常见不一致）', () => {
    const upper = join(tmpdir(), 'SHOPILOT-CHECK-7.ZIP')
    expect(assertSafeExportPath(upper, EXTS, '诊断包导出')).toBe(resolve(upper))
  })
})
