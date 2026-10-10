/**
 * 商品详情页采集（方案 §5.3 的补充路径；实测记录见 docs/product-profiles.md §10）
 *
 * 为什么需要单独一条：列表页每行只有一张缩略图，**微信实测是 SVG**（本地化会按 §5.9 如实拒绝），
 * 真正的商品图（WebP，实测 10 张）与 SKU（规格名「颜色」「尺码」）都在详情页。
 *
 * 地址**直接拼**（`detailUrlFor`，用实测登记的模板），不去点列表里的「编辑」——
 * 实测点它会让同一个 webview 的 CDP 会话失效，而带 `productId` 的地址就是编辑页。
 *
 * 只读语义：只导航到详情页并读 DOM，**不填写、不提交、不点任何按钮**。
 */

import type { WebContents } from 'electron'
import type { Store } from '@shared/schemas/store'
import { detailUrlFor, productProfileFor } from '@shared/constants/product'
import * as StoreManager from '../stores/store-manager'
import { openStoreBrowser, waitForStoreWebContents, setStoreLifecycleBlock } from '../browser/window-manager'
import { getDatabase } from '../db/database'
import { logMain } from '../services/logger'
import { readProductDetail } from '../platform-adapters/product-page-reader'
import { ProductRepository } from './product-repository'

export interface ProductDetailRuntime {
  getStore: (storeId: string) => Store | null
  waitForStoreWebContents: (storeId: string, timeoutMs?: number) => Promise<WebContents | null>
  openStorePage: (storeId: string) => void
  setStoreLifecycleBlock?: (storeId: string, reason: 'task' | 'confirmation' | 'upload' | 'external', active: boolean) => void
  repository: ProductRepository
}

function createDefaultRuntime(): ProductDetailRuntime {
  return {
    getStore: StoreManager.getStore,
    waitForStoreWebContents,
    openStorePage: storeId => openStoreBrowser(storeId, { display: false, source: 'main' }),
    setStoreLifecycleBlock,
    repository: new ProductRepository(getDatabase())
  }
}

export interface ProductDetailResult {
  status: 'SUCCEEDED' | 'FAILED' | 'PAGE_NOT_READY' | 'NOT_VERIFIED' | 'LINK_NOT_FOUND'
  reasonCode: string
  safeMessage: string
  imageCount: number
  skuCount: number
  specNames: string[]
  /** 详情页读到的其它字段（类目/短标题/品牌…），只用于界面展示 */
  fields: Array<{ label: string; value: string }>
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { const handle = setTimeout(resolve, ms); if (typeof handle.unref === 'function') handle.unref() })
}

/**
 * 导航到详情页并**等真正到位**。
 *
 * 为什么不用 `navigateTo`：它把 `loadURL` 的 reject 当成失败，而实测（2026-09-30）
 * 微信详情页会返回 `ERR_FAILED`，**页面却照样正常打开** ——
 * 应用自己的 `browser.navigateTab` 正是 `loadURL(...).catch(() => {})` 之后另外等结果。
 * 所以这里采用同样的口径：**不看 reject，看最终 URL 到底有没有变成详情页**。
 * （不去改共享的 `navigateTo`，那会牵动经营采集那条已经稳定的链路。）
 */
async function navigateToDetail(wc: WebContents, url: string, timeoutMs = 30_000): Promise<{ ok: boolean; reason: string | null }> {
  let target: URL
  try { target = new URL(url) } catch { return { ok: false, reason: 'ERR_INVALID_URL' } }
  try {
    await wc.loadURL(url)
  } catch { /* reject 不代表失败，由下面的 URL 轮询判定 */ }

  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (wc.isDestroyed()) return { ok: false, reason: 'PAGE_DESTROYED' }
    let current = ''
    try { current = wc.getURL() } catch { return { ok: false, reason: 'PAGE_DESTROYED' } }
    // 只比 origin + pathname：平台的 SPA 会在 query 上做文章，但那不影响"到了详情页"这个判断
    try {
      const parsed = new URL(current)
      if (parsed.origin === target.origin && parsed.pathname === target.pathname) return { ok: true, reason: null }
    } catch { /* 还在 about:blank 之类 */ }
    if (Date.now() >= deadline) return { ok: false, reason: `URL_NOT_REACHED(${current.slice(0, 90)})` }
    await delay(500)
  }
}

