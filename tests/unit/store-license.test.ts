import { describe, expect, it } from 'vitest'
import { storeCreateSchema, storeUpdateSchema } from '@shared/schemas/store'
import {
  NO_LICENSE_KEY,
  decideLicenseWrite,
  groupStoresByLicense,
  licenseKeyOf,
  licenseLabelOf,
  normalizeLicenseName,
  normalizeLicenseNo
} from '@shared/store-license'

describe('营业执照归一化', () => {
  it('统一社会信用代码：去掉空格与连字符并转大写（用户是从执照上连格式一起复制过来的）', () => {
    expect(normalizeLicenseNo(' 91310000 ma1fl-1234x ')).toBe('91310000MA1FL1234X')
    expect(normalizeLicenseNo('91310000MA1FL1234X')).toBe('91310000MA1FL1234X')
    expect(normalizeLicenseNo(null)).toBe('')
  })

  it('主体名称：去首尾空白、内部连续空白（含全角空格）压成一个', () => {
    expect(normalizeLicenseName('  上海  某某\u3000贸易 有限公司 ')).toBe('上海 某某 贸易 有限公司')
    expect(normalizeLicenseName(undefined)).toBe('')
  })
})

describe('营业执照分组 key', () => {
  it('有统一社会信用代码就以它为准——名称写法不同也能归到一起', () => {
    const a = { licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' }
    const b = { licenseName: '上海某某贸易有限公司（总部）', licenseNo: '91310000ma1fl 1234x' }
    expect(licenseKeyOf(a)).toBe(licenseKeyOf(b))
  })

  it('只有名称时用归一化后的名称（大小写不敏感）', () => {
    expect(licenseKeyOf({ licenseName: 'ABC 贸易' })).toBe(licenseKeyOf({ licenseName: 'abc 贸易' }))
  })

  it('两个都没填归到「未填写」，不与任何真实主体合并', () => {
    expect(licenseKeyOf({})).toBe(NO_LICENSE_KEY)
    expect(licenseKeyOf({ licenseName: '  ', licenseNo: null })).toBe(NO_LICENSE_KEY)
    expect(NO_LICENSE_KEY).not.toBe('')
  })

  it('展示名优先用主体名称，没名称时退化成代码', () => {
    expect(licenseLabelOf({ licenseName: '上海某某', licenseNo: '91310000MA1FL1234X' })).toBe('上海某某')
    expect(licenseLabelOf({ licenseNo: '91310000MA1FL1234X' })).toBe('91310000MA1FL1234X')
    expect(licenseLabelOf({})).toBe('')
  })
})

describe('按营业执照归组（发票中心筛选条用）', () => {
  const stores = [
    { id: 's1', licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' },
    { id: 's2', licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' },
    { id: 's3', licenseName: '杭州另家科技有限公司', licenseNo: '91330100MA2AB5678Y' },
    { id: 's4', licenseName: null, licenseNo: null }
  ]

  it('同一执照的店铺归成一个主体并计数，「未填写」单独成桶且排最后', () => {
    const { groups, hasMissing } = groupStoresByLicense(stores)
    expect(groups.map(l => [l.label || NO_LICENSE_KEY, l.storeCount])).toEqual([
      ['上海某某贸易有限公司', 2],
      ['杭州另家科技有限公司', 1],
      [NO_LICENSE_KEY, 1]
    ])
    expect(groups[groups.length - 1].key).toBe(NO_LICENSE_KEY)
    expect(hasMissing).toBe(true)
  })

  it('只有名称的店会并进同名且有代码的那个主体（否则会出现两个同名胶囊各 1 家，看起来像坏了）', () => {
    const { groups, keyByStore } = groupStoresByLicense([
      { id: 'a', licenseName: '上海某某贸易有限公司' },
      { id: 'b', licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' }
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].storeCount).toBe(2)
    expect(groups[0].no).toBe('91310000MA1FL1234X')
    expect(keyByStore.get('a')).toBe('91310000MA1FL1234X')
  })

  it('两家都填了代码但代码不同 → 绝不合并（名称再像也是两个主体）', () => {
    const { groups } = groupStoresByLicense([
      { id: 'a', licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' },
      { id: 'b', licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL9999Z' }
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.storeCount === 1)).toBe(true)
  })

  it('胶囊上的「N 家」必须等于按该 key 筛出来的店铺数（否则界面自相矛盾）', () => {
    const { groups, keyByStore } = groupStoresByLicense([
      ...stores,
      { id: 's5', licenseName: '上海某某贸易有限公司' },
      { id: 's6', licenseNo: '91310000MA1FL1234X' }
    ])
    for (const g of groups) {
      const matched = [...keyByStore.entries()].filter(([, key]) => key === g.key)
      expect(matched.length).toBe(g.storeCount)
      expect(matched.map(([id]) => id).sort()).toEqual([...g.storeIds].sort())
    }
  })

  it('名称相近但不是同一家的，绝不合并（错一个公司就是错票）', () => {
    const { groups } = groupStoresByLicense([
      { id: 'a', licenseName: '上海某某贸易有限公司' },
      { id: 'b', licenseName: '上海某某贸易有限公司分公司' }
    ])
    expect(groups).toHaveLength(2)
  })

  it('全部店铺都没填时 hasMissing 为真，且只有「未填写」一个桶', () => {
    const { groups, hasMissing } = groupStoresByLicense([{ id: 'a' }, { id: 'b' }])
    expect(hasMissing).toBe(true)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe(NO_LICENSE_KEY)
    expect(groups[0].storeCount).toBe(2)
  })

  it('都填了就 hasMissing 为假（界面不再显示"未填写"胶囊）', () => {
    expect(groupStoresByLicense([
      { id: 'a', licenseName: '上海某某', licenseNo: '91310000MA1FL1234X' }
    ]).hasMissing).toBe(false)
  })
})

describe('把平台读到的主体写回店铺营业执照', () => {
  const fetched = { name: '夏邑县唯衣美服装工作室', no: '92411426MA9KEBPH6L' }

  it('店铺空着 → 两项都填（这正是"自动获取主体"要的效果）', () => {
    const d = decideLicenseWrite({}, fetched)
    expect(d.action).toBe('fill')
    expect(d.write).toEqual({ licenseName: fetched.name, licenseNo: fetched.no })
    expect(d.conflicts).toEqual([])
  })

  it('已填且一致 → 不动，报 same（大小写/空格差异也算一致）', () => {
    const d = decideLicenseWrite({ licenseName: '夏邑县唯衣美服装工作室', licenseNo: '92411426ma9kebph6l' }, fetched)
    expect(d.action).toBe('same')
    expect(d.write).toEqual({})
  })

  it('已填但与平台不同 → **绝不覆盖**，两个值都回报（错一个公司就是错票）', () => {
    const d = decideLicenseWrite({ licenseName: '另一家公司', licenseNo: null }, fetched)
    expect(d.action).toBe('fill')                                  // 代码是空的可填
    expect(d.write).toEqual({ licenseNo: fetched.no })              // 名称不写
    expect(d.conflicts).toEqual([{ field: 'licenseName', existing: '另一家公司', fetched: fetched.name }])
    expect(d.write.licenseName).toBeUndefined()
  })

  it('只有名称冲突、没有可填字段 → 纯冲突', () => {
    const d = decideLicenseWrite({ licenseName: '另一家公司', licenseNo: fetched.no }, { name: fetched.name })
    expect(d.action).toBe('conflict')
    expect(d.write).toEqual({})
    expect(d.conflicts).toHaveLength(1)
  })

  it('平台给的是掩码 → 不写、如实说明（实测微信「9233**********D310」就是这个形态）', () => {
    const d = decideLicenseWrite({}, { name: '东阳市花小朵电子商务商行', no: '9233**********D310' })
    expect(d.action).toBe('fill')
    expect(d.write).toEqual({ licenseName: '东阳市花小朵电子商务商行' })   // 名称可用、代码不可用
    expect(d.rejected[0].field).toBe('licenseNo')
    expect(d.rejected[0].why).toContain('打了码')
  })

  it('代码位数不对 → 不写（否则会被当成另一个主体另起一桶）', () => {
    const d = decideLicenseWrite({}, { no: '92411426MA9KEBPH6' })
    expect(d.action).toBe('nothing')
    expect(d.write).toEqual({})
    expect(d.rejected[0].why).toContain('18 位')
  })

  it('只读到名称（平台没给代码）→ 只填名称，绝不编造代码', () => {
    const d = decideLicenseWrite({}, { name: '夏邑县唯衣美服装工作室' })
    expect(d.write).toEqual({ licenseName: '夏邑县唯衣美服装工作室' })
    expect(d.write.licenseNo).toBeUndefined()
  })

  it('一个字都没读到 → 什么都不写，并标出"可能个人店铺或页面改版"', () => {
    const d = decideLicenseWrite({}, {})
    expect(d.action).toBe('nothing')
    expect(d.write).toEqual({})
    expect(d.fetchedNothing).toBe(true)
  })

  it('名称过长（疑似爬到整块容器）→ 不写', () => {
    const d = decideLicenseWrite({}, { name: '主'.repeat(121) })
    expect(d.write).toEqual({})
    expect(d.rejected[0].why).toContain('过长')
  })
})

describe('店铺 schema 的营业执照字段', () => {
  it('新建时可空，也可带空格/连字符的 18 位代码', () => {
    expect(storeCreateSchema.parse({ name: '店铺', platform: '抖店' }).licenseNo).toBeUndefined()
    expect(storeCreateSchema.safeParse({ name: '店铺', platform: '抖店', licenseNo: '91310000 MA1FL-1234X' }).success).toBe(true)
  })

  it('旧税号 15 位也接受（老店铺执照上是 15 位）', () => {
    expect(storeCreateSchema.safeParse({ name: '店铺', platform: '抖店', licenseNo: '310000123456789' }).success).toBe(true)
  })

  it('位数不对的代码拒绝（否则会被当成另一个主体另起一桶）', () => {
    const bad = storeCreateSchema.safeParse({ name: '店铺', platform: '抖店', licenseNo: '91310000MA1FL123' })
    expect(bad.success).toBe(false)
    expect(bad.success === false && bad.error.issues[0].message).toContain('统一社会信用代码')
  })

  it('更新补丁里可以清空（空串 = 未填写），但长度超限被拒', () => {
    expect(storeUpdateSchema.safeParse({ storeId: 'store_1', patch: { licenseName: '', licenseNo: '' } }).success).toBe(true)
    expect(storeUpdateSchema.safeParse({ storeId: 'store_1', patch: { licenseName: 'x'.repeat(121) } }).success).toBe(false)
  })
})
