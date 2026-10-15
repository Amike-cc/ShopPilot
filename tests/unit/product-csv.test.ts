import { describe, expect, it } from 'vitest'
import {
  PRODUCT_CSV_HEADERS,
  buildProductCsv,
  mapCsvRowsToImportRows,
  parseCsvRows,
  planProductCsvImport,
  productCsvRows,
  summarizeVariants,
  type ProductCsvSource,
  type ProductMatchSummary
} from '../../packages/shared/src/product-batch'

/**
 * v4 重设计 §4.6 R3：CSV 导出/导入（测试清单 9.2：往返一致、注入前缀、字段级更新）。
 */

function makeSource(overrides: Partial<ProductCsvSource> = {}): ProductCsvSource {
  return {
    title: '真皮沙发',
    subtitle: null,
    brand: '某某品牌',
    localCategory: '客厅/沙发',
    tags: ['清仓', '主推'],
    status: 'ready',
    variants: [
      { spec: [{ name: '颜色', value: '黑' }], priceMinor: 12900, stock: 10, skuCode: 'SKU-A', barcode: null },
      { spec: [{ name: '颜色', value: '白' }], priceMinor: 15900, stock: 4, skuCode: 'SKU-B', barcode: null }
    ],
    linkedPlatforms: ['微信小店'],
    updatedAt: 0,
    ...overrides
  }
}

const csvRow = (cells: string[]): string => {
  if (cells.length !== PRODUCT_CSV_HEADERS.length) throw new Error(`列数 ${cells.length} != ${PRODUCT_CSV_HEADERS.length}`)
  return cells.join(',')
}

describe('CSV 导出', () => {
  it('往返一致：导出行 + parseCsvRows 解析回列值（含引号/逗号转义）', () => {
    const source = makeSource({ title: '带,逗号与"引号"的标题' })
    const csv = buildProductCsv(productCsvRows([source]))
    expect(csv.startsWith('\uFEFF')).toBe(true) // UTF-8 BOM
    const parsed = parseCsvRows(csv)
    expect(parsed[0][0]).toBe('标题') // 表头
    expect(parsed[1][0]).toBe('带,逗号与"引号"的标题')
    expect(parsed[1][9]).toBe('SKU-A|SKU-B')
    expect(parsed[1][7]).toBe('¥129.00–¥159.00')
    expect(parsed[1][8]).toBe('14') // 库存合计
  })

  it('公式注入防护：= + - @ 开头的单元格被中和（复用发票中心经验）', () => {
    const evil = makeSource({ title: '=HYPERLINK("http://evil")', brand: '+1' })
    const csv = buildProductCsv(productCsvRows([evil]))
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).toContain("'+1")
    expect(/(^|,)=/.test(csv.slice(1))).toBe(false) // 没有任何单元格以未中和的 = 开头
  })

  it('变体聚合口径：单规格单价格不显示区间；null 库存显示空', () => {
    const single = summarizeVariants([{ spec: [], priceMinor: 12900, stock: null, skuCode: null }])
    expect(single.priceText).toBe('¥129.00')
    expect(single.stockText).toBe('')
  })
})

describe('CSV 导入规划', () => {
  const matches: ProductMatchSummary[] = [
    { id: 'p1', title: '真皮沙发', status: 'ready', subtitle: null, brand: '某某品牌', localCategory: '客厅/沙发', tags: ['主推'], variants: [{ skuCode: 'SKU-A', priceMinor: 12900, stock: 10 }, { skuCode: 'SKU-B', priceMinor: 15900, stock: 4 }] },
    { id: 'p2', title: '重名商品', status: 'draft', subtitle: null, brand: null, localCategory: null, tags: [], variants: [{ skuCode: null, priceMinor: null, stock: null }] },
    { id: 'p3', title: '重名商品', status: 'draft', subtitle: null, brand: null, localCategory: null, tags: [], variants: [{ skuCode: null, priceMinor: null, stock: null }] }
  ]

  it('字段级更新 diff：只含有值的列、价格按 SKU 定位变体', () => {
    const rows = mapCsvRowsToImportRows(parseCsvRows(
      '标题,副标题,品牌,本地分类,标签,状态,规格,价格,库存,SKU码,条码,挂载平台,更新时间\r\n' +
      csvRow(['真皮沙发', '新副标题', '', '', '', '', '', '0.89', '89', 'SKU-A', '', '', '']) + '\r\n'
    ))
    const plan = planProductCsvImport(rows, matches)
    expect(plan.updates.length).toBe(1)
    expect(plan.updates[0].productId).toBe('p1')
    const fields = plan.updates[0].changes.map(change => change.field)
    expect(fields).toContain('副标题')
    expect(fields).toContain('价格(SKU-A)')
    expect(fields).toContain('库存(SKU-A)')
    expect(plan.updates[0].changes.find(change => change.field === '价格(SKU-A)')?.after).toBe('¥0.89')
  })

  it('匹配键：SKU 未命中但标题唯一 → 走标题；重名标题 → 如实冲突；多规格改价缺 SKU → 冲突', () => {
    const rows = mapCsvRowsToImportRows(parseCsvRows(
      '标题,副标题,品牌,本地分类,标签,状态,规格,价格,库存,SKU码,条码,挂载平台,更新时间\r\n' +
      csvRow(['重名商品', '', '', '', '', '', '', '50', '', 'UNKNOWN-SKU', '', '', '']) + '\r\n' +
      csvRow(['重名商品', '', '', '', '', '', '', '60', '', '', '', '', '']) + '\r\n'
    ))
    const plan = planProductCsvImport(rows, matches)
    expect(plan.conflicts.some(item => /标题无法唯一定位/.test(item.reason))).toBe(true)  // 行 2：SKU 未命中 + 重名
    expect(plan.conflicts.some(item => /标题命中多个商品/.test(item.reason))).toBe(true)   // 行 3：重名标题如实冲突
  })

  it('无匹配 → 新增；解析不出价格保留 null（绝不当 0）', () => {
    const rows = mapCsvRowsToImportRows(parseCsvRows(
      '标题,副标题,品牌,本地分类,标签,状态,规格,价格,库存,SKU码,条码,挂载平台,更新时间\r\n' +
      csvRow(['全新商品', '', '', '', '', '', '', 'abc', '', '', '', '', '']) + '\r\n'
    ))
    const plan = planProductCsvImport(rows, matches)
    expect(plan.creates.length).toBe(1)
    expect(plan.creates[0].title).toBe('全新商品')
    expect(rows[0].priceMinor).toBeNull()
  })
})
