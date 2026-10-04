import { describe, it, expect } from 'vitest'
import {
  INVITE_PROFILES, INVITE_SUPPORTED_PLATFORMS, inviteProfileFor,
  isBatchProfile, isAssistProfile
} from '../../packages/shared/src/constants/invite'
import {
  buildInviteSteps, buildAssistSteps, buildBatchSteps,
  hasRequiredBatchContacts, urlPathHint
} from '../../packages/shared/src/invite-steps'
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
      expect(p.categoryDepth).toBe(3)
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

  it('抖店改版抽屉（2026-09-22 真机）：无话术框、结构化表单与必填项都入档', () => {
    const p = inviteProfileFor('抖店')!
    if (!isBatchProfile(p)) throw new Error('抖店应为 batch-list')
    // 抽屉里已没有 textarea → 话术相关字段必须缺席，抽屉判据改用根容器
    expect(p.scriptSelector).toBeUndefined()
    expect(p.drawerSelector).toBe('.auxo-drawer-open')
    // 权益：改版后的 7 项（旧档案的「免费申样/视频素材支持/优质视频投放」已失效），上限 3
    expect(p.benefits).toEqual(['专属高佣', '免费样品', '佣金可谈', '机制可谈', '优质视频投流', '视频素材/脚本支持', '带货指导/陪跑'])
    expect(p.benefitsMax).toBe(3)
    // 核心优势：13 项、上限 5
    expect(p.strengths?.maxSelect).toBe(5)
    expect(p.strengths?.options.length).toBe(13)
    expect(p.strengths?.options).toContain('源头工厂')
    expect(p.strengths?.options).toContain('售后无忧')
    // 主营（消息里的填空）+ 推荐商品开关（必填项的满足方式）
    expect(p.drawerForm?.mainCategory).toEqual({
      triggerSelector: '.auxo-cascader-multiple-wrapper',
      popoverSelector: '.auxo-cascader-menus',
      maxSelect: 1
    })
    expect(p.drawerForm?.goodsSwitch).toEqual({ label: '使用平台推荐商品', selectedMarker: '已添加', min: 1 })
    // 联系方式只有手机号/微信号（没有"联系人"这一项）
    expect(p.contactSelectors?.contact).toBeUndefined()
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
      // 广场筛选：四个类型页签 + 带货类目 + 带货销售总额 + 其他筛选（2026-10-02 真机逐项重测）
      expect(p.finderTypes).toEqual(['全部带货者', '直播带货者', '短视频带货者', '公众号带货者'])
      expect(p.finderCategoryLabel).toBe('带货类目')
      expect(p.finderCategories).toContain('母婴')
      expect(p.finderCategories).toContain('美妆护肤')
      // 34 项，且是**平台当前**的叫法：2026-09-14 那版记的「汽车电动」平台已改名为「汽摩电动」，
      // 按旧文案点只会得到"页面上找不到"（真机实测确认）
      expect(p.finderCategories.length).toBe(34)
      expect(p.finderCategories).toContain('汽摩电动')
      expect(p.finderCategories).not.toContain('汽车电动')
      // 带货销售总额：只是「近30日带货数据」里的一个指标下拉，区间是复选框组（16 档，含「不限」）
      expect(p.finderSalesMetric).toBe('带货销售总额')
      expect(p.finderSalesTiers?.length).toBe(16)
      expect(p.finderSalesTiers?.[0]).toBe('不限')
      expect(p.finderSalesTiers).toContain('￥1万以下')
      expect(p.finderSalesTiers).toContain('￥10万-20万')
      expect(p.finderSalesTiers).toContain('￥700万-1000万')
      expect(p.finderSalesTiers?.at(-1)).toBe('￥1000万以上')
      // 实测：只有「全部带货者」这一档有「带货销售总额」指标（直播/短视频/公众号各只有本类型指标）
      expect(p.finderSalesTypes).toEqual(['全部带货者'])
      // 其他筛选 7 项（2026-09-14 那版只有 2 项）
      expect(p.finderOtherLabel).toBe('其他筛选')
      expect(p.finderOtherFilters).toEqual(['可开发票', '有联系方式', '有认证', '回复率高', '优质带货者', '近期选品活跃', '品牌好物推荐官'])
      expect(p.finderOtherFilters).toContain('有联系方式')
    }
  })

  it('已支持平台列表包含三家，未实现平台返回 null（不猜测）', () => {
    expect(INVITE_SUPPORTED_PLATFORMS).toContain('抖店')
    expect(INVITE_SUPPORTED_PLATFORMS).toContain('微信小店')
    expect(INVITE_SUPPORTED_PLATFORMS).toContain('快手小店')
    expect(inviteProfileFor('拼多多')).toBeNull()
    expect(inviteProfileFor(null)).toBeNull()
    expect(Object.keys(INVITE_PROFILES).length).toBe(INVITE_SUPPORTED_PLATFORMS.length)
  })

  it('快手小店为 batch-list 流程，实测锚点入档（2026-09-15 真机量取）', () => {
    const p = inviteProfileFor('快手小店')
    expect(p).toBeTruthy()
    expect(isBatchProfile(p!)).toBe(true)
    if (!isBatchProfile(p!)) return
    // 入口在**分销后台**，不是商家后台
    expect(p.pageUrl).toBe('https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro')
    // 单批上限 100（抽屉底部明示「今日剩余100条」）；平台要求至少勾 2 位（只勾 1 位点按钮无反应）
    expect(p.maxBatch).toBe(100)
    expect(p.minSelect).toBe(2)
    expect(p.scriptMaxLen).toBe(500)
    expect(p.maxProducts).toBe(10)
    expect(p.categoryDepth).toBe(2)
    // 快手没有「达人等级」筛选 → levels 为空（面板与步骤据此跳过）
    expect(p.levels).toEqual([])
    expect(p.texts.levelTrigger).toBe('')
    // 类目 = 带货类目 18 项，且每项都有实测子类
    expect(p.categories.length).toBe(18)
    expect(p.categories).toEqual(p.categoryTree.map(c => c.name))
    for (const node of p.categoryTree) {
      expect(node.children.length, `${node.name} 应有子类`).toBeGreaterThan(0)
    }
    expect(p.categoryLabelText).toBe('带货类目')
    expect(p.texts.categoryAnyLeaf).toBe('全部')
    // 四行筛选里只有需要用户选的登记为 extraFilterRows（带货类目=主类目、带货数据未做）
    expect(p.extraFilterRows?.map(r => r.label)).toEqual(['内容标签', '合作信息'])
    for (const row of (p.extraFilterRows || [])) expect(row.climb).toBeGreaterThan(0)
    // 抽屉里的必填联系方式
    expect(p.contactSelectors?.contact).toContain('联系人')
    expect(p.contactSelectors?.phone).toContain('手机号')
    expect(p.contactSelectors?.wechat).toContain('微信号')
    // 商品要开弹窗选（含带空格的确认真实文案）
    expect(p.goodsModal?.confirmText).toBe('确 认')
    expect(p.goodsModal?.rootSelector).toContain('modal-body')
    // 额度按页面明示文案取（不是抖店那种"看按钮禁用"）
    expect(p.quotaCheck).toBe('requireQuota')
    expect(p.quota?.textIncludes).toBe('今日剩余')
    expect(p.quota?.min).toBeGreaterThan(0)
    // 类目行容器类名相同 → 用「行标签 + 上溯」
    expect(p.categoryChipScope).toEqual({ text: '带货类目', climb: 2 })
    expect(p.benefitsLabelText).toBe('合作标签')
    expect(p.benefits).toHaveLength(6)
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

  it('每轮重新进广场并应用筛选；一轮=一个达人（进广场→筛选→详情→邀请带货→表单→发送→校验）', () => {
    const steps = buildAssistSteps(WX as any, { ...base, finderType: '直播带货者', finderOtherFilters: ['有联系方式'] }, 'https://store.weixin.qq.com/shop/findersquare/find')
    const { opening, loop } = wxParts(steps)
    expect(loop.type).toBe('loop')
    expect(loop.input.stopOn).toContain('TASK_QUOTA_EXCEEDED')
    expect(loop.input.stopOn).toContain('TASK_SELECTION_SHORTFALL')
    expect(loop.input.maxRounds).toBeGreaterThan(1)
    const round = wxRound(steps)
    const types = round.map(s => s.type)
    /**
     * **筛选必须在轮内**（这是 2026-10-03 真机实测后定下的契约）：
     * 应用只为"当前活动标签页"保留 DOM <webview>，切到详情页再切回来时广场页是**重新加载**的，
     * 页内筛选随之丢失。旧实现把"导航 + 筛选"放在 loop 外面（以为广场页一直活着），
     * 第 1 位没错、第 2 轮起就会在没筛选的名单上继续邀约——所以这里钉死：
     * 每轮自己导航 + 自己筛选，且轮内不再有 useTab。
     */
    expect(types[0]).toBe('navigate')
    expect(types[1]).toBe('waitForPage')
    // 地址到了不等于筛选区渲染好了：先等类目行的行标签出现，再点筛选
    // （真机实测：不等就会点空，报"找不到「全部带货者」/「不限」"）
    expect(types[2]).toBe('waitForText')
    expect(round[2].input).toMatchObject({ text: '带货类目', deep: true })
    const roundTexts = round.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(roundTexts).toContain('直播带货者')
    expect(roundTexts).toContain('有联系方式')
    expect(types).not.toContain('useTab')
    // loop 外面不再有任何筛选点击（否则就是又回到"只应用一次"的旧写法）
    const outside = opening.filter(s => s.type === 'clickByText')
    expect(outside.length).toBe(0)
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
    // 发送 → 等平台确认弹窗 → 确认 → **双判据**（弹窗关闭 + 商品行清空）→ 截图
    const sendIdx = round.findIndex(s => s.type === 'clickByText' && s.input.text === '发送邀约')
    expect(sendIdx).toBeGreaterThan(-1)
    expect(round[sendIdx].input).toMatchObject({ text: '发送邀约', deep: true, mode: 'real' })
    expect(round[sendIdx + 1]).toMatchObject({ type: 'waitForText', input: { text: '确认发送邀约', deep: true } })
    expect(round[sendIdx + 2]).toMatchObject({ type: 'clickByText', input: { text: '确认', deep: true, mode: 'real' } })
    // ① 确认弹窗真的关掉（按文案等消失：弹窗是平台通用组件、没有稳定选择器）
    expect(round[sendIdx + 3]).toMatchObject({ type: 'waitForGone', input: { text: '确认发送邀约', deep: true } })
    // ② 平台清空了「邀约商品」行
    expect(round[sendIdx + 4]).toMatchObject({ type: 'waitForGone', input: { selector: WX.selectors.goodsRows, deep: true } })
    expect(types).toContain('screenshot')
    // 一轮步骤数在 loop 的 80 步上限内（含筛选：极限配置约 78 步）
    expect(round.length).toBeLessThanOrEqual(80)
  })

  it('7 天内邀过的达人：点「详情」时按台账昵称跳过，并回传昵称供记账', () => {
    const withLedger = wxRound(buildAssistSteps(WX as any, { ...base, recentlyInvited: ['恩妹阅读', '郑奶奶科学育儿'] }, SQUARE))
    const detail = withLedger.find(s => s.type === 'clickByText' && String(s.input.text) === '详情')!
    // 台账昵称清单 → 引擎在点「详情」前把这些行剔掉（省一次详情页访问）
    expect(detail.input.skipTexts).toEqual(['恩妹阅读', '郑奶奶科学育儿'])
    // 无论有没有台账，都要回传"这一行是谁"，本轮真发出后写入台账
    expect(detail.input.recordRowText).toBe(true)
    // 没有台账时不生成 skipTexts（不猜），但仍要记账
    const noLedger = wxRound(buildAssistSteps(WX as any, base, SQUARE)).find(s => s.type === 'clickByText' && String(s.input.text) === '详情')!
    expect(noLedger.input.skipTexts).toBeUndefined()
    expect(noLedger.input.recordRowText).toBe(true)
    // 台账清单最多带 500 条（防止任务载荷被撑爆）
    const many = wxRound(buildAssistSteps(WX as any, { ...base, recentlyInvited: Array.from({ length: 600 }, (_, i) => `达人${i}`) }, SQUARE))
      .find(s => s.type === 'clickByText' && String(s.input.text) === '详情')!
    expect((many.input.skipTexts as string[]).length).toBe(500)
  })

  it('额度护栏：本次最多邀约几位 = loop 的轮数上限（平台读不到剩余额度，这是我们唯一的硬上限）', () => {
    // 显式设置 → 原样生效
    const three = wxParts(buildAssistSteps(WX as any, { ...base, maxInvites: 3 }, SQUARE)).loop
    expect(three.input.maxRounds).toBe(3)
    // 缺省 → 面板默认值（10），不是"不限"
    const fallback = wxParts(buildAssistSteps(WX as any, base, SQUARE)).loop
    expect(fallback.input.maxRounds).toBe(10)
    // 坏值 → 收敛到合法区间，绝不变成"无限发"
    expect(wxParts(buildAssistSteps(WX as any, { ...base, maxInvites: 0 }, SQUARE)).loop.input.maxRounds).toBe(10)
    expect(wxParts(buildAssistSteps(WX as any, { ...base, maxInvites: -5 }, SQUARE)).loop.input.maxRounds).toBe(10)
    expect(wxParts(buildAssistSteps(WX as any, { ...base, maxInvites: 999 }, SQUARE)).loop.input.maxRounds).toBe(50)
    expect(wxParts(buildAssistSteps(WX as any, { ...base, maxInvites: 7.6 }, SQUARE)).loop.input.maxRounds).toBe(8)
  })

  it('本页取不出人 → onCode 点「下一页」重试；单个人打不开 → 跳过换人；翻不动 → 由 stopOn 收工', () => {
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
    // 单个达人详情页打不开（微应用间歇性不渲染）→ restart 跳过换人，且带连续跳过上限。
    // 恢复步骤只退避：restart 会**重开本轮**，而本轮第一步就是"重新进广场 + 重新筛选"，
    // 所以不需要（也不该）再插一个 useTab 去切标签页。
    const skip = (loop.input.onCode || []).find((r: any) => r.code === 'TASK_DAREN_PAGE_UNOPENABLE')!
    expect(skip).toBeTruthy()
    expect(skip.restart).toBe(true)
    expect(skip.limit).toBeGreaterThan(1)
    expect(skip.steps.some((s: any) => s.type === 'waitMs')).toBe(true)
    expect(skip.steps.some((s: any) => s.type === 'useTab')).toBe(false)
    // 这一位不满足平台合作条件（页面正常、只是不能邀约）→ advance：换下一位，且**不退避**
    // （不是限流，等多久都一样）。restart 与 advance 的差别在"要不要回滚已访问记录"，
    // 用 restart 会原地重试同一位直到耗尽次数。
    const notInvitable = (loop.input.onCode || []).find((r: any) => r.code === 'TASK_DAREN_NOT_INVITABLE')!
    expect(notInvitable).toBeTruthy()
    expect(notInvitable.advance).toBe(true)
    expect(notInvitable.restart).toBeUndefined()
    expect(notInvitable.limit).toBeGreaterThan(1)
    expect(notInvitable.steps.some((s: any) => s.type === 'useTab')).toBe(false)
    // 这一位 7 天内已邀约过（按钮禁用 + 平台提示）→ 同样 advance 跳过换人。
    // 一批刚发完紧接着再跑时，广场排在前面的往往正是刚邀过的人，不跳过会当场中止。
    const already = (loop.input.onCode || []).find((r: any) => r.code === 'TASK_DAREN_ALREADY_INVITED')!
    expect(already).toBeTruthy()
    expect(already.advance).toBe(true)
    expect(already.limit).toBeGreaterThan(1)
    // "列表到头"（SELECTION_SHORTFALL）不能配 restart，否则永远收不了尾
    expect((loop.input.onCode || []).some((r: any) => r.code === 'TASK_SELECTION_SHORTFALL')).toBe(false)
  })

  it('广场三行筛选：都限定在对应行内、点完回读勾选态（点了没选上就如实失败）', () => {
    const steps = buildAssistSteps(WX as any, {
      ...base,
      finderType: '全部带货者',
      finderCategories: ['汽摩电动'],
      finderSalesTiers: ['￥10万-20万', '￥20万-30万'],
      finderOtherFilters: ['有认证']
    }, SQUARE)
    const round = wxRound(steps)
    const clicks = round.filter(s => s.type === 'clickByText')
    const find = (text: string) => clicks.find(s => String(s.input.text) === text)!

    // 类目：限定「带货类目」行（行标签文字在 DIV 里，上溯 2 层才是行容器）；
    // 折叠态下受信任鼠标点不中行外的 chip → 用默认 JS 点击（真机实测合成 click 在折叠态一样生效）
    const cat = find('汽摩电动')
    expect(cat.input.within).toEqual({ text: '带货类目', climb: 2 })
    expect(cat.input.mode).toBeUndefined()
    expect(cat.input.skipIfChecked).toBe(true)
    expect(cat.input.verifyChecked).toBe(true)
    expect(cat.input.verifyCode).toBe('TASK_FILTER_NOT_APPLIED')
    // 勾选类筛选允许重试：构造上幂等（已勾选则跳过、未勾选才重新定位再点）
    expect(cat.retryLimit).toBe(2)

    /**
     * 带货销售总额：**状态无关**地打开下拉（2026-10-04 真机失败后改）。
     *
     * 旧写法"先点开 → 点档位 → 再点收"依赖"开局一定是收起"；用户连发到第 13 轮时面板已开，
     * "先点开"反而点收了 → `找不到「不限」` → 已发出 12 位的整批中止。
     * 现在：档位步骤带 openVia（不可见才去点 DT），收尾步骤带 onlyIfVisible（只在确实开着时收）。
     */
    const sale = find('￥10万-20万')
    expect(sale.input.within).toEqual({ text: '带货销售总额', climb: 1 })
    expect(sale.input.exact).toBe(true)
    expect(sale.input.skipIfChecked).toBe(true)
    expect(sale.input.verifyChecked).toBe(true)
    expect(sale.input.openVia).toEqual({ text: '带货销售总额', exact: true, deep: true })
    expect(sale.retryLimit).toBe(2)
    expect(clicks.filter(s => String(s.input.text).startsWith('￥')).length).toBe(2)
    const toggles = clicks.filter(s => String(s.input.text) === '带货销售总额')
    expect(toggles.length).toBe(1) // 只剩"条件性收起"（开面板由档位步骤的 openVia 负责）
    expect(toggles[0].input.exact).toBe(true)
    expect(toggles[0].input.onlyIfVisible).toMatchObject({ text: '￥10万-20万', within: { text: '带货销售总额', climb: 1 } })
    // 顺序：两个档位 → 收面板（档位在收起之前）
    const order = clicks.map(s => String(s.input.text))
    expect(order.indexOf('￥20万-30万')).toBeLessThan(order.lastIndexOf('带货销售总额'))

    // 其他筛选：同样限定在「其他筛选」行内，同样允许安全重试
    const other = find('有认证')
    expect(other.input.within).toEqual({ text: '其他筛选', climb: 2 })
    expect(other.input.verifyChecked).toBe(true)
    expect(other.retryLimit).toBe(2)

    // 没配筛选时不生成任何筛选点击（不猜、不多点）
    const none = wxRound(buildAssistSteps(WX as any, base, SQUARE))
      .filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(none).not.toContain('直播带货者')
    expect(none).not.toContain('汽摩电动')
    expect(none).not.toContain('带货销售总额')
    expect(none).not.toContain('有认证')
  })

  it('每轮都重新应用筛选；点不到「详情」=本页取不出（翻页恢复）', () => {
    const steps = buildAssistSteps(WX as any, {
      ...base, finderType: '直播带货者', finderCategories: ['母婴'], finderOtherFilters: ['有联系方式']
    }, 'https://store.weixin.qq.com/shop/findersquare/find')
    const round = wxRound(steps)
    const texts = round.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    // 三个筛选都在轮内（每轮重新点，理由见上面那条用例的契约说明）
    expect(texts).toContain('直播带货者')
    expect(texts).toContain('母婴')
    expect(texts).toContain('有联系方式')
    // 进达人详情：取不出就按 PAGE_EXHAUSTED 交给 onCode 翻页（而不是直接收工）
    const detail = round.find(s => s.type === 'clickByText' && String(s.input.text) === '详情')!
    expect(detail.input.missingCode).toBe('TASK_PAGE_EXHAUSTED')
    // 平台点「详情」是 window.open 开新标签页（页面本身不跳转）→ 必须带 followTab，
    // 否则引擎留在旧标签页等 finder-detail，整轮超时失败（2026-09-14 真店实测）。
    // closeOld:true —— 跟到详情页时关掉广场页：每轮开头会重新导航+筛选，
    // 广场不再需要保活；留着它每轮泄漏一个标签页（实测两轮 123 → 126）。
    expect(detail.input.followTab).toMatchObject({ urlIncludes: 'finder-detail', closeOld: true })
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
    // 这一位打不开（微应用没渲染、按钮不存在）要报专属码，才能被 onCode 跳过换人而不是整批中断
    expect(invite.input.missingCode).toBe('TASK_DAREN_PAGE_UNOPENABLE')
    // 页面正常但平台明说"这一位不满足合作条件"（实测「暂未到达合作门槛」）时，必须与上面那条
    // **分开**：一个要换下一位、一个要重试同一位。缺席判据与专属码都要落在步骤上。
    expect(invite.input.absentText).toBe('暂未到达合作门槛')
    expect(invite.input.absentCode).toBe('TASK_DAREN_NOT_INVITABLE')
    // 按钮存在但禁用（实测平台提示「你已经邀请过该达人，7天内不可再次发送带货邀约」）
    // 也要走"跳过换下一位"而不是中止整单
    expect(invite.input.disabledCode).toBe('TASK_DAREN_ALREADY_INVITED')
    expect(texts).toContain('邀请带货')
    // 轮内仍应等待详情页/表单页
    for (const inc of ['finder-detail', 'initiate-invite']) {
      expect(round.some(s => s.type === 'waitForPage' && String(s.input.urlIncludes) === inc)).toBe(true)
    }
    // 不传筛选时不该出现这些点击（轮内也没有）
    const step2 = buildAssistSteps(WX as any, base, SQUARE)
    const roundTexts2 = wxRound(step2).filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(roundTexts2).not.toContain('直播带货者')
    expect(roundTexts2).not.toContain('母婴')
    expect(roundTexts2).not.toContain('有联系方式')
  })

  it('assist-form 的 aiGenerate 带 retryLimit（模型抖动不该把整批已发出的邀约打成失败）', () => {
    const steps = buildAssistSteps(WX as any, { ...base, scriptMode: 'ai', script: '' }, SQUARE)
    const ai = wxRound(steps).find(s => s.type === 'aiGenerate')!
    expect(ai).toBeTruthy()
    // 生成话术是幂等的（重跑只是重新生成覆盖同一输入框），所以允许瞬态重试
    expect(ai.retryLimit).toBeGreaterThan(0)
    // 非幂等的步骤绝不能带 retryLimit（重放=重复点击/重复发送）
    for (const s of wxRound(steps)) {
      if (s.type === 'clickByText' || s.type === 'typeText') expect(s.retryLimit).toBeUndefined()
    }
  })

  it('邀约商品：填了商品ID按ID精确指定；留空则固定加 1 个（面板已去掉「添加商品数量」）', () => {
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
    // 面板不再让用户填数量，productCount 恒为 1 → 只确保 1 个商品
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

  it('一轮内部顺序：广场 → 类目(chip+级联项+校验) → 等级 → 搜索 → 逐个勾选 → 抽屉 → 额度预检 → 必填项 → 确认发送 → 抽屉关闭校验 → 截图', () => {
    const round = roundSteps(build())
    const types = round.map(s => s.type)
    expect(types[0]).toBe('navigate')

    // 类目：先等筛选区渲染（2026-10-04 快手真机：不等就点，弹层被留在屏幕外 -9999），
    // 再点 chip + 级联项 + 校验（只点 chip 筛选不生效，这是实测修掉的缺陷）
    const filterReady = round.find(s => s.type === 'waitForText' && String(s.input.text) === DD.texts.categoryLabel)!
    expect(filterReady.input.within).toBeUndefined()
    const catChip = round.find(s => s.type === 'clickByText' && String(s.input.text) === '生鲜')!
    expect(catChip.input.within).toEqual({ selector: DD.categoryChipScope })
    const catLeaf = round.find(s => s.type === 'clickByText' && String(s.input.text) === '不限')!
    expect(catLeaf.input.within).toEqual({ selector: DD.categoryPopoverSelector })
    // 生效校验：按锚点文案上溯定位（抖店），不是那个"等筛选区"的步骤
    const catVerify = round.find(s => s.type === 'waitForText' && String(s.input.text) === '生鲜')!
    expect(catVerify.input.within).toEqual({ text: '已筛选', climb: 1 })
    // 顺序：等筛选区 → chip → 叶子；校验在列表出现之后（勾人之前）
    expect(types.indexOf('waitForText')).toBeLessThan(types.indexOf('clickByText'))
    expect(types.indexOf('waitForText')).toBeLessThan(types.indexOf('clickAll'))

    // 逐个勾选：clickAll 限定 tbody（不含表头全选），上限取用户设定值，允许滚动续选
    const clickAll = round.find(s => s.type === 'clickAll')!
    expect(clickAll.input).toMatchObject({ selector: 'tbody input[type=checkbox]', max: 40, scroll: true })

    // 抽屉打开的判据是**根容器**：抖店改版抽屉没有话术框（textarea 已不存在），只有根容器这一条
    const drawerOpen = round.find(s => s.type === 'waitForSelector' && String(s.input.selector).includes('auxo-drawer'))!
    expect(String(drawerOpen.input.selector)).toBe(DD.drawerSelector)

    // 抽屉打开后、发送前先做「确认发送」可用性（额度）预检
    const requireEnabled = round.find(s => s.type === 'requireEnabled')!
    expect(String(requireEnabled.input.text)).toBe('确认发送')
    expect(types.indexOf('requireEnabled')).toBeLessThan(types.lastIndexOf('clickByText'))

    // 发送前的保护改为程序化判据（用户明确要求达人邀约**不设人工确认门禁**，点下即真实发送）：
    // 门禁步骤必须缺席，但"发送"与"结果校验"照旧
    expect(types).not.toContain('waitForUserConfirmation')
    const sendIdx = round.findIndex(s => s.type === 'clickByText' && String(s.input.text) === DD.texts.confirmSend)
    expect(sendIdx).toBeGreaterThan(types.indexOf('requireEnabled'))

    // 发送后必须校验结果（抽屉关闭）并截图留档
    const gone = round.find(s => s.type === 'waitForGone')!
    expect(String(gone.input.selector)).toBe(DD.drawerSelector)
    expect(types.indexOf('waitForGone')).toBeGreaterThan(sendIdx)
    expect(types[types.length - 1]).toBe('screenshot')

    // 不应出现微信专属步骤（requireQuota 除外：抖店用它做"推荐商品真的挂上了"的复核）
    for (const t of ['mirrorTabUrl', 'typeText', 'ensureRows']) expect(types).not.toContain(t)
  })

  it('用户要求：整条批量流里没有人工确认门禁（点下「开始邀约」即真实发送）', () => {
    const ddRound = roundSteps(build())
    expect(ddRound.map(s => s.type)).not.toContain('waitForUserConfirmation')
    // 快手同样是批量流，一起确认（微信辅助流本来就走平台确认弹窗，不带门禁）
    const KS2 = inviteProfileFor('快手小店')!
    const ksSteps = buildBatchSteps(KS2 as any, {
      category: '个护家清', subcategory: '', levels: [], count: 2,
      script: 'x', scriptMode: 'manual', benefits: [], productCount: 1
    } as any, 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro')
    expect(((ksSteps[0].input as any).steps as any[]).map(s => s.type)).not.toContain('waitForUserConfirmation')
  })

  it('改版抽屉没有话术框 → 不生成任何写话术的步骤，且抽屉里的必填项都在发送前处理好', () => {
    const round = roundSteps(build({
      scriptMode: 'manual',
      script: '这段文案不该被写进页面',
      contacts: [
        { selector: '#phone', text: '15057937334' },
        { selector: '#wechat', text: 'jiaoe988' }
      ]
    }))
    const types = round.map(s => s.type)
    // 抖店档案已无 scriptSelector：aiGenerate / setInput(话术) / readText 一律不生成
    expect(DD.scriptSelector).toBeUndefined()
    expect(types).not.toContain('aiGenerate')
    expect(types).not.toContain('readText')
    expect(round.some(s => s.type === 'setInput' && String(s.input.text).includes('这段文案'))).toBe(false)

    // 联系方式（手机号/微信号，实测必填）按档案选择器写入，且都在发送之前
    const sendStepIdx = round.findIndex(s => s.type === 'clickByText' && String(s.input.text) === DD.texts.confirmSend)
    expect(sendStepIdx).toBeGreaterThan(-1)
    const setInputs = round.filter(s => s.type === 'setInput')
    expect(setInputs.map(s => String(s.input.selector)).sort()).toEqual(['#phone', '#wechat'])
    expect(Math.max(...setInputs.map(s => round.indexOf(s)))).toBeLessThan(sendStepIdx)

    // 推荐商品（必填项）：开关点一下 + 复核真的挂上了（错误码必须是 TASK_PRODUCT_NOT_SELECTED，
    // 不能是默认的额度错误码——那会被 loop 当"正常收工"，一位都没邀约却报成功）
    const goodsSwitch = round.find(s => s.type === 'clickByText' && String(s.input.text) === DD.drawerForm!.goodsSwitch.label)!
    expect(goodsSwitch.input.within).toEqual({ selector: DD.drawerSelector })
    const goodsAssert = round.find(s => s.type === 'requireQuota' && String(s.input.textIncludes) === DD.drawerForm!.goodsSwitch.selectedMarker)!
    expect(goodsAssert.input).toMatchObject({ min: 1, code: 'TASK_PRODUCT_NOT_SELECTED' })
    expect(round.indexOf(goodsAssert)).toBeLessThan(sendStepIdx)
  })

  it('核心优势 / 权益：按文案在抽屉范围内点（已选则跳过），且都在发送之前', () => {
    const round = roundSteps(build({
      benefits: ['专属高佣', '免费样品'],
      strengths: ['源头工厂', '品类丰富']
    }))
    const sendStepIdx = round.findIndex(s => s.type === 'clickByText' && String(s.input.text) === DD.texts.confirmSend)
    expect(sendStepIdx).toBeGreaterThan(-1)
    for (const text of ['源头工厂', '品类丰富', '专属高佣', '免费样品']) {
      const step = round.find(s => s.type === 'clickByText' && String(s.input.text) === text)
      expect(step, `缺少勾选「${text}」的步骤`).toBeTruthy()
      expect(step!.input).toMatchObject({ within: { selector: DD.drawerSelector }, skipIfChecked: true })
      expect(round.indexOf(step!)).toBeLessThan(sendStepIdx)
    }
    // 不勾就不生成（不会去点一堆没选的标签）
    const bare = roundSteps(build({ benefits: [], strengths: [] }))
    expect(bare.some(s => s.type === 'clickByText' && String(s.input.text) === '源头工厂')).toBe(false)

    // 主营：按选择器真点开下拉 → 真点一级（子列这时才展开）→ 点二级（已选则跳过）→ Escape。
    // 三条真机教训都钉在这里：
    //  ① 触发器不能按文案找（平台记住上次填写后文案不再是「请下拉选择」）→ 用 click + selector + real；
    //  ② 下拉面板是 body 级 portal，不能拿抽屉当范围 → 选项步的 within 是 popoverSelector；
    //  ③ 重复点已勾选的项等于反选 → 二级项带 skipIfChecked。
    const withMain = roundSteps(build({ mainCategory: '个护家清/家清纸品' }))
    const mainCfg = DD.drawerForm!.mainCategory!
    const trigger = withMain.find(s => s.type === 'click' && String(s.input.selector) === mainCfg.triggerSelector)!
    expect(trigger.input).toMatchObject({ mode: 'real' })
    expect(withMain.some(s => s.type === 'hover')).toBe(false)
    const rootClick = withMain.find(s => s.type === 'clickByText' && String(s.input.text) === '个护家清')!
    expect(rootClick.input).toMatchObject({ mode: 'real', within: { selector: mainCfg.popoverSelector } })
    const pick = withMain.find(s => s.type === 'clickByText' && String(s.input.text) === '家清纸品')!
    expect(pick.input).toMatchObject({ mode: 'real', within: { selector: mainCfg.popoverSelector }, skipIfChecked: true })
    // 顺序：点开下拉 → 点一级（展开子列）→ 点二级 → Esc 收起
    expect(withMain.indexOf(trigger)).toBeLessThan(withMain.indexOf(rootClick))
    expect(withMain.indexOf(rootClick)).toBeLessThan(withMain.indexOf(pick))
    const pickIdx = withMain.indexOf(pick)
    expect(withMain.findIndex((s, i) => i > pickIdx && s.type === 'pressKey')).toBeGreaterThan(pickIdx)
    // 面板范围必须与抽屉范围不同，否则真机上必然找不到选项
    expect(mainCfg.popoverSelector).not.toBe(DD.drawerSelector)
  })

  it('二级类目：选了二级就点二级项并连带校验；不选则点「不限」', () => {
    // 选二级：级联里点的是二级名（不是「不限」），且「已筛选」要同时校验一级与二级
    const round = roundSteps(build({ category: '个护家清', subcategory: '家清纸品' }))
    const texts = round.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(texts).toContain('个护家清')
    expect(texts).toContain('家清纸品')
    expect(texts).not.toContain('不限')
    // 生效校验那几条（排除"等筛选区渲染"的步骤：它按行标签等，不是校验）
    const verifies = round.filter(s => s.type === 'waitForText' && String(s.input.text) !== DD.texts.categoryLabel).map(s => String(s.input.text))
    expect(verifies).toEqual(['个护家清', '家清纸品'])
    // loop 标签带上二级
    expect(String(build({ category: '个护家清', subcategory: '家清纸品' })[0].input.label)).toContain('个护家清/家清纸品')

    // 二级留空 → 点「不限」（整个一级）
    const round2 = roundSteps(build({ category: '个护家清', subcategory: '' }))
    const texts2 = round2.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(texts2).toContain('不限')
    expect(texts2).not.toContain('家清纸品')
    expect(round2.filter(s => s.type === 'waitForText' && String(s.input.text) !== DD.texts.categoryLabel)).toHaveLength(1)

    // 一级不筛 → 不生成类目相关步骤（不猜、不多点）
    const round3 = roundSteps(build({ category: '', subcategory: '' }))
    const types3 = round3.map(s => s.type)
    expect(types3).not.toContain('waitForText')
    expect(round3.some(s => s.type === 'clickByText' && String(s.input.text) === '不限')).toBe(false)
  })

  it('三级类目：悬停二级展开第三列后点三级，并校验一级/二级/三级都生效', () => {
    const steps = build({
      category: '个护家清',
      subcategory: '家清纸品',
      category3: '纸品'
    })
    const round = roundSteps(steps)
    // 真机实测（2026-09-22）：直接点二级 = 只应用「一级/二级」并把弹层收起，
    // 三级列只在**悬停**二级项时才渲染 → 所以配了三级就**不点二级**，改为 hover + 点三级。
    const clickTexts = round.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(clickTexts).toContain('个护家清')
    expect(clickTexts).not.toContain('家清纸品')
    const hoverStep = round.find(s => s.type === 'hover')!
    expect(hoverStep.input).toMatchObject({ text: '家清纸品', within: { selector: DD.categoryPopoverSelector } })
    const thirdClick = round.find(s => s.type === 'clickByText' && s.input.text === '纸品')!
    expect(thirdClick.input).toMatchObject({
      exact: true,
      mode: 'real',
      within: { selector: DD.categoryPopoverSelector }
    })
    // 悬停必须在点三级之前（顺序反了就点不到）
    expect(round.indexOf(hoverStep)).toBeLessThan(round.indexOf(thirdClick))
    const verificationSteps = round.filter(s => s.type === 'waitForText' && String(s.input.text) !== DD.texts.categoryLabel)
    const verifies = verificationSteps.map(s => String(s.input.text))
    expect(verifies).toEqual(['个护家清', '家清纸品', '纸品'])
    expect(verificationSteps.find(s => s.input.text === '纸品')!.input).toMatchObject({ token: true })
    expect(String(steps[0].input.label)).toContain('个护家清/家清纸品/纸品')

    // 没有三级值时仍保留原来的两级行为：直接点二级（不悬停、不猜叶子）
    const twoLevel = roundSteps(build({ category: '个护家清', subcategory: '家清纸品', category3: '' }))
    expect(twoLevel.map(s => s.type)).not.toContain('hover')
    expect(twoLevel.filter(s => s.type === 'waitForText' && String(s.input.text) !== DD.texts.categoryLabel).map(s => String(s.input.text))).toEqual(['个护家清', '家清纸品'])
    // 快手（两级平台）同样不生成 hover
    const KS2 = inviteProfileFor('快手小店')!
    const ksSteps = buildBatchSteps(KS2 as any, {
      category: '个护家清', subcategory: '纸品湿巾', levels: [], count: 2,
      script: 'x', scriptMode: 'manual', benefits: [], productCount: 1
    } as any, 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro')
    expect(((ksSteps[0].input as any).steps as any[]).map(s => s.type)).not.toContain('hover')
  })

  it('不选类目时不生成类目相关步骤（不猜、不多点）', () => {
    const round = roundSteps(build({ category: '' }))
    const types = round.map(s => s.type)
    expect(types).not.toContain('waitForText')
    expect(round.some(s => s.type === 'clickByText' && String(s.input.text) === '不限')).toBe(false)
  })

  it('改版抽屉没有话术框 → AI 模式也不会生成 aiGenerate（话术步骤整段按档案跳过）', () => {
    const round = roundSteps(build({ scriptMode: 'ai' }))
    const types = round.map(s => s.type)
    expect(types).not.toContain('aiGenerate')
    expect(types).not.toContain('readText')
    // 话术步骤缺席不影响发送：发送与结果校验照旧（且没有人工确认门禁）
    expect(types).not.toContain('waitForUserConfirmation')
    expect(types).toContain('waitForGone')
    expect(round.some(s => s.type === 'clickByText' && String(s.input.text) === DD.texts.confirmSend)).toBe(true)
  })
})

// ---------- 快手小店（batch-list 的第二个平台：差异全部走档案字段） ----------

describe('快手小店（batch-list）步骤构造', () => {
  const KS = inviteProfileFor('快手小店')!
  const ksBuild = (over: Partial<Parameters<typeof buildBatchSteps>[1]> = {}) => buildBatchSteps(
    KS as any,
    {
      category: '个护家清', subcategory: '', levels: [], count: 2,
      script: '来带货吧', scriptMode: 'manual', benefits: ['可聊高佣'],
      contacts: [{ selector: 'input[placeholder*="常用联系人称呼"]', text: '刘涛' }],
      extraFilters: { 内容标签: ['美妆'], 合作信息: ['有联系方式'] },
      // 与面板默认一致：快手必选商品，默认 1 个
      productCount: 1,
      ...over
    } as any,
    'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro'
  )
  const ksRound = (over: Partial<Parameters<typeof buildBatchSteps>[1]> = {}) =>
    (ksBuild(over)[0].input as any).steps as Array<{ type: string; input: Record<string, any>; timeoutMs?: number }>

  it('开跑前要求填写档案声明的全部联系方式（快手三项，抖店改版抽屉只要手机号+微信号）', () => {
    expect(hasRequiredBatchContacts(KS as any, { contact: '刘涛' })).toBe(false)
    expect(hasRequiredBatchContacts(KS as any, { contact: '刘涛', phone: '13800000000' })).toBe(false)
    expect(hasRequiredBatchContacts(KS as any, {
      contact: '刘涛', phone: '13800000000', wechat: 'amike688'
    })).toBe(true)
    // 抖店：档案没有 contact（改版抽屉没有"联系人"这一项）→ 只校验手机号/微信号
    expect(hasRequiredBatchContacts(DD as any, {})).toBe(false)
    expect(hasRequiredBatchContacts(DD as any, { phone: '13800000000' })).toBe(false)
    expect(hasRequiredBatchContacts(DD as any, { phone: '13800000000', wechat: 'amike688' })).toBe(true)
    // 手机号/微信号的锚点：两个输入框 placeholder 与 class 完全相同，只有 id 能区分
    expect(DD.contactSelectors).toEqual({ phone: '#phone', wechat: '#wechat' })
  })

  it('任务能过创建校验（步骤都在白名单内、loop 不带 timeoutMs）', () => {
    const steps = ksBuild()
    expect(steps).toHaveLength(1)
    expect(steps[0].type).toBe('loop')
    expect(steps[0].timeoutMs).toBeUndefined()
    expect(taskCreateSchema.safeParse({ name: '达人邀约 · 快手小店', storeScope: 'store_x', steps }).success).toBe(true)
  })

  it('勾选下限按档案抬到 minSelect（快手只勾 1 位点「批量邀约」无反应）', () => {
    // 用户填 1 位（低于平台下限 2）→ 实际按 2 位勾
    const round = ksRound({ count: 1 })
    const clickAll = round.find(s => s.type === 'clickAll')!
    expect(clickAll.input).toMatchObject({ selector: 'tbody input[type=checkbox]', max: 2, scroll: true })
    // 快手达人选人区的计数写作「已选N条」→ 必须给 counterIncludes 消歧义，
    // 否则统计会读到页面上别的「已选…」文案（真机：商品弹窗勾选时读到达人的「已选2条」→ 误报 0 位）
    expect(clickAll.input.counterIncludes).toBe('已选')
    // 勾不满时 clickAll 自己报 TASK_SELECTION_SHORTFALL（loop 的 stopOn 当正常收尾）——
    // 所以不该再加"按钮可用性预检"：那道预检会被页面上的下拉挡住按钮而误报（真机踩到）。
    expect(round.filter(s => s.type === 'requireEnabled').map(s => s.input.text)).toEqual([])
    // 用户填 5 位（高于下限）则按 5 位
    expect(ksRound({ count: 5 }).find(s => s.type === 'clickAll')!.input.max).toBe(5)
    // loop 标签如实写"每批 N 位"（N 是实际会勾的数）
    expect(String(ksBuild({ count: 1 })[0].input.label)).toContain('每批 2 位')
  })

  it('抽屉没开要报得清楚：独立错误码 + 计入 stopOn（2026-10-04 快手真机）', () => {
    /**
     * 实测：点「批量邀约」时平台把"近 7 天内已邀过（含被拒）"的达人**静默剔除**；
     * 勾中的全被剔除时这次点击等于没发生（选择清空、抽屉不开、页面无任何提示）。
     * 旧写法只报 TASK_TIMEOUT: 等待选择器… → 看日志的人以为页面卡了。
     */
    const round = ksRound()
    const waitDrawer = round.find(s => s.type === 'waitForSelector' && s.input.code)!
    expect(waitDrawer.input.code).toBe('TASK_DRAWER_NOT_OPEN')
    expect(String(waitDrawer.input.hint)).toContain('一位都没发出去')
    // 它必须**紧跟**在「批量邀约」之后（顺序错了就变成"等别的元素"）
    const types = round.map(s => `${s.type}:${String(s.input.text || s.input.selector || '')}`)
    expect(types.indexOf('clickByText:批量邀约')).toBeLessThan(types.indexOf(`waitForSelector:${KS.scriptSelector}`))
    // loop 侧当"按预期收工"：这一轮没发出去，重试同一批人也不会变
    expect(ksBuild()[0].input.stopOn).toContain('TASK_DRAWER_NOT_OPEN')
  })

  it('7 天内已邀过的达人在勾选阶段就跳过（平台会静默剔除他们，剔光了整批白跑）', () => {
    const withLedger = ksRound({ recentlyInvited: ['力哥', '九零后老母亲一拖二的日常', '  ', '力哥'] })
    const clickAll = withLedger.find(s => s.type === 'clickAll')!
    // 去空 + 去重由载荷侧收口；这里确认清单真的进了步骤（平台没标记，只能靠台账）
    expect(clickAll.input.skipTexts).toEqual(['力哥', '九零后老母亲一拖二的日常', '力哥'])
    // 没有台账时不生成 skipTexts（不猜）
    expect(ksRound().find(s => s.type === 'clickAll')!.input.skipTexts).toBeUndefined()
    // 最多 500 条，防止载荷被撑爆
    const many = ksRound({ recentlyInvited: Array.from({ length: 700 }, (_, i) => `达人${i}`) })
    expect((many.find(s => s.type === 'clickAll')!.input.skipTexts as string[]).length).toBe(500)
  })

  it('合作信息行按 2026-10-04 实测收敛为 3 项（「专属推荐」已从页面消失）', () => {
    // 真机实测：整页 innerText 里搜不到「专属推荐」；档案若保留它，面板勾上就必然点空
    const coop = (KS.extraFilterRows || []).find(r => r.label === '合作信息')!
    expect(coop.options).toEqual(['有联系方式', '无坑位费', '招商中达人'])
    expect(JSON.stringify(KS)).not.toContain('专属推荐')
  })

  it('类目：chip 与叶子都限定范围；快手用「行标签+上溯」，点「全部」= 不限子类', () => {
    const round = ksRound()
    const chip = round.find(s => s.type === 'clickByText' && String(s.input.text) === '个护家清')!
    expect(chip.input.within).toEqual({ text: '带货类目', climb: 2 })
    const leaf = round.find(s => s.type === 'clickByText' && String(s.input.text) === '全部')!
    expect(leaf.input.within).toEqual({ selector: KS.categoryPopoverSelector })
    // 生效校验：在**选择器定位的标记容器**里找类目名。
    // 快手那条标记（.pro-tagForm-result）整段是子元素、自身没有文本节点，
    // 按文案上溯找不到 → 必须用 filteredScope 的选择器（真机彩排实测踩到）。
    // 生效校验那条（排除"等筛选区渲染"的步骤）
    const verify = round.find(s => s.type === 'waitForText' && String(s.input.text) !== KS.categoryLabelText)!
    expect(String(verify.input.text)).toBe('个护家清')
    expect(verify.input.within).toEqual({ selector: KS.filteredScope })
  })

  it('没有等级步骤（快手无该筛选维度）', () => {
    const round = ksRound({ levels: ['LV0'] })
    const texts = round.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    // 档案 levelTrigger 为空 → 就算前端误传了等级名，也不生成"点等级"的步骤
    expect(texts).not.toContain('达人等级')
    expect(texts).not.toContain('LV0')
  })

  it('额外筛选行：只在对应行范围内点（内容标签 / 合作信息）', () => {
    const round = ksRound()
    const tag = round.find(s => s.type === 'clickByText' && String(s.input.text) === '美妆')!
    expect(tag.input.within).toEqual({ text: '内容标签', climb: 2 })
    const coop = round.find(s => s.type === 'clickByText' && String(s.input.text) === '有联系方式')!
    expect(coop.input.within).toEqual({ text: '合作信息', climb: 2 })
    // 没选的行不生成步骤（不乱点）
    const empty = ksRound({ extraFilters: {} })
    const emptyTexts = empty.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(emptyTexts).not.toContain('美妆')
    expect(emptyTexts).not.toContain('有联系方式')
  })

  it('额度按页面明示文案预检（不是抖店的"看按钮禁用"）', () => {
    const round = ksRound()
    const quota = round.find(s => s.type === 'requireQuota')!
    expect(String(quota.input.textIncludes)).toBe('今日剩余')
    expect(round.some(s => s.type === 'requireEnabled' && String(s.input.text) === '发送邀请')).toBe(false)
  })

  it('必填联系方式逐项写入（联系人/手机号/微信号）', () => {
    const round = ksRound({
      contacts: [
        { selector: 'input[placeholder*="常用联系人称呼"]', text: '刘涛' },
        { selector: 'input[placeholder*="常用11位手机号"]', text: '13800000000' },
        { selector: 'input[placeholder*="常用微信号"]', text: 'amike688' }
      ]
    })
    const sets = round.filter(s => s.type === 'setInput').map(s => ({ sel: String(s.input.selector), text: String(s.input.text) }))
    const byText = Object.fromEntries(sets.map(s => [s.text, s.sel]))
    expect(byText['刘涛']).toContain('联系人')
    expect(byText['13800000000']).toContain('手机号')
    expect(byText['amike688']).toContain('微信号')
    // 留空的不写（不覆盖平台上已有的值）
    const onlyContact = ksRound({ contacts: [{ selector: 'input[placeholder*="常用联系人称呼"]', text: '刘涛' }] })
    expect(onlyContact.filter(s => s.type === 'setInput' && String(s.input.selector).includes('手机号'))).toHaveLength(0)
  })

  it('商品：快手**必选**商品才能发送 → 用 JS 点击走弹窗（不受类目下拉遮挡影响）', () => {
    // 实测：快手点「发送邀请」会提示「请选择商品」，且抽屉里那份商品表永远是空的
    // → 必须点「选择商品」开弹窗选，再点弹窗「确 认」回到抽屉。
    // 为什么不用 ensureRows：它内部是受信任鼠标点击，而实测类目级联下拉常残留展开、
    // 盖住这些按钮；clickByText 的默认 JS 点击不受遮挡影响。
    const round = ksRound({ productCount: 2 })
    const open = round.find(s => s.type === 'clickByText' && String(s.input.text) === '选择商品')!
    expect(open).toBeTruthy()
    expect(open.input.mode).toBeUndefined()            // 默认 JS 点击（不依赖坐标）
    expect(KS.goodsModal!.addText).toBe('选择商品')
    // 弹窗内的复选框用 clickAll（内部 label.click()，同样不受遮挡影响）。
    // 弹窗里确实有 tbody（实测 6 个复选框），按 tbody 限定即可排除表头的"全选"
    const boxes = round.find(s => s.type === 'clickAll' && String(s.input.selector).includes('modal-body'))!
    expect(boxes.input.max).toBe(2)
    expect(String(boxes.input.selector)).toContain('tbody')
    // 确认按钮按文案点（实测「确 认」带空格，引擎按去空格匹配）
    expect(round.some(s => s.type === 'clickByText' && String(s.input.text) === '确 认')).toBe(true)
    // 结果校验：商品数必须 ≥ 1（用通用"数字 ≥ min"断言），
    // 但**必须换错误码**——默认 TASK_QUOTA_EXCEEDED 在 loop 的 stopOn 里，
    // 用它会把"商品没选上"当成"按预期收工"，静默地一位都没邀约却报成功。
    const assertCount = round.find(s => s.type === 'requireQuota' && String(s.input.textIncludes) === '已选择商品数')!
    expect(assertCount.input.min).toBe(1)
    expect(assertCount.input.code).toBe('TASK_PRODUCT_NOT_SELECTED')
    // 商品弹窗确认后**可能**再弹一个「商品不符合达人带货要求，确认是否仍要发送邀请？」
    // （只在商品与该达人品类要求不匹配时出现）→ 用 clickIfPresent 出现就点掉，
    // 且必须在"商品数 ≥ 1"断言之前（不点掉它，计数一直是 0/100）。
    const acceptWarn = round.findIndex(s => s.type === 'clickIfPresent')
    expect(acceptWarn).toBeGreaterThan(round.findIndex(s => s.type === 'clickByText' && String(s.input.text) === '确 认'))
    expect(acceptWarn).toBeLessThan(round.indexOf(assertCount))
    // 那个确认框的按钮也叫「确认」，与商品弹窗的「确 认」同名 → 必须用 nearText 限定范围，
    // 否则会点到下层弹窗的按钮（白点一次、确认框留着）。
    // 锚点用**两个变体共有的**那半句（实测该提示框文案是动态的：
    // 「商品不符合达人带货要求…」/「商品佣金率低于达人带货要求…」都出现过）
    expect(round[acceptWarn].input.nearText).toBe('确认是否仍要发送邀请')
    // 商品在**发送之前**选（平台缺商品会拦下发送）
    const sendIdx = round.findIndex(s => s.type === 'clickByText' && String(s.input.text) === '发送邀请')
    expect(round.indexOf(open)).toBeLessThan(sendIdx)
    // 不再用 ensureRows 走商品（那是受信任鼠标路径）
    expect(round.some(s => s.type === 'ensureRows')).toBe(false)
    // 抖店没有 goodsModal → 不生成这些步骤（保持既有行为）
    const ddSteps = buildBatchSteps(DD as any, {
      category: '生鲜', levels: ['LV0'], count: 5,
      script: 'x', scriptMode: 'manual', benefits: []
    } as any, 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square')
    const ddTypes = (ddSteps[0].input as any).steps.map((s: any) => s.type)
    expect(ddTypes).not.toContain('ensureRows')
    // 抖店没有商品弹窗 → 不该有"等弹窗消失"那一步
    expect((ddSteps[0].input as any).steps.some((s: any) => s.type === 'waitForGone' && String(s.input.selector).includes('modal-body'))).toBe(false)
  })
  it('没有人工确认门禁（用户要求直接执行）；发送后：发送邀请 → 关抽屉校验 → 截图', () => {
    const round = ksRound()
    const types = round.map(s => s.type)
    const send = round.find(s => s.type === 'clickByText' && String(s.input.text) === '发送邀请')!
    expect(send).toBeTruthy()
    expect(types).not.toContain('waitForUserConfirmation')
    // 关**抽屉**的那次校验必须在发送之后（现在还有一次"等商品弹窗消失"在前，要按选择器区分）
    const drawerGoneIdx = round.findIndex(s => s.type === 'waitForGone' && String(s.input.selector) === KS.scriptSelector)
    expect(drawerGoneIdx).toBeGreaterThan(round.indexOf(send))
    expect(types[types.length - 1]).toBe('screenshot')
    // 关抽屉校验的超时不能太短：实测快手发送后要几十秒才关，30s 会把成功误报成失败
    expect(round[drawerGoneIdx].timeoutMs).toBeGreaterThanOrEqual(60000)
  })

  it('发送后必须点掉「邀约提示」复核弹窗（不点它抽屉不关，一条都发不出去）', () => {
    // 2026-09-15 真机：点「发送邀请」后平台弹「邀约提示」（佣金率/体验分低于达人要求），
    // 按钮是「继续发送邀约」；不点 → 抽屉一直开着 → waitForGone 超时 → 真实发送被记成失败。
    const round = ksRound()
    const sendIdx = round.findIndex(s => s.type === 'clickByText' && String(s.input.text) === '发送邀请')
    const drawerGoneIdx = round.findIndex(s => s.type === 'waitForGone' && String(s.input.selector) === KS.scriptSelector)
    const between = round.slice(sendIdx + 1, drawerGoneIdx).filter(s => s.type === 'clickIfPresent')
    expect(between.length).toBeGreaterThan(0)
    const texts = between.map(s => String(s.input.text))
    expect(texts).toContain('继续发送邀约')
    // 必须是 clickIfPresent（该弹窗只在"商品与达人要求不匹配"时出现，不能硬等也不能假设没有）
    for (const s of between) expect(s.type).toBe('clickIfPresent')
    // 抽屉收起超时必须维持长值——不能因为"配了确认框"就缩到 60s（那会让快手必然超时）
    expect(round[drawerGoneIdx].timeoutMs).toBeGreaterThanOrEqual(120000)
  })

  it('未实测到发送后弹窗的平台不插入任何条件点击（不会白等，也不会误点）', () => {
    // 抖店档案没登记 postSendConfirmTexts → 发送后不应出现 clickIfPresent
    const ddSteps = buildBatchSteps(DD as any, {
      category: '个护家清', subcategory: '家清纸品', levels: ['LV0'], count: 40,
      script: '话术', scriptMode: 'manual', benefits: ['专属高佣']
    }, 'https://x')
    const inner = (ddSteps[0].input as any).steps
    expect(inner.some((s: any) => s.type === 'clickIfPresent')).toBe(false)
    // 也没登记失败文案 → 不应出现 requireTextAbsent
    expect(inner.some((s: any) => s.type === 'requireTextAbsent')).toBe(false)
  })

  it('发送后先断言"平台报告失败"，再等抽屉收起（否则失败会被误当成"还在处理"）', () => {
    // 2026-09-15 真机：快手发送失败时弹「部分邀约发送失败」并**故意留着抽屉**，
    // waitForGone 只能超时，区分不出"失败了"与"平台还在处理"。
    const round = ksRound()
    const sendIdx = round.findIndex(s => s.type === 'clickByText' && String(s.input.text) === '发送邀请')
    const absentIdx = round.findIndex(s => s.type === 'requireTextAbsent')
    const drawerGoneIdx = round.findIndex(s => s.type === 'waitForGone' && String(s.input.selector) === KS.scriptSelector)
    expect(absentIdx).toBeGreaterThan(sendIdx)
    expect(absentIdx).toBeLessThan(drawerGoneIdx)
    expect(String(round[absentIdx].input.text)).toBe('部分邀约发送失败')
    // 错误码用 PARTIAL：实测这条弹窗是"逐条拒绝"，同批其余人可能已发出（2 位里 1 位进了邀约中），
    // 若用"总失败"的措辞会误导用户重发、造成重复邀约
    expect(round[absentIdx].input.code).toBe('TASK_SEND_PARTIAL')
    expect(String(round[absentIdx].input.hint)).toMatch(/其余人可能已发出/)
    // 必须换错误码：默认码若落进 stopOn 会被当成"按预期收工"（静默地把失败报成成功）
    const loopStep = ksBuild()[0]
    expect((loopStep.input as any).stopOn).not.toContain('TASK_SEND_PARTIAL')
  })

  it('合作标签按文案点击（抽屉里的复选框）', () => {
    const round = ksRound({ benefits: ['可聊高佣', '素材支持'] })
    const texts = round.filter(s => s.type === 'clickByText').map(s => String(s.input.text))
    expect(texts).toContain('可聊高佣')
    expect(texts).toContain('素材支持')
  })
})

/**
 * 端到端形状校验：**把生成的每一个嵌套步骤都过一遍 taskCreateSchema**。
 *
 * 为什么必须有：真机彩排时任务创建被拒 `Unrecognized key(s) in object: 'hint'`——
 * 构造器给 requireQuota 塞了一个 schema 里不存在的字段，而单测只检查了"步骤长什么样"、
 * 没检查"能不能被创建"。这道校验就是那次缺陷的回归网。
 */
describe('生成的步骤必须能真的创建任务（形状与白名单一致）', () => {
  const CASES: Array<[string, any, string]> = [
    [
      '抖店',
      inviteProfileFor('抖店'),
      { category: '个护家清', subcategory: '家清纸品', category3: '纸品', levels: ['LV0', 'LV1'], count: 40, script: '话术', scriptMode: 'manual', benefits: ['专属高佣'] }
    ],
    [
      '抖店（改版抽屉全字段：主营 + 核心优势 + 权益 + 手机号/微信号）',
      inviteProfileFor('抖店'),
      {
        category: '个护家清', subcategory: '家清纸品', category3: '纸品',
        levels: ['LV2'], count: 2, script: '', scriptMode: 'manual',
        strengths: ['源头工厂', '品类丰富', '多款爆款', '商品品质高', '售后无忧'],
        benefits: ['专属高佣', '免费样品', '佣金可谈'],
        mainCategory: '个护家清/家清纸品',
        contacts: [
          { selector: '#phone', text: '15057937334' },
          { selector: '#wechat', text: 'jiaoe988' }
        ]
      }
    ],
    [
      '快手小店',
      inviteProfileFor('快手小店'),
      {
        category: '个护家清', subcategory: '纸品湿巾', levels: [], count: 2,
        script: '话术', scriptMode: 'manual', benefits: ['可聊高佣'],
        extraFilters: { 内容标签: ['美妆'], 合作信息: ['有联系方式'] },
        contacts: [
          { selector: 'input[placeholder*="常用联系人称呼"]', text: '刘涛' },
          { selector: 'input[placeholder*="常用手机号"]', text: '13800000000' }
        ],
        productCount: 1
      }
    ],
    ['快手小店（AI 话术）', inviteProfileFor('快手小店'), { category: '', subcategory: '', levels: [], count: 2, script: '', scriptMode: 'ai', benefits: [], productCount: 1 }]
  ]

  for (const [label, profile, opts] of CASES) {
    it(`${label}：每个嵌套步骤都过 taskCreateSchema`, () => {
      const steps = buildBatchSteps(profile as any, opts as any, 'https://example.com/daren')
      const parsed = taskCreateSchema.safeParse({ name: '达人邀约 · 校验', storeScope: 'store_x', steps })
      if (!parsed.success) {
        // 把具体是第几步、哪个字段不合法打出来，便于直接定位
        const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' | ')
        throw new Error(`${label} 生成的步骤无法创建任务：${issues}`)
      }
      expect(parsed.success).toBe(true)
      // 嵌套步骤数不能超过引擎上限（loop.steps 上限 40）
      const inner = (steps[0].input as any).steps
      expect(inner.length).toBeGreaterThan(0)
      expect(inner.length).toBeLessThanOrEqual(40)
    })
  }

  /**
   * assist-form（微信）也要过同一道校验。
   *
   * 为什么单列一条：`task.create` 会在写库前用 Zod 逐条校验**嵌套步骤与 onCode 规则**，
   * 不合法就整单拒绝、面板只弹一句提示——步骤构造多了个超限字段（如 onCode.limit 超过上限）
   * 就会表现成"点开始邀约没反应"，且在纯步骤构造的单测里完全看不出来。
   * 校验字段上限这类问题必须由"真过一遍 taskCreateSchema"来兜住。
   */
  it('微信小店（assist-form）：生成的步骤同样能创建任务（含 absentText 与 onCode.advance）', () => {
    const steps = buildAssistSteps(WX as any, {
      contact: '刘涛', wechat: 'jiaoe988', phone: '15057937334',
      script: '话术', scriptMode: 'manual', productCount: 1,
      productIds: ['10000687986563'],
      finderType: '直播带货者', finderCategories: ['母婴'], finderOtherFilters: ['有联系方式']
    }, 'https://store.weixin.qq.com/shop/findersquare/find')
    const parsed = taskCreateSchema.safeParse({ name: '达人邀约 · 微信小店 · 校验', storeScope: 'store_x', steps })
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' | ')
      throw new Error(`微信小店生成的步骤无法创建任务：${issues}`)
    }
    expect(parsed.success).toBe(true)
    const loop = steps.find(s => s.type === 'loop')!
    const inner = (loop.input as any).steps
    expect(inner.length).toBeGreaterThan(0)
    expect(inner.length).toBeLessThanOrEqual(40)
  })
})

describe('buildInviteSteps 分派与 urlPathHint', () => {
  it('按档案 flow 分派；配置缺失时明确报错', () => {
    expect(() => buildInviteSteps(WX, {}, 'https://x')).toThrow('assist')
    expect(() => buildInviteSteps(DD, {}, 'https://x')).toThrow('batch')
    const steps = buildInviteSteps(WX, { assist: { contact: 'a', wechat: 'wx', phone: '13800000000', script: 'b', scriptMode: 'manual', productCount: 1 } }, 'https://x')
    // 微信：整条序列就是那一个 loop（每轮自己进广场 + 筛选 + 邀一位）；
    // 广场导航在**轮内**，不再是 loop 前面的独立步骤（见"每轮重新进广场并应用筛选"那条用例）
    expect(steps).toHaveLength(1)
    expect(steps[0].type).toBe('loop')
    const round = steps[0].input.steps as any[]
    expect(round[0].type).toBe('navigate')
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
    expect(stepInputSchemas.waitForText.safeParse({ text: '纸品', token: true }).success).toBe(true)
    expect(stepInputSchemas.waitForText.safeParse({ text: '纸品', exact: true, token: true }).success).toBe(false)
    /**
     * waitForGone 的两种判据（2026-10-03 加 text）：selector 与 text **二选一**。
     * 都缺 = 等了个寂寞；都给 = 判据含糊（到底等哪个消失？），所以两种都拒绝。
     */
    expect(stepInputSchemas.waitForGone.safeParse({ selector: 'tbody tr', deep: true }).success).toBe(true)
    expect(stepInputSchemas.waitForGone.safeParse({ text: '确认发送邀约', deep: true }).success).toBe(true)
    expect(stepInputSchemas.waitForGone.safeParse({ deep: true }).success).toBe(false)
    expect(stepInputSchemas.waitForGone.safeParse({ selector: 'tbody tr', text: '确认发送邀约' }).success).toBe(false)
    expect(stepInputSchemas.ensureRows.safeParse({
      rowsSelector: 'tbody tr', checkboxSelector: 'tbody label',
      addText: '添加商品', confirmText: '确认', min: 1, max: 3, deep: true
    }).success).toBe(true)
    expect(stepInputSchemas.ensureRowsById.safeParse({
      rowsSelector: 'tbody tr', checkboxSelector: 'tbody label',
      addText: '添加商品', confirmText: '确认', productIds: ['10000687986563'], deep: true
    }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: '发送邀约', deep: true, mode: 'real', exact: true }).success).toBe(true)
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

  it('skipIfChecked / click.mode：平台"记住上次填写"时的幂等点击参数可建', () => {
    expect(stepInputSchemas.clickByText.safeParse({ text: '源头工厂', skipIfChecked: true }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: '源头工厂', skipIfChecked: 'yes' }).success).toBe(false)
    expect(stepInputSchemas.click.safeParse({ selector: '.auxo-cascader-multiple-wrapper', mode: 'real' }).success).toBe(true)
    expect(stepInputSchemas.click.safeParse({ selector: 'a', mode: 'trusted' }).success).toBe(false)
    expect(stepInputSchemas.click.safeParse({ selector: 'a', extra: 1 }).success).toBe(false)
  })

  it('hover（悬停展开级联列）：文案必填、within/exact 可选、拒绝多余键', () => {    expect(stepInputSchemas.hover.safeParse({ text: '服装' }).success).toBe(true)
    expect(stepInputSchemas.hover.safeParse({
      text: '服装', deep: true, exact: true, within: { selector: '.quick-filter-cascader-popover' }
    }).success).toBe(true)
    expect(stepInputSchemas.hover.safeParse({ text: '服装', within: { text: '行标签', climb: 2 } }).success).toBe(true)
    expect(stepInputSchemas.hover.safeParse({}).success).toBe(false)
    expect(stepInputSchemas.hover.safeParse({ text: '服装', click: true }).success).toBe(false)
    // 悬停不是提交动作：loop 里也能用（且同样受白名单约束）
    expect(stepInputSchemas.loop.safeParse({
      label: 'x', maxRounds: 2, stopOn: ['TASK_QUOTA_EXCEEDED'],
      steps: [{ type: 'hover', input: { text: '服装' } }]
    }).success).toBe(true)
    expect(stepInputSchemas.loop.safeParse({
      label: 'x', maxRounds: 2, stopOn: ['TASK_QUOTA_EXCEEDED'],
      steps: [{ type: 'hoverSomewhere', input: { text: '服装' } }]
    }).success).toBe(false)
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

  it('absentText/absentCode：目标缺席时按替代文案立刻失败（可换专属错误码）', () => {
    const ok = { text: '邀请带货', deep: true, mode: 'real', absentText: '暂未到达合作门槛', absentCode: 'TASK_DAREN_NOT_INVITABLE' }
    expect(stepInputSchemas.clickByText.safeParse(ok).success).toBe(true)
    // 两者都可以单独给（只给 absentText 时错误码沿用 missingCode）
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', absentText: '暂未到达合作门槛' }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', absentCode: 'TASK_DAREN_NOT_INVITABLE' }).success).toBe(true)
    // 超长 / 多余键都被拒
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', absentText: 'y'.repeat(201) }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', absentCode: 'z'.repeat(41) }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', absentText: 'y', evil: 1 }).success).toBe(false)
  })

  it('verifyChecked：点完回读勾选态（平台只把"筛选生效没有"表达在勾选态上时用它兜底）', () => {
    const ok = {
      text: '有认证', deep: true, within: { text: '其他筛选', climb: 2 },
      skipIfChecked: true, verifyChecked: true, verifyCode: 'TASK_FILTER_NOT_APPLIED'
    }
    expect(stepInputSchemas.clickByText.safeParse(ok).success).toBe(true)
    // 只给 verifyChecked 也可以（错误码取默认值）
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', verifyChecked: true }).success).toBe(true)
    // 类型/长度/多余键照旧被拒
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', verifyChecked: 'yes' }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', verifyCode: 'z'.repeat(41) }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', verifyChecked: true, evil: 1 }).success).toBe(false)
  })

  it('下拉开关语义的步骤输入：openVia / onlyIfVisible 可过校验，坏值被拒', () => {
    // 档位步骤：面板没开就先点开（状态无关）
    expect(stepInputSchemas.clickByText.safeParse({ text: '￥10万-20万', exact: true, openVia: { text: '带货销售总额', exact: true, deep: true } }).success).toBe(true)
    // 收尾步骤：只在面板确实开着时才点（判据限定在该指标 dl 内）
    expect(stepInputSchemas.clickByText.safeParse({ text: '带货销售总额', exact: true, onlyIfVisible: { text: '￥10万-20万', deep: true, within: { text: '带货销售总额', climb: 1 } } }).success).toBe(true)
    // 缺 text / 多余键 / within 写法不对 → 拒
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', openVia: {} }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', openVia: { text: 'y', evil: 1 } }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', onlyIfVisible: {} }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', onlyIfVisible: { text: 'y', within: { selector: '.a', evil: 1 } } }).success).toBe(false)
  })

  it('7 天内不重复邀约的步骤输入：skipTexts / recordRowText 可过校验，坏值被拒', () => {
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', deep: true, mode: 'real', nth: 'unvisited', skipTexts: ['恩妹阅读', '郑奶奶科学育儿'], recordRowText: true }).success).toBe(true)
    // 空串/超长/超量都不接受（空串会让"包含"判断恒真，等于把整页剔光）
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', skipTexts: [''] }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', skipTexts: ['x'.repeat(121)] }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', skipTexts: Array.from({ length: 501 }, (_, i) => `n${i}`) }).success).toBe(false)
    expect(stepInputSchemas.clickByText.safeParse({ text: '详情', recordRowText: 'yes' }).success).toBe(false)
  })

  it('loop.onCode：恢复步骤同样走白名单（未登记类型/超量被拒）', () => {
    const okRule = { code: 'TASK_PAGE_EXHAUSTED', limit: 3, steps: [{ type: 'clickByText', input: { text: '下一页', deep: true, mode: 'real' } }] }
    const base = { label: 'x', maxRounds: 2, stopOn: ['TASK_QUOTA_EXCEEDED'], steps: [{ type: 'navigate', input: { url: 'https://a.b/c' } }] }
    expect(stepInputSchemas.loop.safeParse({ ...base, onCode: [okRule] }).success).toBe(true)
    // advance：跳过这一位换下一位（与 restart 的区别在引擎侧：要不要回滚已访问记录）
    expect(stepInputSchemas.loop.safeParse({ ...base, onCode: [{ ...okRule, advance: true }] }).success).toBe(true)
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
