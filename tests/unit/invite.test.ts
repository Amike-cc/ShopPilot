import { describe, it, expect } from 'vitest'
import {
  INVITE_PROFILES, INVITE_SUPPORTED_PLATFORMS, inviteProfileFor,
  isBatchProfile, isAssistProfile
} from '../../packages/shared/src/constants/invite'
import { buildInviteSteps, buildAssistSteps, buildBatchSteps, urlPathHint } from '../../packages/shared/src/invite-steps'
import { stepInputSchemas, taskCreateSchema } from '../../apps/desktop/src/main/tasks/task-step-schemas'

// ---------- 平台档案（每个平台的达人邀约功能相互独立） ----------

describe('达人邀约平台档案', () => {
  it('抖店保持 batch-list 流程与原有实测参数不变', () => {
    const p = inviteProfileFor('抖店')
    expect(p).toBeTruthy()
    expect(isBatchProfile(p!)).toBe(true)
    if (isBatchProfile(p!)) {
      expect(p.maxBatch).toBe(40)
      expect(p.scriptMaxLen).toBe(150)
      expect(p.maxProducts).toBe(5)
      expect(p.rowCheckboxSelector).toBe('tbody input[type=checkbox]')
      expect(p.texts.batchInvite).toBe('批量邀约带货')
    }
  })

  it('微信小店为 assist-form 流程，实测参数入档', () => {
    const p = inviteProfileFor('微信小店')
    expect(p).toBeTruthy()
    expect(isAssistProfile(p!)).toBe(true)
    if (isAssistProfile(p!)) {
      expect(p.scriptMaxLen).toBe(200)
      expect(p.inviteUrlMarker).toBe('initiate-invite')
      expect(p.pageUrl).toBe('https://store.weixin.qq.com/shop/findersquare/find')
      expect(p.selectors.script).toContain('合作说明')
      expect(p.texts.sendInvite).toBe('发送邀约')
      expect(p.texts.dialogMarker).toBe('确认发送邀约')
    }
  })

  it('已支持平台列表包含两家，未实现平台返回 null（不猜测）', () => {
    expect(INVITE_SUPPORTED_PLATFORMS).toContain('抖店')
    expect(INVITE_SUPPORTED_PLATFORMS).toContain('微信小店')
    expect(inviteProfileFor('拼多多')).toBeNull()
    expect(inviteProfileFor(null)).toBeNull()
    expect(Object.keys(INVITE_PROFILES).length).toBe(INVITE_SUPPORTED_PLATFORMS.length)
  })
})

// ---------- 步骤构造 ----------

const WX = inviteProfileFor('微信小店')!
const DD = inviteProfileFor('抖店')!

describe('微信小店（assist-form）步骤构造', () => {
  const base = {
    contact: '测试联系人',
    wechat: 'wx_test',
    phone: '13800000000',
    script: '您好，诚邀合作带货',
    scriptMode: 'manual' as const,
    productCount: 1
  }

  it('完整序列：镜像邀约页 → 额度预检 → 填表 → 商品 → 门禁 → 发送 → 等弹窗 → 确认 → 截图', () => {
    const steps = buildAssistSteps(WX as any, base)
    const types = steps.map(s => s.type)
    expect(types[0]).toBe('mirrorTabUrl')
    expect(steps[0].input).toEqual({ urlIncludes: 'initiate-invite' })
    expect(types[1]).toBe('waitForPage')
    // 额度先行：镜像后立即检测「今日剩余N次」
    expect(types[2]).toBe('requireQuota')
    expect(steps[2].input).toEqual({ textIncludes: '今日剩余', min: 1, metric: 'invite.quota', deep: true })
    // 三个联系字段 + 话术 = 4 个 typeText，全部 deep
    const typeTexts = steps.filter(s => s.type === 'typeText')
    expect(typeTexts.length).toBe(4)
    for (const t of typeTexts) expect(t.input.deep).toBe(true)
    // 商品自适应步骤
    expect(types).toContain('ensureRows')
    // 门禁在发送之前
    expect(types.indexOf('waitForUserConfirmation')).toBeLessThan(types.indexOf('clickByText'))
    // 门禁消息说明"放行即真实发送"
    const gate = steps.find(s => s.type === 'waitForUserConfirmation')!
    expect(String(gate.input.message)).toContain('真实发送')
    expect(String(gate.input.message)).toContain(base.script)
    // 发送 → 等平台确认弹窗 → 确认 → 截图
    const tail = types.slice(types.indexOf('waitForUserConfirmation'))
    expect(tail).toEqual([
      'waitForUserConfirmation', 'clickByText', 'waitForText', 'clickByText', 'screenshot'
    ])
    const send = steps[types.indexOf('waitForUserConfirmation') + 1]
    expect(send.input).toEqual({ text: '发送邀约', deep: true, mode: 'real' })
    const waitForDialog = steps[types.indexOf('waitForUserConfirmation') + 2]
    expect(waitForDialog.input).toEqual({ text: '确认发送邀约', deep: true })
    const confirm = steps[types.indexOf('waitForUserConfirmation') + 3]
    expect(confirm.input).toEqual({ text: '确认', deep: true, mode: 'real' })
    // 步骤总数必须在引擎 30 步上限内
    expect(steps.length).toBeLessThanOrEqual(30)
  })

  it('微信号/手机号留空则不生成对应步骤', () => {
    const steps = buildAssistSteps(WX as any, { ...base, wechat: '', phone: '' })
    const sels = steps.filter(s => s.type === 'typeText').map(s => String(s.input.selector))
    expect(sels.some(s => s.includes('微信号'))).toBe(false)
    expect(sels.some(s => s.includes('手机号码'))).toBe(false)
    expect(sels.some(s => s.includes('邀约联系人'))).toBe(true)
  })

  it('AI 模式：aiGenerate(deep) + readText 落库，不生成手填 typeText 话术', () => {
    const steps = buildAssistSteps(WX as any, { ...base, scriptMode: 'ai' as const })
    const types = steps.map(s => s.type)
    expect(types).toContain('aiGenerate')
    expect(types).toContain('readText')
    const ai = steps.find(s => s.type === 'aiGenerate')!
    expect(ai.input.deep).toBe(true)
    expect(ai.input.maxLen).toBe(200)
    expect(ai.input.sourceSelector).toBe(WX.selectors.goodsSource)
    // 手填话术的 typeText 不应出现（只剩 3 个联系字段）
    expect(steps.filter(s => s.type === 'typeText').length).toBe(3)
  })
})

