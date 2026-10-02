/**
 * 本地商品草稿的纯规则（方案 §6.2 校验 + §7.5 草稿指纹）
 *
 * 主进程与渲染层共用同一份判定：界面在编辑抽屉里实时显示，服务在保存/发布前再跑一遍
 * （两处各写一套必然分叉 —— 与 `custom-task` 的 issues 模式同一个理由）。
 *
 * 分级口径：
 *   · `blocker` 发不出去（标题为空、没有主图、没有可售规格、价格 ≤ 0）；
 *   · `warning` 能发但会降级或可能被平台拦（标题超出该平台上限）；
 *   · `info`    只是提示（与平台当前价不一致之类）。
 *
 * **只写有实测支撑的平台规则**：例如"微信标题上限 60 字"来自发布页 label 实测 `0/60`
 * （docs/product-profiles.md §1.2）；没实测过的平台一律不给上限，不猜。
 */

import { productDraftHash } from './product-rules'
import type { ProductFieldKey } from './contracts/platform-product'

export interface ProductDraftVariant {
  spec: Array<{ name: string; value: string }>
  priceMinor: number | null
  stock: number | null
  skuCode?: string | null
}

export interface ProductDraftMedia {
  role: 'cover' | 'gallery' | 'detail' | 'sku'
  /** 本地化状态（'localized' 才算真的在本地） */
  state?: 'pending' | 'localized' | 'failed' | 'blocked' | 'missing'
  remoteUrl?: string | null
}

export interface LocalProductDraft {
  title: string
  subtitle?: string | null
  description?: string | null
  brand?: string | null
  localCategory?: string | null
  tags?: string[]
  variants: ProductDraftVariant[]
  media: ProductDraftMedia[]
}

export interface ProductDraftIssue {
  level: 'blocker' | 'warning' | 'info'
  field: ProductFieldKey | 'variants' | 'media'
  message: string
  /** 怎么改（界面直接显示给用户） */
  fixHint?: string
}

/** 各平台**已实测**的字段上限；没实测的平台不给上限（不猜）。 */
export const PLATFORM_TITLE_LIMITS: Record<string, number> = {
  // 微信小店发布页实测：商品名称输入框 label 显示 `0/60`
  微信小店: 60
}

export interface ProductDraftTarget {
  platform?: string
  /** 平台当前价（用于 info 级提示：本地改了价、平台还是老价） */
  platformPriceMinor?: number | null
}

/**
 * 本地商品草稿的分级校验。
 *
 * 顺序稳定（blocker → warning → info），界面按顺序显示，用户从第一条开始改就行。
 */
export function productDraftIssues(draft: LocalProductDraft, target: ProductDraftTarget = {}): ProductDraftIssue[] {
  const issues: ProductDraftIssue[] = []
  const title = String(draft.title ?? '').trim()

  if (!title) {
    issues.push({ level: 'blocker', field: 'title', message: '商品标题为空', fixHint: '填一个标题再保存' })
  } else {
    const limit = target.platform ? PLATFORM_TITLE_LIMITS[target.platform] : undefined
    if (limit && title.length > limit) {
      issues.push({
        level: 'warning',
        field: 'title',
        message: `标题 ${title.length} 字，超出${target.platform}的 ${limit} 字上限`,
        fixHint: `删到 ${limit} 字以内，否则平台会截断`
      })
    }
  }

  // 主图：没有任何 cover 就是 blocker（所有平台都要求主图）
  const covers = draft.media.filter(item => item.role === 'cover')
  if (covers.length === 0) {
    issues.push({ level: 'blocker', field: 'media', message: '没有主图', fixHint: '至少设一张主图' })
  }

  // 图片未本地化：不是 blocker（还能发），但要说清"本地其实没有这张图"
  const notLocal = draft.media.filter(item => item.role !== 'detail' && item.state && item.state !== 'localized')
  if (notLocal.length > 0) {
    issues.push({
      level: 'warning',
      field: 'media',
      message: `有 ${notLocal.length} 张图片还没本地化`,
      fixHint: '未本地化的图依赖平台链接，平台改版或防盗链后可能失效'
    })
  }

  const variants = Array.isArray(draft.variants) ? draft.variants : []
  if (variants.length === 0) {
    issues.push({ level: 'blocker', field: 'variants', message: '没有可售规格（SKU）', fixHint: '至少加一个规格组合' })
  }
  for (const [index, variant] of variants.entries()) {
    const name = variant.spec.map(part => `${part.name}${part.value}`).join('/') || `第 ${index + 1} 个规格`
    if (variant.priceMinor == null) {
      issues.push({ level: 'blocker', field: 'price', message: `${name} 没有价格`, fixHint: '补价格（分为单位存储）' })
    } else if (variant.priceMinor <= 0) {
      issues.push({ level: 'blocker', field: 'price', message: `${name} 价格必须大于 0`, fixHint: '改成大于 0 的价格' })
    }
    if (variant.stock != null && variant.stock < 0) {
      issues.push({ level: 'blocker', field: 'stock', message: `${name} 库存为负数`, fixHint: '改成 0 或正整数' })
    }
  }

  // info：本地价与平台当前价不一致（只提示，不改）
  if (target.platformPriceMinor != null && variants.length > 0) {
    const localMin = variants.reduce<number | null>((min, item) => {
      if (item.priceMinor == null) return min
      return min == null ? item.priceMinor : Math.min(min, item.priceMinor)
    }, null)
    if (localMin != null && localMin !== target.platformPriceMinor) {
      issues.push({
        level: 'info',
        field: 'price',
        message: `本地最低价 ${(localMin / 100).toFixed(2)} 与平台当前价 ${(target.platformPriceMinor / 100).toFixed(2)} 不一致`,
        fixHint: '发布时会按本地价填写'
      })
    }
  }

  return issues
}

