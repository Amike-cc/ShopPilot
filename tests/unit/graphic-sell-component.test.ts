// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UnifiedGraphicSellPage from '../../apps/desktop/src/renderer/src/features/workbench/UnifiedGraphicSellPage.vue'

/**
 * 图文带货工作台的挂载冒烟（2026-10-19 新增功能）。
 *
 * 为什么用 happy-dom 真挂载：这个页面有 40+ 个 data-test 钩子和一套确认框/生成流程，
 * 只扫源码无法发现"模板编译不过、v-model 绑错字段、确认后没发请求"这类问题。
 * 这里用假的 window.shopilot 桥验证：页面渲染 → 填商品名 → 生成（确认）→ 文案与配图落进结果区。
 */

const mounted: App[] = []
const roots: HTMLElement[] = []

function mountPage(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(UnifiedGraphicSellPage)
  app.mount(root)
  mounted.push(app)
  roots.push(root)
  return root
}

function byTest(root: HTMLElement, name: string): HTMLElement | null {
  return root.querySelector(`[data-test="${name}"]`) as HTMLElement | null
}

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve()
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

type BridgeCall = Record<string, unknown>
interface BridgeCalls {
  generateSellCopy: BridgeCall[]
  generateImage: BridgeCall[]
}
/** happy-dom 里没有 Electron preload；测试自己挂一个符合页面调用面的假桥 */
interface MockAi {
  imageConfigGet: () => Promise<unknown>
  generateSellCopy: (input: BridgeCall) => Promise<unknown>
  generateImage: (input: BridgeCall) => Promise<unknown>
  saveImage: (input: BridgeCall) => Promise<unknown>
  revealImage: (path: string) => Promise<unknown>
}
const win = window as unknown as { shopilot?: { ai: MockAi } }

/** 假 Bridge：配置齐全、文案接口返回结构化文案、生图接口按 n 返回对应张数 */
function stubBridge(): BridgeCalls {
  const calls: BridgeCalls = { generateSellCopy: [], generateImage: [] }
  const sellCopyResult = {
    title: '露营椅界的六边形战士',
    body: '3 秒收纳，后备箱不占地。周末露营带上它，坐一下午不腰酸。',
    tags: ['露营', '收纳好物'],
    coverText: '3 秒收纳',
    imagePrompts: ['山野露营地使用场景', '后备箱收纳特写', '椅面材质细节', '折叠结构示意'],
    model: 'vision-model',
    elapsedMs: 2100,
    source: 'image-text',
    imageCount: 1
  }
  win.shopilot = {
    ai: {
      imageConfigGet: async () => ({
        ok: true,
        data: {
          endpoint: 'https://text.example.com', resolvedEndpoint: 'https://text.example.com/v1/chat/completions', model: 'text-model', hasKey: true,
          imageEndpoint: 'https://img.example.com', resolvedImageEndpoint: 'https://img.example.com/v1/images/generations', imageModel: 'gpt-image-2', hasImageKey: true,
          imageTextEndpoint: 'https://vision.example.com', resolvedImageTextEndpoint: 'https://vision.example.com/v1/chat/completions', imageTextModel: 'vision-model', hasImageTextKey: true
        }
      }),
      generateSellCopy: async (input: BridgeCall) => {
        calls.generateSellCopy.push(input)
        return { ok: true, data: sellCopyResult }
      },
      generateImage: async (input: BridgeCall) => {
        calls.generateImage.push(input)
        const count = Math.max(1, Math.min(4, Number(input.n) || 1))
        return {
          ok: true,
          data: {
            model: 'gpt-image-2',
            elapsedMs: 900,
            images: Array.from({ length: count }, () => ({ b64Json: 'QUJD', mimeType: 'image/png' }))
          }
        }
      },
      saveImage: async () => ({ ok: true, data: { path: 'D:/tmp/a.png', bytes: 1024 } }),
      revealImage: async () => ({ ok: true })
    }
  }
  return calls
}

beforeEach(() => {
  // 历史会按预算写 localStorage；每个用例从空历史开始，避免上一条用例的会话干扰断言
  window.localStorage.clear()
})

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  while (roots.length) roots.pop()?.remove()
  delete win.shopilot
})

