import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { payloadHash, stableJson } from '@shared/agent-domain-rules'

export type InventoryChange = {
  productId: string
  skuId?: string | null
  stock?: number | null
  priceMinor?: number | null
}

export type SkuChange = {
  skuId: string
  spec: Array<{ name: string; value: string }>
  stock?: number | null
  priceMinor?: number | null
}

type NormalizedChange = InventoryChange | (SkuChange & { productId: string })

export type FieldDiff = {
  field: 'stock' | 'priceMinor' | 'spec'
  before: string | number | null | Array<{ name: string; value: string }>
  after: string | number | null | Array<{ name: string; value: string }>
}

type SnapshotRow = {
  storeId: string
  platform: string
  productId: string
  platformProductId: string
  skuId: string | null
  stock: number | null
  priceMinor: number | null
  spec: Array<{ name: string; value: string }>
  collectedAt: number
}

export type InventorySnapshotResult = {
  status: 'PARTIAL' | 'NOT_VERIFIED'
  reasonCode: string
  safeMessage: string
  rows: SnapshotRow[]
  capturedAt: number
  source: 'product_platform_links' | 'product_sku_links'
}

export type InventoryDiffResult = {
  status: 'SUCCEEDED' | 'PARTIAL' | 'NOT_VERIFIED'
  reasonCode: string
  safeMessage: string
  rows: Array<SnapshotRow & { inputHash: string; idempotencyKey: string; diffs: FieldDiff[] }>
  capturedAt: number
}

