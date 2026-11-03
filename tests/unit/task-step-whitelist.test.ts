import { describe, expect, it } from 'vitest'
import { TASK_STEP_TYPES } from '@shared/schemas/task'
import { inviteProfileFor } from '@shared/constants/invite'
import { buildInviteSteps, type StepDraft } from '@shared/invite-steps'
import { DEFAULT_STEP_TIMEOUT, stepInputSchemas } from '../../apps/desktop/src/main/tasks/task-step-schemas'

/**
 * 步骤白名单的完整性闸门（2026-10-25）。
 *
 * 事故：`scrollNext` 在 2026-10-21 加进了 `TASK_STEP_TYPES`、幂等表与 executor，
 * **唯独没加进 `stepInputSchemas`**。`validateStepInput` 是第一道也是唯一一道建任务闸门，
 * 拿不到 schema 就抛「step 9.3 scrollNext: 未登记的步骤类型」——抖店侧栏点「开始邀约」
 * 100% 失败，而且报错发生在建任务阶段，界面上只看到一句 toast。
 *
 * 为什么既有测试没拦住：
 *   · `taskCreateSchema` 只校验 `type` 在枚举里，不看 `input`；
 *   · 幂等测试只比对 `TASK_STEP_TYPES` ↔ `STEP_IDEMPOTENT_TYPES`，两者都有 scrollNext，一致；
 *   · 白名单本身是 `Record<string, ZodSchema>`，TypeScript 不会因为少一个键报错。
 * 所以这里同时钉两件事：**类型 ↔ 白名单一一对应**，以及**真实构造的邀约步骤能过白名单**。
 */

describe('步骤白名单与引擎类型一一对应', () => {
  it('每个 TASK_STEP_TYPES 都有输入 schema，且白名单里没有多余类型', () => {
    const declared = [...TASK_STEP_TYPES].sort()
    const registered = Object.keys(stepInputSchemas).sort()
    expect(registered).toEqual(declared)
  })

  it('每个类型的默认超时要么显式声明，要么走 15s 兜底（不能是 0/负数/NaN）', () => {
    for (const type of TASK_STEP_TYPES) {
      const value = DEFAULT_STEP_TIMEOUT[type] ?? 15000
      expect(Number.isFinite(value), `${type} 的默认超时不是有限数`).toBe(true)
      expect(value).toBeGreaterThanOrEqual(500)
    }
    // 滚动一屏要等 settle 检测（最多 1s）+ 页面重渲染，必须显式给值
    expect(DEFAULT_STEP_TIMEOUT.scrollNext).toBe(20000)
  })
})

/** 递归按白名单校验真实构造出的步骤（loop 的嵌套步骤走同一条路径，与 task-store 一致）。 */
function expectDraftValid(draft: StepDraft, path: string): void {
  const schema = stepInputSchemas[draft.type]
  expect(schema, `${path} ${draft.type}：缺少白名单 schema`).toBeTruthy()
  const parsed = schema.safeParse(draft.input ?? {})
  const detail = parsed.success ? '' : parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')
  expect(parsed.success, `${path} ${draft.type}：${detail}`).toBe(true)
  if (draft.type === 'loop') {
    const children = (draft.input as { steps?: StepDraft[] }).steps || []
    expect(children.length, `${path} loop 没有嵌套步骤`).toBeGreaterThan(0)
    children.forEach((child, index) => expectDraftValid(child, `${path}.${index + 1}`))
  }
}

describe('三个平台的邀约步骤都能过白名单（建任务不再被拒）', () => {
  it('抖店逐人沟通（含 scrollNext）', () => {
    const profile = inviteProfileFor('抖店')!
    const steps = buildInviteSteps(profile, {
      batch: {
        category: '服饰内衣', levels: ['LV0'], finderType: '视频达人',
        count: 3, script: '', scriptMode: 'manual', benefits: [], recentlyInvited: []
      }
    }, profile.pageUrl)
    steps.forEach((step, index) => expectDraftValid(step, `抖店.${index + 1}`))
    // 事故点单独钉住：这个类型必须真的出现在抖店流里，否则上面等于没测
    const loop = steps.find(step => step.type === 'loop')!
    const inner = (loop.input as { steps: StepDraft[] }).steps
    expect(inner.map(step => step.type)).toContain('scrollNext')
    // 2026-11-01 真机：优惠券装饰图盖住「在线沟通」落点 → 必须显式允许解除非交互图片遮挡；
    // 同时点完按 Esc，避免会话浮层挡住下一轮。
    const contactClick = inner.find(step => step.type === 'clickByText' && (step.input as { text?: string }).text === '在线沟通')
    expect((contactClick?.input as { ignoreImageOverlay?: boolean })?.ignoreImageOverlay).toBe(true)
    expect(inner.map(step => step.type)).toContain('pressKey')
  })

  it('快手小店批量勾选（含商品弹窗收尾）', () => {
    const profile = inviteProfileFor('快手小店')!
    const steps = buildInviteSteps(profile, {
      batch: {
        category: '', levels: [], count: 5, totalCap: 20,
        script: '你好', scriptMode: 'manual', benefits: [], recentlyInvited: []
      }
    }, profile.pageUrl)
    steps.forEach((step, index) => expectDraftValid(step, `快手.${index + 1}`))
  })

  it('微信小店逐个代填', () => {
    const profile = inviteProfileFor('微信小店')!
    const steps = buildInviteSteps(profile, {
      assist: {
        contact: '张三', phone: '13800138000', wechat: 'wx_test',
        script: '你好', scriptMode: 'manual', productCount: 1, maxInvites: 3,
        recentlyInvited: []
      }
    }, profile.pageUrl)
    steps.forEach((step, index) => expectDraftValid(step, `微信.${index + 1}`))
  })
})

describe('clickByText 的装饰图忽略选项', () => {
  const schema = stepInputSchemas.clickByText
  it('ignoreImageOverlay 是合法布尔开关（只影响真实点击的落点判定）', () => {
    expect(schema.safeParse({ text: '在线沟通', mode: 'real', ignoreImageOverlay: true }).success).toBe(true)
    expect(schema.safeParse({ text: '在线沟通', mode: 'real', ignoreImageOverlay: 'yes' }).success).toBe(false)
  })

  it('allVisitedCode 与 missingCode 分开：前者可交给 loop 滚动恢复', () => {
    expect(schema.safeParse({ text: '在线沟通', allVisitedCode: 'TASK_DOU_DIAN_PAGE_VISITED' }).success).toBe(true)
    expect(schema.safeParse({ text: '在线沟通', allVisitedCode: '' }).success).toBe(false)
  })

  it('skipTextsMatch 只接受 contains / exact-nickname', () => {
    expect(schema.safeParse({ text: '在线沟通', skipTexts: ['小美'], skipTextsMatch: 'exact-nickname' }).success).toBe(true)
    expect(schema.safeParse({ text: '在线沟通', skipTextsMatch: 'contains' }).success).toBe(true)
    expect(schema.safeParse({ text: '在线沟通', skipTextsMatch: 'fuzzy' }).success).toBe(false)
  })
})

describe('scrollNext 的入参边界', () => {
  const schema = stepInputSchemas.scrollNext
  it('接受 text / selector / 空输入（锚点有默认值）', () => {
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ text: '在线沟通' }).success).toBe(true)
    expect(schema.safeParse({ selector: '.auxo-table-body' }).success).toBe(true)
  })

  it('拒绝拼错/多余字段（strict，避免静默失效）', () => {
    expect(schema.safeParse({ txet: '在线沟通' }).success).toBe(false)
  })
})
