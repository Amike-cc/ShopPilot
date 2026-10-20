<script setup lang="ts">
/**
 * 应用中心 / AI 创作（v4 重设计 R1，2026-10-15）。
 *
 * 原 products 分支已拆分到 `features/products/ProductManagementPage.vue`
 * （查询与列表重构 + 三 Tab + 抽屉；发布/编辑等能力整体随迁，不回退）。
 * 本文件只剩 AI 创作与应用中心两个静态视图。
 */
import { computed, ref } from 'vue'
import aiAppIcon from '../../assets/icons/nav-ai.svg'
import publishAppIcon from '../../assets/icons/nav-products.svg'
import settingsAppIcon from '../../assets/icons/nav-settings.svg'
import productsAppIcon from '../../assets/icons/nav-products.svg'
import storesAppIcon from '../../assets/icons/app-stores.svg'
import analyticsAppIcon from '../../assets/icons/app-analytics.svg'
import invoicesAppIcon from '../../assets/icons/app-invoices.svg'
import taxAppIcon from '../../assets/icons/app-tax.svg'
import inviteAppIcon from '../../assets/icons/invite-creator.svg'
import graphicSellAppIcon from '../../assets/icons/settings-square.svg'
import forwardIcon from '../../assets/generated/ui-icons/forward-gen.png'
import assistantArt from '../../assets/generated/ai-assistant-generated.png'
import assistantOpenIcon from '../../assets/generated/ui-icons/assistant-open-gen.png'

type Mode = 'ai' | 'apps'
type Page = 'stores' | 'analytics' | 'invoices' | 'tax' | 'settings' | 'image-studio' | 'graphic-sell' | 'products' | 'creator-invite'
type AppCat = 'store' | 'insight' | 'create' | 'tool'
type AppCatKey = 'all' | AppCat
type AppTone = 'violet' | 'blue' | 'cyan' | 'orange' | 'indigo' | 'green' | 'pink' | 'slate' | 'amber'

interface AppLink {
  key: string
  label: string
  description: string
  /** 卡底只写能力要点，不冒充实时状态或统计数据 */
  note: string
  cat: AppCat
  catLabel: string
  tone: AppTone
  icon: string
  /** 目标页面；entry 为 open-invite 时可省略（不是独立页面） */
  page?: Page
  /** 非独立页面的入口：交给外层决定跳到哪（如打开当前店铺的达人邀约面板） */
  entry?: 'open-invite'
}

const props = defineProps<{ mode: Mode }>()
const emit = defineEmits<{
  navigate: [page: Page]
  'open-assistant': []
  'open-invite': []
}>()
const title = computed(() => props.mode === 'ai' ? 'AI 创作工具' : '应用中心')
const subtitle = computed(() => props.mode === 'ai' ? '访问当前已接入的 AI 助手与模型配置。' : '从同一工作区进入店铺、数据与系统工具；支持搜索、分类筛选与网格 / 列表切换。')

/** 图标底色：资源本身是浅色描边（为深色底准备），这里用 mask 着色，不改动图标文件 */
const appTones: Record<AppTone, { bg: string; fg: string }> = {
  violet: { bg: 'linear-gradient(150deg,#F1EBFF,#DFD3FF)', fg: '#6141E8' },
  blue: { bg: 'linear-gradient(150deg,#EAF2FF,#D4E4FF)', fg: '#1D6FE8' },
  cyan: { bg: 'linear-gradient(150deg,#E4F7FE,#C9EBFA)', fg: '#0A8FBF' },
  orange: { bg: 'linear-gradient(150deg,#FFF2E5,#FFE1C6)', fg: '#CE6D0C' },
  indigo: { bg: 'linear-gradient(150deg,#EAECFF,#D7DBFF)', fg: '#4453D6' },
  green: { bg: 'linear-gradient(150deg,#E6F9F0,#CCEFDE)', fg: '#0C9A6A' },
  pink: { bg: 'linear-gradient(150deg,#FFEBF5,#FFD5E8)', fg: '#CE2F85' },
  slate: { bg: 'linear-gradient(150deg,#F0F3F9,#E1E7F1)', fg: '#5A6478' },
  amber: { bg: 'linear-gradient(150deg,#FFF7E8,#FFE6BC)', fg: '#B26A00' }
}

const appCategories: Array<{ key: AppCatKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'store', label: '店铺运营' },
  { key: 'insight', label: '数据洞察' },
  { key: 'create', label: '内容创作' },
  { key: 'tool', label: '系统工具' }
]

