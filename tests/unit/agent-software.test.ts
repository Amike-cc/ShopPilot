import { describe, expect, it } from 'vitest'
import {
  AGENT_PACK_FORMAT,
  AGENT_PACK_VERSION,
  agentPackExportInputSchema,
  agentPackImportInputSchema,
  agentPackSchema,
  agentPlanGenerateInputSchema,
  agentSoftwareActionSchema,
  agentSoftwareContextSchema,
  agentSoftwarePlanSchema
} from '@shared/schemas/agent'
import { AGENT_CONFIRM_REQUIRED_ACTIONS, AGENT_SIDE_EFFECT_SOFTWARE_ACTIONS } from '@shared/agent-domain-rules'
import { collectionDispatchResult } from '../../apps/desktop/src/main/services/agent-service'

describe('Agent software scope', () => {
  it('returns an explicit unverified receipt when a collection dispatch adds no jobs', () => {
    expect(collectionDispatchResult('collectBusiness', 2, 0)).toMatchObject({ status: 'NOT_VERIFIED', reasonCode: 'NO_JOB_DISPATCHED', summary: { stores: 2, jobs: 0 } })
    expect(collectionDispatchResult('collectBusiness', 2, 1)).toMatchObject({ status: 'PARTIAL', reasonCode: 'BUSINESS_JOB_DISPATCHED', summary: { stores: 2, jobs: 1 } })
  })

  it('accepts only closed application actions', () => {
    expect(agentSoftwareActionSchema.parse({ type: 'displayStore', storeId: 'store_a' })).toEqual({ type: 'displayStore', storeId: 'store_a' })
    expect(agentSoftwareActionSchema.safeParse({ type: 'executeJavaScript', script: 'document.cookie' }).success).toBe(false)
    expect(agentSoftwareActionSchema.safeParse({ type: 'shell', command: 'whoami' }).success).toBe(false)
    expect(agentSoftwareActionSchema.safeParse({ type: 'readFile', path: 'C:\\secret' }).success).toBe(false)
  })

  it('keeps software context bounded and free of runtime handles', () => {
    const context = agentSoftwareContextSchema.parse({
      displayedStoreId: 'store_a',
      activeTab: { storeId: 'store_a', storeName: '店铺 A', tabId: 'tab_a', title: '订单', url: 'https://shop.example/orders' },
      stores: [{ id: 'store_a', name: '店铺 A', platform: '测试平台', status: 'active', isOpen: true, isDisplayed: true, activeTabId: 'tab_a', tabs: [{ id: 'tab_a', title: '订单', url: 'https://shop.example/orders', isActive: true }] }],
      recentTasks: [],
      appLocked: false
    })
    expect(context.stores[0].tabs[0]).not.toHaveProperty('webContents')
    expect(context.recentTasks).toHaveLength(0)
  })

  it('keeps single-agent organization boundaries closed', () => {
    for (const type of ['createAgent', 'activateAgent', 'pauseAgent', 'resumeAgent', 'retireAgent', 'updateAgent', 'bindAgentModel']) {
      expect(agentSoftwareActionSchema.safeParse({ type, agentId: 'agent_a' }).success, type).toBe(false)
    }
    expect(agentSoftwareActionSchema.parse({ type: 'openPanel', panel: 'agentTeam' })).toEqual({ type: 'openPanel', panel: 'agentTeam' })
    expect(agentSoftwareActionSchema.safeParse({ type: 'openPanel', panel: 'devtools' }).success).toBe(false)
  })

  it('accepts store/task/backup/memory actions with bounded parameters', () => {
    expect(agentSoftwareActionSchema.parse({ type: 'createStore', name: '店', platform: '抖店' })).toEqual({ type: 'createStore', name: '店', platform: '抖店' })
    expect(agentSoftwareActionSchema.parse({ type: 'collectInvoices', storeIds: [] })).toEqual({ type: 'collectInvoices', storeIds: [] })
    expect(agentSoftwareActionSchema.parse({ type: 'createBackup' })).toEqual({ type: 'createBackup', label: '' })
    expect(agentSoftwareActionSchema.safeParse({ type: 'deleteStorePermanent', storeId: '' }).success).toBe(false)
    expect(agentSoftwareActionSchema.safeParse({ type: 'runTask', taskId: 'x', code: 'rm -rf' }).success).toBe(false)
    expect(agentSoftwareActionSchema.safeParse({ type: 'updateStore', storeId: 's', password: 'x' }).success).toBe(false)
    expect(agentSoftwareActionSchema.parse({ type: 'pauseTaskRun', taskId: 't1' })).toEqual({ type: 'pauseTaskRun', taskId: 't1' })
    expect(agentSoftwareActionSchema.safeParse({ type: 'createBookmark', storeId: 's', title: 'x' }).success).toBe(false)
  })

  it('uses closed order status and requires explicit refund amount', () => {
    expect(agentSoftwareActionSchema.safeParse({ type: 'orderList', storeId: 'store_a', status: 'MAGIC_STATUS' }).success).toBe(false)
    expect(agentSoftwareActionSchema.safeParse({ type: 'refundConfirm', storeId: 'store_a', orderId: 'order_1' }).success).toBe(false)
    expect(agentSoftwareActionSchema.safeParse({ type: 'refundConfirm', storeId: 'store_a', orderId: 'order_1', amountMinor: 500 }).success).toBe(true)
    expect(AGENT_SIDE_EFFECT_SOFTWARE_ACTIONS.has('fulfillmentPrepare')).toBe(true)
    for (const type of ['fulfillmentConfirm', 'refundConfirm']) expect(AGENT_CONFIRM_REQUIRED_ACTIONS.has(type)).toBe(true)
  })

  it('keeps every commerce confirmation action inside the side-effect boundary', () => {
    const commerceConfirmationActions = [
      'productPublishOpen', 'productPublishAccept', 'inventoryWriteback', 'skuWriteback',
      'fulfillmentConfirm', 'refundConfirm', 'entityApply', 'applyEntity',
      'contentPublish', 'adConfirm', 'customerSendReply'
    ]
    for (const type of commerceConfirmationActions) {
      expect(AGENT_CONFIRM_REQUIRED_ACTIONS.has(type), `${type} must require confirmation`).toBe(true)
      expect(AGENT_SIDE_EFFECT_SOFTWARE_ACTIONS.has(type), `${type} must remain side-effectful`).toBe(true)
    }
  })

  it('accepts a bounded conversation history for agent memory', () => {
    expect(agentPlanGenerateInputSchema.parse({ goal: '你好' }).history).toEqual([])
    expect(agentPlanGenerateInputSchema.parse({ goal: '你好', history: [{ role: 'user', text: '暗号是蓝鲸七号' }] }).history).toHaveLength(1)
    expect(() => agentPlanGenerateInputSchema.parse({ goal: '你好', history: Array.from({ length: 65 }, () => ({ role: 'user', text: 'x' })) })).toThrow()
    expect(() => agentPlanGenerateInputSchema.parse({ goal: '你好', history: [{ role: 'system', text: 'x' }] })).toThrow()
  })

  it('defaults team and job summaries to empty arrays in the software context', () => {
    const context = agentSoftwareContextSchema.parse({ displayedStoreId: null, activeTab: null, stores: [], recentTasks: [], appLocked: false })
    expect(context.agents).toEqual([])
    expect(context.jobs).toEqual([])
  })

  it('accepts skill and plugin actions with bounded declarative steps', () => {
    expect(agentSoftwareActionSchema.parse({ type: 'createSkill', name: '每日巡检', steps: [{ type: 'listStores' }] })).toEqual({
      type: 'createSkill', name: '每日巡检', description: '', intent: '', steps: [{ type: 'listStores', input: {} }]
    })
    expect(agentSoftwareActionSchema.parse({ type: 'runSkill', skillId: 'skill_1' })).toEqual({ type: 'runSkill', skillId: 'skill_1' })
    expect(agentSoftwareActionSchema.parse({ type: 'createPlugin', name: '日报', skillIds: ['skill_1'] })).toEqual({ type: 'createPlugin', name: '日报', description: '', skillIds: ['skill_1'] })
    expect(agentSoftwareActionSchema.safeParse({ type: 'createSkill', name: 'x', steps: [] }).success).toBe(false)
    expect(agentSoftwareActionSchema.safeParse({ type: 'createPlugin', name: 'x', skillIds: [] }).success).toBe(false)
    expect(agentSoftwareActionSchema.safeParse({ type: 'createSkill', name: 'x', steps: [{ type: 'listStores', script: 'rm -rf' }] }).success).toBe(false)
    expect(agentSoftwareActionSchema.safeParse({ type: 'runSkill' }).success).toBe(true)
  })

  it('exposes skills in the bounded software context', () => {
    const context = agentSoftwareContextSchema.parse({
      displayedStoreId: null, activeTab: null, stores: [], recentTasks: [], appLocked: false,
      skills: [{ id: 'skill_1', name: '巡检', description: '', stepCount: 2 }]
    })
    expect(context.skills).toHaveLength(1)
    const defaults = agentSoftwareContextSchema.parse({ displayedStoreId: null, activeTab: null, stores: [], recentTasks: [], appLocked: false })
    expect(defaults.skills).toEqual([])
  })

  it('parses a bounded share pack, defaults status/input and rejects code-bearing steps', () => {
    const pack = agentPackSchema.parse({ format: AGENT_PACK_FORMAT, version: AGENT_PACK_VERSION, skills: [{ name: '巡检', steps: [{ type: 'listStores' }] }], plugins: [{ name: '包', skills: ['巡检'] }] })
    expect(pack.skills[0].status).toBe('enabled')
    expect(pack.skills[0].steps[0].input).toEqual({})
    expect(pack.plugins[0].description).toBe('')
    expect(agentPackSchema.safeParse({ format: AGENT_PACK_FORMAT, version: 2, skills: [], plugins: [] }).success).toBe(false)
    expect(agentPackSchema.safeParse({ format: 'other-pack', version: AGENT_PACK_VERSION, skills: [], plugins: [] }).success).toBe(false)
    expect(agentPackSchema.safeParse({ format: AGENT_PACK_FORMAT, version: AGENT_PACK_VERSION, skills: [{ name: 'x', steps: [{ type: 'listStores', script: 'rm -rf' }] }], plugins: [] }).success).toBe(false)
    expect(agentPackSchema.safeParse({ format: AGENT_PACK_FORMAT, version: AGENT_PACK_VERSION, skills: [], plugins: [{ name: '空包', skills: [] }] }).success).toBe(false)
    expect(agentPackImportInputSchema.parse({ json: '{}' }).confirmed).toBe(false)
    expect(agentPackExportInputSchema.parse({}).skillNames).toEqual([])
  })

  it('requires a visible confirmation flag for destructive software plans', () => {
    const base = {
      id: 'plan_1', name: '关闭店铺', goal: '关闭店铺 A',
      steps: [{ id: 'step_1', action: { type: 'closeStore', storeId: 'store_a' }, description: '关闭店铺 A', risk: 'write' as const, requiresConfirmation: true }],
      requiresConfirmation: true, status: 'draft' as const
    }
    expect(agentSoftwarePlanSchema.parse(base).requiresConfirmation).toBe(true)
    expect(agentSoftwarePlanSchema.safeParse({ ...base, steps: [{ ...base.steps[0], requiresConfirmation: false }] }).success).toBe(true)
  })
})
