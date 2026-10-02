/**
 * 批量发布编排的纯规则（方案 §7.8）
 *
 * 三条不可动摇的约定，全部来自方案原文：
 *   ① **一次只打开一个店铺**（避免多店同时开页面与内存压力）；
 *   ② 进度必须显示**"已完成 / 待人工 / 失败"三个数**，不是一个百分比
 *      —— 百分比会把"卡在等人"伪装成"快做完了"；
 *   ③ 中止后未开始的 item 保持 `pending`，**可续跑**，已完成的店不受影响。
 *
 * 还有一条本模块刻意**不做**的事：**不做整体回滚**（平台侧无法可靠回滚，方案 §7.7 最后一行）。
 */

/** 单次批量的硬上限（方案 §7.8）。 */
export const BATCH_LIMITS = { maxStores: 20, maxProducts: 20, maxItems: 400 } as const

/** 一个批量项的初始状态。 */
export type BatchItemState = 'pending' | 'running' | 'awaiting_human' | 'confirmed' | 'needs_review' | 'failed' | 'skipped' | 'discarded'

export interface BatchPlanInput {
  productIds: readonly string[]
  storeIds: readonly string[]
}

export interface BatchPlanItem {
  productId: string
  storeId: string
  /** 编排顺序：按店铺分组（同一家店连着做完再换下一家） */
  order: number
  state: BatchItemState
}

export interface BatchPlan {
  ok: boolean
  /** 计划被拒绝的原因（超上限时逐条说清是哪个上限） */
  errors: string[]
  items: BatchPlanItem[]
  /** 按编排顺序排好的店铺序列（一次只开一家） */
  storeOrder: string[]
  totals: { products: number; stores: number; items: number }
}

/**
 * 生成批量计划。
 *
 * **顺序 = 按店铺分组**：这样"一次只打开一个店铺"就只是"按 storeOrder 往前走"，
 * 编排逻辑不需要额外的调度器。
 */
export function planBatch(input: BatchPlanInput): BatchPlan {
  const errors: string[] = []
  const productIds = Array.from(new Set(input.productIds.filter(Boolean)))
  const storeIds = Array.from(new Set(input.storeIds.filter(Boolean)))

  if (!productIds.length) errors.push('没有选要发布的商品')
  if (!storeIds.length) errors.push('没有选要发布到哪些店铺')
  if (storeIds.length > BATCH_LIMITS.maxStores) {
    errors.push(`一次最多 ${BATCH_LIMITS.maxStores} 家店铺，当前选了 ${storeIds.length} 家`)
  }
  if (productIds.length > BATCH_LIMITS.maxProducts) {
    errors.push(`一次最多 ${BATCH_LIMITS.maxProducts} 个商品，当前选了 ${productIds.length} 个`)
  }
  const items = productIds.length * storeIds.length
  if (items > BATCH_LIMITS.maxItems) {
    errors.push(`一次最多 ${BATCH_LIMITS.maxItems} 个发布项（${BATCH_LIMITS.maxStores} 店 × ${BATCH_LIMITS.maxProducts} 商品），当前是 ${items} 个`)
  }

  // 编排：外层店铺、内层商品 → 同一家店连着做完再换下一家
  const ordered: BatchPlanItem[] = []
  let order = 0
  for (const storeId of storeIds) {
    for (const productId of productIds) {
      ordered.push({ productId, storeId, order: order++, state: 'pending' })
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    items: ordered,
    storeOrder: [...storeIds],
    totals: { products: productIds.length, stores: storeIds.length, items }
  }
}

/** 进度：**三个数**，不是一个百分比（方案 §7.8）。 */
export interface BatchProgress {
  total: number
  /** 已完成（`confirmed`） */
  done: number
  /** 待人工（`awaiting_human` / `needs_review`） */
  waitingHuman: number
  /** 失败（`failed`） */
  failed: number
  /** 还没开始（`pending`） */
  pending: number
  /** 进行中（`running`） */
  running: number
  /** 跳过 / 放弃 */
  skipped: number
  /** 当前应该处理哪家店（编排上的"一次只开一家"） */
  currentStoreId: string | null
  /** 这一批**能不能算结束**：没有 pending/running 才算结束（有人工待办也算没结束） */
  finished: boolean
  /** 一句话进度（界面直接显示，**不出现百分比**） */
  summary: string
}

/**
 * 汇总一批的进度。
 *
 * `currentStoreId` 的取法：**按编排顺序找第一家还有 pending/running 的店**；
 * 如果所有店都只剩"待人工"，就返回第一家待人工的店 —— 因为那时人必须回去处理它。
 * 这样界面上的"当前店铺"永远指向"下一步该动的那一家"，不会指向一家已经做完的店。
 */
export function batchProgress(items: readonly BatchPlanItem[]): BatchProgress {
  const count = (states: BatchItemState[]): number => items.filter(item => states.includes(item.state)).length
  const done = count(['confirmed'])
  const waitingHuman = count(['awaiting_human', 'needs_review'])
  const failed = count(['failed'])
  const pending = count(['pending'])
  const running = count(['running'])
  const skipped = count(['skipped', 'discarded'])

  const byOrder = [...items].sort((a, b) => a.order - b.order)
  const working = byOrder.find(item => item.state === 'pending' || item.state === 'running')
  const waiting = byOrder.find(item => item.state === 'awaiting_human' || item.state === 'needs_review')
  const currentStoreId = working?.storeId ?? waiting?.storeId ?? null

  // **"待人工"也算没结束**：有人卡在人工交接点上，这一批就没做完 ——
  // 这正是"进度必须给三个数"的理由：百分比会把"卡在等人"伪装成"快做完了"。
  const finished = pending === 0 && running === 0 && waitingHuman === 0
  return {
    total: items.length,
    done, waitingHuman, failed, pending, running, skipped,
    currentStoreId,
    finished,
    summary: finished
      ? `本批结束：已完成 ${done}、待人工 ${waitingHuman}、失败 ${failed}`
      : `进行中：已完成 ${done}、待人工 ${waitingHuman}、失败 ${failed}、未开始 ${pending}`
  }
}

/**
 * 中止后的续跑集合：**未开始的保持 pending**（方案 §7.8），已完成的店不受影响。
 *
 * 返回"中止时要落库的状态"，让服务层照着写 —— 规则与落库分开，便于单测。
 */
export function abortBatch(items: readonly BatchPlanItem[]): Array<{ order: number; state: BatchItemState }> {
  return items.map(item => ({
    order: item.order,
    // 只把"正在跑"的退回 pending（可以重来）；已经 awaiting_human 的**保持等待**（人工交接点不该被中止冲掉）
    state: item.state === 'running' ? 'pending' : item.state
  }))
}

/**
 * "下一家该处理的店"——批量的编排入口（方案 §7.8 的"处理这家/跳过这家先做下一家"）。
 *
 * `skipStoreId` 用于"跳过这家先做下一家"：把该店所有 pending 标成 `skipped`。
 */
export function nextStoreToWork(input: {
  items: readonly BatchPlanItem[]
  skipStoreId?: string | null
}): { storeId: string | null; skipped: Array<{ order: number; state: BatchItemState }> } {
  const items = input.items.map(item => (
    input.skipStoreId && item.storeId === input.skipStoreId && item.state === 'pending'
      ? { ...item, state: 'skipped' as BatchItemState }
      : item
  ))
  const skipped = items
    .filter((item, index) => item.state !== input.items[index].state)
    .map(item => ({ order: item.order, state: item.state }))
  const progress = batchProgress(items)
  return { storeId: progress.currentStoreId, skipped }
}
