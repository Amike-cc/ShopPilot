import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { AgentSoftwareActionResult } from '@shared/contracts/agent-software'
import type { AgentSoftwareAction } from '@shared/schemas/agent'

export interface CommerceActionLedgerEntry {
  id: string
  actionType: string
  storeId: string | null
  inputHash: string
  status: string
  confirmationId: string | null
  sideEffectStarted: boolean
  evidence: unknown
  summary: unknown
  recoveryAdvice: string | null
  createdAt: number
  updatedAt: number
}

const TRACKED = new Set([
  'collectInvoices', 'collectBusiness', 'collectEntity', 'collectOrders',
  'orderCollect', 'businessMetricsCollect', 'invoiceCollect', 'entityCollect',
  'businessMetricsCompare', 'commerceHealth', 'invoiceExport', 'entityApply',
  'contentDraft', 'contentReview', 'contentPublish', 'campaignPlan', 'couponPlan', 'adPlan', 'adConfirm', 'customerInbox', 'customerDraftReply', 'customerSendReply',
  'inventoryCollect', 'inventoryDiff', 'inventoryWriteback', 'skuCollect', 'skuDiff', 'skuWriteback',
  'orderList', 'orderGet', 'fulfillmentPrepare', 'fulfillmentConfirm', 'fulfillmentVerify', 'afterSaleCollect', 'refundReview', 'refundConfirm', 'refundVerify',
  'productSync', 'productList', 'productLibraryList', 'productDetailCollect', 'productPublishPreflight', 'productPublishOpen', 'productPublishVerify', 'productPublishReadback', 'productPublishAccept', 'productPublishChecklist', 'productPublishBatchProgress'
])

