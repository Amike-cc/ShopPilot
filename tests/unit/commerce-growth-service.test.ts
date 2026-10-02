import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate } from '../../apps/desktop/src/main/db/migrations'
import { commerceGrowthServiceFor } from '../../apps/desktop/src/main/services/commerce-growth-service'

type Db = { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }; close(): void }
type Ctor = new (path: string) => Db
function load(): Ctor | null { try { return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: Ctor }).DatabaseSync ?? null } catch { return null } }
const Ctor = load(); const realIt = Ctor ? it : it.skip
function setup() { const db = new Ctor!(':memory:'); const shim = { exec: (sql: string) => db.exec(sql), prepare: (sql: string) => db.prepare(sql), transaction: (fn: () => void) => () => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } } }; migrate(shim as never); db.prepare('INSERT INTO stores (id,name,platform,admin_url,status,avatar_color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('s1','店铺','微信小店','https://example.invalid','online','#000',0,0); return db }

describe('commerce growth and content domain service', () => {
  realIt('creates idempotent content drafts and keeps publish behind confirmation', () => {
    const db = setup(); const service = commerceGrowthServiceFor(db as never)
    const first = service.contentDraft({ storeId: 's1', title: '标题', body: '正文' })
    const second = service.contentDraft({ storeId: 's1', title: '标题', body: '正文' })
    expect(first.summary.draftId).toBe(second.summary.draftId)
    expect(service.contentPublish(String(first.summary.draftId), false).reasonCode).toBe('CONTENT_REVIEW_REQUIRED')
    expect(service.contentReview(String(first.summary.draftId)).status).toBe('SUCCEEDED')
    expect(service.contentPublish(String(first.summary.draftId), false).status).toBe('WAITING_CONFIRMATION')
    expect(service.contentPublish(String(first.summary.draftId), true, 'confirm').status).toBe('NOT_VERIFIED')
    db.close()
  })

  realIt('creates plans and refuses unverified ad/customer side effects', () => {
    const db = setup(); const service = commerceGrowthServiceFor(db as never)
    const plan = service.growthPlan({ storeId: 's1', domain: 'AD', name: '测试投放', budgetMinor: 1000 })
    expect(service.adConfirm({ storeId: 's1', planId: String(plan.summary.planId), confirmed: false }).status).toBe('WAITING_CONFIRMATION')
    expect(service.adConfirm({ storeId: 's1', planId: String(plan.summary.planId), confirmed: true, confirmationId: 'c1' }).status).toBe('NOT_VERIFIED')
    const draft = service.customerDraft({ storeId: 's1', conversationId: 'conv-1', body: '您好' })
    expect(service.customerSend({ storeId: 's1', conversationId: 'wrong', draftId: String(draft.summary.draftId), confirmed: true, confirmationId: 'c2' }).status).toBe('FAILED')
    expect(service.customerSend({ storeId: 's1', conversationId: 'conv-1', draftId: String(draft.summary.draftId), confirmed: true, confirmationId: 'c2' }).status).toBe('NOT_VERIFIED')
    expect((service.customerInbox('s1').summary as any).conversations[0].conversationId).toBe('conv-1')
    db.close()
  })
})
