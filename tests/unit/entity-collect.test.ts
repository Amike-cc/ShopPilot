import { describe, expect, it } from 'vitest'
import {
  ENTITY_METRIC_NAME,
  ENTITY_METRIC_NO,
  ENTITY_PROFILES,
  ENTITY_SUPPORTED_PLATFORMS,
  ENTITY_UNSUPPORTED_NOTE,
  entityProfileFor,
  entityUnsupportedNote
} from '@shared/constants/entity'
import { buildEntityCollectSteps } from '@shared/entity-steps'
import { stepInputSchemas } from '../../apps/desktop/src/main/tasks/task-step-schemas'

describe('主体信息档案（去平台后台读本店自己的营业执照）', () => {
  it('只登记已实测过的平台（快手小店 + 拼多多 + 微信小店 + 抖店），未实测的不猜', () => {
    expect([...ENTITY_SUPPORTED_PLATFORMS].sort()).toEqual(['快手小店', '拼多多', '微信小店', '抖店'].sort())
    // 四家都实测过了 → 「未实测说明」应为空（两边都写会让界面自相矛盾）
    expect(Object.keys(ENTITY_UNSUPPORTED_NOTE)).toEqual([])
    expect(entityProfileFor(null)).toBeNull()
  })

  it('每个档案都齐备：页面地址是 https、就绪判据落在地址里、锚点与实测日期都在', () => {
    for (const [name, p] of Object.entries(ENTITY_PROFILES)) {
      expect(p.platform, name).toBe(name)
      expect(p.pageUrl.startsWith('https://'), name).toBe(true)
      expect(p.pageUrl.includes(p.urlMarker), name).toBe(true)
      expect(p.settleMs, name).toBeGreaterThan(0)
      expect(p.measuredAt, name).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(p.limits?.length, `${name} 要写清实测局限`).toBeGreaterThan(0)
      // 两种读取方式**二选一**：读页面锚点（readLabelValue）或读接口（readApi）。
      // 走接口的没有页面锚点，所以这里按分支校验，而不是一律要求锚点非空。
      if (p.api) {
        expect(p.api.urlMarker.length, name).toBeGreaterThan(0)
        expect(p.api.namePath.length, name).toBeGreaterThan(0)
        expect(p.api.noPath.length, name).toBeGreaterThan(0)
      } else {
        expect(p.noAnchor.length, name).toBeGreaterThan(0)
        expect(p.nameAnchors.length, name).toBeGreaterThan(0)
        expect(new Set(p.nameAnchors).size, name).toBe(p.nameAnchors.length)   // 候选不能重复
        expect(new Set([p.noAnchor, ...(p.noAnchors || [])]).size, name).toBe(1 + (p.noAnchors || []).length)  // 代码候选也不能重复
      }
    }
  })

  it('四家都实测通过后，「取不到」的说明应为空（留着会让界面自相矛盾）', () => {
    expect(Object.keys(ENTITY_UNSUPPORTED_NOTE)).toEqual([])
    for (const platform of ['快手小店', '拼多多', '微信小店', '抖店']) {
      expect(entityProfileFor(platform), platform).toBeTruthy()
    }
    // 真碰到没档案的平台时，兜底那句话必须是"尚未实测"，**不能**说成"该平台没有主体信息"
    const fallback = entityUnsupportedNote('某新平台')
    expect(fallback).toContain('尚未实测')
    expect(fallback).not.toContain('没有主体信息页')
  })
})

describe('主体采集步骤', () => {
  const profile = entityProfileFor('快手小店')!

  it('序列：导航 → 等就绪 → 显式等取数 → 先按代码标签（含候选）读 → 再按名称候选读', () => {
    const steps = buildEntityCollectSteps(profile)
    const codeLabels = [profile.noAnchor, ...(profile.noAnchors || [])]
    expect(steps.map(s => s.type)).toEqual([
      'navigate', 'waitForPage', 'waitMs',
      ...codeLabels.map(() => 'readLabelValue'),
      ...profile.nameAnchors.map(() => 'readLabelValue')
    ])
    expect(steps[0].input.url).toBe(profile.pageUrl)
    expect(steps[1].input.urlIncludes).toBe(profile.urlMarker)
    expect(steps[2].input.ms).toBe(profile.settleMs)
  })

  it('**先读统一社会信用代码（及其候选）、再读名称**：代码标签跨主体类型更稳，名称行文案会变', () => {
    const reads = buildEntityCollectSteps(profile).filter(s => s.type === 'readLabelValue')
    const codeLabels = [profile.noAnchor, ...(profile.noAnchors || [])]
    expect(reads.slice(0, codeLabels.length).map(s => s.input.label)).toEqual(codeLabels)
    expect(reads.slice(0, codeLabels.length).every(s => s.input.metric === ENTITY_METRIC_NO)).toBe(true)
    expect(reads.slice(codeLabels.length).map(s => s.input.label)).toEqual(profile.nameAnchors)
    expect(reads.slice(codeLabels.length).every(s => s.input.metric === ENTITY_METRIC_NAME)).toBe(true)
  })

  it('拼多多档案（2026-10-14 实测）：页址、代码行文案与名称候选都按实测登记', () => {
    const pdd = entityProfileFor('拼多多')!
    expect(pdd.pageUrl).toBe('https://mms.pinduoduo.com/mallcenter/info/main/index')
    expect(pdd.noAnchor).toBe('营业执照注册号')            // 实测这一行的文案
    expect(pdd.noAnchors).toContain('统一社会信用代码')     // 未实测的同族候选
    expect(pdd.nameAnchors[0]).toBe('个体工商户名称')
    expect(pdd.measuredAt).toBe('2026-10-14')
    // 候选都要能真的生成步骤，且都过引擎白名单
    for (const s of buildEntityCollectSteps(pdd)) {
      expect((stepInputSchemas as any)[s.type].safeParse(s.input).success, `${s.type} ${JSON.stringify(s.input)}`).toBe(true)
    }
  })

  it('每个读取都要 allowText（公司名/代码要被数值抽取截断）+ absentOk（该主体类型没有这一行不算失败）', () => {
    for (const s of buildEntityCollectSteps(profile).filter(s => s.type === 'readLabelValue')) {
      expect(s.input.allowText, String(s.input.label)).toBe(true)
      expect(s.input.absentOk, String(s.input.label)).toBe(true)
      expect(s.input.maxValueLen).toBeGreaterThan(0)
    }
  })

  it('步骤参数全部过引擎白名单（absentOk 是白名单字段，未知字段仍被拒）', () => {
    for (const s of buildEntityCollectSteps(profile)) {
      const schema = (stepInputSchemas as any)[s.type]
      expect(schema, s.type).toBeTruthy()
      expect(schema.safeParse(s.input).success, `${s.type} ${JSON.stringify(s.input)}`).toBe(true)
    }
    expect(stepInputSchemas.readLabelValue.safeParse({ label: '统一社会信用代码', metric: ENTITY_METRIC_NO, allowText: true, absentOk: true }).success).toBe(true)
    expect(stepInputSchemas.readLabelValue.safeParse({ label: 'x', absentOk: true, evil: 1 }).success).toBe(false)
  })

  it('值上限挡住"爬到整块容器"（读到的不是单值时必须如实失败，而不是把一整块文本当主体名）', () => {
    const steps = buildEntityCollectSteps(profile)
    for (const s of steps.filter(x => x.type === 'readLabelValue')) {
      expect(s.input.maxValueLen).toBeLessThanOrEqual(200)
      expect(s.input.maxValueLen).toBeGreaterThanOrEqual(40)
    }
  })
})