/** 只列真实存在的页面；没有的模块一律不摆卡片，避免点进去是空壳 */
const appLinks: AppLink[] = [
  { key: 'stores', label: '店铺管理', description: '管理店铺、平台与登录状态，托管本机浏览器工作区。', note: '平台登录 · 浏览器工作区', cat: 'store', catLabel: '店铺运营', tone: 'blue', icon: storesAppIcon, page: 'stores' },
  { key: 'invite', label: '达人邀约', description: '按店铺查看邀约批次、逐人记录与停止原因；配置与发送沿用平台实测流程。', note: '批次 · 逐人记录 · 停止原因', cat: 'store', catLabel: '店铺运营', tone: 'amber', icon: inviteAppIcon, page: 'creator-invite' },
  { key: 'products', label: '商品管理', description: '查询、编辑与批量发布预检，支持草稿、回收站与 CSV。', note: '批量发布 · 回收站', cat: 'store', catLabel: '店铺运营', tone: 'green', icon: productsAppIcon, page: 'products' },
  { key: 'analytics', label: '数据分析', description: '查看真实快照、经营指标与数据采集入口。', note: '真实快照 · 采集口径', cat: 'insight', catLabel: '数据洞察', tone: 'violet', icon: analyticsAppIcon, page: 'analytics' },
  { key: 'invoices', label: '发票中心', description: '汇总待开票记录并导出 CSV，按主体与店铺核对。', note: '待开票 · CSV 导出', cat: 'insight', catLabel: '数据洞察', tone: 'orange', icon: invoicesAppIcon, page: 'invoices' },
  { key: 'tax', label: '涉税信息', description: '查看平台按季度报送的涉税经营数据与主体汇总。', note: '季度报送 · 只读核对', cat: 'insight', catLabel: '数据洞察', tone: 'green', icon: taxAppIcon, page: 'tax' },
  { key: 'image-studio', label: 'AI 生成商品图', description: '模型选择、对话式生图与真实结果预览。', note: '模型选择 · 结果预览', cat: 'create', catLabel: '内容创作', tone: 'pink', icon: aiAppIcon, page: 'image-studio' },
  { key: 'graphic-sell', label: '图文带货', description: '填商品信息，AI 生成带货笔记文案与多张配图，可编辑、复制与保存。', note: '带货文案 · 多图配图 · 历史', cat: 'create', catLabel: '内容创作', tone: 'orange', icon: graphicSellAppIcon, page: 'graphic-sell' },
  { key: 'settings', label: '设置中心', description: '平台地址、AI 配置、应用锁与数据维护。', note: '地址 · AI · 应用锁', cat: 'tool', catLabel: '系统工具', tone: 'slate', icon: settingsAppIcon, page: 'settings' }
]

const appsQuery = ref('')
const appsCat = ref<AppCatKey>('all')
const appsView = ref<'grid' | 'list'>('grid')

const appsVisible = computed(() => {
  const keyword = appsQuery.value.trim().toLowerCase()
  return appLinks.filter((item) => {
    if (appsCat.value !== 'all' && item.cat !== appsCat.value) return false
    if (!keyword) return true
    return `${item.label} ${item.description} ${item.note} ${item.catLabel}`.toLowerCase().includes(keyword)
  })
})

const appCounts = computed<Record<AppCatKey, number>>(() => {
  const counts: Record<AppCatKey, number> = { all: appLinks.length, store: 0, insight: 0, create: 0, tool: 0 }
  for (const item of appLinks) counts[item.cat] += 1
  return counts
})

const appsCatLabel = computed(() => appCategories.find((cat) => cat.key === appsCat.value)?.label ?? '全部')

/** 卡片点击：独立页面直接跳；达人邀约需要当前店铺上下文，交给外层处理 */
function openApp(item: AppLink): void {
  if (item.entry === 'open-invite') {
    emit('open-invite')
    return
  }
  if (item.page) emit('navigate', item.page)
}

