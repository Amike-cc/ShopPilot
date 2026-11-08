import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { catalogSlug, parseCatalogIndex } from '@shared/extension-catalog'
import { validateExtensionManifest } from '../../apps/desktop/src/main/services/extension-manifest'

/**
 * 插件中心（2026-11-08）。
 *
 * 两条线：
 *   ① 纯函数：slug 必须稳定（重复安装覆盖同一目录），目录清单必须严格拒绝路径穿越/坏条目；
 *   ② 仓库资产：随包发的 `assets/browser-extensions` 必须真的能装上——
 *      清单合法、每个条目目录存在、manifest 过应用同一套安全校验。
 *      第二条最容易在"改了文件忘了改清单"时静默坏掉，所以钉在单测里。
 */

const ROOT = resolve(__dirname, '../..')
const CATALOG_ROOT = join(ROOT, 'assets', 'browser-extensions')

describe('catalogSlug：安装目录由条目 id 确定性推导', () => {
  it('格式符合应用既有的扩展目录规则（ext_ + 8 位小写十六进制）', () => {
    expect(catalogSlug('luopan-downloader')).toMatch(/^ext_[a-z0-9]{8}$/)
    expect(catalogSlug('a-b-c')).toMatch(/^ext_[a-z0-9]{8}$/)
  })

  it('同一个 key 永远得到同一个 slug（重复安装=覆盖，不允许装出两份）', () => {
    const first = catalogSlug('luopan-downloader')
    for (let i = 0; i < 20; i += 1) expect(catalogSlug('luopan-downloader')).toBe(first)
  })

  it('不同 key 给出不同 slug（现有目录条目之间不冲突）', () => {
    const keys = ['luopan-downloader', 'helper-a', 'helper-b']
    const slugs = new Set(keys.map(catalogSlug))
    expect(slugs.size).toBe(keys.length)
  })
})

describe('parseCatalogIndex：坏清单必须在安装前被拒', () => {
  const good = {
    version: 1,
    entries: [{ key: 'demo-ext', dir: 'demo-ext', name: '示例插件', summary: '一句话说明', tags: ['示例'] }]
  }

  it('合法清单原样通过，并保留可选字段', () => {
    const parsed = parseCatalogIndex({ ...good, entries: [{ ...good.entries[0], description: '详细说明' }] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.index.entries[0]).toMatchObject({ key: 'demo-ext', dir: 'demo-ext', name: '示例插件', description: '详细说明' })
  })

  it('拒绝路径穿越的目录名（这条能防"把任意目录复制成扩展"）', () => {
    for (const dir of ['../evil', '..\\evil', 'a/b', 'C:\\tmp', '.hidden']) {
      const parsed = parseCatalogIndex({ version: 1, entries: [{ ...good.entries[0], dir }] })
      expect(parsed.ok, `dir=${dir} 应被拒绝`).toBe(false)
    }
  })

  it('拒绝不合法 key / 重复 key / 缺名称 / 缺简介 / 版本不支持', () => {
    expect(parseCatalogIndex({ version: 1, entries: [{ ...good.entries[0], key: 'A' }] }).ok).toBe(false)
    expect(parseCatalogIndex({ version: 1, entries: [good.entries[0], { ...good.entries[0] }] }).ok).toBe(false)
    expect(parseCatalogIndex({ version: 1, entries: [{ ...good.entries[0], name: '' }] }).ok).toBe(false)
    expect(parseCatalogIndex({ version: 1, entries: [{ ...good.entries[0], summary: '' }] }).ok).toBe(false)
    expect(parseCatalogIndex({ version: 2, entries: good.entries }).ok).toBe(false)
    expect(parseCatalogIndex(null).ok).toBe(false)
  })
})

describe('随包发的插件目录本身是合法的（改了文件必须改清单）', () => {
  it('catalog.json 能被解析，且每个条目都有目录与合法 manifest', () => {
    const indexPath = join(CATALOG_ROOT, 'catalog.json')
    expect(existsSync(indexPath), '缺少 assets/browser-extensions/catalog.json').toBe(true)
    const parsed = parseCatalogIndex(JSON.parse(readFileSync(indexPath, 'utf8')))
    expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true)
    if (!parsed.ok) return
    expect(parsed.index.entries.length).toBeGreaterThan(0)

    for (const entry of parsed.index.entries) {
      const dir = join(CATALOG_ROOT, entry.dir)
      const manifestPath = join(dir, 'manifest.json')
      expect(existsSync(manifestPath), `条目 ${entry.key} 缺少 manifest.json（${dir}）`).toBe(true)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const validated = validateExtensionManifest(manifest)
      expect(validated.ok, `条目 ${entry.key} 的清单被应用安全规则拒绝：${validated.ok ? '' : validated.message}`).toBe(true)
      expect(statSync(dir).isDirectory()).toBe(true)
    }
  })
})
