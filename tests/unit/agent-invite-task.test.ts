import { describe, expect, it } from 'vitest'
import { inviteProfileFor } from '@shared/constants/invite'
import { buildInviteTaskPayload, inviteTaskIssues, normalizeInviteTaskConfig, parseInviteProductIds } from '@shared/invite-task'

const douyin = inviteProfileFor('抖店')!
const wechat = inviteProfileFor('微信小店')!
const kuaishou = inviteProfileFor('快手小店')!

describe('Invite task builder (panel + agent single source)', () => {
  it('builds a batch invite payload from a normalized snapshot with bounded values', () => {
    const config = normalizeInviteTaskConfig('batch-list', {
      category: '美妆', subcategory: '', category3: '', levels: ['LV0', 'LV1'],
      count: 40, script: '你好，合作一下', scriptMode: 'manual', benefits: ['佣金高'],
      strengths: ['工厂直供'], mainCategory: '', extraFilters: { 内容标签: ['美妆'] },
      batchContact: '张三', batchPhone: '13800138000', batchWechat: 'wx_test', batchProductCount: 1
    })
    const issues = inviteTaskIssues({ profile: douyin, config })
    expect(issues, JSON.stringify(issues)).toEqual([])
    const payload = buildInviteTaskPayload({ profile: douyin, storeId: 'store_a', squareUrl: douyin.pageUrl, config })!
    expect(payload).not.toBeNull()
    expect(payload.storeScope).toBe('store_a')
    expect(payload.name).toContain('达人邀约 · 抖店 · 美妆')
    expect(payload.name).toContain(`最多 ${douyin.maxBatch} 位`)
    expect(payload.steps.length).toBeGreaterThan(0)
    expect(JSON.stringify(payload.steps)).toContain('佣金高')
    // 超上限的数量不会被静默收敛：由 inviteTaskIssues 明确报错（见下一个用例）
    expect(inviteTaskIssues({ profile: douyin, config: { ...config, count: 999 } })).toContain('邀约数量需为 1～40 的整数')
  })

  it('reports readable issues instead of guessing missing fields', () => {
    const empty = normalizeInviteTaskConfig('batch-list', {})
    expect(inviteTaskIssues({ profile: douyin, config: empty })).toContain('达人等级未选择')
    expect(inviteTaskIssues({ profile: douyin, config: empty })).toContain('邀约数量需为 1～40 的整数')
    expect(inviteTaskIssues({ profile: douyin, config: empty }).some(issue => issue.includes('联系方式'))).toBe(true)
    expect(buildInviteTaskPayload({ profile: douyin, storeId: 'store_a', squareUrl: douyin.pageUrl, config: empty })).toBeNull()
    // 快手档案声明了三项必填联系方式与话术框（scriptSelector）
    const kuaishouEmpty = normalizeInviteTaskConfig('batch-list', { count: 2, levels: [] })
    expect(inviteTaskIssues({ profile: kuaishou, config: kuaishouEmpty })).toContain('邀约话术未填写')
    expect(inviteTaskIssues({ profile: kuaishou, config: kuaishouEmpty }).some(issue => issue.includes('联系方式'))).toBe(true)
    const fixed = normalizeInviteTaskConfig('batch-list', { count: 2, script: '你好', scriptMode: 'manual', batchContact: '张三', batchPhone: '13800138000', batchWechat: 'wx' })
    expect(inviteTaskIssues({ profile: kuaishou, config: fixed })).toEqual([])
  })

  it('requires contacts and bounded product ids for the assist flow', () => {
    const missing = normalizeInviteTaskConfig('assist-form', { script: '你好', scriptMode: 'manual' })
    const issues = inviteTaskIssues({ profile: wechat, config: missing })
    expect(issues).toContain('联系人未填写')
    expect(issues).toContain('微信号未填写')
    expect(issues).toContain('手机号未填写')
    const ready = normalizeInviteTaskConfig('assist-form', {
      script: '你好', scriptMode: 'manual', contact: '张三', wechat: 'wx', phone: '13800138000',
      productIds: '111,222 111\n333', finderType: '全部带货者', finderCategories: ['美妆']
    })
    expect(ready.productIds).toEqual(['111', '222', '333'])
    const payload = buildInviteTaskPayload({ profile: wechat, storeId: 'store_w', squareUrl: wechat.pageUrl, config: ready })!
    expect(payload.name).toContain('辅助填单')
    expect(JSON.stringify(payload.steps)).toContain('13800138000')
    expect(parseInviteProductIds(Array.from({ length: 40 }, (_, i) => `id_${i}`)).length).toBe(30)
  })

  it('AI script mode is accepted without manual script (engine reports AI_NOT_CONFIGURED honestly)', () => {
    const config = normalizeInviteTaskConfig('batch-list', { count: 3, scriptMode: 'ai', batchContact: '张三', batchPhone: '13800138000', batchWechat: 'wx' })
    const issues = inviteTaskIssues({ profile: kuaishou, config })
    expect(issues, JSON.stringify(issues)).toEqual([])
    expect(buildInviteTaskPayload({ profile: kuaishou, storeId: 'store_k', squareUrl: kuaishou.pageUrl, config })).not.toBeNull()
  })

  it('rejects unknown platforms instead of inventing a profile', () => {
    expect(inviteProfileFor('拼多多')).toBeNull()
  })
})
