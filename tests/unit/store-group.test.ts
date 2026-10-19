import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  STORE_GROUP_MAX_LENGTH,
  groupStoreRows,
  listStoreGroups,
  normalizeGroupName,
  validateGroupName,
  type StoreGroupInput
} from '../../apps/desktop/src/renderer/src/features/stores/store-group'

/**
 * 店铺分组的回归网（2026-10-18「分组能看不能设」补齐的 Phase 1）。
 *
 * 这批是纯函数：输入清洗（trim / 折叠空白 / 空→null / 超长截断）、字符白名单、
 * 分组列表去重排序、分组渲染顺序（未分组固定置底）。UI 与 store 接线在 Phase 2 另行覆盖。
 */

const SOURCE = readFileSync(
  resolve('apps/desktop/src/renderer/src/features/stores/store-group.ts'),
  'utf8'
)

function store(id: string, groupName?: string | null): StoreGroupInput {
  return { id, name: `店铺${id}`, groupName }
}

/** 把 groupStoreRows 的结果压成便于断言的形状：`{ 组名: [storeId...] }`，未分组用 null 键 */
function rowsToIds(rows: Array<{ group: string | null, stores: StoreGroupInput[] }>) {
  return rows.map(row => ({ group: row.group, ids: row.stores.map(item => item.id) }))
}

describe('normalizeGroupName：清洗输入', () => {
  it('长度上限就是任务约定的 24', () => {
    expect(STORE_GROUP_MAX_LENGTH).toBe(24)
  })

  it('非字符串与空值一律视为未分组，不抛异常', () => {
    for (const raw of [null, undefined, 123, 0, {}, [], true, Symbol('x')]) {
      expect(normalizeGroupName(raw)).toBeNull()
    }
  })

  it('空串 / 纯空白 / 全角空格 / 换行都是未分组', () => {
    for (const raw of ['', '   ', '\t', '\n', '\r\n', '\u3000', ' \u3000\t ']) {
      expect(normalizeGroupName(raw)).toBeNull()
    }
  })

  it('trim 首尾空白', () => {
    expect(normalizeGroupName(' 销售组 ')).toBe('销售组')
    expect(normalizeGroupName('\t售后组\n')).toBe('售后组')
  })

  it('折叠内部空白（含 tab / 换行 / 不换行空格 / 全角空格）', () => {
    expect(normalizeGroupName('销售   组')).toBe('销售 组')
    expect(normalizeGroupName('销售\t\n组')).toBe('销售 组')
    expect(normalizeGroupName('销售\u00a0组')).toBe('销售 组')
    expect(normalizeGroupName('销售\u3000组')).toBe('销售 组')
    expect(normalizeGroupName('  a   b   c  ')).toBe('a b c')
  })

  it('超长按 STORE_GROUP_MAX_LENGTH 截断', () => {
    expect(normalizeGroupName('A'.repeat(30))).toBe('A'.repeat(24))
    expect(normalizeGroupName('店'.repeat(30))).toBe('店'.repeat(24))
    expect(normalizeGroupName('店'.repeat(30))!.length).toBe(STORE_GROUP_MAX_LENGTH)
    // 刚好等于上限不截断
    expect(normalizeGroupName('B'.repeat(24))).toBe('B'.repeat(24))
  })

  it('截断后不会留下尾随空格', () => {
    // 第 24 个码点正好是空格：截断后要再去掉
    const raw = `${'A'.repeat(23)} B`
    expect(normalizeGroupName(raw)).toBe('A'.repeat(23))
    expect(normalizeGroupName('C'.repeat(23) + ' 尾巴')).toBe('C'.repeat(23))
  })

  it('按码点截断，不会把 emoji 切成半个代理对', () => {
    const result = normalizeGroupName('👍'.repeat(30))!
    expect(Array.from(result).length).toBe(STORE_GROUP_MAX_LENGTH)
    expect(result).toBe('👍'.repeat(STORE_GROUP_MAX_LENGTH))
    expect(result.length).toBe(STORE_GROUP_MAX_LENGTH * 2) // UTF-16 单元数，说明按码点而非按单元截断
  })

  it('不改写合法名字（幂等）', () => {
    const once = normalizeGroupName(' 中国·华东 ')
    expect(once).toBe('中国·华东')
    expect(normalizeGroupName(once)).toBe(once)
  })
})

