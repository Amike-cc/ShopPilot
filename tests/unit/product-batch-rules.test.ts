import { describe, expect, it } from 'vitest'
import {
  BATCH_LIMITS,
  abortBatch,
  batchProgress,
  nextStoreToWork,
  planBatch,
  type BatchPlanItem
} from '../../packages/shared/src/product-batch-rules'

const P = ['p1', 'p2']
const S = ['s1', 's2']

describe('批量计划：上限与编排顺序', () => {
  it('2 商品 × 2 店 = 4 个发布项，**按店铺分组**排（同一家店连着做完再换下一家）', () => {
    const plan = planBatch({ productIds: P, storeIds: S })
    expect(plan.ok).toBe(true)
    expect(plan.totals).toEqual({ products: 2, stores: 2, items: 4 })
    expect(plan.items.map(item => `${item.storeId}:${item.productId}`)).toEqual([
      's1:p1', 's1:p2', 's2:p1', 's2:p2'      // 一次只开一家 → 顺序必须是"店连着"
    ])
    expect(plan.storeOrder).toEqual(['s1', 's2'])
    expect(plan.items.every(item => item.state === 'pending')).toBe(true)
  })

  it('重复的商品/店铺只算一次（去重后再判上限）', () => {
    const plan = planBatch({ productIds: ['p1', 'p1'], storeIds: ['s1', 's1'] })
    expect(plan.totals).toEqual({ products: 1, stores: 1, items: 1 })
  })

  it('超过 20 店 / 20 商品 / 400 项 → 逐条说清是哪个上限，并拒绝执行', () => {
    const stores = Array.from({ length: 21 }, (_, i) => `s${i}`)
    const products = Array.from({ length: 21 }, (_, i) => `p${i}`)
    const plan = planBatch({ productIds: products, storeIds: stores })
    expect(plan.ok).toBe(false)
    expect(plan.errors.some(text => text.includes(`最多 ${BATCH_LIMITS.maxStores} 家店铺`))).toBe(true)
    expect(plan.errors.some(text => text.includes(`最多 ${BATCH_LIMITS.maxProducts} 个商品`))).toBe(true)
    expect(plan.errors.some(text => text.includes(`${BATCH_LIMITS.maxItems} 个发布项`))).toBe(true)
  })

  it('刚好到上限 → 允许（20 × 20 = 400）', () => {
    const stores = Array.from({ length: 20 }, (_, i) => `s${i}`)
    const products = Array.from({ length: 20 }, (_, i) => `p${i}`)
    const plan = planBatch({ productIds: products, storeIds: stores })
    expect(plan.ok).toBe(true)
    expect(plan.totals.items).toBe(400)
  })

  it('空选择 → 明确报错，不是静默生成空计划', () => {
    expect(planBatch({ productIds: [], storeIds: S }).errors).toContain('没有选要发布的商品')
    expect(planBatch({ productIds: P, storeIds: [] }).errors).toContain('没有选要发布到哪些店铺')
  })
})

function items(states: Array<[string, BatchPlanItem['state']]>): BatchPlanItem[] {
  return states.map(([storeId, state], index) => ({ productId: `p${index}`, storeId, order: index, state }))
}

