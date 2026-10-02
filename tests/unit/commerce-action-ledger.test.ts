import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate } from '../../apps/desktop/src/main/db/migrations'
import { commerceActionLedgerFor } from '../../apps/desktop/src/main/services/commerce-action-ledger'

type Db = { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }; close(): void }
type Ctor = new (path: string) => Db
function load(): Ctor | null { try { return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: Ctor }).DatabaseSync ?? null } catch { return null } }
const Ctor = load(); const realIt = Ctor ? it : it.skip

describe('commerce agent action ledger', () => {
  realIt('deduplicates the same input hash and keeps recovery advice', () => {
    const db = new Ctor!(':memory:')
    const shim = { exec: (sql: string) => db.exec(sql), prepare: (sql: string) => db.prepare(sql), transaction: (fn: () => void) => () => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } } }
    migrate(shim as never)
    const action = { type: 'contentPublish', draftId: 'draft-1', confirmationId: 'confirm-1' } as any
    const ledger = commerceActionLedgerFor(db as never)
    ledger.record(action, { actionType: action.type, status: 'WAITING_CONFIRMATION', reasonCode: 'CONFIRMATION_REQUIRED', safeMessage: 'wait', summary: { draftId: 'draft-1' }, evidence: { source: 'test', capturedAt: 1 } })
    ledger.record(action, { actionType: action.type, status: 'NOT_VERIFIED', reasonCode: 'PLATFORM_NOT_VERIFIED', safeMessage: 'not verified', summary: { draftId: 'draft-1' }, evidence: { source: 'test', capturedAt: 2 } })
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_agent_action_ledger').get() as { c: number }).c)).toBe(1)
    expect((db.prepare('SELECT status,recovery_advice,side_effect_started FROM commerce_agent_action_ledger').get() as any)).toMatchObject({ status: 'not_verified', side_effect_started: 0 })
    db.close()
  })

  realIt('preserves recovery status and side effect marker, and lists parsed entries', () => {
    const db = new Ctor!(':memory:')
    const shim = { exec: (sql: string) => db.exec(sql), prepare: (sql: string) => db.prepare(sql), transaction: (fn: () => void) => () => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } } }
    migrate(shim as never)
    const action = { type: 'productPublishOpen', itemId: 'item-1', fill: true } as any
    const ledger = commerceActionLedgerFor(db as never)
    ledger.record(action, { actionType: action.type, status: 'RECOVERY_REQUIRED', reasonCode: 'SIDE_EFFECT', safeMessage: 'read back', summary: { sideEffectStarted: true }, evidence: { source: 'test', capturedAt: 1 } })
    ledger.record(action, { actionType: action.type, status: 'FAILED', reasonCode: 'RETRY', safeMessage: 'retry', summary: { sideEffectStarted: false }, evidence: { source: 'test', capturedAt: 2 } })
    expect(ledger.list({ limit: 1 })[0]).toMatchObject({ status: 'recovery_required', sideEffectStarted: true, recoveryAdvice: expect.stringContaining('禁止盲目重试') })
    db.close()
  })

  realIt('creates running state before completion and does not overwrite recovery state', () => {
    const db = new Ctor!(':memory:')
    const shim = { exec: (sql: string) => db.exec(sql), prepare: (sql: string) => db.prepare(sql), transaction: (fn: () => void) => () => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } } }
    migrate(shim as never)
    const action = { type: 'refundConfirm', orderId: 'order-1', amountMinor: 100 } as any
    const ledger = commerceActionLedgerFor(db as never)
    ledger.start(action)
    expect(ledger.list({ limit: 1 })[0]).toMatchObject({ status: 'running', sideEffectStarted: false })
    ledger.record(action, { actionType: action.type, status: 'RECOVERY_REQUIRED', reasonCode: 'SIDE_EFFECT', safeMessage: 'read back', summary: { sideEffectStarted: true }, evidence: { source: 'test', capturedAt: 1 } })
    ledger.start(action)
    expect(ledger.list({ limit: 1 })[0]).toMatchObject({ status: 'recovery_required', sideEffectStarted: true })
    db.close()
  })

  realIt('allows a safe retry to re-enter running after a failed read or confirmation wait', () => {
    const db = new Ctor!(':memory:')
    const shim = { exec: (sql: string) => db.exec(sql), prepare: (sql: string) => db.prepare(sql), transaction: (fn: () => void) => () => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } } }
    migrate(shim as never)
    const action = { type: 'productLibraryList', limit: 10 } as any
    const ledger = commerceActionLedgerFor(db as never)
    ledger.record(action, { actionType: action.type, status: 'FAILED', reasonCode: 'PAGE_NOT_READY', safeMessage: 'retryable', summary: { sideEffectStarted: false }, evidence: { source: 'test', capturedAt: 1 } })
    ledger.start(action)
    expect(ledger.list({ limit: 1 })[0]).toMatchObject({ status: 'running', sideEffectStarted: false })
    ledger.record(action, { actionType: action.type, status: 'WAITING_CONFIRMATION', reasonCode: 'CONFIRMATION_REQUIRED', safeMessage: 'confirm', summary: { sideEffectStarted: false }, evidence: { source: 'test', capturedAt: 2 } })
    ledger.start(action)
    expect(ledger.list({ limit: 1 })[0]).toMatchObject({ status: 'running', sideEffectStarted: false })
    const collection = { type: 'collectBusiness', storeIds: [] } as any
    ledger.start(collection)
    expect(ledger.list({ limit: 10 }).find(entry => entry.actionType === 'collectBusiness')).toMatchObject({ actionType: 'collectBusiness', status: 'running' })
    db.close()
  })
})
