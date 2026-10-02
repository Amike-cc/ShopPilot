import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { HUMAN_GATE_PUBLISH_STATES, IN_FLIGHT_PUBLISH_STATES, PUBLISH_ITEM_STATES, toBatchItemState } from '../../packages/shared/src/product-status'
import { batchProgress } from '../../packages/shared/src/product-batch-rules'

/**
 * 源码扫描：**仓储 SQL 里出现的发布项状态名，必须在词表里**。
 *
 * 这个测试是有来历的（2026-10-01 实测）：我给「全部暂停」写的 SQL 过滤了 `status = 'in_progress'` ——
 * 一个在任何一套命名里都不存在的值。它永远命中 0 行、**静默空操作**（不报错、不生效），
 * 而当时**没有任何测试能发现**。这个测试就是补这个洞。
 */
function readRepo(): string {
  return readFileSync(join(process.cwd(), 'apps/desktop/src/main/products/product-repository.ts'), 'utf8')
}

/** 抽出所有 `status = 'x'` / `status IN ('x','y')` 里的字面量。 */
function statusLiterals(sql: string): string[] {
  const out = new Set<string>()
  for (const match of sql.matchAll(/status\s*=\s*'([a-z_]+)'/g)) out.add(match[1])
  for (const match of sql.matchAll(/status\s+IN\s*\(([^)]*)\)/g)) {
    for (const item of match[1].matchAll(/'([a-z_]+)'/g)) out.add(item[1])
  }
  return [...out]
}

describe('发布项状态词表', () => {
  it('仓储 SQL 里的状态名**全部**在词表里（写错就失败，而不是静默失效）', () => {
    const sql = readRepo()
    // 只看"发布台账"那几张表的语句（别把商品/链接表的状态混进来）
    const publishSql = sql
      .split('\n')
      .filter(line => /product_publish_items|product_publish_jobs/.test(line) || /status\s*(=|IN)/.test(line))
      .join('\n')
    const literals = statusLiterals(publishSql)
      // 商品/链接表的状态（platform_status 等）不在本词表范围
      .filter(name => !['missing', 'active', 'deleted', 'draft'].includes(name))
    expect(literals.length).toBeGreaterThan(3)
    const unknown = literals.filter(name => !(PUBLISH_ITEM_STATES as readonly string[]).includes(name))
    expect(unknown, `仓储 SQL 里出现了词表外的状态名：${unknown.join(', ')}`).toEqual([])
  })

  it('**"正在跑"不叫 running** —— 真实命名是 prechecking/filling/fill_partial/verifying', () => {
    // 这一条是那个 bug 的核心：我曾按规则层的 `running` 去想当然，
    // 而库里从来没有 running，只有这四个中间态。
    expect([...IN_FLIGHT_PUBLISH_STATES]).toEqual(['prechecking', 'filling', 'fill_partial', 'verifying'])
    expect((PUBLISH_ITEM_STATES as readonly string[]).includes('running')).toBe(false)
  })

  it('**awaiting_human 不是"正在跑"** —— 它是人工交接点，暂停不该冲掉它', () => {
    expect((IN_FLIGHT_PUBLISH_STATES as readonly string[]).includes('awaiting_human')).toBe(false)
    expect([...HUMAN_GATE_PUBLISH_STATES]).toEqual(['awaiting_human'])
  })

  it('词表本身没有重复项', () => {
    expect(new Set(PUBLISH_ITEM_STATES).size).toBe(PUBLISH_ITEM_STATES.length)
  })
})

describe('台账状态 → 规则层状态的显式映射', () => {
  it('**台账的 precheck_failed 必须映射成 failed** —— 否则批量进度会漏报失败', () => {
    // 这是那个真 bug：服务层原来做 `as` 强转，precheck_failed 不是 BatchItemState 的成员，
    // 于是 batchProgress 统计 failed 时**一条都数不到** → 界面显示"失败 0"而实际有失败项。
    expect(toBatchItemState('precheck_failed')).toBe('failed')
    expect(toBatchItemState('failed')).toBe('failed')
  })

  it('四个"正在跑"的中间态都映射成 running', () => {
    for (const state of IN_FLIGHT_PUBLISH_STATES) expect(toBatchItemState(state)).toBe('running')
  })

  it('人工交接点原样保留（不该被当成失败或完成）', () => {
    expect(toBatchItemState('awaiting_human')).toBe('awaiting_human')
    expect(toBatchItemState('needs_review')).toBe('needs_review')
  })

  it('**认不出来的状态按 failed 处理**，不静默吞掉', () => {
    expect(toBatchItemState('something_new_from_platform')).toBe('failed')
    expect(toBatchItemState('')).toBe('failed')
  })

  it('回归：用真实台账状态跑一遍批量进度，失败项**数得出来**', () => {
    // 模拟服务层的映射 + 规则层统计这条链路（这是曾经漏报的地方）
    const rows = [
      { status: 'confirmed' },        // 已完成
      { status: 'precheck_failed' },  // ← 旧写法漏掉的就是它
      { status: 'awaiting_human' },   // 待人工
      { status: 'prechecking' },      // 正在跑
      { status: 'pending' }
    ]
    const planItems = rows.map((row, index) => ({ productId: 'p', storeId: 's', order: index, state: toBatchItemState(row.status) }))
    const progress = batchProgress(planItems)
    expect(progress.failed).toBe(1)
    expect(progress.done).toBe(1)
    expect(progress.waitingHuman).toBe(1)
    expect(progress.running).toBe(1)
    expect(progress.pending).toBe(1)
  })
})