function resetAppsFilter(): void {
  appsQuery.value = ''
  appsCat.value = 'all'
}

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
        <span class="dashboard-eyebrow">WORKSPACE / {{ mode === 'ai' ? 'AI STUDIO' : 'APPS' }}</span>
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
        <article class="app-card app-card-action" @click="emit('navigate', 'settings')" @keydown.enter="emit('navigate', 'settings')" tabindex="0" role="button"><span class="app-card-icon violet"><img :src="settingsAppIcon" alt="" /></span><div><h2>AI 模型配置</h2><p>查看文本/生图服务商、模型连接与凭据状态。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
      </div>
    </template>

    <template v-else>
      <div class="apps-center">
        <!-- 搜索 / 分类 / 视图 -->
        <div class="ac-toolbar">
          <label class="ac-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
            <input
              v-model="appsQuery"
              data-test="apps-search"
              type="text"
              placeholder="搜索应用名称或功能…"
              aria-label="搜索应用"
              @keydown.esc="appsQuery = ''"
            />
            <button v-if="appsQuery" type="button" class="ac-search-clear" aria-label="清空搜索" @click="appsQuery = ''">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </label>

          <div class="ac-chips" role="group" aria-label="应用分类筛选">
            <button
              v-for="cat in appCategories"
              :key="cat.key"
              type="button"
              class="ac-chip"
              :class="{ on: appsCat === cat.key }"
              :aria-pressed="appsCat === cat.key"
              :data-test="`apps-filter-${cat.key}`"
              @click="appsCat = cat.key"
            >
              {{ cat.label }}<span>{{ appCounts[cat.key] }}</span>
            </button>
          </div>

          <div class="ac-views" role="group" aria-label="视图切换">
            <button type="button" class="ac-view" :class="{ on: appsView === 'grid' }" aria-label="网格视图" data-test="apps-view-grid" @click="appsView = 'grid'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></svg>
            </button>
            <button type="button" class="ac-view" :class="{ on: appsView === 'list' }" aria-label="列表视图" data-test="apps-view-list" @click="appsView = 'list'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            </button>
          </div>
        </div>

        <!-- 推荐位 -->
        <div class="ac-hero">
          <img class="ac-hero-art" :src="assistantArt" alt="" />
          <div class="ac-hero-copy">
            <span class="ac-hero-pill"><i></i>已接入</span>
            <h2>AI 电商助手 · 纯文本对话</h2>
            <p>可以讨论问题、整理思路或给出手动操作建议；不会读取或操作店铺、网页、任务与软件数据，所有操作仍需人工确认。</p>
          </div>
          <button type="button" class="unified-button primary" data-test="apps-open-assistant" @click="emit('open-assistant')">打开助手</button>
        </div>

        <!-- 分组头 -->
        <div class="ac-section">
          <h2>{{ appsCat === 'all' ? '全部应用' : appsCatLabel }}</h2>
          <span class="ac-count" data-test="apps-count">{{ appsVisible.length }}</span>
        </div>

        <!-- 应用网格 -->
        <div class="ac-grid" :class="{ 'is-list': appsView === 'list' }">
          <article
            v-for="item in appsVisible"
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
              <span class="ac-cat">{{ item.catLabel }}</span>
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

          <div v-if="appsVisible.length === 0" class="ac-empty" data-test="apps-empty">
            <span class="ac-empty-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
            </span>
            <h3>没有匹配的应用</h3>
            <p>换个关键词，或清除分类筛选再试一次。</p>
            <button type="button" class="unified-button" data-test="apps-reset" @click="resetAppsFilter">清除筛选</button>
          </div>
        </div>

        <div class="ac-strip">
          已显示 <b>{{ appsVisible.length }}</b> / {{ appLinks.length }} 个应用<template v-if="appsQuery.trim()"> · 搜索「{{ appsQuery.trim() }}」</template><template v-else-if="appsCat !== 'all'"> · 分类「{{ appsCatLabel }}」</template>
        </div>
      </div>
    </template>
  </section>
