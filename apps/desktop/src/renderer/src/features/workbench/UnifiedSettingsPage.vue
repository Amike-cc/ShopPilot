<template>
  <section class="unified-page unified-settings-page" data-test="unified-settings-page">
    <div class="settings-dialog-shell" data-test="settings-dialog">
    <header class="unified-page-head settings-hero"><div class="settings-title-block"><div class="settings-title-icon"><img :src="settingsIcon" alt="" /></div><div><span class="dashboard-eyebrow">WORKSPACE / SETTINGS</span><h1>设置中心</h1><p>集中管理平台入口、AI 服务和工作台扩展，敏感凭据只在主进程安全存储。</p><div class="settings-head-tags"><span>安全 IPC</span><span>本地加密</span><span>实时状态</span></div></div></div><div class="settings-head-actions"><div class="settings-save-state" v-if="savedMessage"><i></i>{{ savedMessage }}</div><button type="button" class="unified-button ghost btn-ghost" @click="emit('close')"><img class="button-icon" :src="settingsCloseIcon" alt="" />关闭</button></div></header>
    <div class="settings-layout"><nav class="settings-nav sub-tabs" aria-label="设置页签"><div class="settings-nav-title"><span>CONTROL PANEL</span><strong>工作台设置</strong></div><button v-for="tab in tabs" :key="tab.key" type="button" :class="{ active: activeTab === tab.key }" :aria-current="activeTab === tab.key ? 'page' : undefined" :data-test="`settings-tab-${tab.key}`" @click="selectTab(tab.key)"><img class="settings-tab-icon" :src="tab.icon" alt="" /><em :class="{ stab: ['config', 'square', 'ai', 'agents', 'about'].includes(tab.key) }">{{ tab.label }}</em><b><img :src="forwardIcon" alt="" /></b></button></nav><main class="settings-content modal">
      <section v-if="activeTab === 'config'" class="settings-section" data-test="settings-config" data-unified-test="unified-settings-config"><div class="settings-section-head"><div><h2>平台首页地址</h2><p>地址栏首页按钮使用这里的覆盖值；留空则回退到平台目录默认地址。</p></div><button type="button" class="unified-button primary" data-test="settings-save" :disabled="homeLoading || homeSaving || !homeLoaded" @click="savePlatformUrls"><img class="button-icon" :src="settingsSaveIcon" alt="" />{{ homeSaving ? '保存中…' : '保存配置' }}</button></div><div v-if="homeLoadError" class="settings-note error" role="alert">{{ homeLoadError }}<button type="button" class="settings-inline-retry" :disabled="homeLoading" @click="loadPlatformUrls">{{ homeLoading ? '读取中…' : '重试读取' }}</button></div><div v-else-if="homeLoading" class="settings-note" role="status">正在读取已保存的平台地址…</div><div v-if="homeValidationError" class="settings-note error" role="alert">{{ homeValidationError }}</div><div v-for="platform in platformDefs" :key="platform.name" class="settings-field-row" data-test="platform-home-row"><label><span class="plat-name">{{ platform.name }}</span><input v-model="homeDraft[platform.name]" :data-test="`home-url-${platform.name}`" :placeholder="platform.adminUrl" spellcheck="false" :disabled="homeLoading || !homeLoaded" /></label><button type="button" class="unified-button ghost" :disabled="homeLoading || homeSaving || !homeLoaded || !homeDraft[platform.name]" @click="homeDraft[platform.name] = ''"><img class="button-icon" :src="refreshIcon" alt="" />恢复默认</button></div><div class="settings-note">地址必须是有效的 http:// 或 https:// URL；留空时恢复平台默认地址。不联网探测可达性。</div></section>
      <section v-else-if="activeTab === 'square'" class="settings-section" data-test="settings-square" data-unified-test="unified-settings-square"><div class="settings-section-head"><div><h2>达人广场地址</h2><p>仅对已有真实流程档案的平台开放；未实测平台不会猜测页面。</p></div><button type="button" class="unified-button primary" data-test="settings-save" :disabled="squareLoading || squareSaving || !squareLoaded" @click="saveSquareUrls"><img class="button-icon" :src="settingsSaveIcon" alt="" />{{ squareSaving ? '保存中…' : '保存配置' }}</button></div><div v-if="squareLoadError" class="settings-note error" role="alert">{{ squareLoadError }}<button type="button" class="settings-inline-retry" :disabled="squareLoading" @click="loadSquareUrls">{{ squareLoading ? '读取中…' : '重试读取' }}</button></div><div v-else-if="squareLoading" class="settings-note" role="status">正在读取已保存的达人广场地址…</div><div v-if="squareValidationError" class="settings-note error" role="alert">{{ squareValidationError }}</div><div v-for="profile in inviteProfiles" :key="profile.platform" class="settings-field-row" data-test="square-url-row"><label><span class="plat-name">{{ profile.platform }}</span><input v-model="squareDraft[profile.platform]" :placeholder="profile.pageUrl" :data-test="`square-url-${profile.platform}`" spellcheck="false" :disabled="squareLoading || !squareLoaded" /></label><button type="button" class="unified-button ghost" :disabled="squareLoading || squareSaving || !squareLoaded || !squareDraft[profile.platform]" @click="squareDraft[profile.platform] = ''"><img class="button-icon" :src="refreshIcon" alt="" />恢复默认</button></div><div class="settings-note">支持平台：{{ inviteProfiles.map(item => item.platform).join('、') || '暂无' }}。地址必须是有效的 http:// 或 https:// URL。</div></section>
      <section v-else-if="activeTab === 'ai'" class="settings-section ai-settings-section" data-test="settings-ai" data-unified-test="unified-settings-ai">
        <div class="settings-section-head"><div><h2>AI 配置</h2><p>Agent 文本、商品图生成、商品图文本分析分别保存地址、模型、超时和 API Key；Key 只经主进程 safeStorage 保存，页面不回显。</p></div></div>
        <div v-if="aiLoadError" class="settings-note error ai-load-error" role="alert">{{ aiLoadError }}<button type="button" class="settings-inline-retry" :disabled="aiConfigLoading" @click="loadAi">{{ aiConfigLoading ? '读取中…' : '重试读取' }}</button></div>
        <div v-else-if="aiConfigLoading" class="settings-note ai-load-error" role="status">正在读取 AI 配置…</div>
        <div class="ai-config-summary" data-test="ai-config-summary"><div class="ai-summary-copy"><span class="settings-kicker">CONFIGURATION</span><strong>{{ configuredSummary }}</strong><p>此状态表示配置项完整度；接口可用性请查看各卡片的连接测试结果。</p></div><div class="ai-summary-statuses"><span class="ai-summary-status" :class="{ ready: aiReady }"><i></i><b>Agent 文本</b><em>{{ aiReady ? '已配置' : '待配置' }}</em></span><span class="ai-summary-status" :class="{ ready: imageReady }"><i></i><b>生图接口</b><em>{{ imageReady ? '已配置' : '待配置' }}</em></span><span class="ai-summary-status" :class="{ ready: imageTextReady }"><i></i><b>生图文本</b><em>{{ imageTextReady ? '已配置' : '待配置' }}</em></span></div></div>
        <div class="ai-config-grid">
          <section class="ai-config-card" data-test="text-ai-config">
            <div class="ai-card-head"><div><span class="settings-kicker">TEXT / AGENT</span><h3>文本 API</h3><p>Agent 与通用对话使用这套配置；商品图片页面的分析文本使用下方独立配置。</p></div><span class="ai-status" :class="{ ok: aiReady }">{{ aiReady ? '配置完整' : '待完善' }}</span></div>
            <label class="settings-field"><span>服务商</span><select v-model="aiProvider" :disabled="aiConfigLoading || !aiLoaded" @change="applyPreset"><option v-for="preset in presets" :key="preset.key" :value="preset.key">{{ preset.label }}</option><option value="__custom__">自定义</option></select></label>
            <label class="settings-field"><span>文本接口地址</span><input v-model="aiDraft.endpoint" data-test="ai-endpoint" data-unified-test="text-ai-endpoint" spellcheck="false" placeholder="https://api.example.com/v1" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <div v-if="resolvedEndpoint" class="settings-note">实际请求：<code>{{ resolvedEndpoint }}</code><br><template v-if="modelsUrl">模型列表：<code>{{ modelsUrl }}</code></template></div>
            <label class="settings-field"><span>文本模型名</span><input v-model="aiDraft.model" data-test="ai-model" data-unified-test="text-ai-model" spellcheck="false" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <label class="settings-field"><span>文本超时（毫秒）</span><input v-model.number="aiDraft.timeoutMs" type="number" min="3000" max="120000" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <label class="settings-field"><span>文本 API Key</span><input v-model="aiKey" data-test="ai-key" type="password" autocomplete="new-password" :placeholder="aiHasKey ? '已配置，留空不修改' : '粘贴文本 API Key'" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <div class="settings-actions"><button type="button" class="unified-button primary" data-test="settings-save" :disabled="aiSaving || aiConfigLoading || !aiLoaded" @click="saveAi()"><img class="button-icon" :src="settingsSaveIcon" alt="" />{{ aiSaving ? '保存中…' : '保存文本配置' }}</button><button type="button" class="unified-button ghost" data-test="ai-models-btn" :disabled="aiLoading || aiTesting || aiSaving || aiConfigLoading || !aiLoaded" @click="fetchModels"><img class="button-icon" :src="refreshGenIcon" alt="" />{{ aiLoading ? '读取中…' : '获取文本模型' }}</button><button type="button" class="unified-button ghost" data-test="ai-test" :disabled="aiTesting || aiLoading || aiSaving || aiConfigLoading || !aiLoaded" @click="testAi"><img class="button-icon" :src="settingsTestIcon" alt="" />{{ aiTesting ? '测试中…' : '测试文本接口' }}</button><button v-if="aiHasKey" type="button" class="unified-button danger" data-test="ai-key-clear" :disabled="aiSaving || aiConfigLoading || !aiLoaded" @click="clearKey"><img class="button-icon" :src="settingsKeyClearIcon" alt="" />清除文本 Key</button></div>
            <div v-if="aiMessage" class="settings-note" data-test="ai-msg" :class="{ ok: aiOk }">{{ aiMessage }}</div>
            <div v-if="aiModels.length" class="settings-field image-model-picker"><span>已读取的文本模型</span><select data-test="ai-model-pick" :value="aiDraft.model" @change="pickAiModel(($event.target as HTMLSelectElement).value)"><option value="">— 选择后填入模型名 —</option><option v-for="model in aiModels" :key="model" :value="model">{{ model }}</option></select></div>
          </section>
          <section class="ai-config-card image-ai-config-card" data-test="image-ai-config">
            <div class="ai-card-head"><div><span class="settings-kicker">IMAGE / GENERATION</span><h3>生图 API</h3><p>商品图生成和图片编辑只使用这套独立配置。</p></div><span class="ai-status" :class="{ ok: imageReady }">{{ imageReady ? '配置完整' : '待完善' }}</span></div>
            <label class="settings-field"><span>生图接口地址</span><input v-model="imageDraft.endpoint" data-test="image-ai-endpoint" spellcheck="false" placeholder="https://api.example.com/v1 或 /images/generations" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <div v-if="imageResolvedEndpoint" class="settings-note">实际生图请求：<code>{{ imageResolvedEndpoint }}</code><br><template v-if="imageModelsUrl">模型列表：<code>{{ imageModelsUrl }}</code></template></div>
            <label class="settings-field"><span>生图模型名</span><input v-model="imageDraft.model" data-test="image-ai-model" spellcheck="false" placeholder="例如 gpt-image-1、flux-1" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <label class="settings-field"><span>生图超时（毫秒）</span><input v-model.number="imageDraft.timeoutMs" type="number" min="3000" max="600000" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <label class="settings-field"><span>生图 API Key</span><input v-model="imageKey" type="password" autocomplete="new-password" :placeholder="imageHasKey ? '已配置，留空不修改' : '粘贴生图 API Key'" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <div class="settings-actions"><button type="button" class="unified-button primary" :disabled="imageSaving || aiConfigLoading || !aiLoaded" @click="saveImageAi()"><img class="button-icon" :src="settingsSaveIcon" alt="" />{{ imageSaving ? '保存中…' : '保存生图配置' }}</button><button type="button" class="unified-button ghost" :disabled="imageLoading || imageTesting || imageSaving || aiConfigLoading || !aiLoaded" @click="fetchImageModels"><img class="button-icon" :src="refreshGenIcon" alt="" />{{ imageLoading ? '读取中…' : '获取生图模型' }}</button><button type="button" class="unified-button ghost" :disabled="imageTesting || imageLoading || imageSaving || aiConfigLoading || !aiLoaded" @click="testImageAi"><img class="button-icon" :src="settingsTestImageIcon" alt="" />{{ imageTesting ? '测试中…' : '测试生图接口' }}</button><button v-if="imageHasKey" type="button" class="unified-button danger" :disabled="imageSaving || aiConfigLoading || !aiLoaded" @click="clearImageKey"><img class="button-icon" :src="settingsKeyClearIcon" alt="" />清除生图 Key</button></div>
            <div v-if="imageMessage" class="settings-note" :class="{ ok: imageOk }">{{ imageMessage }}</div>
            <div v-if="imageModels.length" class="settings-field image-model-picker"><span>已读取的生图模型</span><select :value="imageDraft.model" @change="pickImageModel(($event.target as HTMLSelectElement).value)"><option value="">— 选择后填入模型名 —</option><option v-for="model in imageModels" :key="model" :value="model">{{ model }}</option></select></div>
            <div class="settings-note">图片生成可能产生第三方费用；“测试生图接口”只读 GET /models，不会发起付费图片生成。没有真实图片返回时，工作台只显示空状态。</div>
          </section>
          <section class="ai-config-card image-text-ai-config-card" data-test="image-text-ai-config">
            <div class="ai-card-head"><div><span class="settings-kicker">IMAGE / TEXT ANALYSIS</span><h3>生图文本 API</h3><p>仅用于 AI 生成商品图片页面的商品分析和提示词整理，不会读取或修改 Agent 配置。</p></div><span class="ai-status" :class="{ ok: imageTextReady }">{{ imageTextReady ? '配置完整' : '待完善' }}</span></div>
            <div v-if="imageTextLoadError" class="settings-note error" role="alert">{{ imageTextLoadError }}<button type="button" class="settings-inline-retry" :disabled="imageTextConfigLoading" @click="loadImageTextAi">{{ imageTextConfigLoading ? '读取中…' : '重试读取' }}</button></div>
            <div v-else-if="imageTextConfigLoading" class="settings-note" role="status">正在读取分析配置…</div>
            <label class="settings-field"><span>分析文本接口地址</span><input v-model="imageTextDraft.endpoint" data-test="image-text-ai-endpoint" spellcheck="false" placeholder="https://api.example.com/v1" :disabled="imageTextConfigLoading || !imageTextLoaded" /></label>
            <div v-if="imageTextResolvedEndpoint" class="settings-note">实际请求：<code>{{ imageTextResolvedEndpoint }}</code><br><template v-if="imageTextModelsUrl">模型列表：<code>{{ imageTextModelsUrl }}</code></template></div>
            <label class="settings-field"><span>分析文本模型名</span><input v-model="imageTextDraft.model" data-test="image-text-ai-model" spellcheck="false" placeholder="例如 deepseek-chat、qwen-plus" :disabled="imageTextConfigLoading || !imageTextLoaded" /></label>
            <label class="settings-field"><span>分析文本超时（毫秒）</span><input v-model.number="imageTextDraft.timeoutMs" type="number" min="3000" max="120000" :disabled="imageTextConfigLoading || !imageTextLoaded" /></label>
            <label class="settings-field"><span>分析文本 API Key</span><input v-model="imageTextKey" type="password" autocomplete="new-password" :placeholder="imageTextHasKey ? '已配置，留空不修改' : '粘贴商品分析文本 API Key'" :disabled="imageTextConfigLoading || !imageTextLoaded" /></label>
            <div class="settings-actions"><button type="button" class="unified-button primary" :disabled="imageTextSaving || imageTextConfigLoading || !imageTextLoaded" @click="saveImageTextAi()"><img class="button-icon" :src="settingsSaveIcon" alt="" />{{ imageTextSaving ? '保存中…' : '保存生图文本配置' }}</button><button type="button" class="unified-button ghost" :disabled="imageTextLoading || imageTextTesting || imageTextSaving || imageTextConfigLoading || !imageTextLoaded" @click="fetchImageTextModels"><img class="button-icon" :src="refreshGenIcon" alt="" />{{ imageTextLoading ? '读取中…' : '获取分析模型' }}</button><button type="button" class="unified-button ghost" :disabled="imageTextTesting || imageTextLoading || imageTextSaving || imageTextConfigLoading || !imageTextLoaded" @click="testImageTextAi"><img class="button-icon" :src="settingsTestIcon" alt="" />{{ imageTextTesting ? '测试中…' : '测试分析接口' }}</button><button v-if="imageTextHasKey" type="button" class="unified-button danger" :disabled="imageTextSaving || imageTextConfigLoading || !imageTextLoaded" @click="clearImageTextKey"><img class="button-icon" :src="settingsKeyClearIcon" alt="" />清除分析 Key</button></div>
            <div v-if="imageTextMessage" class="settings-note" :class="{ ok: imageTextOk }">{{ imageTextMessage }}</div>
            <div v-if="imageTextModels.length" class="settings-field image-model-picker"><span>已读取的分析模型</span><select :value="imageTextDraft.model" @change="pickImageTextModel(($event.target as HTMLSelectElement).value)"><option value="">— 选择后填入模型名 —</option><option v-for="model in imageTextModels" :key="model" :value="model">{{ model }}</option></select></div>
            <div class="settings-note">此配置只负责整理卖点、场景和图片提示词；真正生成图片仍只使用上面的生图 API。测试只发起最小文本请求，未配置时页面保持明确不可用状态。</div>
          </section>
        </div>
      </section>
      <section v-else-if="activeTab === 'agents'" class="settings-section agent-section" data-test="unified-settings-agents"><AgentAdminPanel @toast="(message, kind) => ws.toast(message, kind || 'error')" /></section>
      <section v-else class="settings-section" data-test="settings-about" data-unified-test="unified-settings-about">
        <div class="about-hero"><div class="about-mark"><img :src="brandMark" alt="ShopPilot" /></div><div><h2>ShopPilot</h2><p>电商店铺浏览器工作台</p></div></div>
        <div class="about-grid">
          <div><span>版本</span><strong data-test="about-version">v{{ updateStatus.currentVersion || '—' }}</strong></div>
          <div><span>构建</span><strong>INTERNAL_BUILD</strong></div>
          <div><span>更新通道</span><select v-model="updateChannel" data-test="update-channel" :disabled="updateChannelSaving || updateLoading || !updateLoaded" @change="saveUpdateChannel"><option value="stable">稳定版</option><option value="beta">测试版</option></select></div>
          <div class="about-toggle"><span>启动自动检查</span><label class="update-autocheck"><input v-model="updateAutoCheck" type="checkbox" data-test="update-autocheck" :disabled="updateAutoCheckSaving || updateLoading || !updateLoaded" @change="saveUpdateAutoCheck" /><em>{{ updateAutoCheck ? '已开启' : '已关闭' }}</em></label></div>
        </div>
        <div v-if="updateLoadError" class="settings-note error" role="alert">{{ updateLoadError }}<button type="button" class="settings-inline-retry" :disabled="updateLoading" @click="loadUpdate">{{ updateLoading ? '读取中…' : '重试读取' }}</button></div>
        <div v-else-if="updateLoading" class="settings-note" role="status">正在读取更新设置…</div>
        <div class="settings-note" data-test="update-dialog">更新包下载后会校验哈希；安装前请保存正在编辑的内容。当前通道：{{ updateChannel === 'beta' ? '测试版' : '稳定版' }} · 更新源：{{ updateSourceLabel }}。</div>
        <div class="settings-actions">
          <button v-if="!['available','downloaded','downloading'].includes(updateStatus.state)" type="button" class="unified-button primary" data-test="update-check-btn" :disabled="updateBusy || updateLoading || !updateLoaded || updateStatus.state === 'checking'" @click="checkUpdate"><img class="button-icon" :src="refreshGenIcon" alt="" />{{ updateStatus.state === 'checking' ? '检查中…' : '检查更新' }}</button>
          <button v-if="['available','downloading'].includes(updateStatus.state)" type="button" class="unified-button primary" data-test="update-download-btn" :disabled="updateBusy || updateStatus.state === 'downloading'" @click="downloadUpdate"><img class="button-icon" :src="updateDownloadIcon" alt="" />{{ updateStatus.state === 'downloading' ? `下载中 ${Math.round(updateStatus.percent || 0)}%` : '下载更新' }}</button>
          <button v-if="updateStatus.state === 'downloaded'" type="button" class="unified-button primary" data-test="update-install-btn" :disabled="updateBusy" @click="installUpdate"><img class="button-icon" :src="updateDownloadIcon" alt="" />重启并安装</button>
          <span class="update-message" :class="[updateStatus.state, { error: !!updateStatus.error && ['error','not-available'].includes(updateStatus.state) }]" data-test="update-message" role="status" aria-live="polite">{{ updateMessage }}</span>
        </div>
        <div v-if="updateStatus.releaseNotes" class="settings-note update-release-notes" data-test="update-release-notes"><strong>版本说明</strong><pre>{{ updateStatus.releaseNotes }}</pre></div>
      </section>
    </main></div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AgentAdminPanel from '../agent/AgentAdminPanel.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import settingsIcon from '../../assets/icons/nav-settings.svg'
