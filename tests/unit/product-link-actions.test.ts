/**
 * 「解除归并」纯逻辑的回归测试。
 *
 * 背景：主进程 `products:library:unmerge` 一直可用、`products.list` 每行也带 `linkId`/`productId`，
 * 但渲染层从来没有入口——「归并能挂不能摘」。判定与文案抽成纯模块后在这里逐条钉住：
 * 三态判定错一格，界面上就会出现"对未归并的行也能摘"的假入口，或者真正该摘的行没有按钮。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  UNMERGE_FALLBACK_TEXT,
  canUnmerge,
  productLinkMergeState,
  unmergeConfirmText,
  unmergeErrorText,
  type ProductLinkRowLike
} from '../../apps/desktop/src/renderer/src/features/products/product-link-actions'

const MODULE_PATH = 'apps/desktop/src/renderer/src/features/products/product-link-actions.ts'
const PAGE_PATH = 'apps/desktop/src/renderer/src/features/products/ProductManagementPage.vue'

/** 已归并的一行：`products.list` 返回的 ProductLinkRow 结构子集 */
const MERGED: ProductLinkRowLike = {
  linkId: 'link_1',
  platformProductId: 'pdd_1001',
  platformTitle: '夏季纯棉短袖',
  productId: 'prod_1',
  productTitle: '短袖T恤（本地）'
}

