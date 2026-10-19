import { describe, expect, it } from 'vitest'
import { storeCreateSchema, storeUpdateSchema } from '@shared/schemas/store'
import {
  NO_LICENSE_KEY,
  decideLicenseWrite,
  entityVerdictText,
  filterRowsByLicenseKey,
  groupStoresByLicense,
  licenseKeyOf,
  licenseLabelOf,
  licenseScopeLabel,
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

// 导出待开票 CSV 必须跟着屏上的主体筛选走（代账按主体分账；导错了就是把 A 公司的清单给别家代账）。
// 规则与屏上完全同源：都用 groupStoresByLicense 的 keyByStore。
describe('按开票主体筛行（发票中心筛选与导出共用）', () => {
  const rows = [
    { storeId: 'a1', licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' },
    { storeId: 'a2', licenseName: '上海某某贸易有限公司', licenseNo: '91310000ma1fl-1234x' },
    // 只填名称、没填代码 → 要并进同名且有代码的那个主体（这正是整份列表才能定的那条规则）
    { storeId: 'a3', licenseName: '上海某某贸易有限公司', licenseNo: null },
    { storeId: 'b1', licenseName: '验己-B 公司', licenseNo: '91310000MA1FL9999Z' },
    // 只有名称、谁都没填代码 → 名称（小写）就是它的 key
    { storeId: 'c1', licenseName: '只填名称的工作室', licenseNo: null },
    { storeId: 'n1', licenseName: null, licenseNo: null }
  ]

  it('不传 key = 不筛选（全部行都在）', () => {
    expect(filterRowsByLicenseKey(rows, '')).toHaveLength(6)
    expect(filterRowsByLicenseKey(rows, null)).toHaveLength(6)
    expect(filterRowsByLicenseKey(rows, undefined)).toHaveLength(6)
  })

  it('按信用代码筛：同名但没填代码的那家也一起出来（否则"胶囊写 3 家、导出只有 2 家"）', () => {
    const hit = filterRowsByLicenseKey(rows, '91310000MA1FL1234X')
    expect(hit.map(r => r.storeId)).toEqual(['a1', 'a2', 'a3'])
  })

  it('按名称筛（该主体谁都没填代码时，名称就是 key）', () => {
    const hit = filterRowsByLicenseKey(rows, '只填名称的工作室')
    expect(hit.map(r => r.storeId)).toEqual(['c1'])
  })

  it('填了代码的主体只能按代码查：拿它的名称当 key 查不到（key 不是名称）', () => {
    expect(filterRowsByLicenseKey(rows, '验己-b 公司')).toEqual([])
  })

  it('「未填写」能单独筛出来补录，不与任何真实主体混', () => {
    const hit = filterRowsByLicenseKey(rows, NO_LICENSE_KEY)
    expect(hit.map(r => r.storeId)).toEqual(['n1'])
  })

  it('key 不存在 → 空数组（界面据此提示"当前主体下没有可导出的数据"）', () => {
    expect(filterRowsByLicenseKey(rows, '不存在的 key')).toEqual([])
  })

  it('不改动入参（导出与界面各自持有自己的数组）', () => {
    const input = [...rows]
    const hit = filterRowsByLicenseKey(input, '91310000MA1FL1234X')
    expect(input).toHaveLength(rows.length)
    expect(hit).not.toBe(input)
  })

  it('空白 key = 不筛选（与空串同一语义，不报错）', () => {
    expect(filterRowsByLicenseKey(rows, '   ')).toHaveLength(6)
  })

  it('超长 key（超过 IPC 的 200 字符上限也不会命中任何主体）→ 空数组', () => {
    expect(filterRowsByLicenseKey(rows, 'x'.repeat(500))).toEqual([])
  })

  it('导出范围标签：只填了信用代码的主体显示代码，而不是空串/「全部主体」', () => {
    const codeOnly = [
      { storeId: 'c1', licenseName: null, licenseNo: '91310000MA1FL7777Z' },
      { storeId: 'c2', licenseName: '  ', licenseNo: '91310000ma1fl-7777z' }
    ]
    expect(licenseScopeLabel(codeOnly, '91310000MA1FL7777Z')).toBe('91310000MA1FL7777Z')
    expect(licenseScopeLabel(rows, '91310000MA1FL1234X')).toBe('上海某某贸易有限公司')
    expect(licenseScopeLabel(rows, NO_LICENSE_KEY)).toBe('未填写营业执照')
    expect(licenseScopeLabel(rows, '')).toBe('')
    // 兜底：连值都取不到时用 key 本身，绝不回落成"全部主体"
    // （licenseScopeLabel 只读执照字段，传 storeId 属于契约外的多余属性）
    expect(licenseScopeLabel([{ licenseName: null, licenseNo: null }], 'some-key')).toBe('some-key')
  })
})

// 主体核对：平台**没读到**的字段是"未比对"，店里**空着**而平台读到的是"可补录"——
// 两者最容易被糊成一句"一致/不一致"，而这个结论直接决定用户会不会去改一个本来没错的主体。
describe('平台读到的主体 vs 已填主体（界面核对结论）', () => {
  it('店里只填了名称、平台读到名称+代码 → 不是冲突，而是"代码可补录"', () => {
    const text = entityVerdictText(
      { licenseName: '上海某某贸易有限公司', licenseNo: null },
      { name: '上海某某贸易有限公司', no: '91310000MA1FL1234X' }
    )
    expect(text).toContain('名称与已填一致')
    expect(text).toContain('信用代码平台读到了、店里还空着')
    expect(text).not.toContain('不一致')
  })

  it('平台只读到名称 → 只说名称一致，代码明说未比对（不拿没比过的字段打包票）', () => {
    const text = entityVerdictText(
      { licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' },
      { name: '上海某某贸易有限公司', no: null }
    )
    expect(text).toContain('名称与已填一致')
    expect(text).toContain('信用代码平台没读到（未比对）')
    expect(text).not.toContain('与已填主体一致')
  })
  it('两边都有值且真的不同 → 报不一致，并把两边的值都摆出来', () => {
    const text = entityVerdictText(
      { licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' },
      { name: '杭州某某贸易有限公司', no: '91330100MA2AB5678Y' }
    )
    expect(text).toContain('与已填的不一致')
    expect(text).toContain('上海某某贸易有限公司')
    expect(text).toContain('杭州某某贸易有限公司')
  })

  it('名称大小写/空格/连字符差异不算不一致（与写回判定同一套归一化）', () => {
    const text = entityVerdictText(
      { licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' },
      { name: ' 上海某某贸易有限公司 ', no: '91310000ma1fl-1234x' }
    )
    expect(text).toBe('名称、信用代码与已填一致')
  })

  it('店里什么都没填时按"平台读到了哪几项"如实说', () => {
    expect(entityVerdictText({}, { name: '上海某某', no: '91310000MA1FL1234X' }))
      .toContain('平台读到了名称和信用代码')
    expect(entityVerdictText({ licenseName: null, licenseNo: null }, { name: null, no: null }))
      .toBe('店铺还没填主体，可在上方点「获取主体营业执照」填入')
  })

  // 2026-10-14 真机：拼多多个人店铺的「营业执照信息」四行都写「无」。显示侧若把它当"读到了"，
  // 就是在替一个不存在的执照打包票——与写入侧（占位被拒）也必须一致。
  it('平台写的是占位文案「无」→ 说清"没有可用的主体信息"，不说"读到了"', () => {
    const text = entityVerdictText({ licenseName: null, licenseNo: null }, { name: '无', no: '无' })
    expect(text).toContain('没有可用的主体信息')
    expect(text).not.toContain('平台读到了')
    expect(text).toContain('不会写入店铺')
  })

  it('一项是占位、一项是真值时分别说明（占位那项不算读到了）', () => {
    const text = entityVerdictText({}, { name: '上海某某贸易有限公司', no: '无' })
    expect(text).toContain('平台读到了名称')
    expect(text).toContain('信用代码这一行写的是「无」')
  })

  it('已填的店里出现占位值 → 报"未比对"，绝不当成一致或冲突', () => {
    const text = entityVerdictText(
      { licenseName: '上海某某贸易有限公司', licenseNo: '91310000MA1FL1234X' },
      { name: '上海某某贸易有限公司', no: '无' }
    )
    expect(text).toContain('名称与已填一致')
    expect(text).toContain('信用代码这一行写的是「无」')
    expect(text).not.toContain('不一致')
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

  // 2026-10-14 真机实测踩到的形态：拼多多个人店铺的「营业执照信息」四行都写「无」。
  // 这类占位文案不是掩码、长度也合法——不挡就会被当成"主体名称=无"写进库，比不填更糟。
  it('平台写「无」这类占位文案 → 不写，并如实说明是占位（实测拼多多个人店铺）', () => {
    const d = decideLicenseWrite({}, { name: '无', no: '无' })
    expect(d.action).toBe('nothing')
    expect(d.write).toEqual({})
    expect(d.rejected.map(r => r.field).sort()).toEqual(['licenseName', 'licenseNo'])
    expect(d.rejected[0].why).toContain('占位')
    expect(d.fetchedNothing).toBe(false)   // 读到了东西，只是不可用——与"一个字没读到"要分开
  })

  it('其它常见占位文案同样不写（暂无 / — / 未填写 / 保密 / N/A）', () => {
    for (const raw of ['暂无', '—', '未填写', '保密', 'N/A']) {
      const d = decideLicenseWrite({}, { name: raw, no: raw })
      expect(d.write, raw).toEqual({})
      expect(d.rejected.length, raw).toBe(2)
      expect(d.action, raw).toBe('nothing')
    }
  })

  it('单个连字符「-」：名称按占位拒绝；代码侧因为连字符被归一化掉，等价于"没读到"', () => {
    const d = decideLicenseWrite({}, { name: '-', no: '-' })
    expect(d.write).toEqual({})
    expect(d.rejected).toEqual([expect.objectContaining({ field: 'licenseName' })])
  })

  it('正常主体名称里带「无」字不算占位（只挡整串就是占位文案的）', () => {
    const d = decideLicenseWrite({}, { name: '无锡市无界贸易有限公司' })
    expect(d.write.licenseName).toBe('无锡市无界贸易有限公司')
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
