import { describe, it, expect } from 'vitest'
import {
  STEP_CATALOG,
  catalogGroups,
  findCatalogEntry,
  hasBlockingIssues,
  makeDraftStep,
  toEngineSteps,
  validateCustomSteps,
  type CustomStepDraft
} from '../../packages/shared/src/custom-task'
import { TASK_STEP_TYPES } from '../../packages/shared/src/schemas/task'
import { stepInputSchemas } from '../../apps/desktop/src/main/tasks/task-step-schemas'

/**
 * 自定义任务编排器的单测。
 *
 * 这里最重要的一组是「目录 ↔ Zod schema 不许漂移」：编排器按目录渲染表单、
 * 按目录裁剪字段，而**权威校验在主进程的 Zod**（strict()：多一个键、少一个必填都会整单被拒）。
 * 两者一旦不一致，用户就会"表单填得好好的、点创建被拒"，且错误信息是引擎味的
 * TASK_INVALID_STEP——正是当初决定不给步骤编辑器的那条理由。所以用单测把一致性钉死。
 */

// ---------- 目录 ↔ Zod schema 一致性（防漂移，本组是核心） ----------

/** 给字段造一个"合法样本值"（键名优先，其次按 kind 兜底） */
const BY_KEY: Record<string, unknown> = {
  url: 'https://example.com/page',
  path: '/shop/qualification/home',
  urlIncludes: 'finder-square',
  selector: 'div',
  text: '确定',
  textIncludes: '今日剩余',
  label: '成交金额',
  metric: 'invite.quota',
  hint: '额度不足，请明天再试',
  message: '确认向 3 位达人发送邀约？',
  nearText: '确认是否仍要发送邀请',
  counterIncludes: '已选',
  max: 1,
  min: 1,
  ms: 3000,
  waitMs: 5000,
  maxRounds: 5,
  key: 'Escape',
  mode: 'js'
}

function sampleValueFor(key: string, kind: string, def?: unknown, min?: number): unknown {
  if (key in BY_KEY) return BY_KEY[key]
  if (def !== undefined) return def
  if (kind === 'number') return min !== undefined ? Math.max(min, 1) : 1
  if (kind === 'boolean') return true
  return 'x'
}

/** 按目录把一条步骤填成"合法样本"（互斥组只填第一个） */
function sampleDraft(entry: (typeof STEP_CATALOG)[number]): CustomStepDraft {
  const input: Record<string, unknown> = {}
  const skip = new Set<string>()
  for (const group of entry.requiredOneOf || []) {
    // 只填第一个，其余留空 —— 否则会被 Zod 的 refine(二选一) 拒掉
    for (const k of group.slice(1)) skip.add(k)
  }
  for (const f of entry.fields) {
    if (skip.has(f.key)) continue
    if (f.kind === 'within') continue // 可选字段，留空即可
    input[f.key] = sampleValueFor(f.key, f.kind, f.default, f.min)
  }
  return { type: entry.type, input }
}

