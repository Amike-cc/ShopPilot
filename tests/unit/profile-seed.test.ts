import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CORE_POOL, createSeededRandom, hashSeed, seedProfileValues } from '../../apps/desktop/src/main/stores/profile-seed'

/**
 * 「每店独立指纹」播种的回归网（2026-10-16 指纹审查 P0）。
 *
 * 审查结论：原来所有店铺的档案值**完全相同**，而 hardware_concurrency / webgl_vendor /
 * webgl_renderer 直接写 null（=不覆盖 → 页面读到宿主真实核数与显卡）。这一组断言把
 * "同店稳定、跨店不同、值来自真实档位池"三件事钉死，防止以后又被改回一条常量。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const MANAGER = read('apps/desktop/src/main/stores/profile-manager.ts')

const CHROME = '152.0.7977.149'
const ids = ['store_aa11', 'store_bb22', 'store_cc33', 'store_dd44', 'store_ee55', 'store_ff66', 'store_gg77', 'store_hh88']

describe('播种：同店稳定', () => {
  it('同一个 storeId 永远得到同一套值（不许每次启动/每次建店变）', () => {
    const first = seedProfileValues('store_aa11', CHROME)
    const second = seedProfileValues('store_aa11', CHROME)
    expect(second).toEqual(first)
  })

  it('哈希与 PRNG 都是确定性的（同种子同序列）', () => {
    expect(hashSeed('store_aa11')).toBe(hashSeed('store_aa11'))
    expect(hashSeed('store_aa11')).not.toBe(hashSeed('store_bb22'))
    const a = createSeededRandom(1234)
    const b = createSeededRandom(1234)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('播种：跨店不同（这才是"去匿名化"的关键）', () => {
  it('八家店的指纹组合互不相同（分辨率+核心数+显卡+噪声种子）', () => {
    const signatures = ids.map(id => {
      const v = seedProfileValues(id, CHROME)
      return `${v.screenWidth}x${v.screenHeight}|${v.hardwareConcurrency}|${v.webglRenderer}|${v.noiseSeed}`
    })
    expect(new Set(signatures).size).toBe(ids.length)
  })

  it('噪声种子必须逐店不同（canvas/audio 噪声的种子，撞了就等于没噪声）', () => {
    const seeds = ids.map(id => seedProfileValues(id, CHROME).noiseSeed)
    expect(new Set(seeds).size).toBe(ids.length)
  })
})

describe('播种：值必须来自真实档位池，且与引擎自洽', () => {
  it('分辨率/核心数/显卡都在池内，colorDepth 固定 24', () => {
    for (const id of ids) {
      const v = seedProfileValues(id, CHROME)
      expect(v.screenWidth).toBeGreaterThanOrEqual(1366)
      expect(v.screenHeight).toBeGreaterThanOrEqual(768)
      expect(CORE_POOL).toContain(v.hardwareConcurrency)
      expect(v.webglVendor).toMatch(/^Google Inc\. \(/)
      expect(v.webglRenderer).toContain('ANGLE (')
      expect(v.webglRenderer).toContain('Direct3D11')
      expect(v.colorDepth).toBe(24)
    }
  })

  it('UA 用本机引擎版本、不含 Electron/ShopPilot 痕迹（谎报版本会让 UA-CH 与引擎对不上）', () => {
    const v = seedProfileValues('store_aa11', CHROME)
    expect(v.userAgent).toContain(`Chrome/${CHROME}`)
    expect(v.userAgent).toContain('Windows NT 10.0; Win64; x64')
    expect(v.userAgent).not.toMatch(/Electron|ShopPilot|shopilot/i)
    // 语言/时区不参与播种：它们必须与代理出口地理一致，乱变只会制造新的矛盾
    expect(v.language).toBe('zh-CN')
    expect(v.timezone).toBe('Asia/Shanghai')
  })
})

describe('接线：建店时真的用了播种值（不许回退成常量与 null）', () => {
  const body = () => {
    const fn = MANAGER.match(/function ensureProfileForStore[\s\S]*?return getProfile\(storeId\)!/)
    expect(fn).toBeTruthy()
    return fn![0]
  }

  it('建店走 seedProfileValues，且不再写 null 的硬件字段', () => {
    const fn = body()
    expect(fn).toContain('seedProfileValues(storeId')
    for (const field of ['seeded.screenWidth', 'seeded.screenHeight', 'seeded.hardwareConcurrency', 'seeded.webglVendor', 'seeded.webglRenderer']) {
      expect(fn).toContain(field)
    }
    // 关键回归：这四个字段曾经是写死的 null / 常量
    expect(fn).not.toContain('1920, 1080, 24, null')
    expect(fn).not.toContain('null, null, partition')
  })

  it('UA-CH 落库（此前 ua_client_hints_json 列从无写入点）', () => {
    expect(body()).toContain('JSON.stringify(parseUaClientHints(userAgent))')
  })
})