/** 有没有阻断项（保存/发布前的门禁）。 */
export function hasBlockingIssue(issues: readonly ProductDraftIssue[]): boolean {
  return issues.some(issue => issue.level === 'blocker')
}

/**
 * 本地商品的草稿指纹。
 *
 * 只放"会影响发布结果"的字段：标题/副标题/描述/品牌/规格组合与价格库存/图片顺序与来源。
 * 图片用 `remoteUrl` 或本地化状态参与指纹 —— 同一张图从"未本地化"变成"已本地化"不算内容变化，
 * 所以**只用 remoteUrl 的稳定标识**（没有 remoteUrl 时退回 role+序号）。
 *
 * 用途：判断"自上次发布后改没改"（没改就不让重发），也是发布幂等键的组成部分。
 */
export function localProductDraftHash(draft: LocalProductDraft): string {
  return productDraftHash({
    title: String(draft.title ?? '').trim(),
    subtitle: draft.subtitle ?? null,
    description: draft.description ?? null,
    brand: draft.brand ?? null,
    localCategory: draft.localCategory ?? null,
    tags: [...(draft.tags ?? [])].sort(),
    variants: (draft.variants ?? []).map(variant => ({
      spec: variant.spec.map(part => `${part.name}=${part.value}`).sort(),
      priceMinor: variant.priceMinor ?? null,
      stock: variant.stock ?? null,
      skuCode: variant.skuCode ?? null
    })),
    media: (draft.media ?? []).map((item, index) => ({ role: item.role, key: item.remoteUrl || `#${index}` }))
  })
}

/** 把平台商品映射成一份"本地商品草稿"（归并/另存为时的初值）。 */
export function draftFromPlatformProduct(input: {
  title: string
  subtitle?: string | null
  priceMinor: number | null
  stock: number | null
  imageUrls?: string[]
  skus?: Array<{ spec: Array<{ name: string; value: string }>; priceMinor: number | null; stock: number | null; imageUrl?: string | null }>
}): LocalProductDraft {
  const imageUrls = input.imageUrls ?? []
  const skus = input.skus ?? []
  const variants: ProductDraftVariant[] = skus.length
    ? skus.map(sku => ({ spec: sku.spec, priceMinor: sku.priceMinor, stock: sku.stock }))
    // 列表页拿不到 SKU（实测四平台都是"要进详情页才有"）→ 用商品级价格库存建一个单规格，
    // 并在界面上说明"这是列表页的单规格占位，需要补规格"
    : [{ spec: [], priceMinor: input.priceMinor, stock: input.stock }]

  return {
    title: input.title,
    subtitle: input.subtitle ?? null,
    description: null,
    brand: null,
    localCategory: null,
    tags: [],
    variants,
    media: imageUrls.map((url, index) => ({ role: index === 0 ? 'cover' : 'gallery', remoteUrl: url, state: 'pending' }))
  }
}
