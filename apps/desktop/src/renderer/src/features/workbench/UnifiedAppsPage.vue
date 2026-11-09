<script setup lang="ts">
/**
 * 应用商城 / AI 创作（v4 重设计 R1，2026-10-15）。
 *
 * 原 products 分支已拆分到 `features/products/ProductManagementPage.vue`
 * （查询与列表重构 + 三 Tab + 抽屉；发布/编辑等能力整体随迁，不回退）。
 * 本文件只剩 AI 创作与应用商城两个静态视图。
 */
import { computed, onMounted, ref } from 'vue'
import aiAppIcon from '../../assets/icons/nav-ai.svg'
import publishAppIcon from '../../assets/icons/nav-products.svg'
import settingsAppIcon from '../../assets/icons/nav-settings.svg'
import productsAppIcon from '../../assets/icons/nav-products.svg'
import storesAppIcon from '../../assets/icons/app-stores.svg'
import analyticsAppIcon from '../../assets/icons/app-analytics.svg'
import invoicesAppIcon from '../../assets/icons/app-invoices.svg'
import taxAppIcon from '../../assets/icons/app-tax.svg'
import graphicSellAppIcon from '../../assets/icons/settings-square.svg'
import forwardIcon from '../../assets/generated/ui-icons/forward-gen.png'
import assistantArt from '../../assets/generated/ai-assistant-generated.png'
import assistantOpenIcon from '../../assets/generated/ui-icons/assistant-open-gen.png'
import AppCenterExtensions from './AppCenterExtensions.vue'
import SettingsModal from './SettingsModal.vue'
import { ensureAppModulesLoaded, isModuleInstalled, setModuleInstalled, type OptionalModuleKey } from './use-app-modules'

type Mode = 'ai' | 'apps'
type Page = 'stores' | 'analytics' | 'invoices' | 'tax' | 'settings' | 'image-studio' | 'graphic-sell' | 'products'
type AppTone = 'violet' | 'blue' | 'cyan' | 'orange' | 'indigo' | 'green' | 'pink' | 'slate' | 'amber'

interface AppLink {
  key: string
  label: string
  description: string
  /** 卡底只写能力要点，不冒充实时状态或统计数据 */
  note: string
  tone: AppTone
  icon: string
  page: Page
}

const props = defineProps<{ mode: Mode }>()
const emit = defineEmits<{
  navigate: [page: Page]
  'open-assistant': []
}>()
const title = computed(() => props.mode === 'ai' ? 'AI 创作工具' : '应用商城')
const subtitle = computed(() => props.mode === 'ai'
  ? '访问当前已接入的 AI 助手与模型配置。'
  : '安装插件与扩展，进入 AI 工具、业务应用与系统页面；插件随应用内置，离线可装。')

/** 图标底色：资源本身是浅色描边（为深色底准备），这里用 mask 着色，不改动图标文件 */
const appTones: Record<AppTone, { bg: string; fg: string }> = {
  violet: { bg: '#F3EFFF', fg: '#5340D9' },
  blue: { bg: '#EAF2FF', fg: '#1D6FE8' },
  cyan: { bg: '#E4F7FE', fg: '#0A7EA4' },
  orange: { bg: '#FFF3E6', fg: '#B85E0A' },
  indigo: { bg: '#EDEEFF', fg: '#4453D6' },
  green: { bg: '#E7F8F0', fg: '#0C8A5F' },
  pink: { bg: '#FFEDF5', fg: '#C02C7C' },
  slate: { bg: '#F0F3F7', fg: '#54607A' },
  amber: { bg: '#FFF7E6', fg: '#A56400' }
}

/**
 * 业务应用：内置业务模块，但不是产品底座（2026-11-09 产品口径：商品/发票/涉税不算核心）。
 * 在商城按「内置可选」展示，提供入口但不提供安装/卸载；侧栏仍可直达。
 */
const businessApps: AppLink[] = [
  { key: 'products', label: '商品管理', description: '查询、编辑与批量发布预检，支持草稿、回收站与 CSV。', note: '批量发布 · 回收站', tone: 'green', icon: productsAppIcon, page: 'products' },
  { key: 'invoices', label: '发票中心', description: '汇总待开票记录并导出 CSV，按主体与店铺核对。', note: '待开票 · CSV 导出', tone: 'orange', icon: invoicesAppIcon, page: 'invoices' },
  { key: 'tax', label: '涉税信息', description: '查看平台按季度报送的涉税经营数据与主体汇总。', note: '季度报送 · 只读核对', tone: 'green', icon: taxAppIcon, page: 'tax' }
]

