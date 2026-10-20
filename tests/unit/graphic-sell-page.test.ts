import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 「AI 创作 → 图文带货」接线守卫（2026-10-19 新增功能）。
 *
 * 为什么单独钉：这个功能跨四处接线（shared 通道 / 主进程 handler / preload / 渲染层页面与路由），
 * 少接一处不会编译失败，只会在运行期表现为"卡片点进去没反应"或"按钮点了没请求"。
 * 与 image-studio-parity.test.ts 同一套做法：只扫源码文本，不 import electron、不起窗口。
 */

const readSource = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const page = readSource('apps/desktop/src/renderer/src/features/workbench/UnifiedGraphicSellPage.vue')
const composable = readSource('apps/desktop/src/renderer/src/features/workbench/use-graphic-sell.ts')
const logic = readSource('apps/desktop/src/renderer/src/features/workbench/graphic-sell.ts')
const sharedContract = readSource('packages/shared/src/contracts/ai-sell-copy.ts')
const channels = readSource('packages/shared/src/contracts/ipc.ts')
const envDts = readSource('apps/desktop/src/renderer/src/env.d.ts')
const preload = readSource('apps/desktop/src/preload/index.ts')
const handlers = readSource('apps/desktop/src/main/ipc/ai-handlers.ts')
const client = readSource('apps/desktop/src/main/services/ai-client.ts')
const appsPage = readSource('apps/desktop/src/renderer/src/features/workbench/UnifiedAppsPage.vue')
const dashboard = readSource('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')

describe('图文带货：跨进程链路四处对接', () => {
  it('shared 契约声明通道常量与结果类型', () => {
    expect(channels).toContain("AI_IMAGE_TEXT_SELL_COPY: 'ai:image-text:sell-copy'")
    expect(sharedContract).toContain('export interface SellCopyResult')
    expect(sharedContract).toContain('export interface SellCopyInput')
    expect(sharedContract).toContain('SELL_COPY_LIMITS')
  })

  it('主进程 handler：可信校验 + 审计 + 调用 ai-client，不把错误吞掉', () => {
    expect(handlers).toContain('IPC_CHANNELS.AI_IMAGE_TEXT_SELL_COPY')
    expect(handlers).toContain('AiClient.generateSellCopyText(')
    expect(handlers).toContain("writeAudit('ai.imageText.sellCopy'")
    expect(handlers).toContain('describeAiFailure')
    // 与既有 AI 通道同一安全口径：进入业务逻辑前先 assertTrusted(event)
    const start = handlers.indexOf('IPC_CHANNELS.AI_IMAGE_TEXT_SELL_COPY')
    const slice = handlers.slice(start, start + 1600)
    expect(slice).toContain('assertTrusted(event)')
    expect(slice).toContain('failure(')
  })

  it('ai-client 复用「生图文本 API」那条带主文本回退的链路', () => {
    expect(client).toContain('export async function generateSellCopyText')
    expect(client).toContain('chatCompleteForImageText')
    expect(client).toContain("source === 'main-text' ? 'main-text' : 'image-text'")
  })

  it('preload / env.d.ts 同步暴露 generateSellCopy（ipc-contract 三方一致）', () => {
    expect(preload).toContain('generateSellCopy:')
    expect(preload).toContain('IPC_CHANNELS.AI_IMAGE_TEXT_SELL_COPY')
    expect(envDts).toContain('generateSellCopy:')
  })
})