import configIcon from '../../assets/icons/settings-config.svg'
import squareIcon from '../../assets/icons/settings-square.svg'
import aiIcon from '../../assets/icons/settings-ai.svg'
import agentsIcon from '../../assets/icons/settings-agents.svg'
import aboutIcon from '../../assets/icons/settings-about.svg'
import brandMark from '../../assets/generated/shopilot-logo-generated.png'
import { INVITE_PROFILES } from '@shared/constants/invite'
import { AI_IMAGE_TIMEOUT_MAX_MS, AI_PROVIDER_PRESETS, AI_TIMEOUT_MAX_MS, AI_TIMEOUT_MIN_MS, DEFAULT_AI_ENDPOINT, DEFAULT_AI_IMAGE_ENDPOINT, DEFAULT_AI_IMAGE_MODEL, DEFAULT_AI_IMAGE_TEXT_ENDPOINT, DEFAULT_AI_IMAGE_TEXT_MODEL, DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS, DEFAULT_AI_IMAGE_TIMEOUT_MS, DEFAULT_AI_MODEL, DEFAULT_AI_TIMEOUT_MS, INVITE_SQUARE_URLS_SETTING, normalizeAiEndpoint, normalizeImageEndpoint, modelsUrlFromChat, modelsUrlFromImageEndpoint } from '@shared/constants/ai'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import settingsSaveIcon from '../../assets/generated/ui-icons/settings-save-gen.png'
import refreshGenIcon from '../../assets/generated/ui-icons/workspace-refresh-gen.png'
import updateDownloadIcon from '../../assets/generated/ui-icons/update-download-gen.png'
import settingsCloseIcon from '../../assets/generated/ui-icons/settings-cancel-gen.png'
import settingsTestIcon from '../../assets/generated/ui-icons/settings-test-gen.png'
import settingsTestImageIcon from '../../assets/generated/ui-icons/settings-test-image-gen.png'
import settingsKeyClearIcon from '../../assets/generated/ui-icons/settings-key-clear-gen.png'
import forwardIcon from '../../assets/generated/ui-icons/forward-gen.png'
import refreshIcon from '../../assets/generated/ui-icons/refresh.png'

