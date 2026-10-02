import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { payloadHash } from '@shared/agent-domain-rules'
import type { AgentSoftwareResultStatus } from '@shared/contracts/agent-software'
import type { UnifiedOrder } from '@shared/contracts/unified-order'
import { OrderRepository } from './order-repository'

type ActionDomain = 'FULFILLMENT' | 'REFUND'
type ProposalStatus = 'WAITING_CONFIRMATION' | 'NOT_VERIFIED' | 'SUCCEEDED' | 'FAILED' | 'RECOVERY_REQUIRED'

export interface LifecycleActionResult {
  status: AgentSoftwareResultStatus
  reasonCode: string
  safeMessage: string
  summary: Record<string, string | number | boolean | null>
  evidence: { source: string; capturedAt: number; counts?: Record<string, number> }
}

interface ProposalRow { id: string; status: ProposalStatus; side_effect_started: number }

function safeOrderState(order: UnifiedOrder): Record<string, unknown> {
  // Do not persist or return buyer identity, address, phone, item title or raw platform payload.
  return {
    status: order.status,
    platformStatus: order.platformStatus,
    paidAmountMinor: order.paidAmountMinor,
    refundAmountMinor: order.refundAmountMinor,
    shippedAt: order.shippedAt,
    completedAt: order.completedAt
  }
}

export class OrderLifecycleService {
  private readonly orders: OrderRepository

  constructor(private readonly db: Database.Database) { this.orders = new OrderRepository(db) }

  private getOrder(storeId: string, orderId: string): UnifiedOrder | null {
    return this.orders.getOrderById(storeId, orderId)
  }

