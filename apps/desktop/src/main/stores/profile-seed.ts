/**
 * 建店时播种"每店独立"的指纹值集（2026-10-16 指纹审查 P0）。
 *
 * 审查结论：原实现给所有店铺写**完全相同**的默认值（同 UA、同 1920×1080、同 24 位色），
 * 而 `hardware_concurrency` / `webgl_vendor` / `webgl_renderer` 直接写 **null**（=不覆盖，
 * 页面读到的是宿主真值：真实核数、真实显卡 `ANGLE (NVIDIA …)`），且没有 canvas/audio 噪声 ——
 * 结果是**同机多店在平台侧可被并成一个实体、机器可被识别**（去匿名化为 0）。
 *
 * 设计要点：
 *   ① **确定性**：种子取自 storeId（FNV-1a + mulberry32），所以同一家店每次算出的值完全一致
 *      （满足"不允许每次启动随机变更"），不同店铺几乎必然不同；
 *   ② 值都从**真实存在的机型档位池**里取，不自造离奇组合；UA 的 Chrome 主版本用**本机引擎版本**
 *      —— 引擎就是它，UA 里报别的版本会让特性检测与 UA-CH 与真实引擎对不上；
 *   ③ 平台固定 Windows（引擎是 Windows Chromium）：谎报 macOS 会立刻在字体/GPU/navigator.platform
 *      上暴露；要支持 macOS 档案得先有对应引擎，不在本次范围；
 *   ④ 语言/时区**不参与播种**：它们必须与代理出口地理位置一致，乱变只会制造新的矛盾
 *      （与代理联动是另一项待办）。
 */

export interface SeededProfileValues {
  userAgent: string
  osDisplay: string
  language: string
  timezone: string
  screenWidth: number
  screenHeight: number
  colorDepth: number
  hardwareConcurrency: number
  webglVendor: string
  webglRenderer: string
  /** canvas / audio 噪声种子：同店稳定、跨店不同 */
  noiseSeed: number
}

/** 显示分辨率档位（都是真实常见组合，且不大于主流桌面屏） */
const SCREEN_POOL: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 }
]

/** 逻辑核心数档位（Chromium 报的是逻辑核） */
export const CORE_POOL: ReadonlyArray<number> = [4, 6, 8, 12, 16]

/** 显卡档位：都是真实存在的 ANGLE 串（Windows + D3D11） */
const GPU_POOL: ReadonlyArray<{ vendor: string; renderer: string }> = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' }
]

/** FNV-1a：把 storeId 变成稳定的 32 位种子 */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5
  const text = String(input || '')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** mulberry32：小而确定的 PRNG（同种子同序列，跨平台一致） */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(pool: readonly T[], random: () => number): T => pool[Math.floor(random() * pool.length) % pool.length]

/**
 * 按 storeId 播种一套档案值。**纯函数**：同 storeId + 同引擎版本 → 同结果（可重复、可单测）。
 * @param storeId 店铺 id
 * @param chromeVersion 本机 Chromium 版本（来自 `process.versions.chrome`），写进 UA
 */
export function seedProfileValues(storeId: string, chromeVersion: string): SeededProfileValues {
  const version = String(chromeVersion || '126.0.0.0')
  const random = createSeededRandom(hashSeed(`profile:${storeId}`))
  const screen = pick(SCREEN_POOL, random)
  const cores = pick(CORE_POOL, random)
  const gpu = pick(GPU_POOL, random)
  // Windows 10/11 的 UA 完全相同（真实 Chrome 就是这么报的）——差异放在 osDisplay 等展示字段上
  const osDisplay = random() < 0.5 ? 'Windows 10' : 'Windows 11'
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    osDisplay,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    screenWidth: screen.width,
    screenHeight: screen.height,
    colorDepth: 24,
    hardwareConcurrency: cores,
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    noiseSeed: hashSeed(`noise:${storeId}`)
  }
}
