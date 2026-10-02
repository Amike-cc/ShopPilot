/**
 * 图片本地化队列与保留策略的纯规则（方案 §5.9 收尾）
 *
 * 两块互相咬合的东西：
 *   · **队列**：把"哪些图还没本地化"扫出来、排好序、定好重试口径 —— 不用再一个商品一个商品手点；
 *   · **保留策略**：本地文件不会自己消失。商品删了、图换了，磁盘上的文件就成了孤儿。
 *     这里判定"哪些能删、哪些必须留"，但**只判定**——真正的删除由服务层做，且限定在
 *     应用自己的 `product-media` 目录内（见服务层的说明）。
 *
 * ⚠️ 一条纪律：**不可重试的失败不要反复重试**。
 * 比如"地址指向内网"（SSRF 拦截）或"内容是 SVG"——重试一百次结果都一样，
 * 只会拖慢队列、刷满日志，还会让人误以为"多试几次就好了"。
 */

/** 队列上限：一次最多处理多少张（避免一次点下去跑半小时没反馈）。 */
export const MEDIA_QUEUE_LIMITS = {
  maxItemsPerRun: 200,
  /** 单张失败后最多再试几次（可重试类） */
  maxRetries: 2,
  /** 退避基数（毫秒）：第 n 次重试等 base × 2^(n-1) */
  retryBackoffMs: 1500
} as const

/** 保留策略。 */
export const MEDIA_RETENTION = {
  /** 商品删除后，它的图片文件保留多久再清（给"误删了想找回"留个窗口） */
  keepAfterProductDeletedMs: 30 * 24 * 60 * 60 * 1000,
  /** 孤儿文件（不在 product_media 表里）至少存在多久才清（避免误删"刚写盘还没入库"的文件） */
  orphanGraceMs: 24 * 60 * 60 * 1000
} as const

/** 媒体行的本地化状态（与 `product_media.state` 对齐）。 */
export type MediaState = 'pending' | 'localized' | 'failed' | 'blocked' | 'missing'

export interface MediaQueueCandidate {
  productId: string
  /** `product_media.id` */
  mediaId: string
  role: 'cover' | 'gallery' | 'detail' | 'sku'
  state: MediaState
  remoteUrl: string | null
  /** 已经失败过几次（队列据此决定还试不试） */
  attempts: number
  sortOrder: number
}

export interface MediaQueueItem extends MediaQueueCandidate {
  /** 队列里的执行顺序 */
  queueIndex: number
  /** 这次要不要真的去下（不可重试的失败会标 false，并说明原因） */
  shouldAttempt: boolean
  reason: string | null
}

/**
 * 规划一次队列执行。
 *
 * 排序口径：**主图优先**（cover → sku → gallery → detail），同角色按 sortOrder。
 * 理由：主图决定"能不能发"（预检里没有主图是 blocker），先把 blocker 解掉最有价值。
 */
export function planMediaQueue(input: {
  candidates: readonly MediaQueueCandidate[]
  /** 这次最多处理多少张（默认 200） */
  maxItems?: number
  maxRetries?: number
}): { items: MediaQueueItem[]; skipped: number; summary: string } {
  const maxItems = Math.max(1, input.maxItems ?? MEDIA_QUEUE_LIMITS.maxItemsPerRun)
  const maxRetries = Math.max(0, input.maxRetries ?? MEDIA_QUEUE_LIMITS.maxRetries)
  const roleRank: Record<MediaQueueCandidate['role'], number> = { cover: 0, sku: 1, gallery: 2, detail: 3 }

  const sorted = [...input.candidates].sort((a, b) => {
    const byRole = roleRank[a.role] - roleRank[b.role]
    if (byRole !== 0) return byRole
    return a.sortOrder - b.sortOrder
  })

  const items: MediaQueueItem[] = []
  let skipped = 0
  for (const candidate of sorted) {
    // 已经本地化 / 文件缺失（missing 需要重新下）→ 不用再下
    if (candidate.state === 'localized') { skipped += 1; continue }
    if (!candidate.remoteUrl) {
      items.push({ ...candidate, queueIndex: items.length, shouldAttempt: false, reason: '没有图片地址（列表页/详情页都没取到），无从下载' })
      continue
    }
    // **不可重试**：SSRF 拦截、格式不支持 —— 重试多少次都一样
    if (candidate.state === 'blocked') {
      items.push({ ...candidate, queueIndex: items.length, shouldAttempt: false, reason: '上次被安全规则拒绝（私网地址/SVG 等），重试结果相同，已跳过' })
      continue
    }
    if (candidate.attempts > maxRetries) {
      items.push({ ...candidate, queueIndex: items.length, shouldAttempt: false, reason: `已失败 ${candidate.attempts} 次（上限 ${maxRetries} 次），不再自动重试` })
      continue
    }
    items.push({ ...candidate, queueIndex: items.length, shouldAttempt: true, reason: null })
  }

  const attempted = items.filter(item => item.shouldAttempt).length
  const capped = items.slice(0, maxItems)
  const overflow = items.length - capped.length
  return {
    items: capped,
    skipped: skipped + Math.max(0, overflow),
    summary: `队列：待处理 ${capped.length} 张（其中会真的下载 ${capped.filter(item => item.shouldAttempt).length} 张），跳过 ${skipped + Math.max(0, overflow)} 张`
      + (attempted > capped.length ? `；本次受上限 ${maxItems} 张限制，还有 ${attempted - capped.length} 张下次再跑` : '')
  }
}

