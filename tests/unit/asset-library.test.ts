import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ASSET_LIBRARY_LIMITS,
  assetSourceLabel,
  filterAssetLibraryItems,
  formatAssetSize,
  normalizeAssetName,
  normalizeAssetTags,
  type AssetLibraryItem
} from '../../packages/shared/src/contracts/asset-library'

const read = (path: string) => readFileSync(path, 'utf8')
const page = read('apps/desktop/src/renderer/src/features/workbench/UnifiedAssetLibraryPage.vue')
const chatPage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedChatImagePage.vue')
const bridge = read('apps/desktop/src/renderer/src/features/workbench/asset-library-bridge.ts')
const preload = read('apps/desktop/src/preload/index.ts')
const env = read('apps/desktop/src/renderer/src/env.d.ts')
const ipc = read('packages/shared/src/contracts/ipc.ts')
const migrations = read('apps/desktop/src/main/db/migrations.ts')
const handlers = read('apps/desktop/src/main/ipc/asset-library-handlers.ts')
const service = read('apps/desktop/src/main/services/asset-library.ts')
const modules = read('apps/desktop/src/renderer/src/features/workbench/use-app-modules.ts')
const mainIndex = read('apps/desktop/src/main/index.ts')

function item(partial: Partial<AssetLibraryItem>): AssetLibraryItem {
  return {
    id: partial.id || 'a1',
    name: partial.name || '素材',
    mimeType: partial.mimeType || 'image/jpeg',
    size: partial.size ?? 1024,
    width: partial.width ?? 800,
    height: partial.height ?? 800,
    tags: partial.tags || [],
    source: partial.source || 'upload',
    thumbUrl: partial.thumbUrl || '',
    createdAt: partial.createdAt || 1,
    updatedAt: partial.updatedAt || 1
  }
}

describe('素材库纯逻辑', () => {
  it('名称压成单行并截断，空值用兜底名', () => {
    expect(normalizeAssetName('  春季\n主图  ')).toBe('春季 主图')
    expect(normalizeAssetName('')).toBe('未命名素材')
    expect(normalizeAssetName('x'.repeat(300))).toHaveLength(ASSET_LIBRARY_LIMITS.name)
  })

  it('标签支持数组/中英文逗号/顿号，去 #、去重、截断', () => {
    expect(normalizeAssetTags('主图, 春季，童装、#主图\n 鞋包 ')).toEqual(['主图', '春季', '童装', '鞋包'])
    expect(normalizeAssetTags(['A', 'a', 'B'])).toEqual(['A', 'B'])
    expect(normalizeAssetTags(['x'.repeat(80)])[0]).toHaveLength(ASSET_LIBRARY_LIMITS.tag)
    expect(normalizeAssetTags(Array.from({ length: 20 }, (_, index) => `tag${index}`))).toHaveLength(ASSET_LIBRARY_LIMITS.tags)
  })

  it('按名称/标签、来源、单个标签筛选', () => {
    const items = [
      item({ id: '1', name: '春季童装主图', tags: ['童装', '主图'], source: 'upload' }),
      item({ id: '2', name: 'AI 场景图', tags: ['场景', 'AI生成'], source: 'chat-image' })
    ]
    expect(filterAssetLibraryItems(items, { query: '童装' }).map(i => i.id)).toEqual(['1'])
    expect(filterAssetLibraryItems(items, { query: '场景' }).map(i => i.id)).toEqual(['2'])
    expect(filterAssetLibraryItems(items, { source: 'chat-image' }).map(i => i.id)).toEqual(['2'])
    expect(filterAssetLibraryItems(items, { tag: '主图' }).map(i => i.id)).toEqual(['1'])
    expect(filterAssetLibraryItems(items, { query: '不存在' })).toEqual([])
  })

  it('大小与来源文案稳定', () => {
    expect(formatAssetSize(0)).toBe('0 B')
    expect(formatAssetSize(900)).toBe('900 B')
    expect(formatAssetSize(2048)).toBe('2.0 KB')
    expect(formatAssetSize(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(assetSourceLabel('upload')).toBe('本地上传')
    expect(assetSourceLabel('chat-image')).toBe('AI 生成')
  })
})

describe('素材库接线', () => {
  it('数据库迁移建表并带索引', () => {
    expect(migrations).toContain("name: 'asset_library'")
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS asset_library_items')
    expect(migrations).toContain('idx_asset_library_updated')
  })

  it('IPC 通道、preload、env 三方一致', () => {
    for (const channel of ['ASSETS_LIST', 'ASSETS_ADD_DATA_URL', 'ASSETS_UPDATE', 'ASSETS_REMOVE', 'ASSETS_READ', 'ASSETS_REVEAL']) {
      expect(ipc).toContain(channel)
    }
    expect(preload).toContain('assets: {')
    expect(preload).toContain('addDataUrl:')
    expect(preload).toContain('IPC_CHANNELS.ASSETS_REMOVE')
    expect(env).toContain('assets: {')
    expect(env).toContain('addDataUrl:')
  })

  it('主进程先校验可信调用方，只按 id 操作并审计增删改', () => {
    expect(handlers).toContain('assertTrustedRenderer(event')
    expect(handlers).toContain("writeAudit('assets.add'")
    expect(handlers).toContain("writeAudit('assets.remove'")
    expect(service).toContain('asset_library_items')
    expect(service).toContain('nativeImage.createFromBuffer')
    expect(service).toContain('sha256')
    expect(service).not.toContain('input.path')
    expect(mainIndex).toContain('registerAssetLibraryHandlers()')
  })

  it('模块键、一次性上架与路由均已接好', () => {
    expect(modules).toContain("'ai-assets'")
    expect(modules).toContain('ui.apps.aiAssetsIntroduced')
    expect(modules).toContain('introduceAssetLibraryIfNeeded')
    expect(page).toContain('data-test="asset-library-file-input"')
    expect(page).toContain('data-test="asset-library-grid"')
    expect(page).toContain('data-test="asset-detail-use"')
  })
})

describe('素材库页面与对话生图互通', () => {
  it('页面具备导入、搜索、标签、详情编辑与删除钩子', () => {
    for (const hook of [
      'asset-library-page',
      'asset-library-import',
      'asset-library-file-input',
      'asset-library-search',
      'asset-library-source',
      'asset-library-tags',
      'asset-library-grid',
      'asset-library-detail',
      'asset-detail-name',
      'asset-detail-tags',
      'asset-detail-save',
      'asset-detail-reveal',
      'asset-detail-delete',
      'asset-detail-use'
    ]) {
      expect(page, `页面缺少 ${hook}`).toContain(`data-test="${hook}"`)
    }
    expect(page).toContain('ASSET_LIBRARY_LIMITS.maxBytes')
    expect(page).toContain('window.shopilot.assets.list()')
    expect(page).toContain('window.shopilot.assets.addDataUrl(')
    expect(page).toContain('window.shopilot.assets.read(')
  })

  it('「用于对话生图」经一次性交接进入参考图，不写持久状态', () => {
    expect(page).toContain('setPendingAssetReference')
    expect(bridge).toContain('takePendingAssetReference')
    expect(bridge).toContain('pendingAssetReference.value = null')
    expect(chatPage).toContain('takePendingAssetReference()')
    expect(chatPage).toContain('setReference(pending)')
  })

  it('对话生图结果可存入素材库，来源标记为 AI 生成', () => {
    expect(chatPage).toContain('chat-image-to-library-')
    expect(chatPage).toContain("source: 'chat-image'")
    expect(chatPage).toContain("tags: ['AI生成']")
  })
})
