import { describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { productProfileFor } from '@shared/constants/product'
import { readProductDetail } from '../../apps/desktop/src/main/platform-adapters/product-page-reader'
import type { PageHandle } from '../../apps/desktop/src/main/platform-adapters/sales-metrics-page-reader'

/**
 * happy-dom 的 DOMRect/DOMRectList 与 DOM 标准库类型不同名（PropertySymbol 字段），
 * 直接给原型赋标准类型字面量过不了 typecheck:tests。所有"让元素可见"的 mock
 * 统一从这里的 helper 注入：结构上提供 width/height（脚本只读这两个字段），
 * 返回恢复函数，finally 里还原原型。
 */
function mockVisibleRects(window: Window, width: number, height: number): () => void {
  const proto = window.HTMLElement.prototype as unknown as {
    getClientRects: () => unknown
    getBoundingClientRect: () => unknown
  }
  const origRects = window.HTMLElement.prototype.getClientRects
  const origBounds = window.HTMLElement.prototype.getBoundingClientRect
  proto.getClientRects = function () { return [{ width, height }] }
  proto.getBoundingClientRect = function () { return { width, height } }
  return () => {
    window.HTMLElement.prototype.getClientRects = origRects
    window.HTMLElement.prototype.getBoundingClientRect = origBounds
  }
}

/** 同一个 PageHandle 假件在四个用例里只有 window 不同：抽出来免得每处重写六行。 */
function fakePage(window: Window): PageHandle {
  return {
    isDestroyed: () => false,
    executeJavaScript: async (code: string) => window.eval(code),
    getURL: () => window.location.href,
    isLoading: () => false,
    loadURL: async () => undefined,
    sendInputEvent: () => undefined
  } as unknown as PageHandle
}

describe('商品详情页面读取器', () => {
  it('读取图片候选、表单字段、静态键值和 SKU，并保留缺失字段提示', async () => {
    const window = new Window({ url: 'https://store.weixin.qq.com/shop/goods/entry?productId=10001' })
    window.document.body.innerHTML = `
      <label for="title">商品名称</label>
      <input id="title" placeholder="请输入商品名称与关键字" value="儿童暖暖套装">
      <label for="brand">品牌</label>
      <input id="brand" placeholder="请选择品牌" value="自有品牌">
      <label for="description">详情描述</label>
      <div id="description" contenteditable="true">柔软保暖，适合秋冬日常穿着，支持机洗。</div>
      <input placeholder="请输入颜色" value="红色">
      <input placeholder="输入售卖价格" value="29.90">
      <input placeholder="输入库存" value="12">
      <dl><dt>材质</dt><dd>棉</dd></dl>
      <table><tbody><tr><th>产地</th><td>中国</td></tr></tbody></table>
      <img src="/images/cover.webp" width="120" height="120" srcset="/images/cover.webp 1x, /images/cover@2x.webp 2x">
    `
    const restoreRects = mockVisibleRects(window, 120, 120)
    try {
      const profile = productProfileFor('微信小店')
      expect(profile).not.toBeNull()
      const result = await readProductDetail(fakePage(window), profile!)

      expect(result.ok).toBe(true)
      expect(result.title).toBe('儿童暖暖套装')
      expect(result.brand).toBe('自有品牌')
      expect(result.description).toContain('柔软保暖')
      expect(result.imageUrls).toEqual(['https://store.weixin.qq.com/images/cover.webp'])
      expect(result.skus).toEqual([expect.objectContaining({ priceMinor: 2990, stock: 12 })])
      expect(result.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: '材质', value: '棉', kind: 'text' }),
        expect.objectContaining({ label: '产地', value: '中国', kind: 'text' })
      ]))
      expect(result.missingFields).toContain('category')
    } finally {
      restoreRects()
      window.close()
    }
  })

  it('按详情表格行读取多规格组合，并保留每个 SKU 条码', async () => {
    const window = new Window({ url: 'https://store.weixin.qq.com/shop/goods/entry?productId=10002' })
    window.document.body.innerHTML = `
      <input placeholder="请输入商品名称与关键字" value="多规格商品">
      <table><tbody>
        <tr>
          <td><input placeholder="请输入颜色" value="红"></td>
          <td><input placeholder="请输入尺码" value="S"></td>
          <td><input placeholder="输入售卖价格" value="10.00"></td>
          <td><input placeholder="输入库存" value="2"></td>
          <td><input placeholder="输入规格编码" value="R-S"></td>
          <td><input placeholder="请输入商品条形码" value="69000001"></td>
        </tr>
        <tr>
          <td><input placeholder="请输入颜色" value="红"></td>
          <td><input placeholder="请输入尺码" value="M"></td>
          <td><input placeholder="输入售卖价格" value="11.00"></td>
          <td><input placeholder="输入库存" value="3"></td>
          <td><input placeholder="输入规格编码" value="R-M"></td>
          <td><input placeholder="请输入商品条形码" value="69000002"></td>
        </tr>
      </tbody></table>
    `
    const restoreRects = mockVisibleRects(window, 120, 30)
    try {
      const profile = productProfileFor('微信小店')
      const result = await readProductDetail(fakePage(window), profile!)

      expect(result.skus).toHaveLength(2)
      expect(result.skus[0]).toMatchObject({
        spec: [{ name: '颜色', value: '红' }, { name: '尺码', value: 'S' }],
        priceMinor: 1000,
        stock: 2,
        skuCode: 'R-S',
        barcode: '69000001'
      })
      expect(result.skus[1]).toMatchObject({
        spec: [{ name: '颜色', value: '红' }, { name: '尺码', value: 'M' }],
        barcode: '69000002'
      })
      expect(result.specNames).toEqual(['颜色', '尺码'])
    } finally {
      restoreRects()
      window.close()
    }
  })

  it('价格/库存带千分位与货币符时按真实数值解析，不把 "1,299.00" 读成 1（审查 P1-3）', async () => {
    const window = new Window({ url: 'https://store.weixin.qq.com/shop/goods/entry?productId=10003' })
    window.document.body.innerHTML = `
      <input placeholder="请输入商品名称与关键字" value="千分位商品">
      <table><tbody>
        <tr>
          <td><input placeholder="请输入颜色" value="黑"></td>
          <td><input placeholder="输入售卖价格" value="1,299.00"></td>
          <td><input placeholder="输入库存" value="1,200"></td>
        </tr>
        <tr>
          <td><input placeholder="请输入颜色" value="白"></td>
          <td><input placeholder="输入售卖价格" value="¥99"></td>
          <td><input placeholder="输入库存" value="35"></td>
        </tr>
      </tbody></table>
    `
    const restoreRects = mockVisibleRects(window, 120, 30)
    try {
      const profile = productProfileFor('微信小店')
      const result = await readProductDetail(fakePage(window), profile!)

      expect(result.skus).toHaveLength(2)
      // 修复前 parseFloat("1,299.00")=1 → priceMinor=100；parseInt("1,200")=1 → stock=1
      expect(result.skus[0]).toMatchObject({ priceMinor: 129_900, stock: 1200 })
      // "¥99" → 9900 分（货币符剥掉后按有效数值上报，而不是 null）
      expect(result.skus[1]).toMatchObject({ priceMinor: 9_900, stock: 35 })
    } finally {
      restoreRects()
      window.close()
    }
  })

  it('单规格商品（无规格输入、单价格行）不把 sku 记为缺失——纯单规格店铺不再永远 PARTIAL（审查 P2-3）', async () => {
    const window = new Window({ url: 'https://store.weixin.qq.com/shop/goods/entry?productId=10004' })
    window.document.body.innerHTML = `
      <label for="title">商品名称</label>
      <input id="title" placeholder="请输入商品名称与关键字" value="单规格商品">
      <label for="brand">品牌</label>
      <input id="brand" placeholder="请选择品牌" value="自有品牌">
      <input placeholder="输入售卖价格" value="59.90">
      <input placeholder="输入库存" value="10">
    `
    const restoreRects = mockVisibleRects(window, 120, 30)
    try {
      const profile = productProfileFor('微信小店')
      const result = await readProductDetail(fakePage(window), profile!)

      expect(result.ok).toBe(true)
      expect(result.title).toBe('单规格商品')
      // 单规格配不出 SKU 映射是正常形态：不记缺失（修复前这里会 toContain('sku')）
      expect(result.missingFields).not.toContain('sku')
      // 多规格迹象下的配对失败仍然如实记缺失（fail-closed 不放松）
      expect(result.missingFields).toContain('category')
    } finally {
      restoreRects()
      window.close()
    }
  })
})
