import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ASSET_LIBRARY_LIMITS,
  assetLikePattern,
  assetSourceLabel,
  diffAssetFiles,
  formatAssetSize,
  isAssetFileName,
  normalizeAssetListInput,
  normalizeAssetName,
  normalizeAssetTags
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

  it('列表查询入参被夹到合法范围（IPC 传负数/NaN/超大值都打不穿）', () => {
    const fallback = normalizeAssetListInput(undefined)
    expect(fallback).toEqual({ query: '', source: 'all', tag: '', offset: 0, limit: ASSET_LIBRARY_LIMITS.pageSize })

    expect(normalizeAssetListInput({ offset: -5, limit: -1 })).toMatchObject({ offset: 0, limit: ASSET_LIBRARY_LIMITS.pageSize })
    expect(normalizeAssetListInput({ offset: Number.NaN, limit: Number.NaN })).toMatchObject({ offset: 0, limit: ASSET_LIBRARY_LIMITS.pageSize })
    expect(normalizeAssetListInput({ limit: 9999 }).limit).toBe(ASSET_LIBRARY_LIMITS.maxPageSize)
    expect(normalizeAssetListInput({ offset: 120.7 }).offset).toBe(120)
    // IPC 传别的来源值：一律退化成 all，不把未校验的字符串拼进 SQL
    const bogusSource = { source: 'weird' } as unknown as Parameters<typeof normalizeAssetListInput>[0]
    expect(normalizeAssetListInput(bogusSource).source).toBe('all')
    expect(normalizeAssetListInput({ query: '  童装\n主图  ' }).query).toBe('童装 主图')
  })

  it('关键词/LIKE 模式转义通配符，标签用精确匹配避免「主图」命中「主图2」', () => {
    expect(assetLikePattern('童装')).toBe('%童装%')
    expect(assetLikePattern('100%_a\\b')).toBe('%100\\%\\_a\\\\b%')
    expect(assetLikePattern('主图', true)).toBe('%"主图"%')
  })

  it('对账只认受管文件名，区分孤儿与缺失', () => {
    const a = 'ast_0123456789abcdef0123.png'
    const b = 'ast_fedcba9876543210fedc.jpg'
    expect(isAssetFileName(a)).toBe(true)
    expect(isAssetFileName('ast_short.png')).toBe(false)
    expect(isAssetFileName('用户自己放的.png')).toBe(false)
    expect(diffAssetFiles([a], [a, b, 'random.txt'])).toEqual({ orphans: [b], missing: [] })
    expect(diffAssetFiles([a, b], [a])).toEqual({ orphans: [], missing: [b] })
  })

  it('单页条数与容量上限是显式常量（不再一次拉全库）', () => {
    expect(ASSET_LIBRARY_LIMITS.pageSize).toBeLessThanOrEqual(ASSET_LIBRARY_LIMITS.maxPageSize)
    expect(ASSET_LIBRARY_LIMITS.maxTotalBytes).toBe(2 * 1024 * 1024 * 1024)
    expect(ASSET_LIBRARY_LIMITS.maxItems).toBe(2000)
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

  it('列表分页 + 服务端筛选 + 容量上限 + 启动对账都已接好', () => {
    // 分页：LIMIT/OFFSET 进 SQL，筛选（名称/标签/来源）也在 SQL 里做
    expect(service).toContain('LIMIT ? OFFSET ?')
    expect(service).toContain('normalizeAssetListInput')
    expect(service).toContain('assetLikePattern')
    // 容量软上限：条数与总字节，超限明确报错
    expect(service).toContain('ASSET_LIBRARY_LIMITS.maxItems')
    expect(service).toContain('ASSET_LIBRARY_LIMITS.maxTotalBytes')
    expect(service).toContain("'ASSET_LIBRARY_FULL'")
    // 对账：只删受管命名的孤儿文件，且在启动后异步执行
    expect(service).toContain('export function reconcileAssetLibrary')
    expect(service).toContain('diffAssetFiles')
    expect(mainIndex).toContain('reconcileAssetLibrary()')
    // 页面不再本地过滤，改用主进程分页 + 加载更多
    expect(page).toContain('loadMore')
    expect(page).toContain('data-test="asset-library-more"')
    expect(page).toContain('ASSET_LIBRARY_LIMITS.pageSize')
    expect(page).not.toContain('filterAssetLibraryItems')
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
    expect(page).toContain('window.shopilot.assets.list({')
    expect(page).toContain('window.shopilot.assets.addDataUrl(')
    expect(page).toContain('window.shopilot.assets.read(')
  })

  it('「用于对话生图」经一次性交接进入参考图，不写持久状态', () => {
    expect(page).toContain('setPendingAssetReference')
    expect(page).toContain('超过 5MB')
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