export type WritebackProposalResult = {
  status: 'WAITING_CONFIRMATION' | 'NOT_VERIFIED' | 'SUCCEEDED' | 'FAILED'
  reasonCode: string
  safeMessage: string
  proposalIds: string[]
  idempotencyKeys: string[]
  rows: Array<{ before: SnapshotRow | null; after: InventoryChange | SkuChange; diffs: FieldDiff[]; inputHash: string; idempotencyKey: string }>
  capturedAt: number
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function snapshotFromRow(row: Record<string, unknown>): SnapshotRow {
  return {
    storeId: String(row.store_id),
    platform: String(row.platform),
    productId: String(row.product_id || row.platform_product_id),
    platformProductId: String(row.platform_product_id),
    skuId: row.platform_sku_id == null ? null : String(row.platform_sku_id),
    stock: numberOrNull(row.platform_stock),
    priceMinor: numberOrNull(row.platform_price_minor),
    spec: parseJson(row.platform_spec_json, []),
    collectedAt: Number(row.collected_at || 0)
  }
}

function fieldsForChange(change: InventoryChange | SkuChange): Array<'stock' | 'priceMinor' | 'spec'> {
  const fields: Array<'stock' | 'priceMinor' | 'spec'> = []
  if ('stock' in change && change.stock !== undefined) fields.push('stock')
  if ('priceMinor' in change && change.priceMinor !== undefined) fields.push('priceMinor')
  if ('spec' in change) fields.push('spec')
  return fields
}

function diffFor(before: SnapshotRow | null, after: InventoryChange | SkuChange): FieldDiff[] {
  const diffs: FieldDiff[] = []
  for (const field of fieldsForChange(after)) {
    const beforeValue = field === 'stock' ? before?.stock ?? null : field === 'priceMinor' ? before?.priceMinor ?? null : before?.spec ?? []
    const afterValue = field === 'stock' ? after.stock ?? null : field === 'priceMinor' ? after.priceMinor ?? null : ('spec' in after ? after.spec : [])
    if (stableJson(beforeValue) !== stableJson(afterValue)) diffs.push({ field, before: beforeValue, after: afterValue })
  }
  return diffs
}

export class InventorySkuService {
  constructor(private readonly db: Database.Database) {}

  private transaction(fn: () => void): void {
    const candidate = this.db as unknown as { transaction?: (work: () => void) => () => void }
    if (typeof candidate.transaction === 'function') {
      candidate.transaction(fn)()
      return
    }
    this.db.exec('BEGIN')
    try { fn(); this.db.exec('COMMIT') } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* ignore */ } throw error }
  }

  private snapshots(input: { storeIds?: string[]; productIds?: string[]; skuOnly?: boolean }): SnapshotRow[] {
    const where: string[] = []
    const params: Array<string> = []
    if (input.storeIds?.length) {
      where.push(`l.store_id IN (${input.storeIds.map(() => '?').join(',')})`)
      params.push(...input.storeIds)
    }
    if (input.productIds?.length) {
      where.push(`(l.product_id IN (${input.productIds.map(() => '?').join(',')}) OR l.platform_product_id IN (${input.productIds.map(() => '?').join(',')}))`)
      params.push(...input.productIds, ...input.productIds)
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT l.store_id, l.platform, l.product_id, l.platform_product_id,
             l.platform_price_minor, l.platform_stock, l.collected_at,
             NULL AS platform_sku_id, NULL AS platform_spec_json
      FROM product_platform_links l ${filter}
      UNION ALL
      SELECT l.store_id, l.platform, l.product_id, l.platform_product_id,
             s.platform_price_minor, s.platform_stock, s.collected_at,
             s.platform_sku_id, s.platform_spec_json
      FROM product_sku_links s JOIN product_platform_links l ON l.id = s.link_id
      ${filter}
      ORDER BY collected_at DESC
    `).all(...params, ...params) as Array<Record<string, unknown>>
    const mapped = rows.map(snapshotFromRow)
    return input.skuOnly ? mapped.filter(row => !!row.skuId) : mapped
  }

  collect(input: { storeIds?: string[]; productIds?: string[]; skuOnly?: boolean }): InventorySnapshotResult {
    const capturedAt = Date.now()
    const rows = this.snapshots(input)
    return {
      status: rows.length ? 'PARTIAL' : 'NOT_VERIFIED',
      reasonCode: rows.length ? 'LOCAL_SNAPSHOT_ONLY' : 'PLATFORM_SNAPSHOT_MISSING',
      safeMessage: rows.length
        ? '已读取本地平台快照；真实平台实时采集能力仍未验证'
        : '没有可用的平台快照，真实平台采集能力未验证',
      rows,
      capturedAt,
      source: input.skuOnly ? 'product_sku_links' : 'product_platform_links'
    }
  }

  diff(input: { storeId: string; changes: NormalizedChange[]; skuOnly?: boolean }): InventoryDiffResult {
    const capturedAt = Date.now()
    const snapshots = this.snapshots({ storeIds: [input.storeId], skuOnly: input.skuOnly })
    const rows = input.changes.map(change => {
      const skuId = 'skuId' in change ? change.skuId : null
      const matching = (row: SnapshotRow) => row.productId === change.productId || row.platformProductId === change.productId
      // Inventory changes describe the product-level snapshot; prefer its non-SKU row
      // when a product also has multi-spec SKU snapshots, while retaining a fallback
      // for stores that only exposed SKU-level rows.
      const before = snapshots.find(row => !row.skuId && matching(row)) ?? snapshots.find(matching)
      const skuBefore = skuId ? snapshots.find(row => row.skuId === skuId && (row.productId === change.productId || row.platformProductId === change.productId)) : before
      const inputHash = payloadHash({ storeId: input.storeId, platform: skuBefore?.platform ?? 'UNKNOWN', productId: change.productId, skuId, change })
      const idempotencyKey = `${input.storeId}:${skuBefore?.platform ?? 'UNKNOWN'}:${change.productId}:${skuId ?? ''}:${inputHash}`
      return { ...(skuBefore ?? before ?? { storeId: input.storeId, platform: 'UNKNOWN', productId: change.productId, platformProductId: change.productId, skuId: skuId ?? null, stock: null, priceMinor: null, spec: [], collectedAt: 0 }), inputHash, idempotencyKey, diffs: diffFor(skuBefore ?? before ?? null, change) }
    })
    const hasSnapshot = snapshots.length > 0
    return {
      status: hasSnapshot ? 'SUCCEEDED' : 'NOT_VERIFIED',
      reasonCode: hasSnapshot ? 'FIELD_DIFF_READY' : 'PLATFORM_SNAPSHOT_MISSING',
      safeMessage: hasSnapshot ? '已生成字段级 before/after 差异' : '没有平台快照，无法生成可信差异',
      rows,
      capturedAt
    }
  }

  writeback(input: { domain: 'inventory' | 'sku'; storeId: string; changes: NormalizedChange[]; confirmed: boolean; confirmationId?: string }): WritebackProposalResult {
    const diff = this.diff({ storeId: input.storeId, changes: input.changes, skuOnly: input.domain === 'sku' })
    const proposalIds: string[] = []
    const idempotencyKeys: string[] = []
    const now = Date.now()
    const write = () => {
      for (const row of diff.rows) {
        const id = randomUUID()
        const proposalId = String((this.db.prepare(`
          INSERT INTO commerce_writeback_proposals(
            id, domain, store_id, platform, product_id, sku_id, input_hash, idempotency_key,
            status, confirmation_id, before_after_json, side_effect_started, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(idempotency_key) DO UPDATE SET
            status = excluded.status, confirmation_id = excluded.confirmation_id,
            before_after_json = excluded.before_after_json, updated_at = excluded.updated_at
          RETURNING id
        `).get(
          id, input.domain, input.storeId, row.platform, row.productId, row.skuId ?? '', row.inputHash, row.idempotencyKey,
          input.confirmed ? 'NOT_VERIFIED' : 'WAITING_CONFIRMATION', input.confirmationId ?? null,
          JSON.stringify({ before: row, after: input.changes.find(change => ('skuId' in change ? change.skuId : null) === row.skuId && ('productId' in change ? change.productId : '') === row.productId), diffs: row.diffs }), now, now
        ) as { id: string }).id)
        proposalIds.push(proposalId)
        idempotencyKeys.push(row.idempotencyKey)
      }
    }
    this.transaction(write)
    return {
      status: input.confirmed ? 'NOT_VERIFIED' : 'WAITING_CONFIRMATION',
      reasonCode: input.confirmed ? 'PLATFORM_WRITEBACK_NOT_VERIFIED' : 'WRITEBACK_CONFIRMATION_REQUIRED',
      safeMessage: input.confirmed
        ? '已记录写回提案，但当前平台适配器未实测，不会修改平台数据'
        : '已生成写回提案，等待人工确认；不会自动修改平台数据',
      proposalIds,
      idempotencyKeys,
      rows: diff.rows.map((row, index) => ({ before: row, after: input.changes[index] ?? input.changes[0], diffs: row.diffs, inputHash: row.inputHash, idempotencyKey: row.idempotencyKey })),
      capturedAt: now
    }
  }
}

export function inventorySkuServiceFor(db: Database.Database): InventorySkuService {
  return new InventorySkuService(db)
}
