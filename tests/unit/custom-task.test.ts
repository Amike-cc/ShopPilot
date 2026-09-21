import { describe, it, expect } from 'vitest'
import {
  STEP_CATALOG,
  catalogGroups,
  findCatalogEntry,
  hasBlockingIssues,
  makeDraftStep,
  toEngineSteps,
  validateCustomSteps,
  CUSTOM_TASK_MAX_STEPS,
  type CustomStepDraft
} from '../../packages/shared/src/custom-task'
import { TASK_STEP_TYPES } from '../../packages/shared/src/schemas/task'
import { stepInputSchemas, taskCreateSchema } from '../../apps/desktop/src/main/tasks/task-step-schemas'

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

  /**
   * 「拾取」标记的防漂移组。
   *
   * pick 决定哪个字段旁边出现「拾取」按钮。标错的两个方向都伤用户：
   *   - 该标没标 → 用户只能手抄选择器，等于这个功能不存在（这正是本轮要解决的问题）；
   *   - 不该标标了 → 按钮点了会在页面上点出一个跟该字段毫无关系的东西填进去，
   *     用户拿到的锚点看着像对的（确实是个真选择器），任务却跑不通。
   * 两种都不会有编译期信号，只能靠断言钉住。
   */
  it('页面上"已有的元素锚点"字段都给了拾取（选择器类）', () => {
    // 这些字段的值全是"页面上某个元素的选择器"——用户不可能凭空写出来，只能从页面取
    const selectorFields: Array<[string, string]> = [
      ['waitForSelector', 'selector'], ['waitForGone', 'selector'], ['readText', 'selector'],
      ['readTable', 'selector'], ['click', 'selector'], ['clickAll', 'selector'],
      ['setInput', 'selector'], ['typeText', 'selector']
    ]
    for (const [type, key] of selectorFields) {
      const f = findCatalogEntry(type)?.fields.find(x => x.key === key)
      expect(f, `${type}.${key} 字段不存在`).toBeTruthy()
      expect(f!.pick, `${type}.${key} 是页面元素锚点，应标 pick: 'selector'`).toBe('selector')
    }
  })

  it('页面上"已有的文案锚点"字段都给了拾取（文案类）', () => {
    const textFields: Array<[string, string]> = [
      ['waitForText', 'text'], ['clickByText', 'text'], ['clickIfPresent', 'text'],
      ['clickIfPresent', 'nearText'], ['clickAll', 'text'], ['clickAll', 'counterIncludes'],
      ['readLabelValue', 'label'], ['requireEnabled', 'text'],
      ['requireTextAbsent', 'text'], ['requireQuota', 'textIncludes']
    ]
    for (const [type, key] of textFields) {
      const f = findCatalogEntry(type)?.fields.find(x => x.key === key)
      expect(f, `${type}.${key} 字段不存在`).toBeTruthy()
      expect(f!.pick, `${type}.${key} 是页面文案锚点，应标 pick: 'text'`).toBe('text')
    }
  })

  it('"要写进去的值"与"目标地址"不给拾取（给了只会误导）', () => {
    // navigate.url 是目标网址、setInput/typeText.text 是要写入的内容、waitForUserConfirmation.message
    // 是给用户看的提示语——它们都不是"页面上已经存在的东西"，拾取按钮点出来的东西
    // 与这些字段的语义完全对不上。
    const notPickable: Array<[string, string]> = [
      ['navigate', 'url'], ['setInput', 'text'], ['typeText', 'text'],
      ['waitForUserConfirmation', 'message'], ['readText', 'metric'],
      ['readTable', 'metric'], ['requireQuota', 'hint']
    ]
    for (const [type, key] of notPickable) {
      const f = findCatalogEntry(type)?.fields.find(x => x.key === key)
      expect(f, `${type}.${key} 字段不存在`).toBeTruthy()
      expect(f!.pick, `${type}.${key} 不是页面上的锚点，不该给拾取按钮`).toBeUndefined()
    }
  })

  it('pick 的值只有 selector / text 两种（拼错了会渲染出一个语义不明的按钮）', () => {
    for (const e of STEP_CATALOG) {
      for (const f of e.fields) {
        if (f.pick === undefined) continue
        expect(['selector', 'text'], `${e.type}.${f.key} 的 pick 值不合法`).toContain(f.pick)
        // 标记了拾取的字段必须是文本输入（拾取产出的是字符串）
        expect(f.kind, `${e.type}.${f.key} 标了拾取却不是文本字段`).toBe('text')
      }
    }
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

/**
 * 「客户端放行 ⇒ 主进程也放行」是这套两段校验的**唯一契约**：
 * 客户端只做即时反馈，权威永远是主进程 Zod。两者一旦不一致，用户看到的就是
 * "表单填得好好的、点创建被拒"，而错误还是引擎味的 TASK_INVALID_STEP——
 * 正是当初决定不给步骤编辑器的理由。下面几条把已知的漂移面逐个钉死。
 */
describe('自定义任务 · 客户端校验不许比主进程更宽松（防"放行了却被拒"）', () => {
  /** 造一条除待测字段外都合法的草稿 */
  function inputWith(entry: (typeof STEP_CATALOG)[number], key: string, value: unknown): Record<string, unknown> {
    const input: Record<string, unknown> = {}
    const skip = new Set<string>()
    for (const group of entry.requiredOneOf || []) {
      if (group.includes(key)) for (const k of group) if (k !== key) skip.add(k)
      else for (const k of group.slice(1)) skip.add(k)
    }
    const draft = sampleDraft(entry)
    for (const f of entry.fields) {
      if (f.kind === 'within' || skip.has(f.key)) continue
      input[f.key] = f.key === key ? value : draft.input[f.key]
    }
    return input
  }

  function engineAccepts(entry: (typeof STEP_CATALOG)[number], input: Record<string, unknown>): boolean {
    return stepInputSchemas[entry.type].safeParse(toEngineSteps([{ type: entry.type, input }])[0].input).success
  }

  it('每个文本字段：客户端放行的长度，主进程也必须接受（目录 maxLength 没写宽）', () => {
    const probes = [1, 40, 60, 61, 100, 200, 201, 300, 500, 501, 2000, 2001]
    for (const e of STEP_CATALOG) {
      for (const f of e.fields) {
        if (f.kind !== 'text' || f.format === 'httpUrl') continue
        for (const n of probes) {
          const value = 'x'.repeat(n)
          const input = inputWith(e, f.key, value)
          const clientOk = !hasBlockingIssues(validateCustomSteps([{ type: e.type, input }]))
          if (!clientOk) continue
          expect(
            engineAccepts(e, input),
            `${e.type}.${f.key} 填 ${n} 字：客户端放行但主进程拒绝（目录的 maxLength 与 Zod 不一致）`
          ).toBe(true)
        }
      }
    }
  })

  it('每个数值字段：客户端放行的值，主进程也必须接受（含小数/科学计数法等手填写法）', () => {
    const probes = ['1', '3.5', '0.5', '1e2', '1e-2', '-1', ' 5 ', '3000']
    for (const e of STEP_CATALOG) {
      for (const f of e.fields) {
        if (f.kind !== 'number') continue
        for (const v of probes) {
          const input = inputWith(e, f.key, v)
          const clientOk = !hasBlockingIssues(validateCustomSteps([{ type: e.type, input }]))
          if (!clientOk) continue
          expect(
            engineAccepts(e, input),
            `${e.type}.${f.key} 填 ${JSON.stringify(v)}：客户端放行但主进程拒绝`
          ).toBe(true)
        }
      }
    }
  })

  it('网址字段：客户端放行的值必须是主进程认的 http/https（含各种手填错法）', () => {
    const probeUrls = [
      'https://example.com/page', 'http://localhost:8080/x', 'HTTPS://EXAMPLE.COM/X',
      'https://例子.中国/资质页', 'https://a.com/?q=1#h',
      'wx.qq.com/page', 'example.com', 'javascript:alert(1)', 'ftp://a.com', 'http://'
    ]
    const nav = findCatalogEntry('navigate')!
    for (const url of probeUrls) {
      const input = inputWith(nav, 'url', url)
      const clientOk = !hasBlockingIssues(validateCustomSteps([{ type: 'navigate', input }]))
      if (!clientOk) continue
      expect(engineAccepts(nav, input), `url=${url}：客户端放行但主进程拒绝`).toBe(true)
    }
  })

  it('明显写错的网址必须被客户端拦下（而不是留给主进程报错）', () => {
    const nav = findCatalogEntry('navigate')!
    for (const bad of ['wx.qq.com/page', 'javascript:alert(1)', 'ftp://a.com', 'http://', '   ']) {
      const input = inputWith(nav, 'url', bad)
      const issues = validateCustomSteps([{ type: 'navigate', input }])
      expect(hasBlockingIssues(issues), `url=${JSON.stringify(bad)} 应当被客户端拦下`).toBe(true)
      expect(issues.some(i => i.message.includes('网址'))).toBe(true)
    }
  })

  it('超长文本必须被客户端拦下并说清上限', () => {
    const click = findCatalogEntry('click')!
    const input = inputWith(click, 'selector', 'x'.repeat(501))
    const issues = validateCustomSteps([{ type: 'click', input }])
    expect(hasBlockingIssues(issues)).toBe(true)
    expect(issues.some(i => i.level === 'error' && i.message.includes('最多 500'))).toBe(true)
  })

  it('步骤总数：客户端上限与主进程 taskCreateSchema 一致', () => {
    const at = (n: number): CustomStepDraft[] => {
      const out: CustomStepDraft[] = [{ type: 'navigate', input: { url: 'https://example.com/a' } }]
      while (out.length < n) out.push({ type: 'screenshot', input: {} })
      return out
    }
    // 边界值本身合法：正好上限必须两边都放行
    expect(hasBlockingIssues(validateCustomSteps(at(CUSTOM_TASK_MAX_STEPS))), '正好上限不该被拦').toBe(false)
    expect(
      taskCreateSchema.safeParse({ name: 'n', storeScope: 's', steps: toEngineSteps(at(CUSTOM_TASK_MAX_STEPS)) }).success
    ).toBe(true)

    // 超一步：客户端必须自己拦下，而不是等主进程拒
    const over = at(CUSTOM_TASK_MAX_STEPS + 1)
    expect(hasBlockingIssues(validateCustomSteps(over)), '超过上限应当被客户端拦下').toBe(true)
    expect(validateCustomSteps(over).some(i => i.message.includes('最多') && i.message.includes('步'))).toBe(true)
    expect(
      taskCreateSchema.safeParse({ name: 'n', storeScope: 's', steps: toEngineSteps(over) }).success,
      '主进程确实会拒 —— 所以客户端必须拦'
    ).toBe(false)
  })

  it('within 子字段：客户端放行的长度/上溯层数，主进程也必须接受', () => {
    const probes: Array<Record<string, unknown>> = [
      { selector: 'x'.repeat(300) }, { selector: 'x'.repeat(301) },
      { text: 'x'.repeat(60) }, { text: 'x'.repeat(61) },
      { text: 'row', climb: 0 }, { text: 'row', climb: 6 },
      { text: 'row', climb: 7 }, { text: 'row', climb: -1 }
    ]
    for (const within of probes) {
      const draft: CustomStepDraft = { type: 'clickByText', input: { text: '确认', within } }
      const clientOk = !hasBlockingIssues(validateCustomSteps([draft]))
      if (!clientOk) continue
      const ok = stepInputSchemas.clickByText.safeParse(toEngineSteps([draft])[0].input).success
      expect(ok, `within=${JSON.stringify(within)}：客户端放行但主进程拒绝`).toBe(true)
    }
  })

  it('within 的越界值必须被客户端拦下', () => {
    for (const within of [{ selector: 'x'.repeat(301) }, { text: 'x'.repeat(61) }, { text: 'row', climb: 7 }]) {
      const draft: CustomStepDraft = { type: 'clickByText', input: { text: '确认', within } }
      expect(hasBlockingIssues(validateCustomSteps([draft])), `within=${JSON.stringify(within)} 应当被拦`).toBe(true)
    }
  })

  it('每种步骤的目录字段都能构造出"两端都放行"的样本（没有字段把创建彻底堵死）', () => {
    for (const e of STEP_CATALOG) {
      const draft = sampleDraft(e)
      const issues = validateCustomSteps([draft])
      const blocking = issues.filter(i => i.level === 'error')
      expect(blocking, `${e.type} 的样本草稿被客户端拦了：${blocking[0]?.message || ''}`).toEqual([])
      expect(engineAccepts(e, draft.input), `${e.type} 的样本草稿主进程不接受`).toBe(true)
    }
  })
})

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

  it('数字字段填小数 → 报错（主进程全是 .int()，放行会变成"创建被拒"）', () => {
    for (const draft of [
      { type: 'waitMs', input: { ms: '3.5' } },
      { type: 'waitMs', input: { ms: 1.5 } },
      { type: 'waitMs', input: { ms: '0.5' } }
    ] as CustomStepDraft[]) {
      const issues = validateCustomSteps([nav(), draft])
      expect(issues.some(i => i.level === 'error' && i.message.includes('必须是整数')), JSON.stringify(draft)).toBe(true)
      expect(hasBlockingIssues(issues)).toBe(true)
    }
    // 整数照常放行
    expect(validateCustomSteps([nav(), { type: 'waitMs', input: { ms: 3000 } }]).filter(i => i.level === 'error')).toEqual([])
    // 科学计数法解析出来是整数，引擎也接受，不该误报
    expect(stepInputSchemas.waitMs.safeParse(toEngineSteps([{ type: 'waitMs', input: { ms: '1e3' } }])[0].input).success).toBe(true)
    expect(validateCustomSteps([nav(), { type: 'waitMs', input: { ms: '1e3' } }]).filter(i => i.level === 'error')).toEqual([])
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

  it('超时越界/非整数 → 报错并指到具体步骤（与主进程 500~3600000 对齐）', () => {
    const nav = (): CustomStepDraft => ({ type: 'navigate', input: { url: 'https://example.com/a' } })
    for (const bad of [499, 3600001, 1.5, 'abc', NaN] as unknown[]) {
      const s: CustomStepDraft = { type: 'waitMs', input: { ms: 1000 }, timeoutMs: bad as number }
      const issues = validateCustomSteps([nav(), s])
      const err = issues.find(i => i.level === 'error' && i.stepIndex === 1)
      expect(err?.message, `timeoutMs=${String(bad)} 应当被拦`).toContain('超时')
      expect(hasBlockingIssues(issues)).toBe(true)
    }
    // 边界值放行
    for (const good of [500, 3000, 3600000]) {
      const s: CustomStepDraft = { type: 'waitMs', input: { ms: 1000 }, timeoutMs: good }
      expect(
        validateCustomSteps([nav(), s]).filter(i => i.level === 'error' && i.stepIndex === 1),
        `timeoutMs=${good} 不该拦`
      ).toEqual([])
    }
  })

  it('重试次数越界/非整数 → 报错（与主进程 0~5 对齐）', () => {
    const nav = (): CustomStepDraft => ({ type: 'navigate', input: { url: 'https://example.com/a' } })
    for (const bad of [-1, 6, 1.5, 'abc'] as unknown[]) {
      // 用可重放步骤，避免同时触发"副作用禁重试"那条，单独测范围
      const s: CustomStepDraft = { type: 'waitForSelector', input: { selector: 'div' }, retryLimit: bad as number }
      const issues = validateCustomSteps([nav(), s])
      expect(
        issues.some(i => i.level === 'error' && i.stepIndex === 1 && i.message.includes('重试')),
        `retryLimit=${String(bad)} 应当被拦`
      ).toBe(true)
    }
    expect(
      validateCustomSteps([nav(), { type: 'waitForSelector', input: { selector: 'div' }, retryLimit: 3 }])
        .filter(i => i.level === 'error'),
      'retryLimit=3 不该拦'
    ).toEqual([])
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

  it('超时/重试字符串转数字，非数字丢掉不透传（非法值由 validate 报 error）', () => {
    const a = toEngineSteps([{ type: 'waitMs', input: { ms: 1000 }, timeoutMs: '3000' as unknown as number }])
    expect(a[0].timeoutMs).toBe(3000)
    const b = toEngineSteps([{ type: 'waitMs', input: { ms: 1000 }, timeoutMs: 'abc' as unknown as number }])
    expect('timeoutMs' in b[0], '非数字超时不应发给引擎').toBe(false)
    const c = toEngineSteps([{ type: 'waitForSelector', input: { selector: 'div' }, retryLimit: '2' as unknown as number }])
    expect(c[0].retryLimit).toBe(2)
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
