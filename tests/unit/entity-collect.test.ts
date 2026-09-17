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
  it('只登记已实测锚点的平台（当前＝快手小店），不猜', () => {
    expect([...ENTITY_SUPPORTED_PLATFORMS]).toEqual(['快手小店'])
    expect(entityProfileFor('抖店')).toBeNull()
    expect(entityProfileFor('拼多多')).toBeNull()
    expect(entityProfileFor('微信小店')).toBeNull()
    expect(entityProfileFor(null)).toBeNull()
  })

  it('每个档案都齐备：页面地址是 https、就绪判据落在地址里、两个锚点与实测日期都在', () => {
    for (const [name, p] of Object.entries(ENTITY_PROFILES)) {
      expect(p.platform, name).toBe(name)
      expect(p.pageUrl.startsWith('https://'), name).toBe(true)
      expect(p.pageUrl.includes(p.urlMarker), name).toBe(true)
      expect(p.settleMs, name).toBeGreaterThan(0)
      expect(p.measuredAt, name).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(p.noAnchor.length, name).toBeGreaterThan(0)
      expect(p.nameAnchors.length, name).toBeGreaterThan(0)
      expect(new Set(p.nameAnchors).size, name).toBe(p.nameAnchors.length)   // 候选不能重复
      expect(p.limits?.length, `${name} 要写清实测局限`).toBeGreaterThan(0)
    }
  })

  it('未实测的平台都有**具体**原因（指出实测时发生了什么），不是一句"不支持"', () => {
    for (const platform of ['微信小店', '抖店', '拼多多']) {
      const note = entityUnsupportedNote(platform)
      expect(note.length, platform).toBeGreaterThan(30)
      expect(note, platform).not.toContain('该平台尚未实测到可读的主体信息页')
    }
    // 微信那条要说清是"悬浮卡读不到 + 掩码"，因为这是两个不同的限制
    expect(ENTITY_UNSUPPORTED_NOTE['微信小店']).toContain('悬浮卡')
    expect(ENTITY_UNSUPPORTED_NOTE['微信小店']).toContain('掩码')
  })
})

describe('主体采集步骤', () => {
  const profile = entityProfileFor('快手小店')!

  it('序列：导航 → 等就绪 → 显式等取数 → 依次按标签读', () => {
    const steps = buildEntityCollectSteps(profile)
    expect(steps.map(s => s.type)).toEqual([
      'navigate', 'waitForPage', 'waitMs',
      'readLabelValue', ...profile.nameAnchors.map(() => 'readLabelValue')
    ])
    expect(steps[0].input.url).toBe(profile.pageUrl)
    expect(steps[1].input.urlIncludes).toBe(profile.urlMarker)
    expect(steps[2].input.ms).toBe(profile.settleMs)
  })

  it('**先读统一社会信用代码、再读名称**：代码的标签跨主体类型不变，名称行文案会变', () => {
    const reads = buildEntityCollectSteps(profile).filter(s => s.type === 'readLabelValue')
    expect(reads[0].input.label).toBe(profile.noAnchor)
    expect(reads[0].input.metric).toBe(ENTITY_METRIC_NO)
    expect(reads.map(s => s.input.label).slice(1)).toEqual(profile.nameAnchors)
    expect(reads[1].input.metric).toBe(ENTITY_METRIC_NAME)
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