describe('validateGroupName：空 = 取消分组', () => {
  it('null / undefined / 空串 / 纯空白 → ok + value null（语义是取消分组）', () => {
    for (const raw of [null, undefined, '', '   ', '\u3000']) {
      expect(validateGroupName(raw)).toEqual({ ok: true, value: null })
    }
  })

  it('合法名字返回规范化后的值', () => {
    expect(validateGroupName('  销售组  ')).toEqual({ ok: true, value: '销售组' })
    expect(validateGroupName('中国·华东')).toEqual({ ok: true, value: '中国·华东' })
    expect(validateGroupName('Group-1_a')).toEqual({ ok: true, value: 'Group-1_a' })
    expect(validateGroupName('店铺 A1')).toEqual({ ok: true, value: '店铺 A1' })
    expect(validateGroupName('-')).toEqual({ ok: true, value: '-' })
    expect(validateGroupName('·')).toEqual({ ok: true, value: '·' })
    expect(validateGroupName('〇号店')).toEqual({ ok: true, value: '〇号店' })
  })

  it('超长合法名字按上限截断而不是拒绝（与保存路径同口径）', () => {
    const result = validateGroupName('A'.repeat(30))
    expect(result).toEqual({ ok: true, value: 'A'.repeat(24) })
  })

  it('非法字符被拒绝且给出中文原因', () => {
    const bad = ['a@b', '店铺#1', 'a.b', '店铺/组', 'a\\b', '组(1)', '50%', '店铺🚀', 'ＡＢＣ', '１２３', '组，别名', 'a+b', 'a=b', "it's", 'a"b', 'a:b', 'a;b', 'a,b', 'a!b', 'a?b', 'a*b']
    for (const raw of bad) {
      const result = validateGroupName(raw)
      expect(result.ok, `应当拒绝：${raw}`).toBe(false)
      if (!result.ok) {
        expect(result.message).toMatch(/只能包含中英文、数字、空格/)
        expect(result.message.length).toBeGreaterThan(0)
      }
    }
  })

  it('非文本类型被拒绝（不是静默清空）', () => {
    for (const raw of [123, 0, true, false, {}, [], Symbol('x')]) {
      expect(validateGroupName(raw).ok).toBe(false)
    }
  })

  it('内部空白先在规范化阶段折叠，因此不算非法字符', () => {
    expect(validateGroupName('销售   组')).toEqual({ ok: true, value: '销售 组' })
    expect(validateGroupName('销售\t组')).toEqual({ ok: true, value: '销售 组' })
  })
})

