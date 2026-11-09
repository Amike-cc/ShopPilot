import { describe, expect, it } from 'vitest'
import { buildStoreCsv, STORE_CSV_COLUMNS } from '@shared/store-csv'
import type { Store } from '@shared/schemas/store'

function store(overrides: Partial<Store> = {}): Store {
  return {
    id: 's1', name: '甲店', platform: '抖店', adminUrl: 'https://fxg.jinritemai.com', status: 'online',
    avatarColor: '#000', sortOrder: 0, groupName: '华东区', externalCode: 'EXT-1', owner: '张三', region: '上海',
    licenseName: '上海某某公司', licenseNo: '91310000MA1FL1234X', tagsJson: '["重点","售后"]', notes: '第一行\n第二行',
    lastActiveAt: null, createdAt: 0, updatedAt: 0, deletedAt: null,
    ...overrides
  }
}

describe('店铺清单 CSV', () => {
  it('表头与列数固定，标签还原为逗号分隔', () => {
    const { csv, rows } = buildStoreCsv([store()])
    expect(rows).toBe(1)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(STORE_CSV_COLUMNS.map(column => column.label).join(','))
    expect(lines[1]).toContain('重点, 售后')
  })

  it('逗号、引号、换行都按 CSV 转义', () => {
    const { csv } = buildStoreCsv([store({ name: '甲,店', notes: '他说"好"\n然后走了' })])
    expect(csv).toContain('"甲,店"')
    expect(csv).toContain('"他说""好""\n然后走了"')
  })

  it('空值写空串，不写 null/undefined', () => {
    const { csv } = buildStoreCsv([store({ groupName: null, owner: null, licenseNo: null, notes: null })])
    const row = csv.split('\r\n')[1]
    expect(row).not.toContain('null')
    expect(row).not.toContain('undefined')
  })
})
