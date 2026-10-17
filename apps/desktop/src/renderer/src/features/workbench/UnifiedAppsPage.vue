<script setup lang="ts">
/**
 * 应用中心 / AI 创作（v4 重设计 R1，2026-10-15）。
 *
 * 原 products 分支已拆分到 `features/products/ProductManagementPage.vue`
 * （查询与列表重构 + 三 Tab + 抽屉；发布/编辑等能力整体随迁，不回退）。
 * 本文件只剩 AI 创作与应用中心两个静态视图。
 */
import { computed } from 'vue'
import aiAppIcon from '../../assets/icons/nav-ai.svg'
import publishAppIcon from '../../assets/icons/app-orders.svg'
import videoAppIcon from '../../assets/icons/app-tasks.svg'
import mediaAppIcon from '../../assets/icons/app-invoices.svg'
import settingsAppIcon from '../../assets/icons/nav-settings.svg'
import storesAppIcon from '../../assets/icons/app-stores.svg'
import analyticsAppIcon from '../../assets/icons/app-analytics.svg'
import ordersAppIcon from '../../assets/icons/app-orders.svg'
import invoicesAppIcon from '../../assets/icons/app-invoices.svg'
import tasksAppIcon from '../../assets/icons/app-tasks.svg'
import forwardIcon from '../../assets/generated/ui-icons/forward-gen.png'
import assistantArt from '../../assets/generated/ai-assistant-generated.png'
import assistantOpenIcon from '../../assets/generated/ui-icons/assistant-open-gen.png'

type Mode = 'ai' | 'apps'
type Page = 'stores' | 'analytics' | 'orders' | 'invoices' | 'tasks' | 'settings' | 'image-studio' | 'products'
const props = defineProps<{ mode: Mode }>()
const emit = defineEmits<{
  navigate: [page: Page]
  'open-assistant': []
}>()
const title = computed(() => props.mode === 'ai' ? 'AI 创作工具' : '应用中心')
const subtitle = computed(() => props.mode === 'ai' ? '访问当前已接入的 AI 助手、模型配置与任务能力。' : '从同一工作区进入店铺、数据、任务和设置页面。')
const appLinks: Array<{ key: string; label: string; description: string; icon: string; tone: string; page: Page }> = [
  { key: 'stores', label: '店铺管理', description: '管理店铺、平台、登录状态和本机浏览器工作区。', icon: storesAppIcon, tone: 'blue', page: 'stores' },
  { key: 'analytics', label: '数据分析', description: '查看真实快照、经营指标和数据采集入口。', icon: analyticsAppIcon, tone: 'purple', page: 'analytics' },
  { key: 'orders', label: '订单管理', description: '查看已经采集的订单快照和平台支持状态。', icon: ordersAppIcon, tone: 'cyan', page: 'orders' },
  { key: 'invoices', label: '发票中心', description: '汇总真实待开票记录，并导出 CSV。', icon: invoicesAppIcon, tone: 'orange', page: 'invoices' },
  { key: 'tasks', label: 'AI 任务中心', description: '管理 TaskRunner 任务、运行、确认和进度。', icon: tasksAppIcon, tone: 'teal', page: 'tasks' },
  { key: 'settings', label: '设置中心', description: '平台地址、AI 配置、应用锁、数据维护与软件更新。', icon: settingsAppIcon, tone: 'violet', page: 'settings' }
]
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
        <article class="app-card app-card-action" data-test="app-publish" @click="emit('navigate', 'products')" @keydown.enter="emit('navigate', 'products')" tabindex="0" role="button"><span class="app-card-icon blue"><img :src="publishAppIcon" alt="" /></span><div><h2>批量发布商品</h2><p>进入商品管理，发起发布预检与批量编排；提交仍需在店铺页面人工确认。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
        <article class="app-card"><span class="app-card-icon teal"><img :src="videoAppIcon" alt="" /></span><div><h2>短视频去重</h2><p>当前项目没有对应的媒体处理模块。</p></div><span class="unavailable-pill">暂不可用</span></article>
        <article class="app-card"><span class="app-card-icon orange"><img :src="mediaAppIcon" alt="" /></span><div><h2>影像级干扰</h2><p>当前项目没有对应的影像处理模块。</p></div><span class="unavailable-pill">暂不可用</span></article>
        <article class="app-card app-card-action" @click="emit('navigate', 'settings')" @keydown.enter="emit('navigate', 'settings')" tabindex="0" role="button"><span class="app-card-icon violet"><img :src="settingsAppIcon" alt="" /></span><div><h2>AI 模型配置</h2><p>查看文本/生图服务商、模型连接与凭据状态。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
        <article class="app-card app-card-action" @click="emit('navigate', 'tasks')" @keydown.enter="emit('navigate', 'tasks')" tabindex="0" role="button"><span class="app-card-icon cyan"><img :src="tasksAppIcon" alt="" /></span><div><h2>AI 任务中心</h2><p>查看 TaskRunner 中真实任务与运行状态。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
      </div>
    </template>

    <template v-else>
      <div class="app-card-grid">
        <article v-for="item in appLinks" :key="item.key" class="app-card app-card-action" tabindex="0" role="button" @click="emit('navigate', item.page)" @keydown.enter="emit('navigate', item.page)">
          <span class="app-card-icon" :class="item.tone"><img :src="item.icon" alt="" /></span><div><h2>{{ item.label }}</h2><p>{{ item.description }}</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span>
        </article>
      </div>
    </template>
  </section>