/** 重试退避：第 n 次重试等多久（n 从 1 开始）。 */
export function retryDelayMs(attempt: number, base = MEDIA_RETRY_BASE()): number {
  const n = Math.max(1, Math.floor(attempt))
  return base * Math.pow(2, n - 1)
}

function MEDIA_RETRY_BASE(): number { return MEDIA_QUEUE_LIMITS.retryBackoffMs }

// ---------------------------------------------------------------- 保留策略

export interface LocalMediaFile {
  /** 相对 `product-media` 的路径（如 `ab/abcd….webp`） */
  relativePath: string
  bytes: number
  /** 文件修改时间 */
  modifiedAt: number
}

export interface OrphanDecision {
  relativePath: string
  bytes: number
  reason: string
}

/**
 * 判定哪些本地文件是**孤儿**（可以清）。
 *
 * 两条判据，都必须满足才判为可清：
 *   ① **不在 `product_media` 表里**（表里有 = 还有商品在用它）；
 *   ② **已存在超过 `orphanGraceMs`** —— 避免把"刚写盘、还没来得及入库"的文件当孤儿删掉
 *      （写盘与入库之间有窗口，队列并发跑的时候窗口更明显）。
 *
 * 另外：**已删除商品的图片文件也走孤儿判据**（软删商品时我不删 media 行，所以它们仍在表里 →
 * 会被判成"还在用"）。这是**有意的**：软删是审计材料，文件保留 30 天是给"误删了想找回"留窗口。
 * 真要清，由 `keepAfterProductDeletedMs` 那条单独的判据处理（见服务层）。
 */
export function decideOrphans(input: {
  files: readonly LocalMediaFile[]
  /** 表里还在引用的相对路径 */
  referencedPaths: ReadonlySet<string>
  now: number
  graceMs?: number
}): { orphans: OrphanDecision[]; keepCount: number; orphanBytes: number } {
  const grace = input.graceMs ?? MEDIA_RETENTION.orphanGraceMs
  const orphans: OrphanDecision[] = []
  let keepCount = 0
  for (const file of input.files) {
    if (input.referencedPaths.has(file.relativePath)) { keepCount += 1; continue }
    const age = input.now - file.modifiedAt
    if (age < grace) { keepCount += 1; continue }
    orphans.push({
      relativePath: file.relativePath,
      bytes: file.bytes,
      reason: `不在商品媒体表里，且已存在 ${Math.floor(age / 3600_000)} 小时（超过 ${Math.floor(grace / 3600_000)} 小时宽限期）`
    })
  }
  return {
    orphans,
    keepCount,
    orphanBytes: orphans.reduce((sum, item) => sum + item.bytes, 0)
  }
}

/**
 * 清理前的确认话术（方案要求"带将删除 N 个文件/共多少 MB 的确认"）。
 *
 * 单独一个函数是为了**同一句话在界面与日志里完全一致** —— 两处各写一遍必然分叉。
 */
export function orphanCleanupSummary(decision: { orphans: readonly OrphanDecision[]; orphanBytes: number }): string {
  if (!decision.orphans.length) return '没有可清理的孤儿文件（本地图片都在用）'
  const mb = (decision.orphanBytes / 1024 / 1024).toFixed(2)
  return `将删除 ${decision.orphans.length} 个文件、共 ${mb} MB（都不在任何商品上使用）`
}
