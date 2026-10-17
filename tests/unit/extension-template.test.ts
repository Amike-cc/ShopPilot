/**
 * 自研插件模板的契约测试（2026-10-17）。
 *
 * 目的：docs/extension-template 是给用户直接导入的骨架，必须随 manifest 校验规则
 * 一起演进 —— 校验规则一收紧，模板不能悄悄变成「导入就被拒」。
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { validateExtensionManifest } from '../../apps/desktop/src/main/services/extension-manifest'

const TEMPLATE_DIR = join(__dirname, '..', '..', 'docs', 'extension-template')

describe('extension template fixture', () => {
  it('模板目录存在且清单能通过应用校验', () => {
    const manifestPath = join(TEMPLATE_DIR, 'manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const result = validateExtensionManifest(parsed)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.manifestVersion).toBe(3)
    expect(result.manifest.name.length).toBeGreaterThan(0)
  })

  it('模板引用的 content script 文件真实存在（导入后不会 404）', () => {
    const manifest = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'manifest.json'), 'utf8'))
    const files: string[] = []
    for (const entry of manifest.content_scripts || []) {
      for (const file of entry.js || []) files.push(file)
      for (const file of entry.css || []) files.push(file)
    }
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(existsSync(join(TEMPLATE_DIR, file)), `缺少 ${file}`).toBe(true)
    }
  })

  it('模板不申请受限权限、不使用 world:MAIN（否则用户导入即失败）', () => {
    const manifest = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'manifest.json'), 'utf8'))
    for (const entry of manifest.content_scripts || []) {
      expect(entry.world).not.toBe('MAIN')
    }
    const permissions: string[] = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])]
    for (const blocked of ['nativeMessaging', 'debugger', 'cookies', 'proxy', 'downloads', 'identity']) {
      expect(permissions).not.toContain(blocked)
    }
  })
})
