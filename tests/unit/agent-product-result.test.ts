import { describe, expect, it } from 'vitest'
import { agentSoftwareActionResultSchema } from '@shared/contracts/agent-software'

describe('商品域 Agent 结构化回执契约', () => {
  it('要求状态、原因、摘要和脱敏证据字段', () => {
    const result = agentSoftwareActionResultSchema.parse({
      actionType: 'productSync',
      status: 'PARTIAL',
      reasonCode: 'PAGE_CHANGED',
      safeMessage: '页面结构发生变化，本次没有写入脏数据',
      summary: { storeId: 'store_a', platform: '微信小店', fetched: 0 },
      evidence: { source: 'product_sync_runs', capturedAt: Date.now(), runId: null, counts: { fetched: 0, inserted: 0 } }
    })
    expect(result.status).toBe('PARTIAL')
    expect(result.evidence?.source).toBe('product_sync_runs')
  })

  it('拒绝脚本、URL、Cookie 和任意额外字段', () => {
    expect(agentSoftwareActionResultSchema.safeParse({
      actionType: 'productList', status: 'SUCCEEDED', reasonCode: 'LOCAL_QUERY', safeMessage: 'ok',
      summary: {}, script: 'javascript:alert(1)'
    }).success).toBe(false)
  })
})