/**
 * 系统页面：产品底座（店铺/数据/设置），不可卸载。
 * 这些入口在左侧导航都有，折叠起来只作为「不想找侧栏」时的备用路径。
 */
const systemApps: AppLink[] = [
  { key: 'stores', label: '店铺管理', description: '管理店铺、平台与登录状态，托管本机浏览器工作区。', note: '平台登录 · 浏览器工作区', tone: 'blue', icon: storesAppIcon, page: 'stores' },
  { key: 'analytics', label: '数据分析', description: '查看真实快照、经营指标与数据采集入口。', note: '真实快照 · 采集口径', tone: 'violet', icon: analyticsAppIcon, page: 'analytics' },
  { key: 'settings', label: '设置中心', description: '平台地址、AI 配置、应用锁与数据维护。', note: '地址 · AI · 应用锁', tone: 'slate', icon: settingsAppIcon, page: 'settings' }
]

interface AiConfigShape {
  model?: string
  hasKey?: boolean
  imageModel?: string
  hasImageKey?: boolean
  imageTextModel?: string
  hasImageTextKey?: boolean
}

const showSystem = ref(false)
const moduleNotice = ref('')
const moduleError = ref('')
const moduleBusy = ref('')
const aiInstalled = computed(() => isModuleInstalled('ai'))

const aiSettingsOpen = ref(false)

function openAiSettings(): void {
  aiSettingsOpen.value = true
}

function moduleKeyOf(item: AppLink): OptionalModuleKey {
  return item.key as OptionalModuleKey
}

function sayModule(text: string): void {
  moduleNotice.value = text
  window.setTimeout(() => { if (moduleNotice.value === text) moduleNotice.value = '' }, 3000)
}

function activateBusinessApp(item: AppLink): void {
  if (isModuleInstalled(item.key)) openApp(item)
  else void installBusiness(item)
}

async function setBusinessInstalled(item: AppLink, next: boolean): Promise<void> {
  moduleBusy.value = item.key
  moduleError.value = ''
  const result = await setModuleInstalled(moduleKeyOf(item), next)
  if (!result.ok) moduleError.value = result.error || (next ? '下载安装失败' : '卸载失败')
  else {
    sayModule(next ? `已下载安装「${item.label}」，可在功能页面打开「设置」` : `已卸载「${item.label}」，业务数据保留`)
  }
  moduleBusy.value = ''
}

function installBusiness(item: AppLink): Promise<void> {
  return setBusinessInstalled(item, true)
}

async function uninstallBusiness(item: AppLink): Promise<void> {
  if (!window.confirm(`卸载「${item.label}」？\n入口会从左侧导航和商城隐藏，业务数据保留；可随时在应用商城重新下载安装。`)) return
  await setBusinessInstalled(item, false)
}

async function toggleAiModule(next: boolean): Promise<void> {
  if (!next && !window.confirm('卸载「AI 创作」？\n助手、生图与图文带货入口会隐藏，模型配置与历史保留；可随时在应用商城重新下载安装。')) return
  moduleBusy.value = 'ai'
  moduleError.value = ''
  const result = await setModuleInstalled('ai', next)
  if (!result.ok) moduleError.value = result.error || (next ? '下载安装失败' : '卸载失败')
  else {
    sayModule(next ? '已下载安装「AI 创作」，可在 AI 页面打开「功能设置」' : '已卸载「AI 创作」，模型配置与历史保留')
  }
  moduleBusy.value = ''
}
const aiStatus = ref<{ text: AiConfigShape | null; image: AiConfigShape | null; imageText: AiConfigShape | null } | null>(null)
const aiStatusLoading = ref(false)
const aiStatusError = ref('')

function configOf(result: { ok: boolean; data?: unknown }): AiConfigShape | null {
  return result.ok ? (result.data as AiConfigShape) || null : null
}

