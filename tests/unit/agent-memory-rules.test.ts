import { describe, expect, it } from 'vitest'
import { AGENT_MEMORY_ORIGINS, AGENT_MEMORY_TYPES } from '@shared/schemas/agent-domain'
import {
  DURABLE_CUE_RE,
  FORGET_CUE_RE,
  MEMORY_DEDUPE_MAX_CHARS,
  MEMORY_STATEMENT_MAX_PER_MESSAGE,
  MEMORY_STATEMENT_MAX_PER_TURN,
  MEMORY_STATEMENT_MIN_CHARS,
  MEMORY_TYPE_LIMITS,
  extractDurableMemoryCandidates,
  memoryContextScore,
  memoryDedupeText,
  memoryKeywords,
  memoryQueryTokens,
  memoryTypeLimit,
  normalizeLearningText
} from '@shared/agent-memory-rules'

// 这一组用例补的是此前的空白：写入/检索/加密/回滚都有验收，唯独
// 「自动学习到底学什么」没有任何自动化覆盖（learnFrom* 依赖 electron + sqlite，
// 无法在单测里直接调用）。规则抽到 shared 之后，这里直接验证决策本身。

describe('自动学习抽取规则', () => {
  it('只把明确的长期语言变成候选：闲聊、短句、assistant 轮次都不学', () => {
    const candidates = extractDurableMemoryCandidates([
      { role: 'user', text: '今天天气不错，帮我看看店铺' },
      { role: 'assistant', text: '记住：库存低于 10 件要先看证据' },
      { role: 'user', text: '好的' },
      { role: 'user', text: '记住：库存低于 10 件必须先看页面证据' },
      { role: 'user', text: '记住我偏好简洁回复' }
    ])
    expect(candidates.map(candidate => candidate.statement)).toEqual([
      '记住：库存低于 10 件必须先看页面证据',
      '记住我偏好简洁回复'
    ])
  })

  it('按表达区分 procedural / semantic，并给出可审核的置信度与标题', () => {
    const [rule, preference] = extractDurableMemoryCandidates([
      { role: 'user', text: '记住：库存低于 10 件必须先看页面证据' },
      { role: 'user', text: '我喜欢先给结论，再给依据' }
    ])
    expect(rule.type).toBe('procedural')
    expect(rule.confidence).toBe(0.78)
    expect(rule.title.startsWith('用户偏好：')).toBe(true)
    // 弱线索（「我喜欢」缺少 记住/必须/禁止/默认）置信度更低
    expect(preference.type).toBe('semantic')
    expect(preference.confidence).toBe(0.62)
    expect(preference.statement).toBe('我喜欢先给结论，再给依据')
  })

  it('「不要记住」优先于其它线索：整条消息都不产生候选', () => {
    expect(FORGET_CUE_RE.test('忘记之前那条库存规则')).toBe(true)
    expect(extractDurableMemoryCandidates([
      { role: 'user', text: '忘记之前那条库存规则，以后默认按 5 件算' },
      { role: 'user', text: '删除记忆：不要保留我的店铺偏好' }
    ])).toEqual([])
  })

  it('过短的句子不学（避免把「记住了」本身学成记忆）', () => {
    expect(MEMORY_STATEMENT_MIN_CHARS).toBe(8)
    expect(extractDurableMemoryCandidates([{ role: 'user', text: '记住它' }])).toEqual([])
  })

  it('单条消息最多 4 句、单轮最多 8 条，且同轮内去重', () => {
    const sixRules = ['必须先看页面证据再动手', '禁止直接修改商品价格', '每次先列出清单再执行', '默认使用中文简洁回复', '总是核对所有店铺状态', '不要跳过人工审核环节']
    const oneMessage = extractDurableMemoryCandidates([{ role: 'user', text: `记住：${sixRules.join('。')}` }])
    expect(oneMessage).toHaveLength(MEMORY_STATEMENT_MAX_PER_MESSAGE)
    expect(oneMessage.map(candidate => candidate.statement)).toEqual(sixRules.slice(0, 4).map((rule, index) => (index === 0 ? `记住：${rule}` : rule)))

    const manyMessages = extractDurableMemoryCandidates(
      [0, 1, 2].map(index => ({ role: 'user', text: `记住：必须核对店铺状态${index}。禁止直接修改价格${index}。每次先列出清单${index}。默认使用中文回复${index}` }))
    )
    expect(manyMessages).toHaveLength(MEMORY_STATEMENT_MAX_PER_TURN)
    // 超出上限时保留最新的，而不是最早的
    expect(manyMessages.at(-1)!.statement).toBe('默认使用中文回复2')

    const duplicated = extractDurableMemoryCandidates([
      { role: 'user', text: '记住必须核对店铺状态' },
      { role: 'user', text: '记住必须核对店铺状态' }
    ])
    expect(duplicated).toHaveLength(1)
  })

  it('学习文本先脱敏，正文里的手机号/姓名不会进入候选', () => {
    const text = normalizeLearningText('记住：联系人：张三，手机：13800138000')
    expect(text).not.toContain('13800138000')
    expect(text).toContain('[手机号已隐藏]')
    expect(DURABLE_CUE_RE.test(text)).toBe(true)
  })
})

