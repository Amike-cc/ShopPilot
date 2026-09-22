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
})