describe('listStoreGroups：去重 + 丢空值 + 本地化排序', () => {
  it('同名分组只出现一次（跨 store 归并）', () => {
    // 排序显式用 zh-Hans-CN：拼音序 甲(jiǎ) < 乙(yǐ)，换机器也稳定
    expect(listStoreGroups([store('1', '甲组'), store('2', '甲组'), store('3', '乙组')])).toEqual(['甲组', '乙组'])
  })

  it('规范化后再去重：带空白的名字与干净名字是同一组', () => {
    expect(listStoreGroups([store('1', ' 甲组 '), store('2', '甲组'), store('3', '甲组\t')])).toEqual(['甲组'])
  })

  it('null / undefined / 空串 / 纯空白都不产生分组条目', () => {
    expect(listStoreGroups([
      store('1', null),
      store('2'),
      store('3', ''),
      store('4', '   '),
      store('5', '实组')
    ])).toEqual(['实组'])
  })

  it('本地化升序排序（ASCII 可预期）', () => {
    expect(listStoreGroups([store('1', 'Beta'), store('2', 'Alpha'), store('3', 'Gamma')]))
      .toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('空数组与全未分组都返回空列表', () => {
    expect(listStoreGroups([])).toEqual([])
    expect(listStoreGroups([store('1', null), store('2', '  ')])).toEqual([])
  })

  it('排序稳定：重复调用结果一致，且不修改入参', () => {
    const stores = Object.freeze([
      Object.freeze(store('1', '乙组')),
      Object.freeze(store('2', '甲组')),
      Object.freeze(store('3', '乙组'))
    ])
    const before = JSON.stringify(stores)
    const first = listStoreGroups(stores)
    const second = listStoreGroups(stores)
    expect(first).toEqual(second)
    expect(JSON.stringify(stores)).toBe(before)
  })
})

describe('groupStoreRows：未分组固定置底', () => {
  it('混合场景：组按升序、组内保持传入顺序、未分组在最后且为 null', () => {
    const stores = [
      store('1', '乙组'),
      store('2', null),
      store('3', '甲组'),
      store('4', '乙组'),
      store('5', '   ')
    ]
    expect(rowsToIds(groupStoreRows(stores))).toEqual([
      { group: '甲组', ids: ['3'] },
      { group: '乙组', ids: ['1', '4'] },
      { group: null, ids: ['2', '5'] }
    ])
  })

  it('没有未分组店铺时不产出 group: null 那一行', () => {
    const rows = groupStoreRows([store('1', 'B 组'), store('2', 'A 组')])
    expect(rows.map(row => row.group)).toEqual(['A 组', 'B 组'])
    expect(rows.some(row => row.group === null)).toBe(false)
  })

  it('全是未分组时只有一行，且顺序原样保留', () => {
    expect(rowsToIds(groupStoreRows([store('1', null), store('2'), store('3', ' ')]))).toEqual([
      { group: null, ids: ['1', '2', '3'] }
    ])
  })

  it('空数组返回空结果', () => {
    expect(groupStoreRows([])).toEqual([])
  })

  it('分组名先规范化再归并：带空白的与干净的进同一组', () => {
    // '甲 组' 与 '甲组'：zh 排序里前者在前（空格参与比较），断言顺序即锁定比较器口径
    expect(rowsToIds(groupStoreRows([store('1', ' 甲组'), store('2', '甲组 '), store('3', '甲 组')]))).toEqual([
      { group: '甲 组', ids: ['3'] },
      { group: '甲组', ids: ['1', '2'] }
    ])
  })

  it('未分组永远排在已分组之后（即使组名以 Z / 汉字开头）', () => {
    const rows = groupStoreRows([store('1', null), store('2', 'Z组'), store('3', '阿组')])
    expect(rows[rows.length - 1].group).toBeNull()
  })

  it('不改入参、可重复调用（幂等）', () => {
    const stores = Object.freeze([
      Object.freeze(store('1', '乙组')),
      Object.freeze(store('2', null)),
      Object.freeze(store('3', '甲组'))
    ])
    const before = JSON.stringify(stores)
    const first = rowsToIds(groupStoreRows(stores))
    const second = rowsToIds(groupStoreRows(stores))
    expect(first).toEqual(second)
    expect(JSON.stringify(stores)).toBe(before)
  })

  it('随机 300 组：每个店铺恰好出现一次、没有空组、null 组只在最后', () => {
    let seed = 20261018
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const pool = ['甲组', '乙组', ' 甲组 ', 'A组', 'B组', null, undefined, '', '   ', '中国·华东']
    for (let round = 0; round < 300; round++) {
      const count = Math.floor(random() * 10)
      const stores: StoreGroupInput[] = []
      for (let i = 0; i < count; i++) {
        stores.push(store(`s${i}`, pool[Math.floor(random() * pool.length)] as string | null | undefined))
      }
      const rows = groupStoreRows(stores)
      const flattened = rows.flatMap(row => row.stores.map(item => item.id))
      expect(flattened.length, `round=${round}`).toBe(stores.length)
      expect(new Set(flattened).size, `round=${round}`).toBe(stores.length)
      expect(rows.every(row => row.stores.length > 0), `round=${round}`).toBe(true)
      const nullIndex = rows.findIndex(row => row.group === null)
      if (nullIndex >= 0) expect(nullIndex, `round=${round}`).toBe(rows.length - 1)
      // 已分组的行按本地化升序（与模块内比较器同口径）
      const groups = rows.filter(row => row.group !== null).map(row => row.group as string)
      expect(groups, `round=${round}`).toEqual([...groups].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
    }
  })
})

describe('模块边界', () => {
  it('store-group 是纯模块：不依赖 vue / electron / DOM', () => {
    expect(SOURCE).not.toMatch(/from\s+['"]vue['"]/)
    expect(SOURCE).not.toMatch(/from\s+['"]electron['"]/)
    expect(SOURCE).not.toMatch(/from\s+['"]node:/)
    expect(SOURCE).not.toMatch(/require\(/)
    expect(SOURCE).not.toMatch(/\bdocument\./)
    expect(SOURCE).not.toMatch(/\bwindow\./)
  })

  it('导出的 API 形状与任务约定一致', () => {
    expect(SOURCE).toContain('export const STORE_GROUP_MAX_LENGTH = 24')
    expect(SOURCE).toContain('export interface StoreGroupInput {')
    expect(SOURCE).toContain('export function normalizeGroupName(raw: unknown): string | null')
    expect(SOURCE).toContain('export function validateGroupName(raw: unknown): StoreGroupValidation')
    expect(SOURCE).toContain('export function listStoreGroups(stores: readonly StoreGroupInput[]): string[]')
    expect(SOURCE).toContain('export function groupStoreRows(')
  })
})