describe('product-link-actions：模块边界', () => {
  it('纯模块，不 import vue / electron / DOM（保持可单测）', () => {
    const source = readFileSync(resolve(MODULE_PATH), 'utf8')
    expect(source).not.toMatch(/from\s+['"]vue['"]/)
    expect(source).not.toMatch(/from\s+['"]electron['"]/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
  })
})

describe('productLinkMergeState：三态判定', () => {
  it('productId 有值 → merged', () => {
    expect(productLinkMergeState(MERGED)).toBe('merged')
  })

  it('productId 为空但有 linkId → orphan（平台上发现、本地还没归属）', () => {
    expect(productLinkMergeState({ ...MERGED, productId: null, productTitle: null })).toBe('orphan')
    expect(productLinkMergeState({ linkId: 'link_2', productId: undefined })).toBe('orphan')
  })

  it('缺 linkId（null / undefined / 空串 / 纯空白）→ invalid', () => {
    expect(productLinkMergeState({ ...MERGED, linkId: null })).toBe('invalid')
    expect(productLinkMergeState({ ...MERGED, linkId: undefined })).toBe('invalid')
    expect(productLinkMergeState({ ...MERGED, linkId: '' })).toBe('invalid')
    expect(productLinkMergeState({ ...MERGED, linkId: '   ' })).toBe('invalid')
    expect(productLinkMergeState({ linkId: '\t\n' })).toBe('invalid')
  })

  it('linkId 前后空白会被裁掉（不算合法 id 之外的语义）', () => {
    expect(productLinkMergeState({ ...MERGED, linkId: '  link_3  ' })).toBe('merged')
  })

  it('productId 是纯空白 → 视作未归并', () => {
    expect(productLinkMergeState({ ...MERGED, productId: '   ' })).toBe('orphan')
  })

  it('null / undefined / 非对象入参不抛异常，一律 invalid', () => {
    expect(productLinkMergeState(null)).toBe('invalid')
    expect(productLinkMergeState(undefined)).toBe('invalid')
    expect(productLinkMergeState('link_1' as unknown as ProductLinkRowLike)).toBe('invalid')
    expect(productLinkMergeState(42 as unknown as ProductLinkRowLike)).toBe('invalid')
  })

  it('字段是错误类型（数字 / 对象）时按"没有"处理，不把 0 或 {} 当 id', () => {
    expect(productLinkMergeState({ linkId: 0 as unknown as string, productId: 'prod_1' })).toBe('invalid')
    expect(productLinkMergeState({ linkId: 'link_1', productId: 0 as unknown as string })).toBe('orphan')
    expect(productLinkMergeState({ linkId: {} as unknown as string })).toBe('invalid')
  })
})

describe('canUnmerge：只有已归并且 linkId 合法才放行', () => {
  it('merged 放行', () => {
    expect(canUnmerge(MERGED)).toBe(true)
  })

  it('orphan 不放行（没有可摘的归并）', () => {
    expect(canUnmerge({ ...MERGED, productId: null, productTitle: null })).toBe(false)
  })

  it('invalid 不放行（拿不到要摘的那条记录）', () => {
    expect(canUnmerge({ ...MERGED, linkId: '' })).toBe(false)
    expect(canUnmerge({ ...MERGED, linkId: null })).toBe(false)
  })

  it('null / undefined 不放行', () => {
    expect(canUnmerge(null)).toBe(false)
    expect(canUnmerge(undefined)).toBe(false)
  })
})

describe('unmergeConfirmText：文案如实', () => {
  it('标题齐全时逐字措辞（含换行与"台账不动"的承诺）', () => {
    expect(unmergeConfirmText(MERGED)).toBe(
      '解除「夏季纯棉短袖」与本地商品「短袖T恤（本地）」的归并？\n' +
      '解除后这条平台商品会回到「未归并」，本地商品与发布台账不受影响。'
    )
  })

  it('平台标题缺失 → 退回平台商品 ID；本地标题缺失 → 退回本地商品 ID', () => {
    expect(unmergeConfirmText({ ...MERGED, platformTitle: null, productTitle: null })).toBe(
      '解除「pdd_1001」与本地商品「prod_1」的归并？\n' +
      '解除后这条平台商品会回到「未归并」，本地商品与发布台账不受影响。'
    )
  })

  it('纯空白的标题视作缺失（不会出现「」空引号）', () => {
    const text = unmergeConfirmText({ ...MERGED, platformTitle: '   ', productTitle: '' })
    expect(text).toContain('解除「pdd_1001」与本地商品「prod_1」的归并？')
    expect(text).not.toContain('「」')
  })

  it('连 id 都缺失（invalid 行）也能给出可读文案，不出现 undefined', () => {
    const text = unmergeConfirmText({ linkId: 'link_9' })
    expect(text).toContain('解除「该平台商品」的归并？')
    expect(text).not.toContain('undefined')
    expect(text).toContain('本地商品与发布台账不受影响')
  })

  it('null 入参不抛异常', () => {
    const text = unmergeConfirmText(null)
    expect(text).toContain('解除「该平台商品」的归并？')
    expect(text).not.toContain('null')
  })
})

describe('unmergeErrorText：错误兜底不外泄英文栈', () => {
  it('null / undefined / 空串 → 兜底中文', () => {
    expect(unmergeErrorText(null)).toBe(UNMERGE_FALLBACK_TEXT)
    expect(unmergeErrorText(undefined)).toBe(UNMERGE_FALLBACK_TEXT)
    expect(unmergeErrorText('')).toBe(UNMERGE_FALLBACK_TEXT)
    expect(unmergeErrorText('   ')).toBe(UNMERGE_FALLBACK_TEXT)
  })

  it('英文错误码 / 英文异常串不外泄', () => {
    expect(unmergeErrorText('PRODUCT_NOT_FOUND')).toBe(UNMERGE_FALLBACK_TEXT)
    expect(unmergeErrorText('Error: UNIQUE constraint failed: product_platform_links')).toBe(UNMERGE_FALLBACK_TEXT)
    expect(unmergeErrorText(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'))).toBe(UNMERGE_FALLBACK_TEXT)
  })

  it('多行英文栈（含 at fn (path:line:col)）不外泄', () => {
    const stack = 'Error: boom\n    at unmergeLink (D:\\app\\product-repository.ts:785:12)'
    expect(unmergeErrorText(stack)).toBe(UNMERGE_FALLBACK_TEXT)
    expect(unmergeErrorText(new Error(stack))).toBe(UNMERGE_FALLBACK_TEXT)
  })

  it('过长的中文说明也当内部细节处理（不整段甩给用户）', () => {
    expect(unmergeErrorText('异'.repeat(200))).toBe(UNMERGE_FALLBACK_TEXT)
  })

  it('主进程给的中文短句如实转达（IPC 失败信封 error 对象）', () => {
    expect(unmergeErrorText({ code: 'INTERNAL_ERROR', message: '应用已锁定' })).toBe('应用已锁定')
    expect(unmergeErrorText({ code: 'SOMETHING', message: '这条平台商品已经被别的本地商品占用' }))
      .toBe('这条平台商品已经被别的本地商品占用')
  })

  it('已知错误码在无中文文案时给对应说明', () => {
    expect(unmergeErrorText({ code: 'APP_LOCKED', message: '' })).toBe('应用已锁定，请先解锁后再解除归并。')
    expect(unmergeErrorText({ code: 'INVALID_ARGUMENT', message: 'INVALID_ARGUMENT' }))
      .toBe('这条平台商品记录不完整，请刷新列表后重试。')
    expect(unmergeErrorText({ code: 'STORE_NOT_FOUND' })).toBe('店铺不存在或已删除，请刷新列表后重试。')
    expect(unmergeErrorText({ code: 'INTERNAL_ERROR' })).toBe(UNMERGE_FALLBACK_TEXT)
  })

  it('未知错误码 + 英文文案 → 兜底中文', () => {
    expect(unmergeErrorText({ code: 'WEIRD_CODE', message: 'ENOENT: no such file' })).toBe(UNMERGE_FALLBACK_TEXT)
    expect(unmergeErrorText({})).toBe(UNMERGE_FALLBACK_TEXT)
  })

  it('任何入参都不抛异常', () => {
    expect(() => unmergeErrorText(Symbol('x') as unknown)).not.toThrow()
    expect(unmergeErrorText(0)).toBe(UNMERGE_FALLBACK_TEXT)
    expect(unmergeErrorText(false)).toBe(UNMERGE_FALLBACK_TEXT)
  })
})

describe('ProductManagementPage：入口确实接上了（防"归并能挂不能摘"回归）', () => {
  const source = readFileSync(resolve(PAGE_PATH), 'utf8')

  it('渲染「解除归并」按钮（data-test 锚点）并复用本模块判定', () => {
    expect(source).toContain('data-test="platform-unmerge"')
    expect(source).toMatch(/canUnmerge/)
    expect(source).toContain("from './product-link-actions'")
  })

  it('确认后调用主进程 unmerge（带 linkId），成功后重拉当前页', () => {
    expect(source).toMatch(/products\.library\.unmerge\(\{\s*linkId\s*\}\)/)
    expect(source).toMatch(/window\.shopilot\.products\.library\.unmerge/)
    expect(source).toMatch(/await loadLinks\(\)/)
  })

  it('用的是页面内浮层而不是 window.confirm（window.confirm 会阻塞渲染进程、卡 CDP）', () => {
    expect(source).toContain('data-test="unmerge-confirm"')
    // confirmUnmerge 的函数体内不得出现 window.confirm
    const start = source.indexOf('async function confirmUnmerge')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\nonMounted(', start))
    expect(body).not.toContain('window.confirm')
  })

  it('失败用 unmergeErrorText 提示，成功提示「已解除归并」', () => {
    expect(source).toContain('unmergeErrorText(result.error)')
    expect(source).toContain("ws.toast('已解除归并', 'success')")
  })
})