describe('图文带货工作台挂载与生成流程', () => {
  it('没有 Electron 桥时页面仍能渲染，并如实说明无法读取配置（不伪造结果）', async () => {
    const root = mountPage()
    await flush()
    expect(byTest(root, 'graphic-sell-page')).not.toBeNull()
    expect(root.textContent).toContain('一次生成整套带货图文')
    expect(root.textContent).toContain('当前预览环境没有 Electron 桥')
    // 没有配置就不允许生成；结果区也不出现
    expect((byTest(root, 'graphic-sell-generate-button') as HTMLButtonElement).disabled).toBe(true)
    expect(byTest(root, 'graphic-sell-result')).toBeNull()
  })

  it('默认套用参考效果模板（躺床俯拍 9:16 + 儿童模特），未上传商品图时不允许生成，切回 AI 自由设计后才可生成', async () => {
    stubBridge()
    const root = mountPage()
    await flush()

    // 默认就是用户要的参考效果：效果卡高亮、9:16、儿童模特、4 张参考效果图
    expect(byTest(root, 'graphic-sell-effect-bed-lying')?.className).toContain('active')
    expect((byTest(root, 'graphic-sell-ratio') as HTMLSelectElement).value).toBe('9:16')
    expect((byTest(root, 'graphic-sell-model') as HTMLSelectElement).value).toBe('child')
    expect(byTest(root, 'graphic-sell-effect-reference')?.querySelectorAll('img')).toHaveLength(4)
    expect(root.textContent).toContain('参考效果')

    setValue(byTest(root, 'graphic-sell-product-name') as HTMLInputElement, '儿童加厚珊瑚绒家居服')
    await nextTick()
    const generate = byTest(root, 'graphic-sell-generate-button') as HTMLButtonElement
    // 效果模板必须要有商品图做参考，否则按钮不可点、也弹不出确认框
    expect(generate.disabled).toBe(true)
    expect(byTest(root, 'graphic-sell-effect-hint')).not.toBeNull()
    click(generate)
    await nextTick()
    expect(byTest(root, 'graphic-sell-confirm')).toBeNull()

    // 切到 AI 自由设计：不要求商品图，比例回到 3:4，参考效果图隐藏
    click(byTest(root, 'graphic-sell-effect-auto') as HTMLElement)
    await nextTick()
    expect(generate.disabled).toBe(false)
    expect((byTest(root, 'graphic-sell-ratio') as HTMLSelectElement).value).toBe('3:4')
    expect(byTest(root, 'graphic-sell-effect-reference')).toBeNull()
  })

  it('配置齐全时：填商品名 → 生成（确认）→ 文案与配图进入结果区，请求参数与界面一致', async () => {
    const calls = stubBridge()
    const root = mountPage()
    await flush()

    // 配置状态如实显示：文案走生图文本 API、生图显示配置的模型
    const configBar = byTest(root, 'graphic-sell-config')
    expect(configBar?.textContent).toContain('生图文本 API')
    expect(configBar?.textContent).toContain('gpt-image-2')

    // 本次不传商品图：切到不依赖商品图的 AI 自由设计模板
    click(byTest(root, 'graphic-sell-effect-auto') as HTMLElement)
    await nextTick()

    const nameInput = byTest(root, 'graphic-sell-product-name') as HTMLInputElement
    setValue(nameInput, '便携折叠露营椅')
    setValue(byTest(root, 'graphic-sell-selling-points') as HTMLTextAreaElement, '轻量铝合金，3 秒收纳')
    setValue(byTest(root, 'graphic-sell-price') as HTMLInputElement, '¥129')
    await nextTick()

    const generate = byTest(root, 'graphic-sell-generate-button') as HTMLButtonElement
    expect(generate.disabled).toBe(false)
    click(generate)
    await nextTick()
    // 先确认再发请求：确认框里能看到本次请求参数
    const confirm = byTest(root, 'graphic-sell-confirm')
    expect(confirm).not.toBeNull()
    expect(confirm?.textContent).toContain('便携折叠露营椅')
    expect(confirm?.textContent).toContain('1 次文案')

    click(byTest(root, 'graphic-sell-confirm-submit') as HTMLElement)
    await flush(12)

    // 文案请求：商品信息、平台/风格、配图张数都按界面值发出
    expect(calls.generateSellCopy).toHaveLength(1)
    expect(calls.generateSellCopy[0]).toMatchObject({
      productName: '便携折叠露营椅',
      sellingPoints: '轻量铝合金，3 秒收纳',
      price: '¥129',
      platform: '通用',
      style: '种草分享',
      imageCount: 4
    })
    // 生图请求：必须带 confirmed、按文案里的画面描述逐张生成、单次不超过 4 张
    expect(calls.generateImage).toHaveLength(1)
    expect(calls.generateImage[0].confirmed).toBe(true)
    expect(calls.generateImage[0].n).toBe(4)
    expect(calls.generateImage[0].prompt).toContain('便携折叠露营椅')
    expect(calls.generateImage[0].prompt).toContain('山野露营地使用场景')
    expect(calls.generateImage[0].size).toBe('1024x1536')

    // 结果显示区：标题/正文/标签（可编辑输入框里是生成值）、配图网格都在
    const result = byTest(root, 'graphic-sell-result')
    expect(result).not.toBeNull()
    expect((byTest(root, 'graphic-sell-edit-title') as HTMLInputElement).value).toBe('露营椅界的六边形战士')
    expect((byTest(root, 'graphic-sell-edit-body') as HTMLTextAreaElement).value).toContain('3 秒收纳，后备箱不占地')
    expect(result?.textContent).toContain('#露营')
    expect(result?.textContent).toContain('3 秒收纳')
    expect(byTest(root, 'graphic-sell-thumbs')?.querySelectorAll('button')).toHaveLength(4)
    expect(byTest(root, 'graphic-sell-images')?.querySelectorAll('figure')).toHaveLength(4)
    expect(byTest(root, 'graphic-sell-action-notice')).toBeNull()
    // 生成结束，按钮恢复成“换一批”
    expect(byTest(root, 'graphic-sell-generate-button')?.textContent).toContain('换一批')

    // 单张重绘：只重发这一张（n=1），不重新请求文案，也不重发其它三张
    const regenerate = byTest(root, 'graphic-sell-regenerate-1') as HTMLButtonElement
    expect(regenerate).not.toBeNull()
    click(regenerate)
    await flush(8)
    expect(calls.generateSellCopy).toHaveLength(1)
    expect(calls.generateImage).toHaveLength(2)
    expect(calls.generateImage[1].n).toBe(1)
    expect(calls.generateImage[1].confirmed).toBe(true)
    expect(byTest(root, 'graphic-sell-action-notice')?.textContent).toContain('已重绘第 2 张')
    expect(byTest(root, 'graphic-sell-images')?.querySelectorAll('figure')).toHaveLength(4)
  })

  it('文案接口失败时给出可执行中文错误，且不会假装生成了配图', async () => {
    const calls = stubBridge()
    win.shopilot!.ai.generateSellCopy = async () => ({ ok: false, error: { code: 'AI_TIMEOUT', message: '生图文本请求超过 120000ms 未返回（当前文本模型较慢）' } })
    const root = mountPage()
    await flush()
    // 不传商品图：切到 AI 自由设计，确保走到"文案请求失败"这条路径
    click(byTest(root, 'graphic-sell-effect-auto') as HTMLElement)
    await nextTick()
    setValue(byTest(root, 'graphic-sell-product-name') as HTMLInputElement, '露营椅')
    await nextTick()
    click(byTest(root, 'graphic-sell-generate-button') as HTMLElement)
    await nextTick()
    click(byTest(root, 'graphic-sell-confirm-submit') as HTMLElement)
    await flush(8)

    const error = byTest(root, 'graphic-sell-error')
    expect(error?.textContent).toContain('生图文本请求超过')
    expect(calls.generateImage).toHaveLength(0)
    expect(byTest(root, 'graphic-sell-result')).toBeNull()
  })

  it('历史记录面板可以打开，空历史如实说明（无假记录）', async () => {
    stubBridge()
    const root = mountPage()
    await flush()
    click(byTest(root, 'graphic-sell-history-toggle') as HTMLElement)
    await nextTick()
    const panel = byTest(root, 'graphic-sell-history')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('还没有生成记录')
  })
})