export class ProductDetailService {
  private readonly runtimeFactory: () => ProductDetailRuntime

  constructor(runtime?: ProductDetailRuntime) {
    this.runtimeFactory = runtime ? () => runtime : createDefaultRuntime
  }

  /**
   * 采一个平台商品的详情：商品图 + 规格名。
   *
   * SKU 的**价格与库存**详情页也能读到（规格表格），但微信实测那部分是懒渲染的，
   * 本轮先把"平台有哪些规格名"读准并写进 `product_sku_links` 的规格描述里；
   * 逐 SKU 的价格库存等规格表格渲染稳定后再补（**不猜**）。
   */
  async collect(input: { storeId: string; platformProductId: string }): Promise<ProductDetailResult> {
    const runtime = this.runtimeFactory()
    const store = runtime.getStore(input.storeId)
    if (!store) {
      return { status: 'FAILED', reasonCode: 'STORE_NOT_FOUND', safeMessage: '店铺不存在或已删除', imageCount: 0, skuCount: 0, specNames: [], fields: [] }
    }
    const profile = productProfileFor(store.platform)
    const url = detailUrlFor(store.platform, input.platformProductId)
    if (!profile || !url) {
      return {
        status: 'NOT_VERIFIED', reasonCode: 'DETAIL_NOT_VERIFIED',
        safeMessage: `${store.platform}尚未实测到商品详情页地址，暂不能拉取详情（不猜 URL 结构）`,
        imageCount: 0, skuCount: 0, specNames: [], fields: []
      }
    }

    const link = runtime.repository.linkByPlatformProduct({
      platform: store.platform, storeId: input.storeId, platformProductId: input.platformProductId
    })
    if (!link) {
      return { status: 'LINK_NOT_FOUND', reasonCode: 'LINK_NOT_FOUND', safeMessage: '本地没有这条平台商品记录，请先同步一次', imageCount: 0, skuCount: 0, specNames: [], fields: [] }
    }

    // 详情采集可能包含导航和懒加载轮询；明确登记生命周期门禁，
    // 防止用户切到另一家店后 60 秒冷休眠关闭正在读取的 guest。
    runtime.setStoreLifecycleBlock?.(input.storeId, 'external', true)
    try {
    // 先看店铺页是不是已经在：**已经在就不要重开**。
    // 实测（2026-09-30）：无条件 `openStorePage` 会重建视图，随后拿到的 webContents 已失效，
    // 表现为 loadURL 抛错 → NAVIGATION_FAILED（而"店铺已经开着"的场景本来不需要重开）。
    let wc = await runtime.waitForStoreWebContents(input.storeId, 5_000).catch(() => null)
    if (!wc || wc.isDestroyed()) {
      runtime.openStorePage(input.storeId)
      wc = await runtime.waitForStoreWebContents(input.storeId, 30_000)
    }
    if (!wc || wc.isDestroyed()) {
      return { status: 'PAGE_NOT_READY', reasonCode: 'PAGE_NOT_READY', safeMessage: '店铺页面不可用，请先打开该店铺', imageCount: 0, skuCount: 0, specNames: [], fields: [] }
    }

    // 导航重试一次：实测页面正在加载时导航会被打断 —— 属于瞬态，不该让用户看到"失败"就结束。
    let nav = await navigateToDetail(wc, url, 30_000)
    if (!nav.ok) {
      logMain('warn', `[product-detail] 导航未到位 reason=${nav.reason}，2 秒后重试一次 platform=${store.platform} id=${input.platformProductId}`)
      await delay(2000)
      if (!wc.isDestroyed()) nav = await navigateToDetail(wc, url, 30_000)
    }
    if (!nav.ok) {
      logMain('warn', `[product-detail] 导航最终失败 reason=${nav.reason} platform=${store.platform} id=${input.platformProductId}`)
      return {
        status: 'FAILED', reasonCode: 'NAVIGATION_FAILED',
        safeMessage: `打开商品详情页失败（已重试一次：${nav.reason ?? 'UNKNOWN'}），请确认该店铺已登录、页面能正常打开`,
        imageCount: 0, skuCount: 0, specNames: [], fields: []
      }
    }

    // 详情页是懒渲染的（实测：刚打开时图集还没出来）→ 轮询到读出内容为止
    let detail = await readProductDetail(wc, profile)
    for (let attempt = 0; attempt < 24 && detail.imageUrls.length === 0; attempt++) {
      await delay(2000)
      detail = await readProductDetail(wc, profile)
    }
    if (detail.imageUrls.length === 0 && detail.specNames.length === 0) {
      logMain('warn', `[product-detail] 详情页没读到图集与规格 platform=${store.platform} id=${input.platformProductId}`)
      return {
        status: 'FAILED', reasonCode: 'DETAIL_EMPTY',
        safeMessage: '详情页没读到商品图与规格（可能页面还没渲染完，或平台已改版）——本次未改动本地数据',
        imageCount: 0, skuCount: 0, specNames: [], fields: []
      }
    }

    const linkId = String(link.id)
    // 图集：替换列表页那张 SVG 缩略图（**详情页才是能本地化的真图**）
    if (detail.imageUrls.length > 0) {
      runtime.repository.updateLinkImages({ linkId, imageUrls: detail.imageUrls })
    }

    // SKU 映射：只有**配对可靠**（规格值与价格行数量一致、按 DOM 顺序一一对应）时才写。
    //
    // `platform_sku_id` 用什么：优先**规格编码**（平台上的 `输入规格编码`，用户选填）；
    // 为空时用**规格组合**（如 `尺码=可旋转【六重过滤】`）作为稳定键。
    // 为什么这样不算编造：微信小店不把内部 SKU ID 暴露在 DOM 里，而"规格组合"是**实测可读、
    // 且能唯一标识那一行 SKU** 的信息（同一商品里规格值组合不重复）。
    // 关键是它**稳定且可追溯**——不是 `spec:0:品牌` 那种按序号现编的假 ID（那会让下游拿它去比对）。
    const skus = detail.skus.map(sku => ({
      platformSkuId: sku.skuCode || sku.spec.map(part => `${part.name}=${part.value}`).join('|'),
      spec: sku.spec,
      priceMinor: sku.priceMinor,
      stock: sku.stock
    }))
    const written = skus.length ? runtime.repository.replaceLinkSkus({ linkId, skus }) : { inserted: 0, missing: 0 }

    const specSummary = detail.specNames.join('、') || '无'
    const skuSummary = skus.length
      ? `规格值/价格 ${skus.length} 行已建映射`
      : (detail.pairingNote || '没有读到逐 SKU 数据')
    logMain('info', `[product-detail] 采集完成 platform=${store.platform} id=${input.platformProductId} 图=${detail.imageUrls.length} 规格名=${detail.specNames.length} SKU=${written.inserted}`)
    return {
      status: 'SUCCEEDED',
      reasonCode: 'OK',
      safeMessage: `已拉取详情：商品图 ${detail.imageUrls.length} 张、规格名 ${detail.specNames.length} 个（${specSummary}）；${skuSummary}`,
      imageCount: detail.imageUrls.length,
      skuCount: written.inserted,
      specNames: detail.specNames,
      fields: detail.fields
    }
    } finally {
      runtime.setStoreLifecycleBlock?.(input.storeId, 'external', false)
    }
  }
}

export const productDetailService = new ProductDetailService()