</template>
<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.unified-button{min-height:34px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:2px solid rgba(151,120,255,.35);outline-offset:1px}.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}.unified-alert{display:flex;flex-direction:column;gap:5px;padding:14px 16px;margin-bottom:14px;border:1px solid rgba(76,157,255,.23);border-radius:11px;background:rgba(33,91,158,.12);color:var(--dash-text-soft);font-size:12px}.unified-alert strong{color:#1d4ed8}.unified-state,.unified-empty{display:flex;min-height:150px;align-items:center;justify-content:center;gap:12px;flex-direction:column;border:1px dashed var(--dash-border);border-radius:12px;color:var(--dash-text-muted)}.inline-link{border:0;background:transparent;color:#7c5cff;cursor:pointer}.product-store-list{display:flex;flex-direction:column;gap:10px}.product-store-card{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.product-store-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:5px}.product-store-copy span{overflow:hidden;color:var(--dash-text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.unified-status{display:flex;align-items:center;gap:5px;color:var(--dash-text-muted);font-size:10px}.unified-status i,.available-pill i{width:7px;height:7px;border-radius:50%;background:#98a2b3}.unified-status.online,.available-pill{color:#027a48}.unified-status.online i,.available-pill i{background:#12b76a}.unified-status.warning{color:#b54708}.unified-status.warning i{background:#f9f0eb}.ai-assistant-card{display:flex;align-items:center;gap:20px;padding:20px;margin-bottom:14px;border:1px solid rgba(139,92,246,.34);border-radius:15px;background:radial-gradient(circle at 15% 40%,rgba(107,70,214,.22),transparent 32%),#ecedee;box-shadow:inset 0 0 32px rgba(123,81,241,.06)}.ai-orb{position:relative;display:grid;width:68px;height:68px;flex:0 0 auto;place-items:center;border:1px solid rgba(167,134,255,.7);border-radius:50%;background:radial-gradient(circle at 50% 42%,#eff0f4,#ecedef 70%);box-shadow:0 0 28px rgba(135,90,255,.35)}.ai-orb img{width:68px;height:68px;object-fit:contain;position:relative;z-index:1}.ai-orb:before{content:'';position:absolute;width:28px;height:17px;border-radius:50%;background:#ebeced;box-shadow:0 0 0 4px rgba(93,179,255,.13)}.ai-orb i{position:absolute;z-index:1;width:5px;height:5px;border-radius:50%;background:#43bdff}.ai-orb i:first-child{transform:translateX(-8px)}.ai-orb i:last-child{transform:translateX(8px)}.ai-assistant-copy{min-width:0;flex:1}.ai-assistant-copy h2{margin:6px 0;font-size:18px}.ai-assistant-copy p{max-width:680px;margin:0;color:var(--dash-text-muted);font-size:11px;line-height:1.6}.available-pill{display:inline-flex;align-items:center;gap:5px;font-size:10px}.app-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.app-card{display:flex;min-height:96px;align-items:center;gap:12px;padding:15px;border:1px solid var(--dash-border);border-radius:12px;background:#ecedef}.app-card-action{cursor:pointer;transition:transform .15s,border-color .15s,background .15s}.app-card-action:hover,.app-card-action:focus-visible{transform:translateY(-1px);border-color:var(--dash-border-strong);background:#edeef0;outline:2px solid rgba(151,120,255,.3);outline-offset:1px}.app-card>div{min-width:0;flex:1}.app-card h2{margin:0 0 5px;font-size:13px}.app-card p{margin:0;color:var(--dash-text-muted);font-size:10px;line-height:1.5}.app-card-icon{display:grid;width:38px;height:38px;flex:0 0 auto;place-items:center;border-radius:10px;background:rgba(117,92,242,.16);color:#5b3df5;font-size:18px}.app-card-icon img{width:22px;height:22px;object-fit:contain}.app-card-icon.purple,.app-card-icon.violet{background:rgba(128,87,245,.2);color:#5b3df5}.app-card-icon.blue{background:rgba(54,140,255,.18);color:#1d4ed8}.app-card-icon.cyan{background:rgba(29,187,240,.16);color:#1d4ed8}.app-card-icon.teal{background:rgba(21,193,168,.16);color:#027a48}.app-card-icon.orange{background:rgba(247,144,76,.16);color:#b54708}.unavailable-pill{flex:0 0 auto;padding:4px 7px;border:1px solid rgba(242,165,87,.18);border-radius:6px;color:#b54708;font-size:9px}.app-card-arrow{display:grid;place-items:center;margin-left:auto;color:#9d8ae2}.app-card-arrow img{width:17px;height:17px;object-fit:contain}.loader{width:18px;height:18px;border:2px solid rgba(163,143,255,.2);border-top-color:#7c5cff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:880px){.unified-page{padding:16px}.app-card-grid{grid-template-columns:1fr}.product-store-card{flex-wrap:wrap}.product-store-copy{min-width:calc(100% - 60px)}}
</style>