async function loadAiStatus(): Promise<void> {
  aiStatusLoading.value = true
  aiStatusError.value = ''
  try {
    const [text, image, imageText] = await Promise.all([
      window.shopilot.ai.configGet(),
      window.shopilot.ai.imageConfigGet(),
      window.shopilot.ai.imageTextConfigGet()
    ])
    aiStatus.value = { text: configOf(text), image: configOf(image), imageText: configOf(imageText) }
  } catch (e) {
    aiStatusError.value = String((e as Error)?.message || e)
  } finally {
    aiStatusLoading.value = false
  }
}

function modelStatus(cfg: AiConfigShape | null, modelKey: keyof AiConfigShape, keyKey: keyof AiConfigShape): string {
  if (aiStatusLoading.value) return '读取模型状态…'
  if (!cfg) return '模型状态未知'
  return cfg[keyKey] ? String(cfg[modelKey] || '已配置') : '未配置密钥'
}

const textModelStatus = computed(() => modelStatus(aiStatus.value?.text ?? null, 'model', 'hasKey'))
const imageModelStatus = computed(() => modelStatus(aiStatus.value?.image ?? null, 'imageModel', 'hasImageKey'))
const graphicModelStatus = computed(() => {
  const cfg = aiStatus.value?.imageText || aiStatus.value?.text
  return modelStatus(cfg ?? null, aiStatus.value?.imageText ? 'imageTextModel' : 'model', aiStatus.value?.imageText ? 'hasImageTextKey' : 'hasKey')
})

function openApp(item: AppLink): void {
  emit('navigate', item.page)
}

onMounted(() => {
  if (props.mode === 'apps') {
    void ensureAppModulesLoaded()
    void loadAiStatus()
  }
})

/**
 * 图标着色：这些 svg 资源的描边是 #dbe7ff（为深色底准备），浅色界面直接显示几乎看不见。
 * 用 mask 把图标当形状、用 currentColor 上色，避免改动任何图标文件。
 * 值必须带引号——vite 内联 svg 时会把 " 转成 '，无引号的 url() 会因非法字符整条失效。
 */
function iconMask(url: string): Record<string, string> {
  const value = `url("${url}")`
  return { maskImage: value, webkitMaskImage: value }
}
</script>