export function commerceActionLedgerFor(db: Database.Database) {
  return {
    start(action: AgentSoftwareAction): void {
      if (!TRACKED.has(action.type)) return
      const storeId = 'storeId' in action && typeof action.storeId === 'string' ? action.storeId : null
      const inputHash = createHash('sha256').update(JSON.stringify(action)).digest('hex')
      const existing = db.prepare('SELECT id, status, side_effect_started FROM commerce_agent_action_ledger WHERE action_type=? AND store_id IS ? AND input_hash=?').get(action.type, storeId, inputHash) as { id?: string; status?: string; side_effect_started?: number } | undefined
      // 只有已产生副作用或仍需人工回读的记录禁止盲目重放。
      // failed/partial/not_verified/waiting_confirmation 可能需要一次新的、
      // 已通过 Main 确认门禁的执行；重新开始前必须再次留下 running 轨迹。
      if (existing?.side_effect_started === 1 || existing?.status === 'recovery_required') return
      const now = Date.now()
      if (existing?.id) {
        db.prepare('UPDATE commerce_agent_action_ledger SET status=?, confirmation_id=?, recovery_advice=?, updated_at=? WHERE id=?').run('running', 'confirmationId' in action ? action.confirmationId || null : null, '动作执行中；若进程中断，请先检查页面/平台回读，再决定恢复或取消', now, existing.id)
        return
      }
      db.prepare(`
        INSERT INTO commerce_agent_action_ledger(id,action_type,store_id,input_hash,status,confirmation_id,side_effect_started,evidence_json,summary_json,recovery_advice,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(randomUUID(), action.type, storeId, inputHash, 'running', 'confirmationId' in action ? action.confirmationId || null : null, 0, null, null, '动作执行中；若进程中断，请先检查页面/平台回读，再决定恢复或取消', now, now)
    },
    record(action: AgentSoftwareAction, result: AgentSoftwareActionResult): void {
      if (!TRACKED.has(action.type)) return
      const storeId = 'storeId' in action && typeof action.storeId === 'string' ? action.storeId : null
      const inputHash = createHash('sha256').update(JSON.stringify(action)).digest('hex')
      const raw = result.status.toLowerCase()
      const status = (['succeeded', 'failed', 'waiting_confirmation', 'recovery_required', 'blocked_budget', 'blocked_permission', 'not_verified', 'partial', 'unknown'].includes(raw) ? raw : raw === 'login_required' || raw === 'verify_required' ? 'not_verified' : 'failed') as string
      const sideEffectStarted = result.summary.sideEffectStarted === true || result.summary.side_effect_started === true ? 1 : 0
      const advice = result.status === 'WAITING_CONFIRMATION' ? '等待用户确认后重新执行同一 inputHash' : result.status === 'RECOVERY_REQUIRED' ? '已产生或疑似产生页面副作用；先人工回读平台状态，再决定恢复或取消，禁止盲目重试' : result.status === 'NOT_VERIFIED' ? '平台能力未验证；补充真实适配器证据后再执行' : result.status === 'PARTIAL' ? '检查缺失字段或平台回读结果，再决定是否重新发起' : null
      const existing = db.prepare('SELECT id, status, side_effect_started FROM commerce_agent_action_ledger WHERE action_type=? AND store_id IS ? AND input_hash=?').get(action.type, storeId, inputHash) as { id?: string; status?: string; side_effect_started?: number } | undefined
      if (existing?.id) {
        const preservedSideEffect = existing.side_effect_started === 1 || sideEffectStarted === 1 ? 1 : 0
        const preservedRecovery = existing.status === 'recovery_required' && status !== 'succeeded'
        const nextStatus = preservedRecovery ? 'recovery_required' : status
        const nextAdvice = preservedRecovery ? '已产生或疑似产生页面副作用；先人工回读平台状态，再决定恢复或取消，禁止盲目重试' : advice
        db.prepare('UPDATE commerce_agent_action_ledger SET status=?, confirmation_id=?, side_effect_started=?, evidence_json=?, summary_json=?, recovery_advice=?, updated_at=? WHERE id=?').run(nextStatus, 'confirmationId' in action ? action.confirmationId || null : null, preservedSideEffect, result.evidence ? JSON.stringify(result.evidence) : null, JSON.stringify(result.summary), nextAdvice, Date.now(), existing.id)
        return
      }
      db.prepare(`
        INSERT INTO commerce_agent_action_ledger(id,action_type,store_id,input_hash,status,confirmation_id,side_effect_started,evidence_json,summary_json,recovery_advice,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(action_type,store_id,input_hash) DO UPDATE SET status=excluded.status, confirmation_id=excluded.confirmation_id, side_effect_started=excluded.side_effect_started, evidence_json=excluded.evidence_json, summary_json=excluded.summary_json, recovery_advice=excluded.recovery_advice, updated_at=excluded.updated_at
      `).run(randomUUID(), action.type, storeId, inputHash, status, 'confirmationId' in action ? action.confirmationId || null : null, sideEffectStarted, result.evidence ? JSON.stringify(result.evidence) : null, JSON.stringify(result.summary), advice, Date.now(), Date.now())
    },
    list(input: { storeId?: string; status?: string; limit?: number } = {}): CommerceActionLedgerEntry[] {
      const limit = Math.min(200, Math.max(1, Number(input.limit) || 50))
      const clauses: string[] = []
      const params: unknown[] = []
      if (input.storeId) { clauses.push('store_id = ?'); params.push(input.storeId) }
      if (input.status) { clauses.push('status = ?'); params.push(input.status.toLowerCase()) }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const rows = db.prepare(`SELECT id,action_type,store_id,input_hash,status,confirmation_id,side_effect_started,evidence_json,summary_json,recovery_advice,created_at,updated_at FROM commerce_agent_action_ledger ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>
      return rows.map(row => ({
        id: String(row.id), actionType: String(row.action_type), storeId: row.store_id == null ? null : String(row.store_id), inputHash: String(row.input_hash), status: String(row.status),
        confirmationId: row.confirmation_id == null ? null : String(row.confirmation_id), sideEffectStarted: Number(row.side_effect_started) === 1,
        evidence: parseJson(row.evidence_json), summary: parseJson(row.summary_json), recoveryAdvice: row.recovery_advice == null ? null : String(row.recovery_advice), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
      }))
    }
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null
  try { return JSON.parse(value) } catch { return null }
}