const props = defineProps<{ initialTab?: TabKey }>()
const emit = defineEmits<{ close: [] }>()
const ws = useWorkspaceStore()
const tabs = [{ key: 'config', label: '配置', icon: configIcon }, { key: 'square', label: '达人广场', icon: squareIcon }, { key: 'ai', label: 'AI 配置', icon: aiIcon }, { key: 'agents', label: 'Agent 模型', icon: agentsIcon }, { key: 'about', label: '关于软件', icon: aboutIcon }] as const
type TabKey = typeof tabs[number]['key']
const activeTab = ref<TabKey>(props.initialTab || 'config')
const savedMessage = ref('')
const platformDefs = (window.shopilot.platforms || []) as Array<{ name: string; adminUrl: string }>
const homeDraft = reactive<Record<string, string>>({})
const squareDraft = reactive<Record<string, string>>({})
const homeLoading = ref(false)
const homeLoaded = ref(false)
const homeSaving = ref(false)
const homeLoadError = ref('')
const homeValidationError = ref('')
const squareLoading = ref(false)
const squareLoaded = ref(false)
const squareSaving = ref(false)
const squareLoadError = ref('')
const squareValidationError = ref('')
const inviteProfiles = computed(() => Object.values(INVITE_PROFILES))
const presets = AI_PROVIDER_PRESETS

const aiProvider = ref('__custom__')
const aiDraft = reactive({ endpoint: DEFAULT_AI_ENDPOINT, model: DEFAULT_AI_MODEL, timeoutMs: DEFAULT_AI_TIMEOUT_MS })
const aiKey = ref('')
const aiHasKey = ref(false)
const aiConfigLoading = ref(false)
const aiLoaded = ref(false)
const aiLoadError = ref('')
const aiSaving = ref(false)
const aiLoading = ref(false)
const aiTesting = ref(false)
const aiMessage = ref('')
const aiOk = ref(false)
const aiModels = ref<string[]>([])

const imageDraft = reactive({ endpoint: DEFAULT_AI_IMAGE_ENDPOINT, model: DEFAULT_AI_IMAGE_MODEL, timeoutMs: DEFAULT_AI_IMAGE_TIMEOUT_MS })
const imageKey = ref('')
const imageHasKey = ref(false)
const imageSaving = ref(false)
const imageLoading = ref(false)
const imageTesting = ref(false)
const imageMessage = ref('')
const imageOk = ref(false)
const imageModels = ref<string[]>([])

const imageTextDraft = reactive({ endpoint: DEFAULT_AI_IMAGE_TEXT_ENDPOINT, model: DEFAULT_AI_IMAGE_TEXT_MODEL, timeoutMs: DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS })
const imageTextKey = ref('')
const imageTextHasKey = ref(false)
const imageTextConfigLoading = ref(false)
const imageTextLoaded = ref(false)
const imageTextLoadError = ref('')
const imageTextSaving = ref(false)
const imageTextLoading = ref(false)
const imageTextTesting = ref(false)
const imageTextMessage = ref('')
const imageTextOk = ref(false)
const imageTextModels = ref<string[]>([])