describe('自定义任务 · 目录与 Zod schema 必须一致（防漂移）', () => {
  it('目录里每种步骤都是引擎登记过的类型', () => {
    for (const e of STEP_CATALOG) {
      expect(TASK_STEP_TYPES as readonly string[], `目录里的 ${e.type} 不在引擎白名单里`).toContain(e.type)
    }
  })

  it('目录里每种步骤都有对应的 Zod 输入 schema', () => {
    for (const e of STEP_CATALOG) {
      expect(stepInputSchemas[e.type], `${e.type} 没有 Zod schema`).toBeTruthy()
    }
  })

  it('按目录填出的样本，必须能通过主进程的 Zod 校验（字段名/类型/必填/互斥全对齐）', () => {
    for (const e of STEP_CATALOG) {
      const steps = toEngineSteps([sampleDraft(e)])
      const schema = stepInputSchemas[e.type]
      const out = schema.safeParse(steps[0].input)
      const detail = out.success ? '' : out.error.issues.map(x => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ')
      expect(out.success, `${e.type} 的目录字段与 Zod 不一致 → ${detail}`).toBe(true)
    }
  })

  it('目录字段名逐个被 Zod 接受（多写一个键会被 strict() 拒掉，这条专防手滑写错键名）', () => {
    for (const e of STEP_CATALOG) {
      const draft = sampleDraft(e)
      // 逐个字段单独"只填它一个"，其余留空：能区分"是哪个字段写错了"
      for (const f of e.fields) {
        if (f.kind === 'within') continue
        const one: CustomStepDraft = { type: e.type, input: { [f.key]: draft.input[f.key] } }
        // 互斥组要求另一个也在时，跳过（不是这个字段的问题）
        const needsPair = (e.requiredOneOf || []).some(g => g.includes(f.key) && g.length > 1)
        if (needsPair) continue
        const parsed = stepInputSchemas[e.type].safeParse(toEngineSteps([one])[0].input)
        if (parsed.success) continue
        const msgs = parsed.error.issues.map(x => x.message).join('; ')
        // 只可能是"缺必填"（其它必填字段没填），不该是"多了这个键"
        expect(msgs, `${e.type}.${f.key} 被 Zod 拒了：${msgs}`).not.toMatch(/unrecognized|Unrecognized/i)
      }
    }
  })

  it('数值范围与 Zod 对齐（目录 min/max 越界必须也被 Zod 拒，否则表单能填出创建时被拒的值）', () => {
    for (const e of STEP_CATALOG) {
      for (const f of e.fields) {
        if (f.kind !== 'number') continue
        const draft = sampleDraft(e)
        // 目录声明的最小值应当被接受
        if (f.min !== undefined) {
          const atMin: CustomStepDraft = { ...draft, input: { ...draft.input, [f.key]: f.min } }
          const ok = stepInputSchemas[e.type].safeParse(toEngineSteps([atMin])[0].input)
          expect(ok.success, `${e.type}.${f.key} 取目录声明的 min=${f.min} 却被 Zod 拒`).toBe(true)
        }
        // 超出目录声明的上限应当被 Zod 拒（说明上限没有写宽）
        if (f.max !== undefined) {
          const over: CustomStepDraft = { ...draft, input: { ...draft.input, [f.key]: f.max + 1 } }
          const bad = stepInputSchemas[e.type].safeParse(toEngineSteps([over])[0].input)
          expect(bad.success, `${e.type}.${f.key} 超出 max=${f.max} 竟被 Zod 接受（目录上限写得比引擎宽）`).toBe(false)
        }
      }
    }
  })

  it('目录不含高风险/流程专用步骤（loop、ensureRows*、aiGenerate、mirrorTabUrl、fillDraft）', () => {
    const banned = ['loop', 'ensureRows', 'ensureRowsById', 'aiGenerate', 'mirrorTabUrl', 'fillDraft']
    for (const t of banned) {
      expect(findCatalogEntry(t), `不该把 ${t} 开放给自定义编排`).toBeUndefined()
    }
  })

  it('每种步骤都有中文标签、分组与说明（编排器里不出现英文 type）', () => {
    for (const e of STEP_CATALOG) {
      expect(e.label.length, `${e.type} 缺中文标签`).toBeGreaterThan(0)
      expect(e.group.length, `${e.type} 缺分组`).toBeGreaterThan(0)
      expect(e.desc.length, `${e.type} 缺说明`).toBeGreaterThan(0)
      expect(e.label, `${e.type} 的标签不该等于英文 type`).not.toBe(e.type)
    }
  })

  it('catalogGroups 覆盖所有步骤且不重复', () => {
    const groups = catalogGroups()
    const all = new Set(STEP_CATALOG.map(e => e.group))
    expect(new Set(groups).size, '分组名不该重复').toBe(groups.length)
    expect(new Set(groups)).toEqual(all)
  })

  it('makeDraftStep 带上默认值，且默认值能过 Zod', () => {
    for (const e of STEP_CATALOG) {
      const draft = makeDraftStep(e.type)
      expect(draft.type).toBe(e.type)
      // 补上必填项后应当能过（证明默认值本身是合法取值）
      const filled = { ...draft, input: { ...sampleDraft(e).input, ...draft.input } }
      const out = stepInputSchemas[e.type].safeParse(toEngineSteps([filled])[0].input)
      expect(out.success, `${e.type} 的默认值不合法`).toBe(true)
    }
  })
})

// ---------- 提交门禁：这是开放步骤编辑器的前提条件 ----------

describe('自定义任务 · 提交动作必须前置人工确认门禁', () => {
  const gate = (): CustomStepDraft => ({ type: 'waitForUserConfirmation', input: { message: '确认发送？' } })
  const nav = (): CustomStepDraft => ({ type: 'navigate', input: { url: 'https://example.com/a' } })
  const click = (submit: boolean): CustomStepDraft => ({
    type: 'clickByText', input: { text: '确认发送' }, submit
  })

  it('提交动作前没有门禁 → 报错并阻断创建', () => {
    const issues = validateCustomSteps([nav(), click(true)])
    const errs = issues.filter(i => i.level === 'error')
    expect(errs.length, '应当拦住').toBeGreaterThan(0)
    expect(errs[0].message).toContain('门禁')
    expect(errs[0].stepIndex, '要指到具体哪一步').toBe(1)
    expect(hasBlockingIssues(issues)).toBe(true)
  })

  it('门禁在提交动作之前 → 不报这个错', () => {
    const issues = validateCustomSteps([nav(), gate(), click(true)])
    expect(issues.filter(i => i.level === 'error' && i.message.includes('门禁'))).toEqual([])
    expect(hasBlockingIssues(issues)).toBe(false)
  })

  it('门禁放在提交动作**之后**不算数（顺序必须对）', () => {
    const issues = validateCustomSteps([nav(), click(true), gate()])
    const errs = issues.filter(i => i.level === 'error')
    expect(errs.some(e => e.message.includes('门禁')), '门禁在提交之后等于没有').toBe(true)
    expect(hasBlockingIssues(issues)).toBe(true)
  })

  it('没标记为提交动作时不强制门禁（判断权在用户，但会提醒）', () => {
    const issues = validateCustomSteps([nav(), click(false)])
    expect(hasBlockingIssues(issues), '不该拦').toBe(false)
    expect(issues.some(i => i.level === 'warning' && i.message.includes('提交动作'))).toBe(true)
  })

  it('副作用步骤设了重试 → 报错（重试会造成重复点击/重复提交）', () => {
    const s: CustomStepDraft = { type: 'click', input: { selector: 'div' }, retryLimit: 2 }
    const issues = validateCustomSteps([nav(), s])
    expect(issues.some(i => i.level === 'error' && i.message.includes('重试'))).toBe(true)
    expect(hasBlockingIssues(issues)).toBe(true)
  })

  it('可安全重放的步骤设重试 → 允许（例如填写输入框）', () => {
    const s: CustomStepDraft = { type: 'setInput', input: { selector: 'input', text: 'x' }, retryLimit: 2 }
    const issues = validateCustomSteps([nav(), s])
    expect(issues.filter(i => i.level === 'error' && i.message.includes('重试'))).toEqual([])
  })
})

// ---------- 表单校验：必填 / 范围 / 互斥 ----------

describe('自定义任务 · 字段校验', () => {
  const nav = (): CustomStepDraft => ({ type: 'navigate', input: { url: 'https://example.com/a' } })

  it('空步骤 → 报错', () => {
    const issues = validateCustomSteps([])
    expect(hasBlockingIssues(issues)).toBe(true)
  })

  it('未登记的步骤类型 → 报错（不能绕过目录塞任意类型）', () => {
    const issues = validateCustomSteps([{ type: 'loop', input: {} }])
    expect(issues.some(i => i.level === 'error' && i.message.includes('未登记'))).toBe(true)
  })

  it('必填字段为空 → 报错并指出是哪个字段', () => {
    const issues = validateCustomSteps([nav(), { type: 'click', input: {} }])
    const err = issues.find(i => i.level === 'error' && i.stepIndex === 1)
    expect(err?.message).toContain('选择器')
  })

  it('数值越界 → 报错并给出范围', () => {
    const s: CustomStepDraft = { type: 'waitMs', input: { ms: 999999 } }
    const issues = validateCustomSteps([nav(), s])
    const err = issues.find(i => i.level === 'error' && i.stepIndex === 1)
    expect(err?.message).toContain('范围')
  })

  it('数字字段填非数字 → 报错', () => {
    const s: CustomStepDraft = { type: 'waitMs', input: { ms: 'abc' } }
    expect(validateCustomSteps([nav(), s]).some(i => i.level === 'error' && i.message.includes('必须是数字'))).toBe(true)
  })

  it('互斥组两个都填 / 都不填 → 报错（clickAll 的 selector 与 text）', () => {
    const both: CustomStepDraft = { type: 'clickAll', input: { selector: 'a', text: 'b', max: 1 } }
    const neither: CustomStepDraft = { type: 'clickAll', input: { max: 1 } }
    expect(validateCustomSteps([nav(), both]).some(i => i.level === 'error' && i.message.includes('只能填一个'))).toBe(true)
    expect(validateCustomSteps([nav(), neither]).some(i => i.level === 'error' && i.message.includes('只能填一个'))).toBe(true)
    // 恰好填一个 → 通过
    const one: CustomStepDraft = { type: 'clickAll', input: { selector: 'a', max: 1 } }
    expect(validateCustomSteps([nav(), one]).filter(i => i.level === 'error')).toEqual([])
  })

  it('within 的 selector 与 text 都填 → 报错（Zod 的 refine 二选一）', () => {
    const s: CustomStepDraft = {
      type: 'clickByText',
      input: { text: '确认', within: { selector: 'div', text: '行' } }
    }
    expect(validateCustomSteps([nav(), s]).some(i => i.level === 'error' && i.message.includes('二选一'))).toBe(true)
  })

  it('整单没有导航步骤 → 警告（不拦，但提醒结果取决于当时停在哪一页）', () => {
    const s: CustomStepDraft = { type: 'screenshot', input: {} }
    const issues = validateCustomSteps([s])
    expect(hasBlockingIssues(issues), '只是警告不该拦住').toBe(false)
    expect(issues.some(i => i.level === 'warning' && i.message.includes('导航'))).toBe(true)
  })
})

// ---------- 序列化：交给引擎的步骤必须干净 ----------

describe('自定义任务 · 序列化为引擎步骤', () => {
  it('丢掉空字段，但保留 false 与 0（它们是合法取值，不是"没填"）', () => {
    const steps = toEngineSteps([{
      type: 'waitForSelector',
      input: { selector: 'div', deep: false }
    }])
    expect(steps[0].input).toEqual({ selector: 'div', deep: false })

    const withZero = toEngineSteps([{ type: 'requireQuota', input: { textIncludes: '剩余', min: 0 } }])
    expect((withZero[0].input as any).min, 'min=0 不能被当成没填丢掉').toBe(0)
  })

  it('丢掉未填的可选文本字段（strict() 下留着空串会整单被拒）', () => {
    const steps = toEngineSteps([{ type: 'readText', input: { selector: 'div', metric: '' } }])
    expect(steps[0].input).toEqual({ selector: 'div' })
  })

  it('数字字段转成数字（表单里是字符串，引擎要数字）', () => {
    const steps = toEngineSteps([{ type: 'waitMs', input: { ms: '3000' } }])
    expect((steps[0].input as any).ms).toBe(3000)
    expect(typeof (steps[0].input as any).ms).toBe('number')
  })

  it('within 只保留填了的那个分支，并丢掉空对象', () => {
    const a = toEngineSteps([{ type: 'clickByText', input: { text: 'x', within: { selector: 'div' } } }])
    expect((a[0].input as any).within).toEqual({ selector: 'div' })

    const b = toEngineSteps([{ type: 'clickByText', input: { text: 'x', within: { text: '行', climb: '2' } } }])
    expect((b[0].input as any).within).toEqual({ text: '行', climb: 2 })

    const c = toEngineSteps([{ type: 'clickByText', input: { text: 'x', within: {} } }])
    expect((c[0].input as any).within, '空的 within 要整个丢掉').toBeUndefined()
  })

  it('丢弃目录之外的键（用户改不了、也不该发出去的元数据）', () => {
    const steps = toEngineSteps([{
      type: 'click', input: { selector: 'div' }, submit: true
    }])
    expect(steps[0]).toEqual({ type: 'click', input: { selector: 'div' } })
    expect('submit' in steps[0], 'submit 是编排器元数据，不该发给引擎').toBe(false)
  })

  it('序列化结果能过 Zod（端到端：表单 → 引擎）', () => {
    const drafts: CustomStepDraft[] = [
      { type: 'navigate', input: { url: 'https://example.com/square' } },
      { type: 'waitForPage', input: { urlIncludes: 'square' } },
      { type: 'clickByText', input: { text: '搜索', mode: 'js', deep: true } },
      { type: 'waitForUserConfirmation', input: { message: '确认发送？' } },
      { type: 'clickByText', input: { text: '确认发送', mode: 'real' }, submit: true },
      { type: 'screenshot', input: {} }
    ]
    expect(hasBlockingIssues(validateCustomSteps(drafts)), '这份草稿应当可直接创建').toBe(false)
    for (const s of toEngineSteps(drafts)) {
      const out = stepInputSchemas[s.type as string].safeParse(s.input)
      expect(out.success, `${s.type} 序列化后过不了 Zod`).toBe(true)
    }
  })
})