describe('图文带货：AI 创作入口与工作台路由', () => {
  it('AI 创作页新增真实卡片（不是占位，不是“暂不可用”）', () => {
    expect(appsPage).toContain('data-test="app-graphic-sell"')
    expect(appsPage).toContain("emit('navigate', 'graphic-sell')")
    expect(appsPage).toContain("page: 'graphic-sell'")
    expect(appsPage).toContain('图文带货')
    // 应用中心的分类计数从 appLinks 推导，新增一项必须是真实页面
    expect(appsPage).toContain("cat: 'create'")
  })

  it('DashboardView 挂载页面、标题、AI 创作高亮与离开保护', () => {
    expect(dashboard).toContain('UnifiedGraphicSellPage')
    expect(dashboard).toContain("activePage === 'graphic-sell'")
    expect(dashboard).toContain("'graphic-sell': '图文带货'")
    expect(dashboard).toContain("page === 'image-studio' || page === 'graphic-sell'")
    // 生成中离开 = 丢掉已返回的文案/图片，必须被拦住
    expect(dashboard).toContain('const graphicSellBusy = ref(false)')
    expect(dashboard).toContain('graphicSellBusy = $event')
    expect(dashboard).toContain("activePage.value === 'graphic-sell' && graphicSellBusy.value")
    expect(dashboard).toContain('preventBusyAiStudioExit')
  })

  it('工作台页面有完整交互钩子，且不假装结果', () => {
    for (const hook of [
      'graphic-sell-page',
      'graphic-sell-product-name',
      'graphic-sell-selling-points',
      'graphic-sell-platform',
      'graphic-sell-style',
      'graphic-sell-image-count',
      'graphic-sell-material-input',
      'graphic-sell-generate-button',
      'graphic-sell-confirm',
      'graphic-sell-confirm-submit',
      'graphic-sell-result',
      'graphic-sell-edit-title',
      'graphic-sell-edit-body',
      'graphic-sell-edit-tags',
      'graphic-sell-copy-full',
      'graphic-sell-action-notice',
      'graphic-sell-effect-reference',
      'graphic-sell-model',
      'graphic-sell-effect-hint'
    ]) {
      expect(page, `页面缺少 ${hook}`).toContain(`data-test="${hook}"`)
    }
    // 效果模板卡是 v-for 动态 data-test（CDP 里按 graphic-sell-effect-bed-lying 等取值）
    expect(page).toContain(':data-test="`graphic-sell-effect-${item.key}`"')
    // 单张重绘按钮也是动态 data-test
    expect(page).toContain(':data-test="`graphic-sell-regenerate-${index}`"')
    expect(page).toContain('哪张不满意可单独「重绘」')
    // 生成按钮在配置未齐/未填商品名/重绘中时不可点；空状态如实说明缺哪套接口
    expect(page).toContain(':disabled="generating || regeneratingIndex >= 0 || !canGenerate"')
    expect(page).toContain('文案接口未配置')
    expect(page).toContain('生图接口未配置')
    // 不允许把“示例/假数据”当生成结果展示
    expect(page).not.toContain('演示数据')
    expect(page).not.toContain('假数据')
    expect(page).not.toContain('示例结果')
  })
})

describe('图文带货：生成流程与数据边界', () => {
  it('页面向主进程要文案、再按逐图描述生图、保存走主进程落盘', () => {
    expect(composable).toContain('window.shopilot.ai.generateSellCopy(')
    expect(composable).toContain('window.shopilot.ai.generateImage(')
    expect(composable).toContain('window.shopilot.ai.saveImage(')
    expect(composable).toContain('confirmed: true')
    // 配图分批：单次最多 4 张；效果模板一张一请求（逐张构图）
    expect(composable).toContain('graphicSellImageBatches')
    expect(composable).toContain('graphicSellImageBatchSize')
    expect(logic).toContain('for (let remaining = total; remaining > 0; remaining -= perRequest)')
    // 失败原因一律转成可执行中文，不静默
    expect(composable).toContain('describeGraphicSellError')
    expect(composable).toContain("generationError.value = '文案接口返回的内容不完整")
  })

  it('组参在渲染层就按 shared 上限与白名单收口', () => {
    expect(logic).toContain("from '@shared/contracts/ai-sell-copy'")
    expect(logic).toContain('dataUrlToAnalysisImage')
    expect(logic).toContain('normalizeSellCopyPlatform')
    expect(logic).toContain('clampSellCopyImageCount')
    expect(logic).toContain('SELL_COPY_LIMITS')
  })

  it('渲染层不直接出网、不持有 Key：文案与生图请求都只走 preload', () => {
    expect(composable).not.toContain('fetch(')
    expect(page).not.toContain('apiKey')
    expect(page).not.toContain('Authorization')
    expect(composable).not.toContain('Authorization')
  })

  it('生成中显示真实阶段、历史按预算落盘并能在卸载前 flush', () => {
    expect(composable).toContain('phase.value =')
    expect(composable).toContain('schedulePersistHistory')
    expect(composable).toContain('flushPendingPersist')
    expect(composable).toContain('SELL_HISTORY_STORAGE_KEY')
    expect(logic).toContain('trimGraphicSellHistory')
    expect(logic).toContain('SELL_HISTORY_STORAGE_BUDGET')
  })
})