const updateChannel = ref('stable')
const updateAutoCheck = ref(false)
const savedUpdateChannel = ref('stable')
const savedUpdateAutoCheck = ref(false)
const updateLoading = ref(false)
const updateLoaded = ref(false)
const updateLoadError = ref('')
const updateChannelSaving = ref(false)
const updateAutoCheckSaving = ref(false)
const updateBusy = ref(false)
const updateStatus = reactive<{ state: string; currentVersion: string; channel?: string; feedSource?: string; version?: string; percent?: number; transferred?: number; total?: number; releaseNotes?: string; error?: string }>({ state: 'idle', currentVersion: '', feedSource: 'dev' })

const resolvedEndpoint = computed(() => normalizeAiEndpoint(aiDraft.endpoint))
const modelsUrl = computed(() => modelsUrlFromChat(aiDraft.endpoint) || '')
const imageResolvedEndpoint = computed(() => normalizeImageEndpoint(imageDraft.endpoint))
const imageModelsUrl = computed(() => modelsUrlFromImageEndpoint(imageDraft.endpoint) || '')
const imageTextResolvedEndpoint = computed(() => normalizeAiEndpoint(imageTextDraft.endpoint))
const imageTextModelsUrl = computed(() => modelsUrlFromChat(imageTextDraft.endpoint) || '')
const aiReady = computed(() => Boolean(aiLoaded.value && aiHasKey.value && aiDraft.endpoint.trim() && aiDraft.model.trim() && isUsableAiEndpoint(resolvedEndpoint.value)))
const imageReady = computed(() => Boolean(aiLoaded.value && imageHasKey.value && imageDraft.endpoint.trim() && imageDraft.model.trim() && isUsableAiEndpoint(imageResolvedEndpoint.value)))
const imageTextReady = computed(() => Boolean(imageTextLoaded.value && imageTextHasKey.value && imageTextDraft.endpoint.trim() && imageTextDraft.model.trim() && isUsableAiEndpoint(imageTextResolvedEndpoint.value)))
const configuredSummary = computed(() => {
  if (aiConfigLoading.value || imageTextConfigLoading.value) return '正在读取 AI 配置…'
  if (aiLoadError.value && imageTextLoadError.value) return 'AI 配置读取失败'
  const count = [aiReady.value, imageReady.value, imageTextReady.value].filter(Boolean).length
  return count === 3 ? '三套 AI 配置完整' : '已完成 ' + count + '/3 套 AI 配置'
})
const updateSourceLabel = computed(() => updateStatus.feedSource === 'github' ? 'GitHub Releases' : updateStatus.feedSource === 'env-override' ? '自定义更新源' : '开发环境')
const updateMessage = computed(() => {
  if (updateStatus.state === 'checking') return '正在检查更新…'
  if (updateStatus.state === 'downloading') return '正在下载更新' + (typeof updateStatus.percent === 'number' ? ' · ' + Math.round(updateStatus.percent) + '%' : '')
  if (updateStatus.state === 'available') return '发现新版本 v' + (updateStatus.version || '—')
  if (updateStatus.state === 'downloaded') return '更新 v' + (updateStatus.version || '') + ' 已下载并校验，重启后安装'
  if (updateStatus.state === 'not-available') return updateStatus.error || '当前已是最新版本'
  if (updateStatus.state === 'error') return updateStatus.error || '更新检查失败'
  return updateStatus.feedSource === 'dev' ? '开发环境不支持在线更新检查' : '可以检查更新'
})

function selectTab(tab: TabKey) {
  activeTab.value = tab
  if (tab === 'ai' && !aiLoaded.value && !aiConfigLoading.value) void loadAi()
  if (tab === 'ai' && !imageTextLoaded.value && !imageTextConfigLoading.value) void loadImageTextAi()
  if (tab === 'about' && !updateLoaded.value && !updateLoading.value) void loadUpdate()
}

function responseError(result: unknown, fallback: string): string {
  if (!result || typeof result !== 'object' || !('error' in result)) return fallback
  const detail = result.error
  if (!detail || typeof detail !== 'object') return fallback
  const fields = detail as { message?: unknown; code?: unknown }
  return String(fields.message || fields.code || fallback)
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

/** AI 请求会携带 API Key；与 Main 的安全策略保持一致，公网只允许 HTTPS。 */
function isUsableAiEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    if (!url.hostname) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function validateAiEndpoint(value: string, label: string, normalizer: (input: string) => string): boolean {
  const endpoint = normalizer(value.trim())
  if (!value.trim()) return true
  if (endpoint && isUsableAiEndpoint(endpoint)) return true
  const message = label + ' 地址无效：公网服务必须使用 HTTPS，本机服务可使用 HTTP。'
  ws.toast(message, 'error')
  return false
}

async function loadPlatformUrls() {
  homeLoading.value = true
  homeLoaded.value = false
  homeLoadError.value = ''
  try {
    const result = await window.shopilot.settings.get('platform.homeUrls')
    if (!result.ok) throw new Error(responseError(result, '读取平台首页地址失败'))
    Object.keys(homeDraft).forEach(key => delete homeDraft[key])
    Object.assign(homeDraft, asStringRecord(result.data?.value))
    homeLoaded.value = true
  } catch (error) {
    homeLoaded.value = false
    homeLoadError.value = '读取平台首页地址失败：' + String((error as Error)?.message || error)
  } finally {
    homeLoading.value = false
  }
}

async function loadSquareUrls() {
  squareLoading.value = true
  squareLoaded.value = false
  squareLoadError.value = ''
  try {
    const result = await window.shopilot.settings.get(INVITE_SQUARE_URLS_SETTING)
    if (!result.ok) throw new Error(responseError(result, '读取达人广场地址失败'))
    Object.keys(squareDraft).forEach(key => delete squareDraft[key])
    Object.assign(squareDraft, asStringRecord(result.data?.value))
    squareLoaded.value = true
  } catch (error) {
    squareLoaded.value = false
    squareLoadError.value = '读取达人广场地址失败：' + String((error as Error)?.message || error)
  } finally {
    squareLoading.value = false
  }
}

async function savePlatformUrls() {
  homeValidationError.value = ''
  const next: Record<string, string> = {}
  for (const platform of platformDefs) {
    const value = (homeDraft[platform.name] || '').trim()
    if (value && !isValidHttpUrl(value)) {
      homeValidationError.value = platform.name + ' 地址格式无效，请填写完整的 http:// 或 https:// URL。'
      ws.toast(homeValidationError.value, 'error')
      return
    }
    if (value) next[platform.name] = value
  }
  homeSaving.value = true
  try {
    const result = await window.shopilot.settings.set('platform.homeUrls', next)
    if (!result.ok) throw new Error(responseError(result, '保存失败'))
    savedMessage.value = '平台首页地址已保存'
    ws.toast('平台首页地址已保存', 'success')
    emit('close')
  } catch (error) {
    homeValidationError.value = '保存平台首页地址失败：' + String((error as Error)?.message || error)
    ws.toast(homeValidationError.value, 'error')
  } finally {
    homeSaving.value = false
  }
}

async function saveSquareUrls() {
  squareValidationError.value = ''
  const next: Record<string, string> = {}
  for (const profile of inviteProfiles.value) {
    const value = (squareDraft[profile.platform] || '').trim()
    if (value && !isValidHttpUrl(value)) {
      squareValidationError.value = profile.platform + ' 地址格式无效，请填写完整的 http:// 或 https:// URL。'
      ws.toast(squareValidationError.value, 'error')
      return
    }
    if (value) next[profile.platform] = value
  }
  squareSaving.value = true
  try {
    const result = await window.shopilot.settings.set(INVITE_SQUARE_URLS_SETTING, next)
    if (!result.ok) throw new Error(responseError(result, '保存失败'))
    savedMessage.value = '达人广场地址已保存'
    ws.toast('达人广场地址已保存', 'success')
    emit('close')
  } catch (error) {
    squareValidationError.value = '保存达人广场地址失败：' + String((error as Error)?.message || error)
    ws.toast(squareValidationError.value, 'error')
  } finally {
    squareSaving.value = false
  }
}

async function loadAi() {
  if (aiConfigLoading.value) return
  aiConfigLoading.value = true
  aiLoaded.value = false
  aiLoadError.value = ''
  try {
    const result = await window.shopilot.ai.configGet()
    if (!result.ok) throw new Error(responseError(result, '读取文本和生图配置失败'))
    aiDraft.endpoint = result.data.endpoint
    aiDraft.model = result.data.model
    aiDraft.timeoutMs = result.data.timeoutMs
    aiHasKey.value = Boolean(result.data.hasKey)
    imageDraft.endpoint = result.data.imageEndpoint || DEFAULT_AI_IMAGE_ENDPOINT
    imageDraft.model = result.data.imageModel || DEFAULT_AI_IMAGE_MODEL
    imageDraft.timeoutMs = result.data.imageTimeoutMs || DEFAULT_AI_IMAGE_TIMEOUT_MS
    imageHasKey.value = Boolean(result.data.hasImageKey)
    aiProvider.value = presets.find(item => item.baseUrl && normalizeAiEndpoint(item.baseUrl) === normalizeAiEndpoint(aiDraft.endpoint))?.key || '__custom__'
    aiLoaded.value = true
  } catch (error) {
    aiLoaded.value = false
    aiLoadError.value = '读取文本和生图配置失败：' + String((error as Error)?.message || error)
  } finally {
    aiConfigLoading.value = false
  }
}

async function loadImageTextAi() {
  if (imageTextConfigLoading.value) return
  imageTextConfigLoading.value = true
  imageTextLoaded.value = false
  imageTextLoadError.value = ''
  try {
    const result = await window.shopilot.ai.imageTextConfigGet()
    if (!result.ok) throw new Error(responseError(result, '读取生图文本配置失败'))
    imageTextDraft.endpoint = result.data.imageTextEndpoint || DEFAULT_AI_IMAGE_TEXT_ENDPOINT
    imageTextDraft.model = result.data.imageTextModel || DEFAULT_AI_IMAGE_TEXT_MODEL
    imageTextDraft.timeoutMs = result.data.imageTextTimeoutMs || DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS
    imageTextHasKey.value = Boolean(result.data.hasImageTextKey)
    imageTextLoaded.value = true
  } catch (error) {
    imageTextLoaded.value = false
    imageTextLoadError.value = '读取生图文本配置失败：' + String((error as Error)?.message || error)
  } finally {
    imageTextConfigLoading.value = false
  }
}

function applyPreset() {
  const preset = presets.find(item => item.key === aiProvider.value)
  if (!preset?.baseUrl) return
  aiDraft.endpoint = preset.baseUrl
  if (preset.models.length) aiDraft.model = preset.models[0]
}

function validateTimeout(value: unknown, min: number, max: number, label: string): number | null {
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout < min || timeout > max) {
    ws.toast(label + '必须在 ' + min + ' 至 ' + max + ' 毫秒之间。', 'error')
    return null
  }
  return Math.round(timeout)
}