</template>
<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.unified-button{min-height:34px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:2px solid rgba(151,120,255,.35);outline-offset:1px}.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}.unified-alert{display:flex;flex-direction:column;gap:5px;padding:14px 16px;margin-bottom:14px;border:1px solid rgba(76,157,255,.23);border-radius:11px;background:rgba(33,91,158,.12);color:var(--dash-text-soft);font-size:12px}.unified-alert strong{color:#1d4ed8}.unified-state,.unified-empty{display:flex;min-height:150px;align-items:center;justify-content:center;gap:12px;flex-direction:column;border:1px dashed var(--dash-border);border-radius:12px;color:var(--dash-text-muted)}.inline-link{border:0;background:transparent;color:#7c5cff;cursor:pointer}.product-store-list{display:flex;flex-direction:column;gap:10px}.product-store-card{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.product-store-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:5px}.product-store-copy span{overflow:hidden;color:var(--dash-text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.unified-status{display:flex;align-items:center;gap:5px;color:var(--dash-text-muted);font-size:10px}.unified-status i,.available-pill i{width:7px;height:7px;border-radius:50%;background:#98a2b3}.unified-status.online,.available-pill{color:#027a48}.unified-status.online i,.available-pill i{background:#12b76a}.unified-status.warning{color:#b54708}.unified-status.warning i{background:#f9f0eb}.ai-assistant-card{display:flex;align-items:center;gap:20px;padding:20px;margin-bottom:14px;border:1px solid rgba(139,92,246,.34);border-radius:15px;background:radial-gradient(circle at 15% 40%,rgba(107,70,214,.22),transparent 32%),#ecedee;box-shadow:inset 0 0 32px rgba(123,81,241,.06)}.ai-orb{position:relative;display:grid;width:68px;height:68px;flex:0 0 auto;place-items:center;border:1px solid rgba(167,134,255,.7);border-radius:50%;background:radial-gradient(circle at 50% 42%,#eff0f4,#ecedef 70%);box-shadow:0 0 28px rgba(135,90,255,.35)}.ai-orb img{width:68px;height:68px;object-fit:contain;position:relative;z-index:1}.ai-orb:before{content:'';position:absolute;width:28px;height:17px;border-radius:50%;background:#ebeced;box-shadow:0 0 0 4px rgba(93,179,255,.13)}.ai-orb i{position:absolute;z-index:1;width:5px;height:5px;border-radius:50%;background:#43bdff}.ai-orb i:first-child{transform:translateX(-8px)}.ai-orb i:last-child{transform:translateX(8px)}.ai-assistant-copy{min-width:0;flex:1}.ai-assistant-copy h2{margin:6px 0;font-size:18px}.ai-assistant-copy p{max-width:680px;margin:0;color:var(--dash-text-muted);font-size:11px;line-height:1.6}.available-pill{display:inline-flex;align-items:center;gap:5px;font-size:10px}.app-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.app-card{display:flex;min-height:96px;align-items:center;gap:12px;padding:15px;border:1px solid var(--dash-border);border-radius:12px;background:#ecedef}.app-card-action{cursor:pointer;transition:transform .15s,border-color .15s,background .15s}.app-card-action:hover,.app-card-action:focus-visible{transform:translateY(-1px);border-color:var(--dash-border-strong);background:#edeef0;outline:2px solid rgba(151,120,255,.3);outline-offset:1px}.app-card>div{min-width:0;flex:1}.app-card h2{margin:0 0 5px;font-size:13px}.app-card p{margin:0;color:var(--dash-text-muted);font-size:10px;line-height:1.5}.app-card-icon{display:grid;width:38px;height:38px;flex:0 0 auto;place-items:center;border-radius:10px;background:rgba(117,92,242,.16);color:#5b3df5;font-size:18px}.app-card-icon img{width:22px;height:22px;object-fit:contain}.app-card-icon.purple,.app-card-icon.violet{background:rgba(128,87,245,.2);color:#5b3df5}.app-card-icon.blue{background:rgba(54,140,255,.18);color:#1d4ed8}.app-card-icon.cyan{background:rgba(29,187,240,.16);color:#1d4ed8}.app-card-icon.teal{background:rgba(21,193,168,.16);color:#027a48}.app-card-icon.orange{background:rgba(247,144,76,.16);color:#b54708}.unavailable-pill{flex:0 0 auto;padding:4px 7px;border:1px solid rgba(242,165,87,.18);border-radius:6px;color:#b54708;font-size:9px}.app-card-arrow{display:grid;place-items:center;margin-left:auto;color:#9d8ae2}.app-card-arrow img{width:17px;height:17px;object-fit:contain}.loader{width:18px;height:18px;border:2px solid rgba(163,143,255,.2);border-top-color:#7c5cff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:880px){.unified-page{padding:16px}.app-card-grid{grid-template-columns:1fr}.product-store-card{flex-wrap:wrap}.product-store-copy{min-width:calc(100% - 60px)}}
/* ============================================================
   应用中心（2026-10-18 重设计）
   作用域：仅在 mode === 'apps' 的 .apps-center 内，类名统一 ac-*，
   不覆盖 .app-card / .unified-page / .unified-page-head，
   因此 AI 创作视图与其它页面均不受影响。
   ============================================================ */
.apps-center{display:flex;flex-direction:column;min-width:0}

/* 工具条：搜索 + 分类 + 视图 */
.ac-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.ac-search{display:flex;align-items:center;gap:8px;width:300px;height:36px;padding:0 10px;border:1px solid var(--dash-border);border-radius:9px;background:var(--dash-card);box-shadow:0 1px 2px rgba(16,24,40,.04);transition:border-color .15s,box-shadow .15s}
.ac-search:focus-within{border-color:rgba(124,92,255,.55);box-shadow:0 0 0 3px rgba(124,92,255,.13)}
.ac-search>svg{width:15px;height:15px;flex:0 0 auto;color:var(--dash-text-muted)}
.ac-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--dash-text);font:inherit;font-size:12px}
.ac-search input::placeholder{color:var(--dash-text-muted);opacity:.8}
.ac-search-clear{display:grid;place-items:center;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:var(--dash-border-strong);color:var(--dash-text-soft);cursor:pointer}
.ac-search-clear svg{width:8px;height:8px}
.ac-chips{display:flex;gap:6px;flex-wrap:wrap}
.ac-chip{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 11px;border:1px solid var(--dash-border);border-radius:8px;background:var(--dash-card);color:var(--dash-text-soft);font-size:11.5px;font-weight:600;cursor:pointer;transition:border-color .14s,background .14s,color .14s}
.ac-chip span{font-size:10px;font-weight:700;color:var(--dash-text-muted);font-variant-numeric:tabular-nums}
.ac-chip:hover{border-color:var(--dash-border-strong);color:var(--dash-text)}
.ac-chip.on{border-color:#6d4aff;background:#6d4aff;color:#fff;box-shadow:0 4px 12px -5px rgba(109,74,255,.7)}
.ac-chip.on span{color:rgba(255,255,255,.72)}
.ac-views{display:flex;gap:2px;margin-left:auto;padding:3px;border:1px solid var(--dash-border);border-radius:9px;background:#eef1f7}
.ac-view{display:grid;place-items:center;width:30px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dash-text-muted);cursor:pointer;transition:background .14s,color .14s}
.ac-view svg{width:14px;height:14px}
.ac-view:hover{color:var(--dash-text)}
.ac-view.on{background:#fff;color:var(--dash-purple-text);box-shadow:0 1px 3px rgba(16,24,40,.12)}

/* 推荐位：全页唯一渐变块 */
.ac-hero{position:relative;display:flex;align-items:center;gap:16px;padding:16px 20px;margin-bottom:16px;overflow:hidden;border:1px solid #e1d8ff;border-radius:14px;background:radial-gradient(120% 180% at 88% 8%,#fff 0%,transparent 46%),radial-gradient(90% 140% at 10% 92%,rgba(190,168,255,.8) 0%,transparent 55%),linear-gradient(100deg,#f4f0ff,#ece5ff 46%,#f8f5ff)}
.ac-hero-art{width:54px;height:54px;flex:0 0 auto;object-fit:contain}
.ac-hero-copy{min-width:0;flex:1}
.ac-hero-pill{display:inline-flex;align-items:center;gap:5px;height:19px;padding:0 8px;border-radius:999px;background:rgba(18,183,106,.12);color:#0b7b4b;font-size:10px;font-weight:700}
.ac-hero-pill i{width:5px;height:5px;border-radius:50%;background:var(--dash-green)}
.ac-hero-copy h2{margin:6px 0 4px;font-size:16px;font-weight:700;color:#231a4a}
.ac-hero-copy p{margin:0;max-width:620px;color:#5b5178;font-size:11.5px;line-height:1.6}
.ac-hero .unified-button{flex:0 0 auto;margin-left:auto}

/* 分组头 */
.ac-section{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.ac-section h2{margin:0;font-size:13.5px;font-weight:700}
.ac-count{display:grid;place-items:center;min-width:20px;height:18px;padding:0 6px;border-radius:6px;background:#e9eaf2;color:var(--dash-text-soft);font-size:10px;font-weight:700;font-variant-numeric:tabular-nums}

/* 卡片网格 */
.ac-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.ac-card{display:flex;flex-direction:column;min-width:0;padding:15px;border:1px solid var(--dash-border);border-radius:14px;background:var(--dash-card);cursor:pointer;box-shadow:0 1px 2px rgba(16,24,40,.03);transition:transform .16s cubic-bezier(.2,.7,.3,1),box-shadow .16s,border-color .16s}
.ac-card:hover{transform:translateY(-2px);border-color:rgba(124,92,255,.56);box-shadow:0 8px 20px -10px rgba(16,24,40,.18),0 24px 40px -28px rgba(124,92,255,.62)}
.ac-card:active{transform:translateY(-1px);box-shadow:0 2px 6px -2px rgba(16,24,40,.14)}
.ac-card:focus-visible{outline:2px solid var(--dash-purple);outline-offset:2px}
.ac-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px}
.ac-icon{display:grid;place-items:center;width:44px;height:44px;flex:0 0 auto;border:1px solid rgba(16,24,40,.05);border-radius:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.85),0 2px 6px -3px rgba(16,24,40,.2);transition:transform .16s}
.ac-card:hover .ac-icon{transform:scale(1.04)}
.ac-icon i{display:block;width:22px;height:22px;background:currentColor;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:contain;mask-size:contain}
.ac-cat{display:inline-block;flex:0 0 auto;max-width:52%;overflow:hidden;padding:0 6px;border:1px solid var(--dash-border);border-radius:5px;background:#fbfbfe;color:var(--dash-text-muted);font-size:9.5px;font-weight:600;line-height:16px;text-overflow:ellipsis;white-space:nowrap}
.ac-card h3{margin:0 0 4px;font-size:14.5px;font-weight:650;letter-spacing:-.015em;color:var(--dash-text)}
.ac-desc{display:-webkit-box;min-height:35px;margin:0 0 10px;overflow:hidden;color:var(--dash-text-muted);font-size:11.5px;line-height:1.55;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.ac-foot{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:10px;border-top:1px solid #f0f2f8;color:var(--dash-text-muted);font-size:10.5px}
.ac-note{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-open{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;margin-left:auto;color:var(--dash-purple-text);font-weight:600;opacity:0;transform:translateX(-3px);transition:opacity .16s,transform .16s}
.ac-card:hover .ac-open{opacity:1;transform:none}
.ac-open svg{width:11px;height:11px}

/* 空结果 */
.ac-empty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:56px 20px;border:1px dashed var(--dash-border-strong);border-radius:14px;background:#fcfcfe;text-align:center}
.ac-empty-icon{display:grid;place-items:center;width:52px;height:52px;margin-bottom:6px;border-radius:14px;background:#f1f2f8;color:var(--dash-text-muted)}
.ac-empty-icon svg{width:24px;height:24px}
.ac-empty h3{margin:0;font-size:13px;font-weight:650}
.ac-empty p{margin:0 0 10px;color:var(--dash-text-muted);font-size:11.5px}

/* 底部统计条 */
.ac-strip{margin-top:12px;padding-top:12px;border-top:1px solid var(--dash-border);color:var(--dash-text-muted);font-size:11px}
.ac-strip b{color:var(--dash-text);font-variant-numeric:tabular-nums}

/* 列表视图 */
.ac-grid.is-list{grid-template-columns:1fr;gap:8px}
.ac-grid.is-list .ac-card{flex-direction:row;align-items:center;gap:14px;padding:10px 16px}
.ac-grid.is-list .ac-top{display:contents}
.ac-grid.is-list .ac-icon{width:38px;height:38px;border-radius:10px}
.ac-grid.is-list .ac-icon i{width:19px;height:19px}
.ac-grid.is-list .ac-card:hover .ac-icon{transform:none}
.ac-grid.is-list .ac-cat{order:1;width:64px;max-width:64px;text-align:center;box-sizing:border-box}
.ac-grid.is-list .ac-card h3{order:2;flex:0 0 auto;width:150px;margin:0;font-size:13px}
.ac-grid.is-list .ac-desc{order:3;flex:1;min-height:0;margin:0;-webkit-line-clamp:1}
.ac-grid.is-list .ac-foot{order:4;flex:0 0 auto;width:210px;margin:0;padding:0;border:0;justify-content:flex-end}

@media(max-width:1180px){.ac-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:860px){.ac-search{width:100%}.ac-views{margin-left:0}.ac-grid{grid-template-columns:1fr}.ac-hero{flex-wrap:wrap}.ac-hero .unified-button{margin-left:0}.ac-grid.is-list .ac-cat,.ac-grid.is-list .ac-foot{display:none}.ac-grid.is-list .ac-card h3{width:auto}}
</style>