describe('批量进度：必须是**三个数**，不是一个百分比', () => {
  it('汇总出 已完成/待人工/失败 三个数，并带未开始与进行中', () => {
    const progress = batchProgress(items([
      ['s1', 'confirmed'], ['s1', 'awaiting_human'], ['s2', 'failed'], ['s2', 'pending'], ['s2', 'running']
    ]))
    expect(progress.done).toBe(1)
    expect(progress.waitingHuman).toBe(1)
    expect(progress.failed).toBe(1)
    expect(progress.pending).toBe(1)
    expect(progress.running).toBe(1)
    expect(progress.total).toBe(5)
  })

  it('**summary 里不许出现百分比**（百分比会把"卡在等人"伪装成"快做完了"）', () => {
    const progress = batchProgress(items([['s1', 'confirmed'], ['s1', 'awaiting_human']]))
    expect(progress.summary).not.toContain('%')
    expect(progress.summary).toContain('已完成 1')
    expect(progress.summary).toContain('待人工 1')
    expect(progress.summary).toContain('失败 0')
  })

  it('还有人待人工 → **不算结束**（有人工待办就是没结束）', () => {
    const progress = batchProgress(items([['s1', 'confirmed'], ['s1', 'awaiting_human']]))
    expect(progress.finished).toBe(false)
  })

  it('全部落定（含失败）→ 算结束', () => {
    const progress = batchProgress(items([['s1', 'confirmed'], ['s1', 'failed'], ['s1', 'skipped']]))
    expect(progress.finished).toBe(true)
    expect(progress.summary).toContain('本批结束')
  })

  it('当前店铺指向"下一步该动的那一家"：优先还没开始的，其次待人工的', () => {
    const withPending = batchProgress(items([['s1', 'confirmed'], ['s2', 'pending']]))
    expect(withPending.currentStoreId).toBe('s2')
    const onlyWaiting = batchProgress(items([['s1', 'confirmed'], ['s2', 'awaiting_human']]))
    expect(onlyWaiting.currentStoreId).toBe('s2')
    const allDone = batchProgress(items([['s1', 'confirmed'], ['s2', 'confirmed']]))
    expect(allDone.currentStoreId).toBeNull()
  })
})

describe('中止与续跑：未开始的保持 pending', () => {
  it('中止时只把"正在跑"的退回 pending；**awaiting_human 保持等待**（人工交接点不该被冲掉）', () => {
    const plan = abortBatch(items([['s1', 'confirmed'], ['s1', 'running'], ['s2', 'awaiting_human'], ['s2', 'pending']]))
    expect(plan.map(row => row.state)).toEqual(['confirmed', 'pending', 'awaiting_human', 'pending'])
  })

  it('续跑：中止后重新算进度，未开始的仍是 pending（可接着做）', () => {
    const after = items([['s1', 'confirmed'], ['s1', 'pending'], ['s2', 'pending']])
    const progress = batchProgress(after)
    expect(progress.pending).toBe(2)
    expect(progress.finished).toBe(false)
    expect(progress.currentStoreId).toBe('s1')
  })
})

describe('逐店推进：处理这家 / 跳过这家先做下一家', () => {
  it('默认给出编排上的下一家店', () => {
    const result = nextStoreToWork({ items: items([['s1', 'pending'], ['s2', 'pending']]) })
    expect(result.storeId).toBe('s1')
    expect(result.skipped).toHaveLength(0)
  })

  it('「跳过这家」→ 该店未开始的标成 skipped，当前店立刻变成下一家', () => {
    const result = nextStoreToWork({
      items: items([['s1', 'pending'], ['s1', 'pending'], ['s2', 'pending']]),
      skipStoreId: 's1'
    })
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped.every(row => row.state === 'skipped')).toBe(true)
    expect(result.storeId).toBe('s2')
  })

  it('「跳过这家」**不动**该店已经在等人工的项（跳过不等于放弃那一条）', () => {
    const result = nextStoreToWork({
      items: items([['s1', 'awaiting_human'], ['s1', 'pending'], ['s2', 'pending']]),
      skipStoreId: 's1'
    })
    // 只跳过"还没开始的"那一条；awaiting_human 那条原样保留
    expect(result.skipped).toEqual([{ order: 1, state: 'skipped' }])
    // 当前店指向**下一家可开工的**（s2）：用户说了"先做下一家"，
    // 而 s1 那条待人工的仍然计在"待人工"数里，随时可以回头处理。
    expect(result.storeId).toBe('s2')
  })

  it('当前店只按"还能开工的"挑；待人工的店不会被当成当前店（但会计入待人工数）', () => {
    const progress = batchProgress(items([['s1', 'awaiting_human'], ['s2', 'pending']]))
    expect(progress.currentStoreId).toBe('s2')
    expect(progress.waitingHuman).toBe(1)
    expect(progress.finished).toBe(false)
  })
})