async function saveAi(notify = true): Promise<boolean> {
  if (!validateAiEndpoint(aiDraft.endpoint, '文本 API', normalizeAiEndpoint)) {
    aiMessage.value = '文本 API 地址无效：公网服务必须使用 HTTPS，本机服务可使用 HTTP。'
    aiOk.value = false
    return false
  }
  const timeoutMs = validateTimeout(aiDraft.timeoutMs, AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS, '文本超时')
  if (timeoutMs === null) { aiMessage.value = '文本超时值无效'; aiOk.value = false; return false }
  aiSaving.value = true
  aiMessage.value = ''
  try {
    const result = await window.shopilot.ai.configSet({ endpoint: aiDraft.endpoint.trim(), model: aiDraft.model.trim(), timeoutMs })
    if (!result.ok) throw new Error(responseError(result, '保存文本 AI 配置失败'))
    aiHasKey.value = Boolean(result.data.hasKey)
    if (aiKey.value.trim()) {
      const keyResult = await window.shopilot.ai.setKey(aiKey.value.trim())
      if (!keyResult.ok) throw new Error('文本配置已保存，但 API Key 保存失败：' + responseError(keyResult, '请检查密钥后重试'))
      aiHasKey.value = Boolean(keyResult.data.hasKey)
      aiKey.value = ''
    }
    savedMessage.value = '文本 API 配置已保存'
    aiMessage.value = '文本 API 配置已保存'
    aiOk.value = true
    if (notify) ws.toast(aiMessage.value, 'success')
    return true
  } catch (error) {
    aiMessage.value = String((error as Error)?.message || error)
    aiOk.value = false
    ws.toast(aiMessage.value, 'error')
    return false
  } finally {
    aiSaving.value = false
  }
}

async function saveImageAi(notify = true): Promise<boolean> {
  if (!validateAiEndpoint(imageDraft.endpoint, '生图 API', normalizeImageEndpoint)) {
    imageMessage.value = '生图 API 地址无效：公网服务必须使用 HTTPS，本机服务可使用 HTTP。'
    imageOk.value = false
    return false
  }
  const timeoutMs = validateTimeout(imageDraft.timeoutMs, AI_TIMEOUT_MIN_MS, AI_IMAGE_TIMEOUT_MAX_MS, '生图超时')
  if (timeoutMs === null) { imageMessage.value = '生图超时值无效'; imageOk.value = false; return false }
  imageSaving.value = true
  imageMessage.value = ''
  try {
    const result = await window.shopilot.ai.imageConfigSet({ endpoint: imageDraft.endpoint.trim(), model: imageDraft.model.trim(), timeoutMs })
    if (!result.ok) throw new Error(responseError(result, '保存生图 API 配置失败'))
    imageHasKey.value = Boolean(result.data.hasImageKey)
    if (imageKey.value.trim()) {
      const keyResult = await window.shopilot.ai.setImageKey(imageKey.value.trim())
      if (!keyResult.ok) throw new Error('生图配置已保存，但 API Key 保存失败：' + responseError(keyResult, '请检查密钥后重试'))
      imageHasKey.value = Boolean(keyResult.data.hasImageKey)
      imageKey.value = ''
    }
    savedMessage.value = '生图 API 配置已保存'
    imageMessage.value = '生图 API 配置已保存'
    imageOk.value = true
    if (notify) ws.toast(imageMessage.value, 'success')
    return true
  } catch (error) {
    imageMessage.value = String((error as Error)?.message || error)
    imageOk.value = false
    ws.toast(imageMessage.value, 'error')
    return false
  } finally {
    imageSaving.value = false
  }
}

async function saveImageTextAi(notify = true): Promise<boolean> {
  if (!validateAiEndpoint(imageTextDraft.endpoint, '分析文本 API', normalizeAiEndpoint)) {
    imageTextMessage.value = '分析文本 API 地址无效：公网服务必须使用 HTTPS，本机服务可使用 HTTP。'
    imageTextOk.value = false
    return false
  }
  const timeoutMs = validateTimeout(imageTextDraft.timeoutMs, AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS, '分析文本超时')
  if (timeoutMs === null) { imageTextMessage.value = '分析文本超时值无效'; imageTextOk.value = false; return false }
  imageTextSaving.value = true
  imageTextMessage.value = ''
  try {
    const result = await window.shopilot.ai.imageTextConfigSet({ endpoint: imageTextDraft.endpoint.trim(), model: imageTextDraft.model.trim(), timeoutMs })
    if (!result.ok) throw new Error(responseError(result, '保存生图文本 API 配置失败'))
    imageTextHasKey.value = Boolean(result.data.hasImageTextKey)
    if (imageTextKey.value.trim()) {
      const keyResult = await window.shopilot.ai.setImageTextKey(imageTextKey.value.trim())
      if (!keyResult.ok) throw new Error('分析文本配置已保存，但 API Key 保存失败：' + responseError(keyResult, '请检查密钥后重试'))
      imageTextHasKey.value = Boolean(keyResult.data.hasImageTextKey)
      imageTextKey.value = ''
    }
    savedMessage.value = '生图文本 API 配置已保存'
    imageTextMessage.value = '生图文本 API 配置已保存'
    imageTextOk.value = true
    if (notify) ws.toast(imageTextMessage.value, 'success')
    return true
  } catch (error) {
    imageTextMessage.value = String((error as Error)?.message || error)
    imageTextOk.value = false
    ws.toast(imageTextMessage.value, 'error')
    return false
  } finally {
    imageTextSaving.value = false
  }
}

async function fetchModels() {
  aiLoading.value = true
  aiModels.value = []
  try {
    if (!await saveAi(false)) return
    const result = await window.shopilot.ai.listModels()
    if (!result.ok) throw new Error(responseError(result, '获取文本模型失败'))
    aiModels.value = result.data.models
    aiMessage.value = '已获取 ' + result.data.models.length + ' 个文本模型'
    aiOk.value = true
  } catch (error) {
    aiMessage.value = '获取文本模型失败：' + String((error as Error)?.message || error)
    aiOk.value = false
  } finally {
    aiLoading.value = false
  }
}

function pickAiModel(name: string) { if (name) aiDraft.model = name }

async function testAi() {
  aiTesting.value = true
  try {
    if (!await saveAi(false)) return
    const result = await window.shopilot.ai.test()
    if (!result.ok) throw new Error(responseError(result, '连接失败'))
    aiMessage.value = '连接成功：' + result.data.model + ' · ' + result.data.elapsedMs + 'ms'
    aiOk.value = true
  } catch (error) {
    aiMessage.value = '连接失败：' + String((error as Error)?.message || error)
    aiOk.value = false
  } finally {
    aiTesting.value = false
  }
}