<template>
  <section class="unified-page unified-apps-page" :data-test="`unified-${mode}-page`">
    <header class="unified-page-head">
      <div>
        <span class="dashboard-eyebrow">WORKSPACE / {{ mode === 'ai' ? 'AI STUDIO' : 'STORE' }}</span>
        <h1>{{ title }}</h1>
        <p>{{ subtitle }}</p>
      </div>
    </header>

    <template v-if="mode === 'ai'">
      <div class="ai-assistant-card">
        <div class="ai-orb" aria-hidden="true"><img :src="assistantArt" alt="" /></div>
        <div class="ai-assistant-copy" data-test="ai-assistant-copy"><span class="available-pill"><i></i>已接入</span><h2>AI 电商助手</h2><p>纯文本对话：可以讨论问题、整理思路或给出手动操作建议；不会读取或操作店铺、网页、任务与软件数据。</p></div>
        <button type="button" class="unified-button primary" @click="emit('open-assistant')"><img class="button-icon" :src="assistantOpenIcon" alt="" />打开助手</button>
      </div>
      <div class="app-card-grid">
        <article class="app-card app-card-action" @click="emit('navigate', 'image-studio')" @keydown.enter="emit('navigate', 'image-studio')" tabindex="0" role="button"><span class="app-card-icon purple"><img :src="aiAppIcon" alt="" /></span><div><h2>AI 生成商品图</h2><p>进入模型选择、对话生图和真实结果预览工作台。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
        <article class="app-card app-card-action" data-test="app-graphic-sell" @click="emit('navigate', 'graphic-sell')" @keydown.enter="emit('navigate', 'graphic-sell')" tabindex="0" role="button"><span class="app-card-icon orange"><img :src="graphicSellAppIcon" alt="" /></span><div><h2>图文带货</h2><p>填商品信息，AI 写带货文案并生成多张配图；可编辑、复制、保存。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
        <article class="app-card app-card-action" data-test="app-publish" @click="emit('navigate', 'products')" @keydown.enter="emit('navigate', 'products')" tabindex="0" role="button"><span class="app-card-icon blue"><img :src="publishAppIcon" alt="" /></span><div><h2>批量发布商品</h2><p>进入商品管理，发起发布预检与批量编排；提交仍需在店铺页面人工确认。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
        <article class="app-card app-card-action" @click="openAiSettings()" @keydown.enter="openAiSettings()" tabindex="0" role="button"><span class="app-card-icon violet"><img :src="settingsAppIcon" alt="" /></span><div><h2>AI 模型配置</h2><p>查看文本/生图服务商、模型连接与凭据状态。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
      </div>
    </template>

    <template v-else>
      <div class="apps-center">
        <p v-if="moduleNotice" class="ac-notice" role="status">{{ moduleNotice }}</p>
        <p v-if="moduleError" class="ac-notice error" role="alert">{{ moduleError }}</p>
        <AppCenterExtensions />

        <!-- AI 工具（可整体下载安装/卸载） -->
        <div class="ac-section ac-section-row">
          <h2>AI 工具</h2>
          <span class="ac-kind">增值</span>
          <span class="ac-count">3</span>
          <div class="ac-section-actions">
            <button
              type="button"
              class="ac-link"
              data-test="apps-ai-module-toggle"
              :disabled="moduleBusy === 'ai'"
              @click="toggleAiModule(!aiInstalled)"
            >{{ moduleBusy === 'ai' ? '处理中…' : aiInstalled ? '卸载 AI 创作' : '下载安装 AI 创作' }}</button>
          </div>
        </div>
        <p v-if="aiStatusError" class="ac-hint error">读取模型状态失败：{{ aiStatusError }}</p>
        <p v-if="!aiInstalled" class="ac-hint">AI 创作未安装：点右上「下载安装 AI 创作」恢复助手、生图与图文带货。</p>
        <div v-else class="ac-grid" data-test="apps-ai-grid">
          <article class="ac-card" role="button" tabindex="0" data-test="apps-ai-assistant" @click="emit('open-assistant')" @keydown.enter="emit('open-assistant')" @keydown.space.prevent="emit('open-assistant')">
            <div class="ac-top">
              <span class="ac-icon" :style="{ background: appTones.violet.bg, color: appTones.violet.fg }"><i :style="iconMask(aiAppIcon)"></i></span>
              <span class="ac-cat">对话</span>
            </div>
            <h3>AI 电商助手</h3>
            <p class="ac-desc">纯文本对话：讨论问题、整理思路、给出手动操作建议；不会读取或操作店铺与软件数据。</p>
            <div class="ac-foot">
              <span class="ac-note">{{ textModelStatus }}</span>
              <span class="ac-open">打开
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              </span>
            </div>
          </article>

          <article class="ac-card" role="button" tabindex="0" data-test="apps-ai-image" @click="emit('navigate', 'image-studio')" @keydown.enter="emit('navigate', 'image-studio')" @keydown.space.prevent="emit('navigate', 'image-studio')">
            <div class="ac-top">
              <span class="ac-icon" :style="{ background: appTones.pink.bg, color: appTones.pink.fg }"><i :style="iconMask(aiAppIcon)"></i></span>
              <span class="ac-cat">内容创作</span>
            </div>
            <h3>AI 生成商品图</h3>
            <p class="ac-desc">填商品信息、对话式生图，结果可直接预览与保存。</p>
            <div class="ac-foot">
              <span class="ac-note">{{ imageModelStatus }}</span>
              <span class="ac-open">打开
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              </span>
            </div>
          </article>

          <article class="ac-card" role="button" tabindex="0" data-test="apps-ai-graphic" @click="emit('navigate', 'graphic-sell')" @keydown.enter="emit('navigate', 'graphic-sell')" @keydown.space.prevent="emit('navigate', 'graphic-sell')">
            <div class="ac-top">
              <span class="ac-icon" :style="{ background: appTones.orange.bg, color: appTones.orange.fg }"><i :style="iconMask(graphicSellAppIcon)"></i></span>
              <span class="ac-cat">内容创作</span>
            </div>
            <h3>图文带货</h3>
            <p class="ac-desc">AI 写带货笔记文案并生成多张配图，可编辑、复制与保存。</p>
            <div class="ac-foot">
              <span class="ac-note">{{ graphicModelStatus }}</span>
              <span class="ac-open">打开
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              </span>
            </div>
          </article>
        </div>

        <!-- 业务应用：内置模块，可下载安装/卸载，业务数据保留 -->
        <div class="ac-section ac-section-row" data-test="apps-business">
          <h2>业务应用</h2>
          <span class="ac-kind">可下载/卸载</span>
          <span class="ac-count">{{ businessApps.length }}</span>
        </div>
        <p class="ac-hint">内置模块，支持下载安装与卸载；卸载后入口从导航隐藏，业务数据保留。</p>
        <div class="ac-grid" data-test="apps-business-grid">
          <article
            v-for="item in businessApps"
            :key="item.key"
            class="ac-card"
            role="button"
            tabindex="0"
            :data-test="`apps-card-${item.key}`"
            @click="activateBusinessApp(item)"
            @keydown.enter="activateBusinessApp(item)"
            @keydown.space.prevent="activateBusinessApp(item)"
          >
            <div class="ac-top">
              <span class="ac-icon" :style="{ background: appTones[item.tone].bg, color: appTones[item.tone].fg }">
                <i :style="iconMask(item.icon)"></i>
              </span>
              <span class="ac-cat" :class="{ off: !isModuleInstalled(item.key) }">{{ isModuleInstalled(item.key) ? '已安装' : '未安装' }}</span>
            </div>
            <h3>{{ item.label }}</h3>
            <p class="ac-desc">{{ item.description }}</p>
            <div class="ac-foot">
              <span class="ac-note">{{ item.note }}</span>
              <span class="ac-actions">
                <template v-if="isModuleInstalled(item.key)">
                  <button type="button" class="ac-action" @click.stop="openApp(item)">打开</button>
                  <button type="button" class="ac-action danger" :data-test="'apps-module-uninstall-' + item.key" :disabled="moduleBusy === item.key" @click.stop="uninstallBusiness(item)">卸载</button>
                </template>
                <button v-else type="button" class="ac-action primary" :data-test="'apps-module-install-' + item.key" :disabled="moduleBusy === item.key" @click.stop="installBusiness(item)">{{ moduleBusy === item.key ? '安装中…' : '下载安装' }}</button>
              </span>
            </div>
          </article>
        </div>

        <!-- 系统页面：核心底座，默认折叠，避免与左侧导航重复抢首屏 -->
        <div class="ac-section ac-section-row">
          <h2>系统页面</h2>
          <span class="ac-kind">核心</span>
          <span class="ac-count">{{ systemApps.length }}</span>
          <button type="button" class="ac-link" data-test="apps-system-toggle" :aria-expanded="showSystem" @click="showSystem = !showSystem">{{ showSystem ? '收起' : '展开' }}</button>
        </div>
        <p v-if="!showSystem" class="ac-hint">店铺、数据与设置入口；核心页面不可卸载，日常使用左侧导航更快。</p>
        <div v-if="showSystem" class="ac-grid" data-test="apps-system-grid">
          <article
            v-for="item in systemApps"
            :key="item.key"
            class="ac-card"
            role="button"
            tabindex="0"
            :data-test="`apps-card-${item.key}`"
            @click="openApp(item)"
            @keydown.enter="openApp(item)"
            @keydown.space.prevent="openApp(item)"
          >
            <div class="ac-top">
              <span class="ac-icon" :style="{ background: appTones[item.tone].bg, color: appTones[item.tone].fg }">
                <i :style="iconMask(item.icon)"></i>
              </span>
              <span class="ac-cat">核心</span>
            </div>
            <h3>{{ item.label }}</h3>
            <p class="ac-desc">{{ item.description }}</p>
            <div class="ac-foot">
              <span class="ac-note">{{ item.note }}</span>
              <span class="ac-open">打开
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              </span>
            </div>
          </article>
        </div>

      </div>
    </template>
    <SettingsModal
      v-if="mode === 'ai' && aiSettingsOpen"
      title="AI 创作 · 功能设置"
      tab="ai"
      :only-tabs="['ai']"
      @close="aiSettingsOpen = false"
    />
  </section>
