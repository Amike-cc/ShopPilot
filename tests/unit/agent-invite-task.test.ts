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
      // 类目必须是**平台当前实测清单**里的值（这里是「美妆护肤」，不是「美妆」）——
      // 清单外的值会被 inviteTaskIssues 报成缺项，见下面那条用例
      productIds: '111,222 111\n333', finderType: '全部带货者', finderCategories: ['美妆护肤']
    })
    expect(ready.productIds).toEqual(['111', '222', '333'])
    const payload = buildInviteTaskPayload({ profile: wechat, storeId: 'store_w', squareUrl: wechat.pageUrl, config: ready })!
    expect(payload.name).toContain('辅助填单')
    expect(JSON.stringify(payload.steps)).toContain('13800138000')
    expect(parseInviteProductIds(Array.from({ length: 40 }, (_, i) => `id_${i}`)).length).toBe(30)
  })

  it('广场三行筛选（带货类目 / 带货销售总额 / 其他筛选）进载荷，且按实测清单收口', () => {
    const ready = {
      script: '你好', scriptMode: 'manual', contact: '张三', wechat: 'wx', phone: '13800138000',
      finderType: '全部带货者',
      finderCategories: ['汽摩电动', '母婴'],
      finderSalesTiers: ['￥10万-20万', '￥20万-30万'],
      finderOtherFilters: ['有认证', '品牌好物推荐官']
    }
    const config = normalizeInviteTaskConfig('assist-form', ready)
    expect(inviteTaskIssues({ profile: wechat, config })).toEqual([])
    const payload = buildInviteTaskPayload({ profile: wechat, storeId: 'store_w', squareUrl: wechat.pageUrl, config })!
    expect(payload).not.toBeNull()
    const json = JSON.stringify(payload.steps)
    expect(json).toContain('汽摩电动')
    expect(json).toContain('￥10万-20万')
    expect(json).toContain('品牌好物推荐官')
    // 任务名带上筛选摘要（实时日志/卡片一眼看出按什么条件挑人）
    expect(payload.name).toContain('类目 2 项')
    expect(payload.name).toContain('销售额 2 档')
    expect(payload.name).toContain('其他 2 项')
    // 额度护栏进任务名与 loop：平台读不到剩余额度，这是我们唯一的硬上限
    expect(payload.name).toContain('最多 10 位')
    expect(JSON.stringify(payload.steps)).toContain('"maxRounds":10')

    // 平台改名后的旧值（「汽车电动」→「汽摩电动」）：逐条报缺项、且**不进步骤**
    const legacy = normalizeInviteTaskConfig('assist-form', { ...ready, finderCategories: ['汽车电动'] })
    const issues = inviteTaskIssues({ profile: wechat, config: legacy })
    expect(issues.some(issue => issue.includes('汽车电动'))).toBe(true)
    expect(buildInviteTaskPayload({ profile: wechat, storeId: 'store_w', squareUrl: wechat.pageUrl, config: legacy })).toBeNull()

    // 「带货销售总额」只在「全部带货者」下提供：换成别的类型必须当场拦下（否则运行到页面才发现没这一维）
    const wrongType = normalizeInviteTaskConfig('assist-form', { ...ready, finderType: '直播带货者' })
    const typeIssues = inviteTaskIssues({ profile: wechat, config: wrongType })
    expect(typeIssues.some(issue => issue.includes('全部带货者') && issue.includes('直播带货者'))).toBe(true)
    expect(buildInviteTaskPayload({ profile: wechat, storeId: 'store_w', squareUrl: wechat.pageUrl, config: wrongType })).toBeNull()
  })

  it('批量流（快手）也要把 7 天台账带进步骤：归一化不许丢字段', () => {
    /**
     * 2026-10-04 真机：快手点「批量邀约」时平台把近 7 天已邀（含被拒）的达人**静默剔除**，
     * 剔光了整批白跑。防线是在勾选阶段跳过台账里的昵称——但归一化的 batch 分支此前**漏了这个字段**，
     * 面板传了也进不去步骤（等于防线在批量流上没生效）。
     */
    const raw = {
      category: '', levels: [], count: 2, script: '你好', scriptMode: 'manual',
      batchContact: '刘涛', batchPhone: '15057937334', batchWechat: 'jiaoe988', batchProductCount: 1,
      recentlyInvited: ['力哥', '  ', '九零后老母亲一拖二的日常']
    }
    const normalized = normalizeInviteTaskConfig('batch-list', raw)
    expect(normalized.recentlyInvited).toEqual(['力哥', '九零后老母亲一拖二的日常'])
    const payload = buildInviteTaskPayload({ profile: kuaishou, storeId: 'store_k', squareUrl: kuaishou.pageUrl, config: normalized })!
    const clickAll = JSON.stringify(payload.steps)
    expect(clickAll).toContain('"skipTexts":["力哥","九零后老母亲一拖二的日常"]')
    // 没台账时不生成 skipTexts（不猜）
    const noLedger = buildInviteTaskPayload({ profile: kuaishou, storeId: 'store_k', squareUrl: kuaishou.pageUrl, config: normalizeInviteTaskConfig('batch-list', { ...raw, recentlyInvited: undefined }) })!
    expect(JSON.stringify(noLedger.steps)).not.toContain('skipTexts')
  })

  it('7 天内邀过的达人昵称进载荷（点「详情」时跳过），并有边界收口', () => {
    const base = { script: '你好', scriptMode: 'manual', contact: '张三', wechat: 'wx', phone: '13800138000', finderType: '全部带货者' }
    const config = normalizeInviteTaskConfig('assist-form', { ...base, recentlyInvited: ['恩妹阅读', '郑奶奶科学育儿', '', '  '] })
    // 去空 + 去空白项
    expect(config.recentlyInvited).toEqual(['恩妹阅读', '郑奶奶科学育儿'])
    const payload = buildInviteTaskPayload({ profile: wechat, storeId: 'store_w', squareUrl: wechat.pageUrl, config })!
    const json = JSON.stringify(payload.steps)
    expect(json).toContain('恩妹阅读')
    expect(json).toContain('"recordRowText":true')
    // 没有台账时不该出现 skipTexts（不猜），但仍要回传昵称供记账
    const noLedger = buildInviteTaskPayload({ profile: wechat, storeId: 'store_w', squareUrl: wechat.pageUrl, config: normalizeInviteTaskConfig('assist-form', base) })!
    expect(JSON.stringify(noLedger.steps)).not.toContain('skipTexts')
    expect(JSON.stringify(noLedger.steps)).toContain('"recordRowText":true')
    // 最多 500 条
    const many = normalizeInviteTaskConfig('assist-form', { ...base, recentlyInvited: Array.from({ length: 700 }, (_, i) => `达人${i}`) })
    expect((many.recentlyInvited || []).length).toBe(500)
  })

  it('额度护栏：越界的「本次最多邀约」逐条报缺项，缺省给默认值而不是"不限"', () => {
    const base = { script: '你好', scriptMode: 'manual', contact: '张三', wechat: 'wx', phone: '13800138000', finderType: '全部带货者' }
    // 缺省 → 面板默认 10（老配置没有这个字段时不能变成"想发多少发多少"）
    const fallback = normalizeInviteTaskConfig('assist-form', base)
    expect(fallback.maxInvites).toBe(10)
    expect(inviteTaskIssues({ profile: wechat, config: fallback })).toEqual([])
    // 越界/非整数 → 拦下并说清合法范围
    for (const bad of [0, -3, 51, 2.5, Number.NaN]) {
      const config = normalizeInviteTaskConfig('assist-form', { ...base, maxInvites: bad })
      // normalize 会把坏值收敛到默认值，所以这里直接构造快照来验证校验分支
      const raw = { ...config, maxInvites: bad }
      const issues = inviteTaskIssues({ profile: wechat, config: raw })
      expect(issues.some(issue => issue.includes('本次最多邀约')), `maxInvites=${bad}`).toBe(true)
      expect(buildInviteTaskPayload({ profile: wechat, storeId: 'store_w', squareUrl: wechat.pageUrl, config: raw })).toBeNull()
    }
    // 合法值原样进 loop
    const ok = normalizeInviteTaskConfig('assist-form', { ...base, maxInvites: 3 })
    const payload = buildInviteTaskPayload({ profile: wechat, storeId: 'store_w', squareUrl: wechat.pageUrl, config: ok })!
    expect(payload.name).toContain('最多 3 位')
    expect(JSON.stringify(payload.steps)).toContain('"maxRounds":3')
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