async function clearKey() {
  if (!window.confirm('确认清除文本 API Key？')) return
  try {
    const result = await window.shopilot.ai.clearKey()
    if (!result.ok) throw new Error(responseError(result, '清除文本 API Key 失败'))
    aiHasKey.value = false
    aiMessage.value = '文本 API Key 已清除'
    aiOk.value = true
  } catch (error) {
    aiMessage.value = '清除文本 API Key 失败：' + String((error as Error)?.message || error)
    aiOk.value = false
    ws.toast(aiMessage.value, 'error')
  }
}

async function fetchImageModels() {
  imageLoading.value = true
  imageModels.value = []
  try {
    if (!await saveImageAi(false)) return
    const result = await window.shopilot.ai.listImageModels()
    if (!result.ok) throw new Error(responseError(result, '获取生图模型失败'))
    imageModels.value = result.data.models
    imageMessage.value = '已获取 ' + result.data.models.length + ' 个生图模型'
    imageOk.value = true
  } catch (error) {
    imageMessage.value = '获取生图模型失败：' + String((error as Error)?.message || error)
    imageOk.value = false
  } finally {
    imageLoading.value = false
  }
}

async function testImageAi() {
  imageTesting.value = true
  try {
    if (!await saveImageAi(false)) return
    const result = await window.shopilot.ai.testImage()
    if (!result.ok) throw new Error(responseError(result, '生图接口测试失败'))
    imageMessage.value = '生图接口可用：模型 ' + result.data.model + ' · ' + result.data.elapsedMs + 'ms'
    imageOk.value = true
  } catch (error) {
    imageMessage.value = '生图接口失败：' + String((error as Error)?.message || error)
    imageOk.value = false
  } finally {
    imageTesting.value = false
  }
}

async function clearImageKey() {
  if (!window.confirm('确认清除生图 API Key？')) return
  try {
    const result = await window.shopilot.ai.clearImageKey()
    if (!result.ok) throw new Error(responseError(result, '清除生图 API Key 失败'))
    imageHasKey.value = false
    imageMessage.value = '生图 API Key 已清除'
    imageOk.value = true
  } catch (error) {
    imageMessage.value = '清除生图 API Key 失败：' + String((error as Error)?.message || error)
    imageOk.value = false
    ws.toast(imageMessage.value, 'error')
  }
}

function pickImageModel(name: string) { if (name) imageDraft.model = name }

async function fetchImageTextModels() {
  imageTextLoading.value = true
  imageTextModels.value = []
  try {
    if (!await saveImageTextAi(false)) return
    const result = await window.shopilot.ai.listImageTextModels()
    if (!result.ok) throw new Error(responseError(result, '获取分析模型失败'))
    imageTextModels.value = result.data.models
    imageTextMessage.value = '已获取 ' + result.data.models.length + ' 个分析模型'
    imageTextOk.value = true
  } catch (error) {
    imageTextMessage.value = '获取分析模型失败：' + String((error as Error)?.message || error)
    imageTextOk.value = false
  } finally {
    imageTextLoading.value = false
  }
}

async function testImageTextAi() {
  imageTextTesting.value = true
  try {
    if (!await saveImageTextAi(false)) return
    const result = await window.shopilot.ai.testImageText()
    if (!result.ok) throw new Error(responseError(result, '分析接口测试失败'))
    imageTextMessage.value = '分析接口可用：模型 ' + result.data.model + ' · ' + result.data.elapsedMs + 'ms'
    imageTextOk.value = true
  } catch (error) {
    imageTextMessage.value = '分析接口失败：' + String((error as Error)?.message || error)
    imageTextOk.value = false
  } finally {
    imageTextTesting.value = false
  }
}

async function clearImageTextKey() {
  if (!window.confirm('确认清除生图文本 API Key？')) return
  try {
    const result = await window.shopilot.ai.clearImageTextKey()
    if (!result.ok) throw new Error(responseError(result, '清除分析 API Key 失败'))
    imageTextHasKey.value = false
    imageTextMessage.value = '生图文本 API Key 已清除'
    imageTextOk.value = true
  } catch (error) {
    imageTextMessage.value = '清除分析 API Key 失败：' + String((error as Error)?.message || error)
    imageTextOk.value = false
    ws.toast(imageTextMessage.value, 'error')
  }
}

function pickImageTextModel(name: string) { if (name) imageTextDraft.model = name }

async function loadUpdate() {
  if (updateLoading.value) return
  updateLoading.value = true
  updateLoaded.value = false
  updateLoadError.value = ''
  try {
    const [channel, autoCheck, status] = await Promise.all([
      window.shopilot.settings.get('update.channel'),
      window.shopilot.settings.get('update.autoCheck'),
      window.shopilot.update.status()
    ])
    const errors: string[] = []
    if (channel.ok) {
      updateChannel.value = ['stable', 'beta'].includes(channel.data?.value) ? channel.data.value : 'stable'
      savedUpdateChannel.value = updateChannel.value
    } else errors.push('更新通道：' + responseError(channel, '读取失败'))
    if (autoCheck.ok) {
      updateAutoCheck.value = autoCheck.data?.value === true
      savedUpdateAutoCheck.value = updateAutoCheck.value
    } else errors.push('自动检查：' + responseError(autoCheck, '读取失败'))
    if (status.ok) Object.assign(updateStatus, status.data)
    else errors.push('更新状态：' + responseError(status, '读取失败'))
    if (errors.length) throw new Error(errors.join('；'))
    updateLoaded.value = true
  } catch (error) {
    updateLoaded.value = false
    updateLoadError.value = '读取更新设置失败：' + String((error as Error)?.message || error)
  } finally {
    updateLoading.value = false
  }
}

async function saveUpdateChannel() {
  const next = updateChannel.value
  updateChannelSaving.value = true
  try {
    const result = await window.shopilot.settings.set('update.channel', next)
    if (!result.ok) throw new Error(responseError(result, '保存更新通道失败'))
    savedUpdateChannel.value = next
    savedMessage.value = '更新通道已切换为' + (next === 'beta' ? '测试版' : '稳定版')
    ws.toast(savedMessage.value, 'success')
  } catch (error) {
    updateChannel.value = savedUpdateChannel.value
    ws.toast('保存更新通道失败：' + String((error as Error)?.message || error), 'error')
  } finally {
    updateChannelSaving.value = false
  }
}

async function saveUpdateAutoCheck() {
  const next = updateAutoCheck.value
  updateAutoCheckSaving.value = true
  try {
    const result = await window.shopilot.settings.set('update.autoCheck', next)
    if (!result.ok) throw new Error(responseError(result, '保存启动自动检查失败'))
    savedUpdateAutoCheck.value = next
    savedMessage.value = next ? '启动自动检查已开启' : '启动自动检查已关闭'
    ws.toast(savedMessage.value, 'success')
  } catch (error) {
    updateAutoCheck.value = savedUpdateAutoCheck.value
    ws.toast('保存启动自动检查失败：' + String((error as Error)?.message || error), 'error')
  } finally {
    updateAutoCheckSaving.value = false
  }
}

async function checkUpdate() {
  if (updateBusy.value) return
  updateBusy.value = true
  Object.assign(updateStatus, { state: 'checking', error: undefined })
  try {
    const result = await window.shopilot.update.check()
    if (!result.ok) throw new Error(responseError(result, '更新检查失败'))
    Object.assign(updateStatus, result.data)
  } catch (error) {
    Object.assign(updateStatus, { state: 'error', error: String((error as Error)?.message || error) })
  } finally {
    updateBusy.value = false
  }
}

async function downloadUpdate() {
  if (updateBusy.value) return
  updateBusy.value = true
  Object.assign(updateStatus, { state: 'downloading', percent: 0, error: undefined })
  try {
    const result = await window.shopilot.update.download()
    if (!result.ok) throw new Error(responseError(result, '更新下载失败'))
    Object.assign(updateStatus, result.data)
  } catch (error) {
    Object.assign(updateStatus, { state: 'error', error: String((error as Error)?.message || error) })
  } finally {
    updateBusy.value = false
  }
}

async function installUpdate() {
  if (updateBusy.value) return
  updateBusy.value = true
  try {
    const result = await window.shopilot.update.install()
    if (!result.ok) throw new Error(responseError(result, '启动更新安装失败'))
    Object.assign(updateStatus, result.data)
  } catch (error) {
    Object.assign(updateStatus, { state: 'error', error: String((error as Error)?.message || error) })
  } finally {
    updateBusy.value = false
  }
}

function onUpdateStatus(payload: unknown) {
  if (payload && typeof payload === 'object') Object.assign(updateStatus, payload)
}

