import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'

type Result = { status: 'SUCCEEDED' | 'PARTIAL' | 'NOT_VERIFIED' | 'WAITING_CONFIRMATION' | 'FAILED'; reasonCode: string; safeMessage: string; summary: Record<string, unknown>; evidence: { source: string; capturedAt: number; counts?: Record<string, number> } }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const evidence = (source: string, counts: Record<string, number> = {}) => ({ source, capturedAt: Date.now(), counts })

export function commerceGrowthServiceFor(db: Database.Database) {
  return {
    contentDraft(input: { storeId?: string; title: string; body: string }): Result {
      const inputHash = hash(input)
      const existing = db.prepare('SELECT id,status FROM commerce_content_drafts WHERE input_hash=?').get(inputHash) as { id: string; status: string } | undefined
      const id = existing?.id || `draft_${randomUUID()}`
      if (!existing) db.prepare('INSERT INTO commerce_content_drafts(id,store_id,title,body,status,input_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, input.storeId || null, input.title, input.body, 'DRAFT', inputHash, Date.now(), Date.now())
      return { status: 'SUCCEEDED', reasonCode: existing ? 'CONTENT_DRAFT_IDEMPOTENT' : 'CONTENT_DRAFT_CREATED', safeMessage: existing ? '已找到相同内容草稿，未重复创建' : '已创建本地内容草稿，尚未发布', summary: { draftId: id, status: existing?.status || 'DRAFT', storeId: input.storeId || null, title: input.title }, evidence: evidence('commerce_content_drafts', { drafts: 1 }) }
    },
    contentReview(draftId: string): Result {
      const row = db.prepare('SELECT id,store_id,title,body,status,updated_at FROM commerce_content_drafts WHERE id=?').get(draftId) as any
      if (!row) return { status: 'FAILED', reasonCode: 'CONTENT_DRAFT_NOT_FOUND', safeMessage: '内容草稿不存在', summary: { draftId }, evidence: evidence('commerce_content_drafts') }
      if (row.status === 'DRAFT') db.prepare("UPDATE commerce_content_drafts SET status='REVIEWED', updated_at=? WHERE id=?").run(Date.now(), draftId)
      return { status: 'SUCCEEDED', reasonCode: 'CONTENT_REVIEWED_LOCAL', safeMessage: '已读取并标记本地草稿为已审核；没有平台发布副作用', summary: { draftId, storeId: row.store_id, title: row.title, status: row.status === 'DRAFT' ? 'REVIEWED' : row.status, bodyLength: String(row.body).length }, evidence: evidence('commerce_content_drafts', { drafts: 1 }) }
    },
    contentPublish(draftId: string, confirmed: boolean, confirmationId?: string): Result {
      const row = db.prepare('SELECT id,status,store_id,title FROM commerce_content_drafts WHERE id=?').get(draftId) as any
      if (!row) return { status: 'FAILED', reasonCode: 'CONTENT_DRAFT_NOT_FOUND', safeMessage: '内容草稿不存在', summary: { draftId }, evidence: evidence('commerce_content_drafts') }
      if (row.status === 'DRAFT') return { status: 'PARTIAL', reasonCode: 'CONTENT_REVIEW_REQUIRED', safeMessage: '内容草稿尚未审核，先执行 contentReview 再生成发布提案', summary: { draftId, storeId: row.store_id, status: row.status, platformAction: false }, evidence: evidence('commerce_content_drafts') }
      if (!confirmed) return { status: 'WAITING_CONFIRMATION', reasonCode: 'CONFIRMATION_REQUIRED', safeMessage: '内容发布需要人工确认，当前未提交平台', summary: { draftId, storeId: row.store_id, status: row.status, platformAction: false }, evidence: evidence('commerce_content_drafts') }
      db.prepare("UPDATE commerce_content_drafts SET status='PUBLISH_PROPOSED', updated_at=? WHERE id=?").run(Date.now(), draftId)
      return { status: 'NOT_VERIFIED', reasonCode: 'CONTENT_PLATFORM_NOT_VERIFIED', safeMessage: '已记录发布提案，但平台能力未实测，未执行发布', summary: { draftId, storeId: row.store_id, status: 'PUBLISH_PROPOSED', platformAction: false, confirmationId: confirmationId || null }, evidence: evidence('commerce_content_drafts') }
    },
    growthPlan(input: { storeId: string; domain: 'CAMPAIGN' | 'COUPON' | 'AD'; name: string; budgetMinor?: number | null }): Result {
      const inputHash = hash(input)
      const existing = db.prepare('SELECT id,status FROM commerce_growth_plans WHERE input_hash=?').get(inputHash) as { id: string; status: string } | undefined
      const id = existing?.id || `plan_${randomUUID()}`
      if (!existing) db.prepare('INSERT INTO commerce_growth_plans(id,store_id,domain,name,budget_minor,status,input_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, input.storeId, input.domain, input.name, input.budgetMinor ?? null, 'PLANNED', inputHash, Date.now(), Date.now())
      return { status: 'SUCCEEDED', reasonCode: existing ? 'GROWTH_PLAN_IDEMPOTENT' : 'GROWTH_PLAN_CREATED', safeMessage: existing ? '已找到相同计划，未重复创建' : '已创建本地经营计划；投放和预算仍需人工确认', summary: { planId: id, storeId: input.storeId, domain: input.domain, name: input.name, budgetMinor: input.budgetMinor ?? null, status: existing?.status || 'PLANNED' }, evidence: evidence('commerce_growth_plans', { plans: 1 }) }
    },
    adConfirm(input: { storeId: string; planId: string; confirmed: boolean; confirmationId?: string }): Result {
      const row = db.prepare('SELECT id,domain,status,budget_minor FROM commerce_growth_plans WHERE id=? AND store_id=?').get(input.planId, input.storeId) as any
      if (!row) return { status: 'FAILED', reasonCode: 'GROWTH_PLAN_NOT_FOUND', safeMessage: '投放计划不存在', summary: { planId: input.planId }, evidence: evidence('commerce_growth_plans') }
      if (!input.confirmed) return { status: 'WAITING_CONFIRMATION', reasonCode: 'CONFIRMATION_REQUIRED', safeMessage: '广告投放需要人工确认，当前未提交平台', summary: { planId: input.planId, budgetMinor: row.budget_minor, platformAction: false }, evidence: evidence('commerce_growth_plans') }
      db.prepare("UPDATE commerce_growth_plans SET status='NOT_VERIFIED', confirmation_id=?, updated_at=? WHERE id=?").run(input.confirmationId || null, Date.now(), input.planId)
      return { status: 'NOT_VERIFIED', reasonCode: 'AD_PLATFORM_NOT_VERIFIED', safeMessage: '已记录广告确认，但平台投放能力未实测，未扣费、未创建广告任务', summary: { planId: input.planId, budgetMinor: row.budget_minor, platformAction: false, status: 'NOT_VERIFIED' }, evidence: evidence('commerce_growth_plans') }
    },
    customerDraft(input: { storeId: string; conversationId: string; body: string }): Result {
      const inputHash = hash(input); const existing = db.prepare('SELECT id,status FROM commerce_customer_drafts WHERE input_hash=?').get(inputHash) as any
      const id = existing?.id || `reply_${randomUUID()}`
      if (!existing) db.prepare('INSERT INTO commerce_customer_drafts(id,store_id,conversation_id,body,status,input_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, input.storeId, input.conversationId, input.body, 'DRAFT', inputHash, Date.now(), Date.now())
      return { status: 'SUCCEEDED', reasonCode: existing ? 'CUSTOMER_DRAFT_IDEMPOTENT' : 'CUSTOMER_DRAFT_CREATED', safeMessage: '已保存客服回复草稿，未发送', summary: { draftId: id, storeId: input.storeId, conversationId: input.conversationId, status: existing?.status || 'DRAFT', bodyLength: input.body.length }, evidence: evidence('commerce_customer_drafts', { drafts: 1 }) }
    },
    customerInbox(storeId: string, limit = 20): Result {
      const rows = db.prepare('SELECT id,conversation_id,status,updated_at FROM commerce_customer_drafts WHERE store_id=? ORDER BY updated_at DESC LIMIT ?').all(storeId, Math.min(100, limit)) as any[]
      return { status: 'PARTIAL', reasonCode: 'CUSTOMER_PLATFORM_INBOX_NOT_VERIFIED', safeMessage: '本地客服草稿台账可读；平台收件箱未实测，未读取聊天正文', summary: { storeId, returned: rows.length, conversations: rows.map(row => ({ id: row.id, conversationId: row.conversation_id, status: row.status, updatedAt: row.updated_at })) }, evidence: evidence('commerce_customer_drafts', { drafts: rows.length }) }
    },
    customerSend(input: { storeId: string; conversationId: string; draftId: string; confirmed: boolean; confirmationId?: string }): Result {
      const row = db.prepare('SELECT id,conversation_id,status FROM commerce_customer_drafts WHERE id=? AND store_id=? AND conversation_id=?').get(input.draftId, input.storeId, input.conversationId) as any
      if (!row) return { status: 'FAILED', reasonCode: 'CUSTOMER_DRAFT_NOT_FOUND', safeMessage: '客服草稿不存在', summary: { draftId: input.draftId }, evidence: evidence('commerce_customer_drafts') }
      if (!input.confirmed) return { status: 'WAITING_CONFIRMATION', reasonCode: 'CONFIRMATION_REQUIRED', safeMessage: '客服发送需要人工确认，当前未发送', summary: { draftId: input.draftId, conversationId: row.conversation_id, platformAction: false }, evidence: evidence('commerce_customer_drafts') }
      db.prepare("UPDATE commerce_customer_drafts SET status='NOT_VERIFIED', confirmation_id=?, updated_at=? WHERE id=?").run(input.confirmationId || null, Date.now(), input.draftId)
      return { status: 'NOT_VERIFIED', reasonCode: 'CUSTOMER_PLATFORM_NOT_VERIFIED', safeMessage: '已记录发送提案，但平台客服发送能力未实测，未发送消息', summary: { draftId: input.draftId, conversationId: row.conversation_id, platformAction: false, status: 'NOT_VERIFIED' }, evidence: evidence('commerce_customer_drafts') }
    }
  }
}