describe('图文带货：参考效果模板（2026-10-19 按用户 4 张参考图新增）', () => {
  it('默认效果就是参考模板（躺床俯拍 9:16 + 儿童模特），且必须带商品图', () => {
    expect(logic).toContain("export const GRAPHIC_SELL_DEFAULT_EFFECT: GraphicSellEffectKey = 'bed-lying'")
    expect(logic).toContain("key: 'bed-lying'")
    expect(logic).toContain("label: '躺床俯拍'")
    expect(logic).toContain("recommendedRatio: '9:16'")
    expect(logic).toContain("recommendedModel: 'child'")
    expect(logic).toContain('requiresProductImage: true')
    expect(composable).toContain('requiresProductImage')
    // 没有商品图时按钮不可点 / 明确提示，不发一个保不住商品本体的请求
    expect(composable).toContain('效果需要先上传商品图')
    expect(page).toContain('requiresProductImage ? \'该效果必填\'')
  })

  it('模板进入生图提示词：场景、模特、逐张构图、商品一致性，且请求带 effect/model', () => {
    expect(logic).toContain('效果模板：${effect.label}')
    expect(logic).toContain('商品一致性（最高优先级）')
    expect(logic).toContain('本张构图：')
    expect(composable).toContain('{ effect: requestEffect, model: requestModel }')
    expect(composable).toContain('const requestEffect = effect.value')
    expect(composable).toContain('const requestModel = model.value')
    // 模板选择会同时套用推荐模特与比例，并记住选择
    expect(composable).toContain('function selectEffect(')
    expect(composable).toContain('graphicSellEffectDefaults')
    expect(composable).toContain('SELL_PRESET_STORAGE_KEY')
  })

  it('生图效果优化（2026-10-19 实测出图问题）：闭眼安睡、90° 俯拍、单一主体、不编造文字', () => {
    // 实测：模型默认输出"睁眼微笑看镜头"的影楼写真，且会凭空加第二个孩子/第二套商品/假英文刺绣
    expect(logic).toContain('正上方 90° 垂直俯拍')
    expect(logic).toContain('眼睛轻闭')
    expect(logic).toContain('不要摆拍式微笑')
    expect(logic).toContain('只出现一位人物与一套商品')
    expect(logic).toContain('参考图没有文字时')
    expect(logic).toContain('不要出现任何字母')
    expect(logic).toContain('不要过度磨皮')
    expect(logic).toContain('严禁人脸大特写')
    // 单张重绘：一套图里常有一两张跑偏，不能只靠"全部换一批"
    expect(composable).toContain('async function regenerateImage(')
    expect(composable).toContain('regeneratingIndex')
    expect(composable).toContain('lastRequest')
    expect(composable).toContain('已重绘第 ${targetIndex + 1} 张配图')
  })

  it('4 张参考效果图作为内置素材存在，并在页面里展示', () => {
    const assets = [
      'apps/desktop/src/renderer/src/assets/ui/graphic-sell/effect-bed-pink-teddy.jpg',
      'apps/desktop/src/renderer/src/assets/ui/graphic-sell/effect-bed-blue-cat.jpg',
      'apps/desktop/src/renderer/src/assets/ui/graphic-sell/effect-bed-blue-crossed.jpg',
      'apps/desktop/src/renderer/src/assets/ui/graphic-sell/effect-bed-blue-arms.jpg'
    ]
    for (const asset of assets) {
      expect(existsSync(resolve(asset)), `缺少参考效果素材：${asset}`).toBe(true)
      expect(statSync(resolve(asset)).size).toBeGreaterThan(1024)
      expect(page).toContain(asset.split('/').pop() as string)
    }
    expect(page).toContain('参考效果')
    expect(page).toContain('9:16')
  })
})