describe('近重复判定（consolidated 收敛的依据）', () => {
  it('空格、中英文标点、全角与大小写差异判为同一条', () => {
    const base = memoryDedupeText('库存低于 10 件时，先看页面证据。')
    expect(base).not.toBeNull()
    expect(memoryDedupeText('库存低于10件时,先看页面证据')).toBe(base)
    expect(memoryDedupeText('  库存低于 10 件时；先看页面证据！  ')).toBe(base)
    expect(memoryDedupeText('ABC 先看证据')).toBe(memoryDedupeText('abc先看证据'))
  })

  it('不同规则不会互相合并', () => {
    expect(memoryDedupeText('库存低于 10 件时先看证据')).not.toBe(memoryDedupeText('库存低于 5 件时先看证据'))
  })

  it('空正文与超长正文返回 null（宁可不合并，也不能丢证据）', () => {
    expect(memoryDedupeText('   ')).toBeNull()
    expect(memoryDedupeText('。。。')).toBeNull()
    expect(memoryDedupeText('x'.repeat(MEMORY_DEDUPE_MAX_CHARS + 1))).toBeNull()
    expect(memoryDedupeText('x'.repeat(MEMORY_DEDUPE_MAX_CHARS))).not.toBeNull()
  })
})

describe('本地检索（FTS5 + 中文 bigram）', () => {
  it('索引侧同时产出原词与字符 bigram，中文换写法也能命中', () => {
    const keywords = memoryKeywords('库存规则')
    expect(keywords).toContain('库存规则')
    expect(keywords).toContain('库存')
    expect(keywords).toContain('存规')
    expect(keywords).toContain('规则')
    expect(keywords.split(' ').every(token => token.length >= 2)).toBe(true)
  })

  it('索引关键词有上限，长正文不会无界膨胀', () => {
    expect(memoryKeywords('库存'.repeat(2000)).split(' ').length).toBeLessThanOrEqual(800)
  })

  it('查询侧剥掉 FTS5 语法字符并限制 token 数', () => {
    const tokens = memoryQueryTokens('"库存"*:^()规则')
    expect(tokens).toContain('库存')
    expect(tokens).toContain('规则')
    expect(tokens.some(token => /["*:^()]/.test(token))).toBe(false)
    expect(memoryQueryTokens('库存'.repeat(200)).length).toBeLessThanOrEqual(24)
    expect(memoryQueryTokens('   ')).toEqual([])
  })
})

describe('召回打分', () => {
  const now = 1_700_000_000_000

  it('类型权重：procedural > semantic > shared/episodic', () => {
    const base = { title: '库存', content: '', confidence: 0.5, updatedAt: now }
    const procedural = memoryContextScore({ ...base, type: 'procedural' }, ['库存'], now)
    const semantic = memoryContextScore({ ...base, type: 'semantic' }, ['库存'], now)
    const episodic = memoryContextScore({ ...base, type: 'episodic' }, ['库存'], now)
    expect(procedural).toBeGreaterThan(semantic)
    expect(semantic).toBeGreaterThan(episodic)
  })

  it('标题命中比正文命中更相关', () => {
    const terms = ['库存']
    const titleHit = memoryContextScore({ title: '库存规则', content: '随便写', updatedAt: now }, terms, now)
    const bodyHit = memoryContextScore({ title: '其他规则', content: '库存要小心', updatedAt: now }, terms, now)
    expect(titleHit).toBeGreaterThan(bodyHit)
  })

  it('被采纳过的记忆排在反复被拒的记忆前面', () => {
    const base = { title: '库存', content: '库存', confidence: 0.5, updatedAt: now }
    const adopted = memoryContextScore({ ...base, adoptCount: 5, rejectCount: 0 }, ['库存'], now)
    const rejected = memoryContextScore({ ...base, adoptCount: 0, rejectCount: 5 }, ['库存'], now)
    expect(adopted).toBeGreaterThan(rejected)
  })

  it('新鲜度随时间下降，最近命中的记忆更靠前', () => {
    const base = { title: '库存', content: '库存', confidence: 0.5 }
    const fresh = memoryContextScore({ ...base, updatedAt: now }, ['库存'], now)
    const old = memoryContextScore({ ...base, updatedAt: now - 60 * 86400000 }, ['库存'], now)
    expect(fresh).toBeGreaterThan(old)
    const hitRecently = memoryContextScore({ ...base, updatedAt: old, lastHitAt: now }, ['库存'], now)
    const hitLongAgo = memoryContextScore({ ...base, updatedAt: old, lastHitAt: now - 60 * 86400000 }, ['库存'], now)
    expect(hitRecently).toBeGreaterThan(hitLongAgo)
  })

  it('无关键词重叠时仍然只由权重/置信度决定，不会出现 NaN', () => {
    const score = memoryContextScore({ title: '无关', content: '无关', confidence: undefined, updatedAt: undefined }, [], now)
    expect(Number.isFinite(score)).toBe(true)
  })
})

describe('记忆类型契约', () => {
  it('每个类型都有正数上限，且不留实现里没有的死分支', () => {
    expect(Object.keys(MEMORY_TYPE_LIMITS).sort()).toEqual([...AGENT_MEMORY_TYPES].sort())
    for (const type of AGENT_MEMORY_TYPES) expect(memoryTypeLimit(type)).toBeGreaterThan(0)
    expect(memoryTypeLimit('episodic')).toBe(16384)
    // 旧实现在 memoryLimit() 里判过 'working'，但契约/DB CHECK 都没有这个类型
    expect(AGENT_MEMORY_TYPES as readonly string[]).not.toContain('working')
    expect(memoryTypeLimit('working')).toBe(MEMORY_TYPE_LIMITS.semantic)
  })

  it('consolidated 来源已被近重复合并使用', () => {
    expect(AGENT_MEMORY_ORIGINS).toContain('consolidated')
  })
})
