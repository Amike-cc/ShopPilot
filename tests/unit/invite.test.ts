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
      // 二级类目树（2026-09-14 平台级联逐个实测）
      expect(p.categoryTree.length).toBe(22)
      const ge = p.categoryTree.find(c => c.name === '个护家清')!
      expect(ge.children).toContain('个人护理')
      expect(ge.children).toContain('家清纸品')
      // categories 与树的一级一一对应
      expect(p.categories).toEqual(p.categoryTree.map(c => c.name))
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
      // 广场筛选：四个类型页签 + 带货类目 + 其他筛选（真实页面实测 2026-09-14）
      expect(p.finderTypes).toEqual(['全部带货者', '直播带货者', '短视频带货者', '公众号带货者'])
      expect(p.finderCategories).toContain('母婴')
      expect(p.finderCategories).toContain('美妆护肤')
      expect(p.finderOtherFilters).toContain('有联系方式')
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
  const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
  const base = {
    contact: '测试联系人',
    wechat: 'wx_test',
    phone: '13800000000',
    script: '您好，诚邀合作带货',
    scriptMode: 'manual' as const,
    productCount: 1
  }

  // 微信：广场只开一次（分页/筛选是页面内部状态，重载会丢；列表每次加载还会洗牌），
  // 之后是 loop（一轮=一个达人），**无人工确认门禁**，循环到额度用完或翻不动为止
  const wxParts = (steps: any[]) => {
    const opening = steps.slice(0, -1)
    expect(steps[steps.length - 1].type).toBe('loop')
    return { opening, loop: steps[steps.length - 1] }
  }
  const wxRound = (steps: any[]) => {
    const { loop } = wxParts(steps)
    return loop.input.steps as any[]
  }

  it('广场只导航+筛选一次；一轮=一个达人（回广场→详情→邀请带货→表单→发送→校验→回广场）', () => {
    const steps = buildAssistSteps(WX as any, base, 'https://store.weixin.qq.com/shop/findersquare/find')
    const { opening, loop } = wxParts(steps)
    // 开头只导航一次（不再每轮重载：重载会重置分页/筛选，且候选顺序重新洗牌）
    expect(opening[0].type).toBe('navigate')
    expect(opening.some(s => s.type === 'waitForPage')).toBe(true)
    expect(loop.type).toBe('loop')
    expect(loop.input.stopOn).toContain('TASK_QUOTA_EXCEEDED')
    expect(loop.input.stopOn).toContain('TASK_SELECTION_SHORTFALL')
    expect(loop.input.maxRounds).toBeGreaterThan(1)
    const round = wxRound(steps)
    const types = round.map(s => s.type)
    // 一轮开头先切回"一直活着的"广场标签页；轮内不再有 navigate
    expect(types[0]).toBe('useTab')
    expect(types[types.length - 1]).toBe('useTab')
    expect(types).not.toContain('navigate')
    // 额度预检在轮内（额度为 0 → 干净停止）
    expect(types).toContain('requireQuota')
    const quota = round.find(s => s.type === 'requireQuota')!
    expect(quota.input).toEqual({ textIncludes: '今日剩余', min: 1, metric: 'invite.quota', deep: true })
    // 三个联系字段 + 话术 = 4 个 typeText，全部 deep
    const typeTexts = round.filter(s => s.type === 'typeText')
    expect(typeTexts.length).toBe(4)
    for (const t of typeTexts) expect(t.input.deep).toBe(true)
    // 商品自适应步骤
    expect(types).toContain('ensureRows')
    // **没有人工确认门禁**（用户明确要求；点开始即真实发送）
    expect(types).not.toContain('waitForUserConfirmation')
    // 发送 → 等平台确认弹窗 → 确认 → 校验表单商品行消失 → 截图
    const sendIdx = round.findIndex(s => s.type === 'clickByText' && s.input.text === '发送邀约')
    expect(sendIdx).toBeGreaterThan(-1)
    expect(round[sendIdx].input).toMatchObject({ text: '发送邀约', deep: true, mode: 'real' })
    expect(round[sendIdx + 1]).toMatchObject({ type: 'waitForText', input: { text: '确认发送邀约', deep: true } })
    expect(round[sendIdx + 2]).toMatchObject({ type: 'clickByText', input: { text: '确认', deep: true, mode: 'real' } })
    expect(round[sendIdx + 3].type).toBe('waitForGone')
    expect(types).toContain('screenshot')
    // 一轮步骤数在 loop 的 40 步上限内
    expect(round.length).toBeLessThanOrEqual(40)
  })

  it('本页取不出人 → onCode 点「下一页」重试；翻不动 → 由 stopOn 收工', () => {
    const steps = buildAssistSteps(WX as any, base, SQUARE)
    const { loop } = wxParts(steps)
    const rule = (loop.input.onCode || []).find((r: any) => r.code === 'TASK_PAGE_EXHAUSTED')!
    expect(rule).toBeTruthy()
    expect(rule.limit).toBeGreaterThan(1)
    expect(rule.steps.some((s: any) => s.type === 'clickByText' && s.input.text === '下一页')).toBe(true)
    // 「下一页」点不到 / 末页置灰 → 都报 SELECTION_SHORTFALL → 命中 stopOn，正常收尾
    const next = rule.steps.find((s: any) => s.type === 'clickByText' && s.input.text === '下一页')!
    expect(next.input.missingCode).toBe('TASK_SELECTION_SHORTFALL')
    expect(next.input.disabledCode).toBe('TASK_SELECTION_SHORTFALL')
    expect(loop.input.stopOn).toContain('TASK_SELECTION_SHORTFALL')
  })

  it('筛选在开头应用一次；点不到「详情」=本页取不出（翻页恢复）', () => {
    const steps = buildAssistSteps(WX as any, {
      ...base, finderType: '直播带货者', finderCategories: ['母婴'], finderOtherFilters: ['有联系方式']
    }, 'https://store.weixin.qq.com/shop/findersquare/find')
    const { opening } = wxParts(steps)
    const openTexts = opening.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(openTexts).toContain('直播带货者')
    expect(openTexts).toContain('母婴')
    expect(openTexts).toContain('有联系方式')
    const round = wxRound(steps)
    const texts = round.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    // 进达人详情：取不出就按 PAGE_EXHAUSTED 交给 onCode 翻页（而不是直接收工）
    const detail = round.find(s => s.type === 'clickByText' && String(s.input.text) === '详情')!
    expect(detail.input.missingCode).toBe('TASK_PAGE_EXHAUSTED')
    // 平台点「详情」是 window.open 开新标签页（页面本身不跳转）→ 必须带 followTab，
    // 否则引擎留在旧标签页等 finder-detail，整轮超时失败（2026-09-14 真店实测）
    // 详情点击：广场必须留着（分页/筛选是页面内部状态，关了就得重载 → 分页丢、名单重洗）
    expect(detail.input.followTab).toMatchObject({ urlIncludes: 'finder-detail', closeOld: false })
    // 选人靠"还没点过的第一条"：列表每次加载都会洗牌，"第几条"保证不了换人
    expect(detail.input.nth).toBe('unvisited')
    // 详情页的「邀请带货」是普通 BUTTON、点击后**同标签页 pushState** 到 initiate-invite
    // （真站实测）——不能配 followTab，否则白等 40s 新标签页
    const invite = round.find(s => s.type === 'clickByText' && String(s.input.text) === '邀请带货')!
    expect(invite.input.followTab).toBeUndefined()
    expect(invite.input.mode).toBe('real')
    // 点击可能被"SPA 还没挂事件"吃掉（实测 3s 失败 / 4s 成功）→ 用 waitUrl 轮询地址并在未跳转时重试点击
    expect(invite.input.waitUrl).toMatchObject({ includes: 'initiate-invite' })
    expect((invite.input.waitUrl as any).attempts).toBeGreaterThan(1)
    expect(texts).toContain('邀请带货')
    // 轮内仍应等待详情页/表单页
    for (const inc of ['finder-detail', 'initiate-invite']) {
      expect(round.some(s => s.type === 'waitForPage' && String(s.input.urlIncludes) === inc)).toBe(true)
    }
    // 不传筛选时不该出现这些点击
    const step2 = buildAssistSteps(WX as any, base, SQUARE)
    const openTexts2 = wxParts(step2).opening.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(openTexts2).not.toContain('直播带货者')
  })

  it('邀约商品：填了商品ID走 ensureRowsById（按ID指定），没填走 ensureRows（按数量）', () => {
    const withIds = wxRound(buildAssistSteps(WX as any, { ...base, productIds: ['10000687986563', '10000687986564'] }, SQUARE))
    const byId = withIds.find(s => s.type === 'ensureRowsById')!
    expect(byId).toBeTruthy()
    expect(byId.input.productIds).toEqual(['10000687986563', '10000687986564'])
    expect(byId.input.deep).toBe(true)
    expect(String(byId.input.addText)).toBe('添加商品')
    expect(withIds.some(s => s.type === 'ensureRows')).toBe(false)

    const noIds = wxRound(buildAssistSteps(WX as any, base, SQUARE))
    expect(noIds.some(s => s.type === 'ensureRowsById')).toBe(false)
    const byCount = noIds.find(s => s.type === 'ensureRows')!
    expect(byCount.input).toMatchObject({ min: 1, max: 1, deep: true })
  })

  it('微信号/手机号留空则不生成对应步骤', () => {
    const steps = wxRound(buildAssistSteps(WX as any, { ...base, wechat: '', phone: '' }, SQUARE))
    const sels = steps.filter(s => s.type === 'typeText').map(s => String(s.input.selector))
    expect(sels.some(s => s.includes('微信号'))).toBe(false)
    expect(sels.some(s => s.includes('手机号码'))).toBe(false)
    expect(sels.some(s => s.includes('邀约联系人'))).toBe(true)
  })

  it('AI 模式：aiGenerate(deep) + readText 落库，不生成手填 typeText 话术', () => {
    const steps = wxRound(buildAssistSteps(WX as any, { ...base, scriptMode: 'ai' as const }, SQUARE))
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
  const build = (over: Partial<Parameters<typeof buildBatchSteps>[1]> = {}) => buildBatchSteps(DD as any, {
    category: '生鲜', levels: ['LV0', 'LV1'], count: 40,
    script: '合作话术', scriptMode: 'manual', benefits: ['专属高佣'], ...over
  }, 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square')

  /** 取出 loop 里的一轮步骤（整条序列现在只有一个 loop 步骤包着一轮动作） */
  const roundSteps = (steps: any[]) => {
    expect(steps).toHaveLength(1)
    expect(steps[0].type).toBe('loop')
    return steps[0].input.steps as any[]
  }

  it('整条序列是一轮 loop（不是单次执行）：发送后继续下一轮，直到额度用完/可选不足', () => {
    const steps = build()
    expect(steps).toHaveLength(1)
    const loop = steps[0]
    expect(loop.type).toBe('loop')
    expect(loop.input.maxRounds).toBeGreaterThan(1)
    // stopOn 里两个"正常收尾"错误码：额度用完 + 可选达人不足
    expect(loop.input.stopOn).toContain('TASK_QUOTA_EXCEEDED')
    expect(loop.input.stopOn).toContain('TASK_SELECTION_SHORTFALL')
    // 标签里带上本轮口径，界面/日志能看出循环参数
    expect(String(loop.input.label)).toContain('生鲜')
    expect(String(loop.input.label)).toContain('每批 40 位')
    // loop 的 timeoutMs 不能超过引擎上限（否则任务创建阶段就被拒）
    expect(loop.timeoutMs).toBeUndefined()
    expect(taskCreateSchema.safeParse({ name: '达人邀约 · 抖店', storeScope: 'store_x', steps }).success).toBe(true)
  })

  it('一轮内部顺序：广场 → 类目(chip+级联项+校验) → 等级 → 搜索 → 逐个勾选 → 抽屉 → 额度预检 → 话术 → 确认发送 → 抽屉关闭校验 → 截图', () => {
    const round = roundSteps(build())
    const types = round.map(s => s.type)
    expect(types[0]).toBe('navigate')

    // 类目：chip + 级联项 + 校验（只点 chip 筛选不生效，这是实测修掉的缺陷）
    const catChip = round.find(s => s.type === 'clickByText' && String(s.input.text) === '生鲜')!
    expect(catChip.input.within).toEqual({ selector: DD.categoryChipScope })
    const catLeaf = round.find(s => s.type === 'clickByText' && String(s.input.text) === '不限')!
    expect(catLeaf.input.within).toEqual({ selector: DD.categoryPopoverSelector })
    const catVerify = round.find(s => s.type === 'waitForText')!
    expect(String(catVerify.input.text)).toBe('生鲜')
    expect(catVerify.input.within).toEqual({ text: '已筛选', climb: 1 })
    // 顺序：chip → 叶子；校验在列表出现之后（勾人之前）
    expect(types.indexOf('clickByText')).toBeLessThan(types.lastIndexOf('clickByText'))
    expect(types.indexOf('waitForText')).toBeGreaterThan(types.indexOf('waitForSelector'))
    expect(types.indexOf('waitForText')).toBeLessThan(types.indexOf('clickAll'))

    // 逐个勾选：clickAll 限定 tbody（不含表头全选），上限取用户设定值，允许滚动续选
    const clickAll = round.find(s => s.type === 'clickAll')!
    expect(clickAll.input).toMatchObject({ selector: 'tbody input[type=checkbox]', max: 40, scroll: true })

    // 抽屉打开后、发送前先做「确认发送」可用性（额度）预检
    const requireEnabled = round.find(s => s.type === 'requireEnabled')!
    expect(String(requireEnabled.input.text)).toBe('确认发送')
    expect(types.indexOf('requireEnabled')).toBeLessThan(types.lastIndexOf('clickByText'))

    // **没有**人工确认门禁（用户明确要求抖店不再二次确认）
    expect(types).not.toContain('waitForUserConfirmation')

    // 发送后必须校验结果（抽屉关闭）并截图留档
    expect(types.indexOf('waitForGone')).toBeGreaterThan(types.lastIndexOf('clickByText'))
    expect(types[types.length - 1]).toBe('screenshot')

    // 不应出现微信专属步骤
    for (const t of ['mirrorTabUrl', 'typeText', 'ensureRows', 'requireQuota']) expect(types).not.toContain(t)
  })

  it('二级类目：选了二级就点二级项并连带校验；不选则点「不限」', () => {
    // 选二级：级联里点的是二级名（不是「不限」），且「已筛选」要同时校验一级与二级
    const round = roundSteps(build({ category: '个护家清', subcategory: '家清纸品' }))
    const texts = round.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(texts).toContain('个护家清')
    expect(texts).toContain('家清纸品')
    expect(texts).not.toContain('不限')
    const verifies = round.filter(s => s.type === 'waitForText').map(s => String(s.input.text))
    expect(verifies).toEqual(['个护家清', '家清纸品'])
    // loop 标签带上二级
    expect(String(build({ category: '个护家清', subcategory: '家清纸品' })[0].input.label)).toContain('个护家清/家清纸品')

    // 二级留空 → 点「不限」（整个一级）
    const round2 = roundSteps(build({ category: '个护家清', subcategory: '' }))
    const texts2 = round2.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(texts2).toContain('不限')
    expect(texts2).not.toContain('家清纸品')
    expect(round2.filter(s => s.type === 'waitForText')).toHaveLength(1)

    // 一级不筛 → 不生成类目相关步骤（不猜、不多点）
    const round3 = roundSteps(build({ category: '', subcategory: '' }))
    const types3 = round3.map(s => s.type)
    expect(types3).not.toContain('waitForText')
    expect(round3.some(s => s.type === 'clickByText' && String(s.input.text) === '不限')).toBe(false)
  })

  it('不选类目时不生成类目相关步骤（不猜、不多点）', () => {
    const round = roundSteps(build({ category: '' }))
    const types = round.map(s => s.type)
    expect(types).not.toContain('waitForText')
    expect(round.some(s => s.type === 'clickByText' && String(s.input.text) === '不限')).toBe(false)
  })

  it('AI 模式在轮内走 aiGenerate + readText 留档（不在门禁后）', () => {
    const round = roundSteps(build({ scriptMode: 'ai' }))
    const types = round.map(s => s.type)
    expect(types).toContain('aiGenerate')
    expect(types).toContain('readText')
    expect(types.indexOf('aiGenerate')).toBeGreaterThan(types.indexOf('requireEnabled'))
    expect(types.indexOf('aiGenerate')).toBeLessThan(types.lastIndexOf('clickByText'))
  })
})

describe('buildInviteSteps 分派与 urlPathHint', () => {
  it('按档案 flow 分派；配置缺失时明确报错', () => {
    expect(() => buildInviteSteps(WX, {}, 'https://x')).toThrow('assist')
    expect(() => buildInviteSteps(DD, {}, 'https://x')).toThrow('batch')
    const steps = buildInviteSteps(WX, { assist: { contact: 'a', wechat: 'wx', phone: '13800000000', script: 'b', scriptMode: 'manual', productCount: 1 } }, 'https://x')
    // 微信：先开广场（navigate 一次），随后才是 loop（每轮一个达人）
    expect(steps[0].type).toBe('navigate')
    expect(steps[steps.length - 1].type).toBe('loop')
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
    expect(stepInputSchemas.ensureRowsById.safeParse({
      rowsSelector: 'tbody tr', checkboxSelector: 'tbody label',
      addText: '添加商品', confirmText: '确认', productIds: ['10000687986563'], deep: true
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

  it('followTab（点完跟到新标签页）：可选、键受白名单约束', () => {
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', deep: true, mode: 'real', followTab: { urlIncludes: 'finder-detail' } }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', followTab: { closeOld: false } }).success).toBe(true)
    // 多余键/非法值一律拒绝（不接受任何"额外行为"入口）
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', followTab: { urlIncludes: 'x', evil: 1 } }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', followTab: 'yes' }).success).toBe(false)
  })

  it('waitUrl（点后应同标签页跳转）：includes 必填、attempts 有上限、拒绝多余键', () => {
    expect(stepInputSchemas.clickByText.safeParse({ text: '邀请带货', deep: true, mode: 'real', waitUrl: { includes: 'initiate-invite', attempts: 4 } }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: '邀请带货', waitUrl: { includes: 'x' } }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: '邀请带货', waitUrl: {} }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '邀请带货', waitUrl: { includes: 'x', attempts: 0 } }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '邀请带货', waitUrl: { includes: 'x', attempts: 9 } }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '邀请带货', waitUrl: { includes: 'x', evil: 1 } }).success).toBe(false)
  })

  it('nth：两种取值都要 mode:"real"；值只有 round / unvisited', () => {
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', deep: true, mode: 'real', nth: 'round' }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', deep: true, mode: 'real', nth: 'unvisited' }).success).toBe(true)
    // 没有真实鼠标点击就没有"第几条/哪一条"可言 → 拒绝
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', nth: 'round' }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', nth: 'unvisited' }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', mode: 'js', nth: 'unvisited' }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', mode: 'real', nth: 'first' }).success).toBe(false)
  })

  it('disabledCode：禁用态可指定错误码（翻页按钮末页置灰 = 没有更多，不是平台限制）', () => {
    expect(stepInputSchemas.clickByText.safeParse({ text: '下一页', deep: true, mode: 'real', disabledCode: 'TASK_SELECTION_SHORTFALL' }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: '下一页', disabledCode: 'x'.repeat(41) }).success).toBe(false)
  })

  it('useTab：path 与 urlIncludes 二选一；拒绝多余键', () => {    expect(stepInputSchemas.useTab.safeParse({ path: '/shop/findersquare/find' }).success).toBe(true)
    expect(stepInputSchemas.useTab.safeParse({ urlIncludes: 'findersquare/find', closeCurrent: false }).success).toBe(true)
    expect(stepInputSchemas.useTab.safeParse({ path: '/a', urlIncludes: 'b' }).success).toBe(false)
    expect(stepInputSchemas.useTab.safeParse({}).success).toBe(false)
    expect(stepInputSchemas.useTab.safeParse({ path: '/a', evil: 1 }).success).toBe(false)
  })

  it('loop.onCode：恢复步骤同样走白名单（未登记类型/超量被拒）', () => {
    const okRule = { code: 'TASK_PAGE_EXHAUSTED', limit: 3, steps: [{ type: 'clickByText', input: { text: '下一页', deep: true, mode: 'real' } }] }
    const base = { label: 'x', maxRounds: 2, stopOn: ['TASK_QUOTA_EXCEEDED'], steps: [{ type: 'navigate', input: { url: 'https://a.b/c' } }] }
    expect(stepInputSchemas.loop.safeParse({ ...base, onCode: [okRule] }).success).toBe(true)
    // 恢复步骤里的未登记类型 → 整条被拒
    expect(stepInputSchemas.loop.safeParse({ ...base, onCode: [{ ...okRule, steps: [{ type: 'runArbitraryCode', input: {} }] }] }).success).toBe(false)
    // 恢复步骤里的多余字段 → 被拒
    expect(stepInputSchemas.loop.safeParse({ ...base, onCode: [{ ...okRule, steps: [{ type: 'screenshot', input: {}, evil: 1 }] }] }).success).toBe(false)
    // 规则本身的多余键 → 被拒
    expect(stepInputSchemas.loop.safeParse({ ...base, onCode: [{ ...okRule, evil: 1 }] }).success).toBe(false)
  })

  it('within 限定范围：selector 与 text 二选一，climb 有上限', () => {
    expect(stepInputSchemas.clickByText.safeParse({ text: '不限', within: { selector: '.pop' } }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: '生鲜', within: { selector: '.x', text: 'y' } }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '生鲜', within: {} }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '生鲜', within: { text: '已筛选', climb: 99 } }).success).toBe(false)
    expect(stepInputSchemas.waitForText.safeParse({ text: '生鲜', within: { text: '已筛选', climb: 1 } }).success).toBe(true)
    expect(stepInputSchemas.waitForText.safeParse({ text: 'x', within: { selector: '.p', evil: 1 } }).success).toBe(false)
  })

  it('loop：嵌套步骤逐一过白名单（未登记类型/多余字段都被拒）', () => {
    const ok = {
      label: '每批 40 位',
      maxRounds: 20,
      stopOn: ['TASK_QUOTA_EXCEEDED'],
      steps: [
        { type: 'navigate', input: { url: 'https://example.com/a' } },
        { type: 'clickByText', input: { text: '不限', within: { selector: '.pop' } } },
        { type: 'screenshot', input: {} }
      ]
    }
    expect(stepInputSchemas.loop.safeParse(ok).success).toBe(true)
    expect(stepInputSchemas.loop.safeParse({ ...ok, maxRounds: 0 }).success).toBe(false)
    expect(stepInputSchemas.loop.safeParse({ ...ok, stopOn: [] }).success).toBe(false)
    expect(stepInputSchemas.loop.safeParse({ ...ok, steps: [] }).success).toBe(false)
    expect(stepInputSchemas.loop.safeParse({ ...ok, extra: 1 }).success).toBe(false)
    // 嵌套里塞未登记的类型：schema 会拒（类型枚举来自 TASK_STEP_TYPES）
    expect(stepInputSchemas.loop.safeParse({
      ...ok, steps: [{ type: 'runArbitraryJs', input: {} }]
    }).success).toBe(false)
    expect(stepInputSchemas.loop.safeParse({
      ...ok, steps: [{ type: 'navigate', input: { url: 'https://example.com' }, evil: 1 }]
    }).success).toBe(false)
  })

  it('taskCreateSchema 接受完整微信邀约任务', () => {
    const steps = buildAssistSteps(WX as any, {
      contact: '测试联系人', wechat: 'wx', phone: '13800000000', script: '话术', scriptMode: 'manual', productCount: 1
    }, 'https://store.weixin.qq.com/shop/findersquare/find')
    const parsed = taskCreateSchema.safeParse({
      name: '达人邀约 · 微信小店 · 逐个邀约 · 测试联系人',
      storeScope: 'store_x',
      steps
    })
    expect(parsed.success).toBe(true)
  })

  it('长联系方式也必须能建（loop.label 上限 60 字——实测超限会让创建整单被拒）', () => {
    const steps = buildAssistSteps(WX as any, {
      contact: '深圳市宝安区某某贸易商行客服部张经理',
      wechat: 'wxid_very_long_account_name_001',
      phone: '13800000000',
      script: '话术', scriptMode: 'manual', productCount: 1,
      productIds: ['10000687986563', '10000687986564'],
      finderType: '直播带货者', finderCategories: ['母婴', '美妆护肤'], finderOtherFilters: ['有联系方式']
    }, 'https://store.weixin.qq.com/shop/findersquare/find')
    const label = String(steps[0].input.label)
    expect(label.length).toBeLessThanOrEqual(60)
    const parsed = taskCreateSchema.safeParse({
      name: '达人邀约 · 微信小店 · 逐个邀约 · 长联系方式',
      storeScope: 'store_x',
      steps
    })
    if (!parsed.success) console.error(parsed.error.issues.slice(0, 5))
    expect(parsed.success).toBe(true)
  })
})
