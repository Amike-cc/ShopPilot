import { describe, expect, it } from 'vitest'
import { normalizeDouyinCategoryTree } from '@shared/douyin-category-tree'

describe('normalizeDouyinCategoryTree', () => {
  it('reads the current live API header container and keeps the third-level options', () => {
    const tree = normalizeDouyinCategoryTree({
      data: {
        headers: [{
          name: '主推类目',
          header: [
            { name: '全部', type: 'text', field_name: 'main_cate_new', value: '' },
            {
              name: '服饰内衣',
              type: 'cascade',
              field_name: 'main_cate_new',
              value: '3',
              children: [
                { name: '不限', type: 'cascade', field_name: 'main_cate_new', value: '3' },
                {
                  name: '服装',
                  type: 'cascade',
                  field_name: 'common_selection_first_cate_code',
                  value: '1000000001',
                  children: [
                    { name: '女装', type: 'cascade', field_name: 'common_selection_second_cate_code', value: '1000000002' },
                    { name: '男装', type: 'cascade', field_name: 'common_selection_second_cate_code', value: '1000000003' }
                  ]
                }
              ]
            }
          ]
        }]
      }
    })

    expect(tree).toEqual([{
      name: '服饰内衣',
      children: ['服装'],
      grandchildren: [{ name: '服装', children: ['女装', '男装'] }]
    }])
  })

  /**
   * 2026-09-26 审计 P2：这个模块解析的是第三方动态 JSON，原来通篇 `any`，本轮收成
   * `unknown` + 显式收窄。收窄最容易写出行为差异（数组/原始值/怪对象），所以把边界补齐。
   */
  it('非对象 / 空 / 没有 headers 一律返回空数组（不抛异常）', () => {
    for (const payload of [null, undefined, 42, 'text', [], {}, { data: null }, { data: { headers: [] } }, { data: { headers: 'nope' } }]) {
      expect(normalizeDouyinCategoryTree(payload), JSON.stringify(payload ?? null)).toEqual([])
    }
    // 数组载荷：asRecord 会把数组排除，因此直接返回空（原来会去读 payload.data → undefined）
    expect(normalizeDouyinCategoryTree([{ name: '主推类目', header: [{ name: 'A' }] }])).toEqual([])
  })

  it('没有 main_cate 标识的表头 → 返回空数组（不猜）', () => {
    expect(normalizeDouyinCategoryTree({ data: { headers: [{ key: 'price', header: [{ name: '价格' }] }] } })).toEqual([])
  })

  it('兼容 filter_headers 键，并在 header 容器是嵌套 options 时取到子项', () => {
    const tree = normalizeDouyinCategoryTree({
      data: {
        filter_headers: [{
          key: 'main_cate',
          options: [{ label: '家居日用', options: [{ label: '收纳' }, { label: '清洁' }] }]
        }]
      }
    })
    expect(tree).toEqual([{ name: '家居日用', children: ['收纳', '清洁'] }])
  })

  it('表头没有可读 key/name 时，退回在 JSON 文本里找 main_cate 标识', () => {
    const tree = normalizeDouyinCategoryTree({ data: { headers: [{ weird_field: 'main_cate_new', enums: [{ name: '图书', options: [{ name: '小说' }] }] }] } })
    expect(tree).toEqual([{ name: '图书', children: ['小说'] }])
  })

  it('选项里的垃圾项（数字/null/无标签对象）被跳过，且"不限/全部/暂无数据"不作为类目', () => {
    const tree = normalizeDouyinCategoryTree({
      data: { headers: [{ name: '主推类目', header: [1, null, { nope: 1 }, { name: '不限' }, { name: '母婴', children: [{ name: '全部' }, { name: '纸尿裤' }] }] }] }
    })
    expect(tree).toEqual([{ name: '母婴', children: ['纸尿裤'] }])
  })

  /**
   * 明确记录一个容易误判的契约：**没有子项的根类目会被丢弃**（只保留能继续展开的类目）。
   * 上一条用例里"母婴"能留下是因为它有"纸尿裤"这一层。
   */
  it('没有子项的根类目被丢弃（与历史实现一致，不编造空类目）', () => {
    expect(normalizeDouyinCategoryTree({ data: { headers: [{ name: '主推类目', enums: [{ name: '图书' }] }] } })).toEqual([])
    expect(normalizeDouyinCategoryTree({ data: { headers: [{ name: '主推类目', enums: [' 童装 '] }] } })).toEqual([])
    expect(normalizeDouyinCategoryTree({ data: { headers: [{ name: '主推类目', enums: ['童装'] }] } })).toEqual([])
  })

  it('第一层选项全都没有标签 → 空数组（不会把不存在的数据编出来）', () => {
    expect(normalizeDouyinCategoryTree({ data: { headers: [{ name: '主推类目', header: [{ value: '1' }, { value: '2' }] }] } })).toEqual([])
  })

  it('findFirstOptionArray 有深度上限，深层才出现的选项不会被误当成一级类目', () => {
    const deep = { a: { b: { c: { d: { e: { f: [{ name: '太深了' }] } } } } } }
    expect(normalizeDouyinCategoryTree({ data: { headers: [{ name: '主推类目', payload: deep }] } })).toEqual([])
  })

  it('字符串型选项不能单独成类目（需要子项才算一层），但可作为叶子名字', () => {
    const tree = normalizeDouyinCategoryTree({ data: { headers: [{ name: '主推类目', enums: [{ name: '童装', options: [' 汉服 '] }] }] } })
    expect(tree).toEqual([{ name: '童装', children: ['汉服'] }])
  })
})