describe('抖店（batch-list）步骤构造', () => {
  it('保持原有序列：广场 → 筛选 → 批量勾选 → 抽屉 → 额度预检 → 门禁 → 确认发送', () => {
    const steps = buildBatchSteps(DD as any, {
      category: '生鲜', levels: ['LV0', 'LV1'], count: 5,
      script: '合作话术', scriptMode: 'manual', benefits: ['专属高佣']
    }, 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square')
    const types = steps.map(s => s.type)
    expect(types[0]).toBe('navigate')
    expect(types).toContain('clickAll')
    // 抽屉打开后、人工确认门禁前，先做「确认发送」可用性（额度）预检
    const requireEnabled = steps.find(s => s.type === 'requireEnabled')!
    expect(String(requireEnabled.input.text)).toBe('确认发送')
    expect(types.indexOf('requireEnabled')).toBeGreaterThan(types.indexOf('waitForSelector'))
    expect(types.indexOf('requireEnabled')).toBeLessThan(types.indexOf('waitForUserConfirmation'))
    // 门禁在最后一个 clickByText（确认发送）之前
    expect(types.indexOf('waitForUserConfirmation')).toBeLessThan(types.lastIndexOf('clickByText'))
    const gate = steps.find(s => s.type === 'waitForUserConfirmation')!
    expect(String(gate.input.message)).toContain('类目 生鲜')
    // 不应出现微信专属步骤
    for (const t of ['mirrorTabUrl', 'typeText', 'ensureRows', 'requireQuota']) expect(types).not.toContain(t)
  })
})

describe('buildInviteSteps 分派与 urlPathHint', () => {
  it('按档案 flow 分派；配置缺失时明确报错', () => {
    expect(() => buildInviteSteps(WX, {}, 'https://x')).toThrow('assist')
    expect(() => buildInviteSteps(DD, {}, 'https://x')).toThrow('batch')
    const steps = buildInviteSteps(WX, { assist: { contact: 'a', script: 'b', scriptMode: 'manual', productCount: 1 } }, 'https://x')
    expect(steps[0].type).toBe('mirrorTabUrl')
  })
  it('urlPathHint 取末段路径', () => {
    expect(urlPathHint('https://store.weixin.qq.com/shop/findersquare/find')).toBe('find')
    expect(urlPathHint('not-a-url')).toBe('not-a-url')
  })
})

// ---------- 步骤输入白名单（Zod） ----------

describe('任务步骤输入 schema', () => {
  it('微信新步骤全部可过校验', () => {
    expect(stepInputSchemas.mirrorTabUrl.safeParse({ urlIncludes: 'initiate-invite' }).success).toBe(true)
    expect(stepInputSchemas.typeText.safeParse({ selector: 'textarea', text: 'hi', deep: true }).success).toBe(true)
    expect(stepInputSchemas.waitForText.safeParse({ text: '确认发送邀约', deep: true }).success).toBe(true)
    expect(stepInputSchemas.ensureRows.safeParse({
      rowsSelector: 'tbody tr', checkboxSelector: 'tbody label',
      addText: '添加商品', confirmText: '确认', min: 1, max: 3, deep: true
    }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: '发送邀约', deep: true, mode: 'real' }).success).toBe(true)
    expect(stepInputSchemas.requireQuota.safeParse({ textIncludes: '今日剩余', min: 1, metric: 'invite.quota', deep: true }).success).toBe(true)
    expect(stepInputSchemas.requireEnabled.safeParse({ text: '确认发送', hint: '额度用尽' }).success).toBe(true)
  })

  it('strict 白名单：多余键与非法值被拒', () => {
    expect(stepInputSchemas.typeText.safeParse({ selector: 'a', text: 'x', evil: 'code' }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', mode: 'execute' }).success).toBe(false)
    expect(stepInputSchemas.ensureRows.safeParse({ rowsSelector: 'a', max: 1 }).success).toBe(false)
    expect(stepInputSchemas.requireQuota.safeParse({ textIncludes: 'x' }).success).toBe(false)
    expect(stepInputSchemas.requireEnabled.safeParse({ text: 'x', extra: 1 }).success).toBe(false)
  })

  it('taskCreateSchema 接受完整微信邀约任务', () => {
    const steps = buildAssistSteps(WX as any, {
      contact: '测试联系人', wechat: 'wx', script: '话术', scriptMode: 'manual', productCount: 1
    })
    const parsed = taskCreateSchema.safeParse({
      name: '达人邀约 · 微信小店 · 辅助填单 · 测试联系人',
      storeScope: 'store_x',
      steps
    })
    expect(parsed.success).toBe(true)
  })
})