</template>
<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.unified-button{min-height:34px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:2px solid rgba(151,120,255,.35);outline-offset:1px}.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}.unified-alert{display:flex;flex-direction:column;gap:5px;padding:14px 16px;margin-bottom:14px;border:1px solid rgba(76,157,255,.23);border-radius:11px;background:rgba(33,91,158,.12);color:var(--dash-text-soft);font-size:12px}.unified-alert strong{color:#1d4ed8}.unified-state,.unified-empty{display:flex;min-height:150px;align-items:center;justify-content:center;gap:12px;flex-direction:column;border:1px dashed var(--dash-border);border-radius:12px;color:var(--dash-text-muted)}.inline-link{border:0;background:transparent;color:#7c5cff;cursor:pointer}.product-store-list{display:flex;flex-direction:column;gap:10px}.product-store-card{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.product-store-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:5px}.product-store-copy span{overflow:hidden;color:var(--dash-text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.unified-status{display:flex;align-items:center;gap:5px;color:var(--dash-text-muted);font-size:10px}.unified-status i,.available-pill i{width:7px;height:7px;border-radius:50%;background:#98a2b3}.unified-status.online,.available-pill{color:#027a48}.unified-status.online i,.available-pill i{background:#12b76a}.unified-status.warning{color:#b54708}.unified-status.warning i{background:#f9f0eb}.ai-assistant-card{display:flex;align-items:center;gap:20px;padding:20px;margin-bottom:14px;border:1px solid rgba(139,92,246,.34);border-radius:15px;background:radial-gradient(circle at 15% 40%,rgba(107,70,214,.22),transparent 32%),#ecedee;box-shadow:inset 0 0 32px rgba(123,81,241,.06)}.ai-orb{position:relative;display:grid;width:68px;height:68px;flex:0 0 auto;place-items:center;border:1px solid rgba(167,134,255,.7);border-radius:50%;background:radial-gradient(circle at 50% 42%,#eff0f4,#ecedef 70%);box-shadow:0 0 28px rgba(135,90,255,.35)}.ai-orb img{width:68px;height:68px;object-fit:contain;position:relative;z-index:1}.ai-orb:before{content:'';position:absolute;width:28px;height:17px;border-radius:50%;background:#ebeced;box-shadow:0 0 0 4px rgba(93,179,255,.13)}.ai-orb i{position:absolute;z-index:1;width:5px;height:5px;border-radius:50%;background:#43bdff}.ai-orb i:first-child{transform:translateX(-8px)}.ai-orb i:last-child{transform:translateX(8px)}.ai-assistant-copy{min-width:0;flex:1}.ai-assistant-copy h2{margin:6px 0;font-size:18px}.ai-assistant-copy p{max-width:680px;margin:0;color:var(--dash-text-muted);font-size:11px;line-height:1.6}.available-pill{display:inline-flex;align-items:center;gap:5px;font-size:10px}.app-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.app-card{display:flex;min-height:96px;align-items:center;gap:12px;padding:15px;border:1px solid var(--dash-border);border-radius:12px;background:#ecedef}.app-card-action{cursor:pointer;transition:transform .15s,border-color .15s,background .15s}.app-card-action:hover,.app-card-action:focus-visible{transform:translateY(-1px);border-color:var(--dash-border-strong);background:#edeef0;outline:2px solid rgba(151,120,255,.3);outline-offset:1px}.app-card>div{min-width:0;flex:1}.app-card h2{margin:0 0 5px;font-size:13px}.app-card p{margin:0;color:var(--dash-text-muted);font-size:10px;line-height:1.5}.app-card-icon{display:grid;width:38px;height:38px;flex:0 0 auto;place-items:center;border-radius:10px;background:rgba(117,92,242,.16);color:#5b3df5;font-size:18px}.app-card-icon img{width:22px;height:22px;object-fit:contain}.app-card-icon.purple,.app-card-icon.violet{background:rgba(128,87,245,.2);color:#5b3df5}.app-card-icon.blue{background:rgba(54,140,255,.18);color:#1d4ed8}.app-card-icon.cyan{background:rgba(29,187,240,.16);color:#1d4ed8}.app-card-icon.teal{background:rgba(21,193,168,.16);color:#027a48}.app-card-icon.orange{background:rgba(247,144,76,.16);color:#b54708}.unavailable-pill{flex:0 0 auto;padding:4px 7px;border:1px solid rgba(242,165,87,.18);border-radius:6px;color:#b54708;font-size:9px}.app-card-arrow{display:grid;place-items:center;margin-left:auto;color:#9d8ae2}.app-card-arrow img{width:17px;height:17px;object-fit:contain}.loader{width:18px;height:18px;border:2px solid rgba(163,143,255,.2);border-top-color:#7c5cff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:880px){.unified-page{padding:16px}.app-card-grid{grid-template-columns:1fr}.product-store-card{flex-wrap:wrap}.product-store-copy{min-width:calc(100% - 60px)}}
/* 应用商城（2026-11-09 重构）：插件 + AI 工具 + 折叠的系统页面 */
.apps-center{display:flex;flex-direction:column;min-width:0;gap:14px}
.ac-section{display:flex;align-items:center;gap:8px;margin:0}
.ac-section h2{margin:0;font-size:var(--text-14);font-weight:var(--weight-semibold)}
.ac-count{display:grid;place-items:center;min-width:20px;height:18px;padding:0 6px;border-radius:var(--r-xs);background:var(--ui-surface-sunken);color:var(--ui-text-muted);font-size:var(--text-11);font-weight:var(--weight-medium);font-variant-numeric:tabular-nums}
.ac-kind{padding:1px 7px;border-radius:999px;background:var(--ui-surface-sunken);color:var(--ui-text-muted);font-size:var(--text-11);font-weight:var(--weight-medium);line-height:17px}
.ac-link{margin-left:auto;padding:0;border:0;background:transparent;color:var(--brand-text);font-size:var(--text-12);font-weight:var(--weight-medium);cursor:pointer}
.ac-link:hover{text-decoration:underline}
.ac-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--sp-3);align-items:start}
.ac-card{display:flex;flex-direction:column;min-width:0;padding:var(--sp-4);border:1px solid var(--ui-border);border-radius:var(--r-lg);background:var(--ui-surface);cursor:pointer;box-shadow:var(--e1);transition:border-color .16s,box-shadow .16s,transform .16s}
.ac-card:hover{border-color:var(--brand-border);box-shadow:var(--e2);transform:translateY(-1px)}
.ac-card:active{transform:none}
.ac-card:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.ac-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px}
.ac-icon{display:grid;place-items:center;width:38px;height:38px;flex:0 0 auto;border-radius:var(--r-md)}
.ac-icon i{display:block;width:19px;height:19px;background:currentColor;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:contain;mask-size:contain}
.ac-cat{display:inline-block;flex:0 0 auto;max-width:52%;overflow:hidden;padding:0 6px;border:1px solid var(--ui-border);border-radius:var(--r-xs);background:var(--ui-surface-sunken);color:var(--ui-text-muted);font-size:var(--text-11);font-weight:var(--weight-medium);line-height:17px;text-overflow:ellipsis;white-space:nowrap}
.ac-card h3{margin:0 0 4px;font-size:var(--text-14);font-weight:var(--weight-semibold);letter-spacing:-.015em;color:var(--ui-text)}
.ac-desc{display:-webkit-box;margin:0 0 10px;overflow:hidden;color:var(--ui-text-muted);font-size:var(--text-12);line-height:var(--leading-snug);-webkit-box-orient:vertical;-webkit-line-clamp:2}
.ac-foot{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:var(--sp-2);border-top:1px solid var(--ui-border);color:var(--ui-text-muted);font-size:var(--text-11)}
.ac-note{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-open{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;margin-left:auto;color:var(--brand-text);font-weight:var(--weight-medium)}
.ac-open svg{width:11px;height:11px}
.ac-section-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
.ac-section-actions .ac-link{margin-left:0}
.ac-actions{display:inline-flex;align-items:center;gap:8px;margin-left:auto}
.ac-action{padding:0;border:0;background:transparent;color:var(--brand-text);font-size:var(--text-11);font-weight:var(--weight-medium);cursor:pointer}
.ac-action:hover:not(:disabled){text-decoration:underline}
.ac-action.danger{color:var(--danger-text)}
.ac-action.primary{padding:2px 8px;border:1px solid var(--brand);border-radius:var(--r-xs);background:var(--brand);color:#fff}
.ac-action:disabled{opacity:.55;cursor:not-allowed}
.ac-notice{margin:0;padding:8px 10px;border-radius:var(--r-sm);background:var(--success-soft);color:var(--success-text);font-size:var(--text-11)}
.ac-notice.error{background:rgba(217,45,32,.08);color:var(--danger-text)}
.ac-cat.off{color:var(--danger-text);border-color:rgba(217,45,32,.25);background:rgba(217,45,32,.06)}
.ac-hint{margin:0;color:var(--ui-text-muted);font-size:var(--text-11)}
.ac-hint.error{color:var(--danger-text)}
@media(max-width:1180px){.ac-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:860px){.ac-grid{grid-template-columns:1fr}}
</style>