watch(() => aiDraft.endpoint, () => {
  aiModels.value = []
  aiProvider.value = presets.find(item => item.baseUrl && normalizeAiEndpoint(item.baseUrl) === normalizeAiEndpoint(aiDraft.endpoint))?.key || '__custom__'
})
watch(() => imageDraft.endpoint, () => { imageModels.value = [] })
watch(() => imageTextDraft.endpoint, () => { imageTextModels.value = [] })
watch(homeDraft, () => { homeValidationError.value = '' }, { deep: true })
watch(squareDraft, () => { squareValidationError.value = '' }, { deep: true })
watch(() => props.initialTab, value => { if (value) selectTab(value) })

onMounted(() => {
  window.shopilot.on(EVENT_CHANNELS.UPDATE_STATUS_CHANGED, onUpdateStatus)
  window.shopilot.on(EVENT_CHANNELS.UPDATE_PROGRESS, onUpdateStatus)
  void loadPlatformUrls()
  void loadSquareUrls()
  void loadAi()
  void loadImageTextAi()
  if (activeTab.value === 'about') void loadUpdate()
})

onBeforeUnmount(() => {
  window.shopilot.off(EVENT_CHANNELS.UPDATE_STATUS_CHANGED, onUpdateStatus)
  window.shopilot.off(EVENT_CHANNELS.UPDATE_PROGRESS, onUpdateStatus)
})
</script>