  private createProposal(input: {
    domain: ActionDomain
    order: UnifiedOrder
    after: Record<string, unknown>
    confirmed: boolean
    confirmationId?: string
  }): ProposalRow {
    const now = Date.now()
    const before = safeOrderState(input.order)
    const effectiveConfirmationId = input.confirmed ? (input.confirmationId ?? `agent-confirm-${randomUUID()}`) : null
    const identity = { domain: input.domain, storeId: input.order.storeId, platform: input.order.platform, orderId: input.order.id, before, after: input.after }
    const inputHash = payloadHash(identity)
    const idempotencyKey = `${input.domain}:${input.order.storeId}:${input.order.platform}:${input.order.id}:${inputHash}`
    this.db.prepare(`
      INSERT INTO order_action_proposals (
        id, action_domain, store_id, order_id, input_hash, idempotency_key, status,
        confirmation_id, before_after_json, side_effect_started, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      randomUUID(), input.domain, input.order.storeId, input.order.id, inputHash, idempotencyKey,
      input.confirmed ? 'NOT_VERIFIED' : 'WAITING_CONFIRMATION', effectiveConfirmationId,
      JSON.stringify({ before, after: input.after, platformWriteback: false }), now, now
    )
    const proposal = this.db.prepare('SELECT id, status, side_effect_started FROM order_action_proposals WHERE idempotency_key = ?')
      .get(idempotencyKey) as ProposalRow | undefined
    if (!proposal) throw new Error('ORDER_PROPOSAL_PERSIST_FAILED')
    if (input.confirmed && proposal.status === 'WAITING_CONFIRMATION') {
      this.db.prepare(`UPDATE order_action_proposals
        SET status = 'NOT_VERIFIED', confirmation_id = ?, updated_at = ?
        WHERE id = ? AND status = 'WAITING_CONFIRMATION' AND side_effect_started = 0`)
        .run(effectiveConfirmationId, now, proposal.id)
      proposal.status = 'NOT_VERIFIED'
    }
    return proposal
  }

  prepareFulfillment(storeId: string, orderIds: string[]): LifecycleActionResult {
    const prepared: string[] = []
    let blockedUnknown = 0
    let blockedKnown = 0
    let missing = 0
    for (const orderId of [...new Set(orderIds)]) {
      const order = this.getOrder(storeId, orderId)
      if (!order) { missing++; continue }
      if (!['PAID', 'PROCESSING'].includes(order.status)) {
        if (order.status === 'UNKNOWN') blockedUnknown++
        else blockedKnown++
        continue
      }
      this.createProposal({ domain: 'FULFILLMENT', order, after: { logisticsStatus: 'SHIPPED', requiresCarrierAndTracking: true }, confirmed: false })
      prepared.push(order.id)
    }
    const status: AgentSoftwareResultStatus = prepared.length ? (missing || blockedUnknown || blockedKnown ? 'PARTIAL' : 'WAITING_CONFIRMATION') : 'NOT_VERIFIED'
    return {
      status,
      reasonCode: prepared.length ? (status === 'PARTIAL' ? 'FULFILLMENT_PREPARED_PARTIAL' : 'FULFILLMENT_CONFIRMATION_REQUIRED') : 'FULFILLMENT_STATE_UNKNOWN',
      safeMessage: prepared.length
        ? `已为 ${prepared.length} 个订单建立发货确认提案；${blockedKnown ? `${blockedKnown} 个状态不符合发货准备` : ''}${blockedUnknown ? `${blockedUnknown} 个订单状态未知` : ''}${missing ? `${missing} 个订单未找到` : ''}；平台提交能力未验证，未执行发货`
        : '没有可安全准备的已付款订单；未知或未采集状态未作推断',
      summary: { prepared: prepared.length, missing, blockedKnown, blockedUnknown, platformWriteback: false },
      evidence: { source: 'order_action_proposals', capturedAt: Date.now(), counts: { prepared: prepared.length, missing, blockedKnown, blockedUnknown } }
    }
  }

  confirmFulfillment(storeId: string, orderId: string, confirmed: boolean, confirmationId?: string): LifecycleActionResult {
    const order = this.getOrder(storeId, orderId)
    if (!order) return this.notFound('FULFILLMENT_ORDER_NOT_FOUND')
    const proposal = this.db.prepare(`SELECT id, status, side_effect_started FROM order_action_proposals
      WHERE store_id = ? AND order_id = ? AND action_domain = 'FULFILLMENT' ORDER BY created_at DESC LIMIT 1`)
      .get(storeId, order.id) as ProposalRow | undefined
    if (!proposal) return this.result('NOT_VERIFIED', 'FULFILLMENT_NOT_PREPARED', '请先生成发货准备清单；没有发货提案，平台动作未执行', { prepared: false, sideEffectStarted: false })
    if (!confirmed) return this.result('WAITING_CONFIRMATION', 'CONFIRMATION_REQUIRED', '发货需要人工确认；平台动作尚未执行', { proposalId: proposal.id, sideEffectStarted: false })
    if (proposal.side_effect_started) return this.result('RECOVERY_REQUIRED', 'FULFILLMENT_SIDE_EFFECT_REQUIRES_READBACK', '提案已有副作用标记，禁止重试；请先人工核实平台状态', { proposalId: proposal.id, sideEffectStarted: true })
    const effectiveConfirmationId = confirmationId ?? `agent-confirm-${randomUUID()}`
    this.db.prepare(`UPDATE order_action_proposals SET status = 'NOT_VERIFIED', confirmation_id = ?, updated_at = ?
      WHERE id = ? AND status = 'WAITING_CONFIRMATION' AND side_effect_started = 0`).run(effectiveConfirmationId, Date.now(), proposal.id)
    return this.result('NOT_VERIFIED', 'FULFILLMENT_PLATFORM_NOT_VERIFIED', '确认已记录，但当前没有经实测的平台发货适配器；未提交发货，需取得平台能力证据后再执行', { proposalId: proposal.id, platformWriteback: false, sideEffectStarted: false })
  }

  verifyFulfillment(storeId: string, orderId: string): LifecycleActionResult {
    const order = this.getOrder(storeId, orderId)
    if (!order) return this.notFound('FULFILLMENT_ORDER_NOT_FOUND')
    const row = this.db.prepare('SELECT logistics_status, source, collected_at FROM order_fulfillments WHERE order_id = ?')
      .get(order.id) as { logistics_status: string; source: string; collected_at: number } | undefined
    if (!row || row.source !== 'PLATFORM_READBACK' || row.logistics_status === 'UNKNOWN') {
      return this.result('UNKNOWN', 'FULFILLMENT_READBACK_UNKNOWN', '没有平台发货回读证据，物流状态为 UNKNOWN', { logisticsStatus: 'UNKNOWN', platformStatus: null })
    }
    return this.result('SUCCEEDED', 'FULFILLMENT_PLATFORM_READBACK', '已读取平台物流状态', { logisticsStatus: row.logistics_status, platformStatus: order.platformStatus }, row.collected_at)
  }

  reviewRefund(storeId: string, orderId: string): LifecycleActionResult {
    const order = this.getOrder(storeId, orderId)
    if (!order) return this.notFound('REFUND_ORDER_NOT_FOUND')
    const cases = this.db.prepare(`SELECT case_status, refund_status, amount_minor, source FROM after_sale_cases
      WHERE order_id = ? ORDER BY updated_at DESC LIMIT 20`).all(order.id) as Array<{ case_status: string; refund_status: string; amount_minor: number | null; source: string }>
    const verified = cases.filter(row => row.source === 'PLATFORM_READBACK')
    if (!verified.length) {
      return this.result('NOT_VERIFIED', 'AFTER_SALE_PLATFORM_NOT_VERIFIED', '没有平台售后/退款回读记录；售后和退款状态保持 UNKNOWN', { orderStatus: order.status, caseCount: cases.length, refundStatus: 'UNKNOWN', amountMinor: null })
    }
    return this.result('PARTIAL', 'AFTER_SALE_LOCAL_READBACK', '读取到已保存的售后状态摘要；请以最新平台页面复核', { orderStatus: order.status, caseCount: verified.length, refundStatus: verified[0].refund_status, amountMinor: verified[0].amount_minor })
  }

  confirmRefund(input: { storeId: string; orderId: string; amountMinor: number; confirmed: boolean; confirmationId?: string }): LifecycleActionResult {
    const order = this.getOrder(input.storeId, input.orderId)
    if (!order) return this.notFound('REFUND_ORDER_NOT_FOUND')
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return this.result('FAILED', 'REFUND_AMOUNT_INVALID', '退款金额无效，未创建提案', { proposalCreated: false })
    if (order.paidAmountMinor == null) return this.result('NOT_VERIFIED', 'REFUND_PAID_AMOUNT_UNKNOWN', '订单实付金额未知，无法建立可信退款提案', { proposalCreated: false, paidAmountMinor: null })
    if (input.amountMinor > order.paidAmountMinor) return this.result('FAILED', 'REFUND_EXCEEDS_PAID_AMOUNT', '退款金额超过本地记录的实付金额，未创建提案', { proposalCreated: false, paidAmountMinor: order.paidAmountMinor })
    const proposal = this.createProposal({
      domain: 'REFUND', order,
      after: { refundAmountMinor: input.amountMinor, requiresHumanReview: true },
      confirmed: input.confirmed, confirmationId: input.confirmationId
    })
    if (!input.confirmed) return this.result('WAITING_CONFIRMATION', 'CONFIRMATION_REQUIRED', '已创建退款提案，等待人工确认；未执行退款', { proposalId: proposal.id, amountMinor: input.amountMinor, sideEffectStarted: false })
    return this.result('NOT_VERIFIED', 'REFUND_PLATFORM_NOT_VERIFIED', '确认已记录，但当前没有经实测的平台退款适配器；未执行退款资金动作', { proposalId: proposal.id, amountMinor: input.amountMinor, platformWriteback: false, sideEffectStarted: false })
  }

  verifyRefund(storeId: string, orderId: string): LifecycleActionResult {
    const order = this.getOrder(storeId, orderId)
    if (!order) return this.notFound('REFUND_ORDER_NOT_FOUND')
    const row = this.db.prepare(`SELECT refund_status, amount_minor, source, collected_at FROM after_sale_cases
      WHERE order_id = ? ORDER BY updated_at DESC LIMIT 1`).get(order.id) as { refund_status: string; amount_minor: number | null; source: string; collected_at: number } | undefined
    if (!row || row.source !== 'PLATFORM_READBACK' || row.refund_status === 'UNKNOWN') {
      return this.result('UNKNOWN', 'REFUND_READBACK_UNKNOWN', '没有平台退款回读证据，退款状态为 UNKNOWN', { refundStatus: 'UNKNOWN', amountMinor: null })
    }
    return this.result('PARTIAL', 'REFUND_PLATFORM_READBACK', '已读取平台退款状态摘要', { refundStatus: row.refund_status, amountMinor: row.amount_minor }, row.collected_at)
  }

  collectAfterSales(storeIds: string[]): LifecycleActionResult {
    const unique = [...new Set(storeIds)]
    if (!unique.length) return this.result('NOT_VERIFIED', 'AFTER_SALE_STORES_REQUIRED', '需要指定店铺；未访问任何平台', { stores: 0, cases: 0 })
    const placeholders = unique.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT c.case_status, c.refund_status, c.source
      FROM after_sale_cases c JOIN orders o ON o.id = c.order_id WHERE o.store_id IN (${placeholders})`).all(...unique) as Array<{ case_status: string; refund_status: string; source: string }>
    const platformRows = rows.filter(row => row.source === 'PLATFORM_READBACK')
    return {
      status: platformRows.length ? (platformRows.length === rows.length ? 'PARTIAL' : 'PARTIAL') : 'NOT_VERIFIED',
      reasonCode: platformRows.length ? 'AFTER_SALE_LOCAL_SNAPSHOT' : 'AFTER_SALE_PLATFORM_NOT_VERIFIED',
      safeMessage: platformRows.length ? '读取到本地保存的售后状态摘要；平台实时采集尚未验证' : '没有已验证的售后平台适配器或可用售后快照，状态保持 UNKNOWN',
      summary: { stores: unique.length, cases: platformRows.length, unknown: unique.length ? Math.max(0, rows.length - platformRows.length) : 0 },
      evidence: { source: 'after_sale_cases', capturedAt: Date.now(), counts: { stores: unique.length, cases: platformRows.length } }
    }
  }

  private result(status: AgentSoftwareResultStatus, reasonCode: string, safeMessage: string, summary: LifecycleActionResult['summary'], capturedAt = Date.now()): LifecycleActionResult {
    return { status, reasonCode, safeMessage, summary, evidence: { source: 'order_lifecycle', capturedAt, counts: { records: 1 } } }
  }

  private notFound(reasonCode: string): LifecycleActionResult {
    return this.result('FAILED', reasonCode, '目标订单不存在或尚未采集', { found: false })
  }
}

export function orderLifecycleServiceFor(db: Database.Database): OrderLifecycleService {
  return new OrderLifecycleService(db)
}