<style scoped>
.button-icon{width:16px;height:16px;object-fit:contain;vertical-align:-3px;margin-right:4px}.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:16px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.settings-save-state{color:#027a48;font-size:11px}.settings-layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:12px;min-height:0}.settings-nav{display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--dash-border);border-radius:13px;background:#ecedee;align-self:start}.settings-nav button{display:flex;align-items:center;gap:9px;height:38px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dash-text-muted);text-align:left;cursor:pointer}.settings-nav button:hover,.settings-nav button:focus-visible{background:rgba(124,92,255,.12);color:var(--dash-text);outline:none}.settings-nav button.active{border-color:rgba(135,102,246,.42);background:rgba(112,76,232,.18);color:#4c1d95}.settings-nav span{width:18px;color:#5b3df5;text-align:center}.settings-nav .settings-tab-icon{width:17px;height:17px;object-fit:contain}.settings-content{min-width:0}.settings-section{min-height:420px;padding:19px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}.settings-section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px}.settings-section h2{margin:0 0 6px;font-size:17px}.settings-section p{margin:0;color:var(--dash-text-muted);font-size:11px}.unified-button{min-height:32px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:none}.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}.unified-button.danger{border-color:rgba(217,45,32,.35);color:#d92d20}.unified-button:disabled{opacity:.55;cursor:not-allowed}.settings-field-row{display:flex;align-items:end;gap:10px;margin:11px 0}.settings-field-row label,.settings-field{display:flex;flex-direction:column;gap:6px;flex:1;color:var(--dash-text-soft);font-size:11px}.settings-field-row input,.settings-field input,.settings-field select{height:34px;padding:0 10px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-soft);outline:none}.settings-field-row input:focus,.settings-field input:focus,.settings-field select:focus{border-color:rgba(145,113,255,.78);box-shadow:0 0 0 2px rgba(145,113,255,.14)}.settings-note{margin-top:14px;padding:10px 12px;border-radius:8px;background:#edeef0;color:var(--dash-text-muted);font-size:11px;line-height:1.6}.settings-note.ok{border:1px solid rgba(32,209,154,.35);color:#027a48}.settings-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px}.agent-section{overflow:auto}.about-hero{display:flex;align-items:center;gap:12px;padding-bottom:18px;border-bottom:1px solid var(--dash-border)}.about-mark img{width:34px;height:34px;object-fit:contain}.about-mark{display:grid;width:46px;height:46px;place-items:center;border-radius:13px;background:linear-gradient(135deg,#f3f0fc,#a280ff);color:#fff;font-size:24px;box-shadow:0 0 24px rgba(135,102,246,.4)}.about-hero h2{margin:0}.about-hero p{margin:5px 0 0}.about-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px}.about-grid>div{display:flex;flex-direction:column;gap:7px;padding:12px;border-radius:9px;background:#f7f9fd}.about-grid span{color:var(--dash-text-muted);font-size:10px}.about-grid strong{font-size:15px}.about-grid select{height:29px;border:1px solid var(--dash-border);border-radius:6px;background:#ffffff;color:var(--dash-text-soft)}.about-toggle{justify-content:space-between}.update-autocheck{display:flex;align-items:center;gap:7px;color:var(--dash-text-soft);font-size:11px;cursor:pointer}.update-autocheck input{accent-color:#8c5cff}.update-autocheck em{font-style:normal;color:var(--dash-text-muted)}.update-message{margin-left:auto;color:var(--dash-text-muted);font-size:11px}.update-message.not-available{color:#027a48}.update-message.error{color:#f04438}
@media(max-width:820px){.settings-layout{grid-template-columns:1fr}.settings-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.about-grid{grid-template-columns:1fr}.settings-field-row{align-items:stretch;flex-direction:column}}
.ai-settings-section{min-height:0}.ai-config-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.ai-config-card{min-width:0;padding:15px;border:1px solid rgba(111,134,183,.22);border-radius:11px;background:rgba(8,16,30,.42)}.image-ai-config-card{border-color:rgba(147,105,255,.32);background:linear-gradient(145deg,rgba(41,29,76,.28),#f7f9fd)}.image-text-ai-config-card{border-color:rgba(74,191,218,.3);background:linear-gradient(145deg,rgba(18,67,84,.2),#f7f9fd)}.ai-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:14px}.ai-card-head h3{margin:4px 0 5px;font-size:15px}.ai-card-head p{margin:0;color:var(--dash-text-muted);font-size:10px;line-height:1.5}.settings-kicker{color:#9b83ef;font-size:9px;letter-spacing:.14em}.ai-status{padding:4px 7px;border:1px solid rgba(229,168,86,.28);border-radius:999px;color:#b54708;font-size:9px}.ai-status.ok{border-color:rgba(34,209,157,.3);color:#027a48}.image-model-picker{margin-top:12px}.ai-config-card .settings-note{word-break:break-word}.ai-config-card code{color:#5b3df5;font-size:10px}@media(max-width:1260px){.ai-config-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:900px){.ai-config-grid{grid-template-columns:1fr}}
/* Settings refinement layer: keep the existing tokens and tighten visual hierarchy. */
.unified-settings-page{background:radial-gradient(circle at 86% 0%,rgba(113,82,224,.1),transparent 28%),linear-gradient(145deg,#ebeced,#ececee)}
.settings-hero{position:relative;align-items:center;padding:18px 20px;border:1px solid rgba(119,143,197,.22);border-radius:18px;background:linear-gradient(135deg,#edeef0,#ecedee);box-shadow:0 18px 42px rgba(0,0,0,.2);overflow:hidden}
.settings-hero:after{content:'';position:absolute;right:-40px;bottom:-70px;width:220px;height:180px;border-radius:50%;background:rgba(121,87,238,.13);filter:blur(22px);pointer-events:none}
.settings-title-block{display:flex;align-items:center;gap:13px;position:relative;z-index:1}
.settings-title-icon img{width:23px;height:23px;object-fit:contain}.settings-title-icon{display:grid;width:44px;height:44px;place-items:center;border:1px solid rgba(166,139,255,.38);border-radius:13px;background:linear-gradient(145deg,#f4f1fd,#efeff7);box-shadow:0 0 24px rgba(115,83,240,.28);font-size:21px}
.settings-hero h1{margin:4px 0 6px;font-size:26px;letter-spacing:-.04em}
.settings-hero p{max-width:680px}
.settings-head-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
.settings-head-tags span{padding:4px 7px;border:1px solid rgba(123,150,205,.2);border-radius:999px;background:rgba(6,14,29,.26);color:#1d4ed8;font-size:9px}
.settings-save-state{position:relative;z-index:1;display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid rgba(35,211,163,.24);border-radius:999px;background:rgba(24,104,88,.16);color:#027a48}
.settings-save-state i{width:7px;height:7px;border-radius:50%;background:#12b76a;box-shadow:0 0 10px #12b76a}
.settings-nav{position:sticky;top:16px;padding:10px;background:linear-gradient(165deg,#ecedef,#ebeced);box-shadow:0 14px 32px rgba(0,0,0,.16)}
.settings-nav-title{display:flex;flex-direction:column;gap:4px;padding:6px 9px 12px;border-bottom:1px solid rgba(112,135,184,.15)}
.settings-nav-title span{color:#7f8eac;font-size:8px;letter-spacing:.16em}
.settings-nav-title strong{color:#4a5568;font-size:12px}
.settings-nav button{position:relative;transition:background .18s,border-color .18s,color .18s,transform .18s}
.settings-nav button em{font-style:normal;flex:1}
.settings-nav button b img{width:14px;height:14px;object-fit:contain}.settings-nav button b{opacity:0;margin-left:auto;color:#5b3df5;font-size:18px;font-weight:400;line-height:1;transform:translateX(-3px);transition:opacity .18s,transform .18s}
.settings-nav button:hover b,.settings-nav button:focus-visible b,.settings-nav button.active b{opacity:1;transform:translateX(0)}
.settings-nav button.active{box-shadow:0 7px 18px rgba(95,63,216,.2)}
.settings-section{padding:22px;border-radius:16px;background:linear-gradient(145deg,#ecedef,#ecedee);box-shadow:0 16px 34px rgba(0,0,0,.16)}
.settings-section-head{padding-bottom:16px;border-bottom:1px solid #eef1f7}
.settings-field-row{padding:12px 0;margin:0;border-bottom:1px solid rgba(112,135,184,.11)}
.settings-field-row:last-of-type{border-bottom:0}
.settings-field-row label span{font-weight:600;color:#4a5568}
.settings-field{margin-top:13px}
.settings-field>span{font-weight:600;color:#4a5568}
.settings-field input,.settings-field select{transition:border-color .18s,box-shadow .18s,background .18s}
.settings-field input::placeholder{color:#637493}
.ai-config-summary{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 14px;padding:14px 16px;border:1px solid rgba(112,135,190,.2);border-radius:13px;background:linear-gradient(120deg,#edeef0,#ecedef)}
.ai-summary-copy{display:flex;min-width:220px;flex-direction:column;gap:5px}
.ai-summary-copy strong{font-size:15px;color:#4a5568}
.ai-summary-copy p{font-size:10px}
.ai-summary-statuses{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ai-summary-status{display:flex;align-items:center;gap:7px;min-width:118px;padding:8px 9px;border:1px solid rgba(225,168,92,.2);border-radius:9px;background:rgba(8,15,29,.36);color:#4a5568}
.ai-summary-status i{width:7px;height:7px;border-radius:50%;background:#e3ac65}
.ai-summary-status b{font-size:10px}
.ai-summary-status em{margin-left:auto;color:#8c9ab5;font-size:9px;font-style:normal}
.ai-summary-status.ready{border-color:rgba(38,213,166,.25)}
.ai-summary-status.ready i{background:#33d9a7;box-shadow:0 0 9px rgba(51,217,167,.65)}
.ai-summary-status.ready em{color:#027a48}
.ai-config-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.ai-config-card{padding:18px;border-radius:14px;box-shadow:0 12px 26px rgba(0,0,0,.14);transition:transform .18s,border-color .18s,box-shadow .18s}
.ai-config-card:hover{transform:translateY(-2px);box-shadow:0 17px 34px rgba(0,0,0,.22)}
.image-text-ai-config-card{grid-column:1/-1}
.ai-card-head{min-height:64px;padding-bottom:13px;border-bottom:1px solid #eef1f7}
.ai-card-head h3{font-size:16px}
.ai-card-head p{max-width:420px}
.ai-config-card .settings-actions{padding-top:13px;border-top:1px solid rgba(112,135,184,.12)}
.ai-config-card .settings-actions .unified-button.primary{box-shadow:0 7px 16px rgba(105,65,224,.24)}
.ai-config-card .settings-note{border:1px solid #eef1f7;background:#ebeced}
.settings-nav button:focus-visible,.unified-button:focus-visible,.settings-field-row input:focus-visible,.settings-field input:focus-visible,.settings-field select:focus-visible{box-shadow:0 0 0 3px rgba(145,113,255,.2)}
@media(max-width:1180px){.settings-hero{padding:16px 18px}.ai-config-grid{grid-template-columns:1fr}.image-text-ai-config-card{grid-column:auto}.ai-config-summary{align-items:flex-start;flex-direction:column}.ai-summary-statuses{justify-content:flex-start;width:100%}}
@media(max-width:820px){.unified-page{padding:16px}.settings-hero{align-items:flex-start;flex-direction:column}.settings-save-state{align-self:flex-start}.settings-nav{position:static}.settings-section{padding:16px}.settings-section-head{flex-direction:column}.ai-summary-statuses{display:grid;grid-template-columns:1fr}.ai-summary-status{width:100%}}

/* AI providers are independent services, so keep each setup and its actions in one card. */
.ai-config-summary{border-color:rgba(112,76,232,.16);background:linear-gradient(110deg,#fff 0%,#f7f5ff 62%,#f2f8ff 100%);box-shadow:0 8px 22px rgba(42,50,79,.06)}
.ai-summary-status{border-color:#e7e9f0;background:#fff;color:#475467}
.ai-summary-status em{color:#667085}
.ai-config-card{--ai-accent:#7054e8;position:relative;display:flex;min-width:0;flex-direction:column;overflow:hidden;border:1px solid #e4e7ef;border-radius:16px;background:linear-gradient(180deg,#fff 0%,#fbfbfd 100%);box-shadow:0 8px 22px rgba(36,43,66,.07);transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}
.ai-config-card::before{position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,var(--ai-accent),color-mix(in srgb,var(--ai-accent) 24%,#fff));content:''}
.ai-config-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--ai-accent) 28%,#e4e7ef);box-shadow:0 14px 30px rgba(36,43,66,.11)}
.image-ai-config-card{--ai-accent:#7758e8;border-color:#e7e2f7;background:linear-gradient(180deg,#fff 0%,#fcfbff 100%)}
.image-text-ai-config-card{--ai-accent:#258ca5;border-color:#dcecf0;background:linear-gradient(180deg,#fff 0%,#f9fcfd 100%)}
.ai-card-head{min-height:78px;margin-bottom:2px;border-color:#edf0f5}
.ai-card-head h3{color:#202939;letter-spacing:-.02em}
.ai-card-head p{color:#667085;font-size:11px}
.ai-card-head .settings-kicker{color:var(--ai-accent);font-weight:700}
.ai-status{display:inline-flex;flex:none;align-items:center;gap:6px;border-color:#f0d7aa;background:#fffaf1;color:#9a5b08;font-size:10px;font-weight:600;white-space:nowrap}
.ai-status::before{width:6px;height:6px;border-radius:50%;background:#eaaa43;content:''}
.ai-status.ok{border-color:#b8e5d1;background:#f0fbf5;color:#087443}
.ai-status.ok::before{background:#12a66a;box-shadow:0 0 0 3px rgba(18,166,106,.12)}
.ai-config-card .settings-field{gap:7px;color:#475467}
.ai-config-card .settings-field>span{font-size:11px;font-weight:600;color:#475467}
.ai-config-card .settings-field input,.ai-config-card .settings-field select{height:38px;border-color:#dfe3ec;border-radius:9px;background:#fff;color:#344054}
.ai-config-card .settings-field input:focus,.ai-config-card .settings-field select:focus{border-color:color-mix(in srgb,var(--ai-accent) 62%,#fff);box-shadow:0 0 0 3px color-mix(in srgb,var(--ai-accent) 13%,transparent)}
.ai-config-card .settings-field input::placeholder{color:#98a2b3}
.ai-config-card .settings-note{border:1px solid #edf0f5;background:#f7f8fa;color:#667085;line-height:1.65}
.ai-config-card .settings-note.ok{border-color:#b8e5d1;background:#f0fbf5;color:#087443}
.ai-config-card .settings-actions{gap:7px;margin-top:auto;padding-top:16px;border-top:1px solid #edf0f5}
.ai-config-card .settings-actions .unified-button{min-height:34px;border-radius:9px;font-size:11px}
.ai-config-card .settings-actions .unified-button.primary{border-color:var(--ai-accent);background:var(--ai-accent);box-shadow:0 5px 12px color-mix(in srgb,var(--ai-accent) 20%,transparent)}
.ai-config-card .settings-actions .unified-button.primary:hover{filter:brightness(1.06)}
.ai-config-card .settings-actions .unified-button.danger{border-color:#f3c7c3;background:#fffafa;color:#b42318}
.ai-config-card .image-model-picker{margin-top:14px}
.ai-config-card code{overflow-wrap:anywhere;color:var(--ai-accent)}
@media(min-width:1500px){.ai-config-grid{grid-template-columns:repeat(3,minmax(0,1fr));align-items:stretch}.image-text-ai-config-card{grid-column:auto}}
@media(max-width:1499px) and (min-width:901px){.ai-config-grid{grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch}.image-text-ai-config-card{grid-column:1/-1}}
@media(max-width:900px){.ai-config-grid{grid-template-columns:minmax(0,1fr);gap:12px}.image-text-ai-config-card{grid-column:auto}.ai-card-head{min-height:0}}
@media(prefers-reduced-motion:reduce){.ai-config-card,.ai-config-card:hover{transition:none;transform:none}}
.settings-note.error{border:1px solid #fecdca;background:#fff4f2;color:#b42318}.settings-inline-retry{margin-left:8px;padding:3px 8px;border:1px solid #fecdca;border-radius:6px;background:#fff;color:#b42318;font:inherit;cursor:pointer}.settings-inline-retry:disabled{opacity:.6;cursor:wait}.ai-load-error{display:flex;align-items:center;justify-content:space-between;gap:10px}.update-release-notes pre{max-height:240px;overflow:auto;white-space:pre-wrap;font:inherit}.settings-nav button[aria-current="page"]{font-weight:700}
</style>
