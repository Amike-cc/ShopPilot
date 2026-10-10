<template>
  <section :class="['customer-service-workspace', { 'workspace-hidden': !props.active }]" data-test="customer-service-workspace" aria-label="电商客服独立工作区">
    <header class="customer-service-toolbar">
      <div class="customer-service-brand"><span class="customer-service-brand-mark" aria-hidden="true">✦</span><div><strong>电商客服</strong><span>人工接待工作区</span></div></div>
      <div class="customer-service-mode"><span class="mode-dot" aria-hidden="true"></span><strong>独立客服浏览器</strong><span>与经营工作台分离</span></div>
      <div class="workspace-switcher" role="tablist" aria-label="工作区切换">
        <button
          type="button"
          class="workspace-tab"
          data-test="workspace-tab-workbench"
          role="tab"
          aria-selected="false"
          tabindex="0"
          title="返回经营工作台"
          @pointerdown.stop
          @mousedown.stop
          @click.stop.prevent="backToCommerce"
        >
          <span>工作台</span>
        </button>
        <button
          type="button"
          class="workspace-tab active"
          data-test="workspace-tab-customer-service"
          role="tab"
          aria-selected="true"
          tabindex="0"
          title="当前电商客服工作区"
          @pointerdown.stop
          @mousedown.stop
          @click.stop
        >
          <span class="workspace-product-spark" aria-hidden="true">✦</span>
          <span>电商客服</span>
        </button>
      </div>
      <div class="customer-service-toolbar-actions"><span class="customer-service-live"><i aria-hidden="true"></i>页面长活 · 会话独立保存</span><button type="button" class="customer-service-back" data-test="customer-service-back-commerce" @pointerdown.stop @mousedown.stop @click.stop.prevent="backToCommerce">返回经营工作台</button></div>
    </header>

    <div class="customer-service-body">
      <aside class="customer-service-store-rail" aria-label="客服店铺列表">
        <div class="store-rail-heading"><div><span class="section-eyebrow">CUSTOMER SERVICE</span><strong>平台客服</strong></div><span class="store-count">{{ ws.stores.length }}</span></div>
        <div v-if="!ws.ready" class="customer-service-rail-state" data-test="customer-service-loading-state"><span class="state-spinner" aria-hidden="true"></span><span>正在读取店铺…</span></div>
        <div v-else-if="!ws.stores.length" class="customer-service-rail-state" data-test="customer-service-empty-state"><span class="rail-empty-icon" aria-hidden="true">＋</span><strong>暂无店铺</strong><span>先在经营工作台添加店铺。</span></div>
        <div v-else class="customer-service-store-list">
          <button v-for="store in ws.stores" :key="store.id" type="button" :class="['customer-service-store', { active: store.id === selectedStoreId }]" :data-store-id="store.id" @click="selectStore(store.id)">
            <span class="store-avatar" :style="{ background: store.avatarColor || '#8065f5' }" aria-hidden="true">{{ store.name.slice(0, 1) }}</span><span class="store-copy"><strong :title="store.name">{{ store.name }}</strong><small>{{ store.platform }}</small></span><span class="store-state"><i :class="['store-state-dot', statusTone(storeStatus(store.id))]" aria-hidden="true"></i><small>{{ serviceEntry(store) ? (visitedStoreIds.includes(store.id) ? '已打开' : '待打开') : '未配置' }}</small></span>
          </button>
        </div>
        <div class="store-rail-footnote"><span class="footnote-icon" aria-hidden="true">i</span><span>客服工作区只保存自己的店铺选择；每家店铺使用独立客服会话。切换工作区不会关闭、重载或切换经营工作台网页。</span></div>
      </aside>

      <main class="customer-service-main">
        <div v-if="!ws.ready" class="customer-service-state" data-test="customer-service-loading-panel"><div class="customer-service-state-card"><span class="customer-service-state-icon" aria-hidden="true">✦</span><strong>正在准备客服浏览器</strong><span>店铺列表加载完成后，可以直接进入对应平台人工接待。</span></div></div>
        <div v-else-if="!ws.stores.length" class="customer-service-state" data-test="customer-service-empty-panel"><div class="customer-service-state-card"><span class="customer-service-state-icon" aria-hidden="true">＋</span><strong>还没有可接待的店铺</strong><span>请先在经营工作台添加店铺，客服浏览器不会代替你创建店铺。</span><button type="button" class="customer-service-primary" @click="backToCommerce">去添加店铺</button></div></div>
        <div v-else-if="!activeStore" class="customer-service-state"><div class="customer-service-state-card"><span class="customer-service-state-icon" aria-hidden="true">⌁</span><strong>选择一家店铺开始接待</strong><span>左侧店铺会保留各自的客服页面和登录状态。</span><span class="sr-only">未接入可靠来源、未读取平台会话时，能力未接入；不会展示推测数字。</span></div></div>
        <section v-else class="customer-service-browser" data-test="customer-service-browser">
          <div class="browser-heading"><div><span class="section-eyebrow">MANUAL REPLY / EMBEDDED BROWSER</span><h1>{{ activeStore.name }} · {{ activeStore.platform }}客服</h1></div><div class="browser-heading-meta"><span class="page-live-pill"><i aria-hidden="true"></i>客服页面长活</span><span class="message-status" :class="statusTone(selectedStatus)" :title="statusMessage(selectedStatus)"><i aria-hidden="true"></i>{{ statusLabel(selectedStatus) }}</span></div></div>
          <div class="customer-browser-shell">
            <div class="customer-browser-tabs" role="tablist" aria-label="客服页面标签">
              <button v-for="entry in visitedEntries" :key="entry.id" type="button" :class="['customer-browser-tab', { active: entry.id === selectedStoreId }]" role="tab" :aria-selected="entry.id === selectedStoreId" @click="selectStore(entry.id)"><span class="customer-tab-dot" :style="{ background: entry.avatarColor || '#8065f5' }" aria-hidden="true"></span><span>{{ entry.platform }}客服</span><i v-if="browserState(entry.id)?.loading" class="tab-loading" aria-label="加载中"></i></button>
              <span class="customer-tabs-spacer"></span><span class="customer-browser-session-note"><i aria-hidden="true"></i>独立会话</span>
            </div>
            <div class="customer-browser-addressbar"><div class="browser-nav-actions" aria-label="客服网页导航"><button type="button" class="browser-nav-button" title="后退" :disabled="!activeState?.canGoBack" data-test="customer-service-browser-back" @click="goBack"><span aria-hidden="true">‹</span></button><button type="button" class="browser-nav-button" title="前进" :disabled="!activeState?.canGoForward" data-test="customer-service-browser-forward" @click="goForward"><span aria-hidden="true">›</span></button><button type="button" class="browser-nav-button" title="刷新客服页面" data-test="customer-service-browser-reload" @click="reloadActive"><span aria-hidden="true">↻</span></button></div><div class="customer-browser-url" aria-label="当前客服页面地址"><span class="url-lock" aria-hidden="true">⌁</span><span class="url-value" :title="activeState?.url || serviceEntry(activeStore) || ''">{{ activeState?.url || serviceEntry(activeStore) || '平台客服地址未配置' }}</span></div><span class="customer-browser-load-state" :class="{ loading: activeState?.loading, failed: !!activeState?.failed }"><i aria-hidden="true"></i>{{ activeState?.loading ? '加载中' : activeState?.failed ? '加载失败' : '可接待' }}</span></div>
            <div class="customer-browser-viewport" data-test="customer-service-browser-viewport">
              <template v-for="entry in visitedEntries" :key="`view-${entry.id}`"><webview v-if="serviceEntry(entry)" :ref="customerWebviewRefCallback(entry.id)" class="customer-service-webview" :class="{ active: entry.id === selectedStoreId }" :partition="customerPartition(entry.id)" src="about:blank" :data-store-id="entry.id" :aria-label="`${entry.name} · ${entry.platform}客服页面`" allowpopups @did-attach="handleWebviewAttach(entry.id)" @did-start-loading="handleWebviewStart(entry.id)" @did-stop-loading="handleWebviewStop(entry.id)" @did-finish-load="handleWebviewFinish(entry.id)" @did-navigate="handleWebviewNavigate(entry.id, $event)" @did-navigate-in-page="handleWebviewNavigate(entry.id, $event)" @page-title-updated="handleWebviewTitle(entry.id, $event)" @did-fail-load="handleWebviewFailure(entry.id, $event)" @destroyed="handleWebviewDestroyed(entry.id)"></webview></template>
              <div v-if="!serviceEntry(activeStore)" class="customer-browser-empty" data-test="customer-service-url-unavailable"><span class="customer-browser-empty-icon" aria-hidden="true">◎</span><strong>暂未配置 {{ activeStore.platform }}客服地址</strong><span>请为该店铺选择四个平台之一。</span></div>
              <div v-else-if="activeState?.failed" class="customer-browser-error" data-test="customer-service-browser-error" role="alert"><span class="customer-browser-error-icon" aria-hidden="true">!</span><strong>客服页面暂时无法加载</strong><span>{{ activeState.failed }}</span><button type="button" class="customer-service-primary" @click="retryActive">重新加载</button></div>
              <div v-else-if="activeState?.loading" class="customer-browser-loading" data-test="customer-service-browser-loading"><span class="state-spinner" aria-hidden="true"></span><strong>正在打开 {{ activeStore.platform }}客服</strong><span>首次打开可能需要等待平台登录页返回。</span></div>
            </div>
            <div class="customer-browser-footer"><span class="footer-primary"><i aria-hidden="true"></i>人工回复</span><span>请直接在上方平台页面接待和发送消息，当前版本不自动生成或代发内容。</span><span class="footer-spacer"></span><span v-if="lastError" class="footer-error" role="alert">{{ lastError }}</span><button type="button" class="footer-refresh" :disabled="checkingStoreId === selectedStoreId" data-test="customer-service-check-now" @click="checkSelected">{{ checkingStoreId === selectedStoreId ? '检查中…' : '刷新消息状态' }}</button></div>
          </div>
        </section>
      </main>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { isCustomerMessageCheckFresh } from '@shared/contracts/customer-service'
import type { CustomerMessageCheck, CustomerMessageStatus } from '@shared/contracts/customer-service'

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: false })
const emit = defineEmits<{ 'back-commerce': [] }>()
const ws = useWorkspaceStore()
// 客服工作区只保存自己的店铺选择；兼容旧版的 shopilot.customer-service-monitor-store 记忆。
const CUSTOMER_SERVICE_STORE_KEY = 'shopilot.customer-service-browser-store'
const LEGACY_CUSTOMER_SERVICE_STORE_KEY = 'shopilot.customer-service-monitor-store'
const CUSTOMER_SERVICE_PARTITION_PREFIX = 'persist:customer-service_'
const CUSTOMER_SERVICE_URLS: Record<string, string> = { 抖店: 'https://im.jinritemai.com/pc_seller_v2/main/workspace', 拼多多: 'https://mms.pinduoduo.com/chat-merchant/index.html', 快手小店: 'https://im.kwaixiaodian.com/workbench', 微信小店: 'https://store.weixin.qq.com/shop/kf' }
interface CustomerBrowserState { serviceUrl: string; url: string; title: string; loading: boolean; attached: boolean; prepared: boolean; navigationStarted: boolean; failed: string; canGoBack: boolean; canGoForward: boolean }
const selectedStoreId = ref('')
const visitedStoreIds = ref<string[]>([])
const browserStates = reactive<Record<string, CustomerBrowserState>>({})
const webviewEls = new Map<string, any>()
const webviewRefCallbacks = new Map<string, (element: unknown) => void>()
const webviewGenerations = new Map<string, number>()
const preparingStoreIds = new Set<string>()
let workspaceMounted = false
const statuses = ref<Record<string, CustomerMessageCheck>>({})
const checkingStoreId = ref('')
const lastError = ref('')
const freshnessNow = ref(Date.now())
let statusRefreshTimer: ReturnType<typeof setInterval> | null = null
let freshnessTimer: ReturnType<typeof setInterval> | null = null
const activeStore = computed(() => ws.stores.find(store => store.id === selectedStoreId.value) || null)
const activeState = computed(() => selectedStoreId.value ? browserStates[selectedStoreId.value] || null : null)
const selectedStatus = computed(() => selectedStoreId.value ? statuses.value[selectedStoreId.value] || null : null)
const visitedEntries = computed(() => ws.stores.filter(store => visitedStoreIds.value.includes(store.id)))
function customerPartition(storeId: string): string { return `${CUSTOMER_SERVICE_PARTITION_PREFIX}${storeId}` }
function serviceEntry(store: StoreRow | null): string { return store ? CUSTOMER_SERVICE_URLS[store.platform] || '' : '' }
function readStoredStoreId(): string { try { return localStorage.getItem(CUSTOMER_SERVICE_STORE_KEY) || localStorage.getItem(LEGACY_CUSTOMER_SERVICE_STORE_KEY) || '' } catch { return '' } }
function webviewGeneration(storeId: string): number { return webviewGenerations.get(storeId) || 0 }
function bumpWebviewGeneration(storeId: string): number { const next = webviewGeneration(storeId) + 1; webviewGenerations.set(storeId, next); return next }
function ensureBrowserState(store: StoreRow): CustomerBrowserState {
  const configuredUrl = serviceEntry(store)
  const existing = browserStates[store.id]
  if (!existing) {
    browserStates[store.id] = { serviceUrl: configuredUrl, url: configuredUrl, title: `${store.platform}客服`, loading: true, attached: false, prepared: false, navigationStarted: false, failed: '', canGoBack: false, canGoForward: false }
  } else if (existing.serviceUrl !== configuredUrl) {
    // 店铺平台/客服入口可能在经营工作台被修改。旧的异步 prepare 不能再把
    // 原平台 URL 加载进同一个 WebView，先使这一代请求失效，再按新入口重来。
    bumpWebviewGeneration(store.id)
    existing.serviceUrl = configuredUrl
    existing.url = configuredUrl
    existing.title = `${store.platform}客服`
    existing.loading = true
    existing.prepared = false
    existing.navigationStarted = false
    existing.failed = ''
    existing.canGoBack = false
    existing.canGoForward = false
  }
  return browserStates[store.id]
}
function browserState(storeId: string): CustomerBrowserState | null { return browserStates[storeId] || null }
function kickPreparation(storeId: string): void {
  const store = ws.stores.find(item => item.id === storeId)
  const state = browserStates[storeId]
  if (workspaceMounted && props.active && store && state?.attached && !state.navigationStarted && !state.failed && !preparingStoreIds.has(storeId) && serviceEntry(store)) {
    void prepareCustomerService(storeId)
  }
}
function selectStore(storeId: string): void {
  const store = ws.stores.find(item => item.id === storeId)
  if (!store) return
  selectedStoreId.value = storeId
  const state = ensureBrowserState(store)
  if (!visitedStoreIds.value.includes(storeId)) visitedStoreIds.value = [...visitedStoreIds.value, storeId]
  try { localStorage.setItem(CUSTOMER_SERVICE_STORE_KEY, storeId) } catch { /* 当前会话仍可继续 */ }
  if (workspaceMounted && state.attached && !state.navigationStarted && serviceEntry(store)) kickPreparation(storeId)
}
function syncSelectedStore(): void {
  const ids = ws.stores.map(store => store.id)
  ws.stores.forEach(ensureBrowserState)
  // 店铺列表会在应用启动时先于客服工作区可见状态加载完成。隐藏工作区不能
  // 因为这次同步就自动选中首店，否则模板会创建客服 webview、准备独立
  // Session 并导航到远程客服页面，用户甚至还没打开客服入口。
  visitedStoreIds.value = visitedStoreIds.value.filter(id => ids.includes(id))
  if (!ids.length) {
    selectedStoreId.value = ''
    return
  }
  if (ids.includes(selectedStoreId.value)) {
    if (props.active) selectStore(selectedStoreId.value)
    return
  }
  if (!props.active) {
    selectedStoreId.value = ''
    return
  }
  const remembered = readStoredStoreId()
  selectStore(ids.includes(remembered) ? remembered : ids[0])
}
function customerWebviewRefCallback(storeId: string): (element: unknown) => void {
  const existing = webviewRefCallbacks.get(storeId)
  if (existing) return existing
  const callback = (element: unknown): void => {
    const previous = webviewEls.get(storeId)
    if (previous !== element) bumpWebviewGeneration(storeId)
    if (element) webviewEls.set(storeId, element)
    else webviewEls.delete(storeId)
  }
  webviewRefCallbacks.set(storeId, callback)
  return callback
}
function syncWebviewState(storeId: string): void { const state = browserStates[storeId]; const element = webviewEls.get(storeId); if (!state || !element) return; try { state.url = String(element.getURL() || state.url) } catch { /* 页面刚建立时可能尚未有 URL */ }; try { state.title = String(element.getTitle() || state.title) } catch { /* ignore */ }; try { state.canGoBack = !!element.canGoBack() } catch { state.canGoBack = false }; try { state.canGoForward = !!element.canGoForward() } catch { state.canGoForward = false } }
async function waitForWebviewElement(storeId: string, timeoutMs = 5_000, shouldContinue: () => boolean = () => true): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && shouldContinue()) {
    const element = webviewEls.get(storeId)
    if (element) return element
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return shouldContinue() ? webviewEls.get(storeId) || null : null
}
async function prepareCustomerService(storeId: string): Promise<void> {
  const store = ws.stores.find(item => item.id === storeId)
  const state = browserStates[storeId]
  if (!workspaceMounted || !props.active || !store || !state || state.navigationStarted || preparingStoreIds.has(storeId)) return
  const generation = webviewGeneration(storeId)
  preparingStoreIds.add(storeId)
  const isCurrent = (element?: any): boolean => {
    const currentStore = ws.stores.find(item => item.id === storeId)
    return workspaceMounted && props.active && !!currentStore && browserStates[storeId] === state && webviewGeneration(storeId) === generation &&
      serviceEntry(currentStore) === state.serviceUrl && (!element || webviewEls.get(storeId) === element)
  }
  state.loading = true
  state.failed = ''
  try {
    const result = await window.shopilot.customerService.prepare(storeId)
    if (!isCurrent()) return
    if (!result.ok) {
      state.loading = false
      state.failed = result.error.message
      return
    }
    state.prepared = true
    const url = String((result.data as { url?: string } | undefined)?.url || serviceEntry(store))
    if (!isCurrent() || url !== serviceEntry(ws.stores.find(item => item.id === storeId)!)) return
    state.url = url
    await nextTick()
    if (!isCurrent()) return
    const element = await waitForWebviewElement(storeId, 5_000, () => isCurrent())
    if (!isCurrent(element)) return
    if (!element || typeof element.loadURL !== 'function') {
      state.loading = false
      state.failed = '客服页面容器尚未就绪，请重新加载'
      return
    }
    state.navigationStarted = true
    await element.loadURL(url)
  } catch {
    if (!isCurrent()) return
    state.navigationStarted = false
    state.loading = false
    state.failed = '客服页面启动失败，请重新加载'
  } finally {
    preparingStoreIds.delete(storeId)
    // 切换工作区、平台更新或 WebView 重挂可能让本次调用在 IPC 返回前失效。
    // 当前容器仍有效时，在这一代结束后重新踢一次，避免留下“已挂载但永不导航”的空页。
    queueMicrotask(() => kickPreparation(storeId))
  }
}
function handleWebviewAttach(storeId: string): void { const state = browserStates[storeId]; if (!state) return; state.attached = true; state.failed = ''; syncWebviewState(storeId); void prepareCustomerService(storeId) }
function handleWebviewStart(storeId: string): void { const state = browserStates[storeId]; if (state) { state.loading = true; state.failed = '' } }
function handleWebviewStop(storeId: string): void { const state = browserStates[storeId]; if (state) state.loading = false; syncWebviewState(storeId) }
function handleWebviewFinish(storeId: string): void { const state = browserStates[storeId]; if (state) { state.loading = false; state.failed = '' }; syncWebviewState(storeId) }
function handleWebviewNavigate(storeId: string, event: any): void { const state = browserStates[storeId]; if (state && event?.url) state.url = String(event.url); syncWebviewState(storeId) }
function handleWebviewTitle(storeId: string, event: any): void { const state = browserStates[storeId]; if (state && event?.title) state.title = String(event.title) }
function handleWebviewFailure(storeId: string, event: any): void { if (Number(event?.errorCode) === -3) return; const state = browserStates[storeId]; if (!state) return; state.loading = false; state.failed = `加载失败（${event?.errorDescription || event?.errorCode || '未知原因'}）` }
function handleWebviewDestroyed(storeId: string): void { bumpWebviewGeneration(storeId); const state = browserStates[storeId]; if (state) { state.attached = false; state.prepared = false; state.navigationStarted = false }; webviewEls.delete(storeId) }
function withActiveWebview(callback: (element: any) => void): void { const element = webviewEls.get(selectedStoreId.value); if (element) callback(element) }
function goBack(): void { withActiveWebview(element => { try { if (element.canGoBack()) element.goBack() } catch { /* 页面尚未就绪 */ } }) }
function goForward(): void { withActiveWebview(element => { try { if (element.canGoForward()) element.goForward() } catch { /* 页面尚未就绪 */ } }) }
function reloadActive(): void { const state = activeState.value; if (!state?.navigationStarted) { void prepareCustomerService(selectedStoreId.value); return }; withActiveWebview(element => { try { element.reload() } catch { /* 页面尚未就绪 */ } }) }
function retryActive(): void { const store = activeStore.value; if (!store) return; const state = ensureBrowserState(store); state.failed = ''; state.loading = true; if (!state.navigationStarted) { void prepareCustomerService(store.id); return }; const element = webviewEls.get(store.id); try { element?.reload() } catch { void prepareCustomerService(store.id) } }
function storeStatus(storeId: string): CustomerMessageCheck | null { return statuses.value[storeId] || null }
function isFresh(status: CustomerMessageCheck | null | undefined): boolean { return !!status && status.freshness !== 'STALE' && isCustomerMessageCheckFresh(status.capturedAt, freshnessNow.value) }
function statusLabel(status: CustomerMessageStatus | CustomerMessageCheck | null | undefined): string { if (typeof status !== 'string' && status && !isFresh(status)) return '状态过期'; const value = typeof status === 'string' ? status : status?.status; if (value === 'CHECKING') return '检查中'; if (value === 'AVAILABLE') return '消息可读取'; if (value === 'LOGIN_REQUIRED') return '待登录'; if (value === 'PAGE_CHANGED') return '页面改版'; if (value === 'ERROR') return '检查失败'; if (value === 'NOT_VERIFIED') return '未验证'; return '未检查' }
function statusTone(status: CustomerMessageStatus | CustomerMessageCheck | null | undefined): string { if (typeof status !== 'string' && status && !isFresh(status)) return 'pending'; const value = typeof status === 'string' ? status : status?.status; if (value === 'AVAILABLE') return 'available'; if (value === 'LOGIN_REQUIRED' || value === 'ERROR') return 'error'; if (value === 'PAGE_CHANGED') return 'changed'; if (value === 'CHECKING') return 'checking'; return 'pending' }
function statusMessage(status: CustomerMessageCheck | null): string { if (status && !isFresh(status)) return '上次检查已超过实时窗口，等待新的平台证据'; return status?.message || '尚未执行客服消息检查' }
function stopStatusTimers(): void { if (statusRefreshTimer) clearInterval(statusRefreshTimer); if (freshnessTimer) clearInterval(freshnessTimer); statusRefreshTimer = null; freshnessTimer = null }
function startStatusTimers(): void { if (statusRefreshTimer) return; statusRefreshTimer = setInterval(() => { void refreshStatuses() }, 15_000); freshnessTimer = setInterval(() => { freshnessNow.value = Date.now() }, 15_000) }
async function refreshStatuses(): Promise<void> { if (!ws.ready || !ws.stores.length) return; try { const result = await window.shopilot.customerService.list({ limit: 200 }); if (!result.ok) { lastError.value = result.error.message; return }; const next: Record<string, CustomerMessageCheck> = {}; for (const item of (result.data?.items || []) as CustomerMessageCheck[]) next[item.storeId] = item; statuses.value = next } catch { lastError.value = '读取客服消息状态失败' } }
async function checkSelected(): Promise<void> { const storeId = selectedStoreId.value; if (!storeId || checkingStoreId.value) return; checkingStoreId.value = storeId; lastError.value = ''; try { const result = await window.shopilot.customerService.checkNow(storeId); if (!result.ok) { lastError.value = result.error.message; return }; statuses.value = { ...statuses.value, [storeId]: result.data as CustomerMessageCheck } } catch { lastError.value = '客服消息状态检查失败' } finally { checkingStoreId.value = '' } }
function onStatusChanged(payload: unknown): void { const item = payload as CustomerMessageCheck | null; if (!item?.storeId || !item.status) return; statuses.value = { ...statuses.value, [item.storeId]: item } }
function backToCommerce(): void { emit('back-commerce') }
watch(() => ws.stores.map(store => `${store.id}:${store.platform}:${serviceEntry(store)}`).join('|'), syncSelectedStore, { immediate: true })
watch(() => props.active, active => { if (active) syncSelectedStore() })
watch(() => props.active, active => {
  if (!active) return
  void nextTick(() => { if (selectedStoreId.value) kickPreparation(selectedStoreId.value) })
})
watch(() => [props.active, ws.ready, ws.stores.length, ws.appLocked] as const, ([active, ready, count, locked]) => { if (!active || !ready || !count || locked) { stopStatusTimers(); return }; void refreshStatuses(); startStatusTimers() }, { immediate: true })
onMounted(() => { workspaceMounted = true; window.shopilot.on(EVENT_CHANNELS.CUSTOMER_SERVICE_STATUS_CHANGED, onStatusChanged); ws.stores.forEach(ensureBrowserState) })
onBeforeUnmount(() => { workspaceMounted = false; ws.stores.forEach(store => bumpWebviewGeneration(store.id)); preparingStoreIds.clear(); stopStatusTimers(); window.shopilot.off(EVENT_CHANNELS.CUSTOMER_SERVICE_STATUS_CHANGED, onStatusChanged) })
</script>

<style scoped>
.customer-service-workspace {
  position: absolute; inset: 0; z-index: 20; display: flex; min-width: 0; min-height: 0;
  flex-direction: column; overflow: hidden; background: #f4f6fb; color: #172033; opacity: 1; pointer-events: auto; transform: translate3d(0, 0, 0); will-change: transform, opacity;
}
.customer-service-workspace.workspace-hidden { z-index: 0; opacity: 0; pointer-events: none; transform: translate3d(-200vw, 0, 0); }
.customer-service-toolbar {
  position: relative; z-index: 10; display: flex; min-height: 70px; flex: 0 0 70px; align-items: center;
  gap: 26px; padding: 0 148px 0 28px; border-bottom: 1px solid #e4e8f1; background: #fff;
  box-shadow: 0 2px 12px rgba(31, 41, 55, .04); -webkit-app-region: drag;
}
.customer-service-brand { display: flex; min-width: 218px; align-items: center; gap: 11px; }
.customer-service-brand-mark { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 11px; background: linear-gradient(135deg, #8c6bff, #5b3df5); color: #fff; font-size: 19px; }
.customer-service-brand div { display: grid; gap: 2px; }
.customer-service-brand strong { color: #172033; font-size: 15px; }
.customer-service-brand span { color: #697586; font-size: 10px; }
.customer-service-mode { display: inline-flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 12px; border: 1px solid #e2defc; border-radius: 10px; background: #faf9ff; color: #5b3df5; font-size: 11px; }
.customer-service-mode > span:last-child { color: #7c7696; }
.workspace-switcher {
  position: absolute;
  z-index: 11;
  top: 50%;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid #e1e5ed;
  border-radius: 11px;
  background: #f7f8fc;
  box-shadow: 0 1px 3px rgba(31, 41, 55, .04);
  -webkit-app-region: no-drag;
  transform: translate(-50%, -50%);
}
.workspace-tab {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 7px;
  padding: 0 13px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #697586;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background .16s, color .16s, box-shadow .16s;
}
.workspace-tab:hover, .workspace-tab:focus-visible { background: #fff; color: #273142; box-shadow: 0 2px 8px rgba(31, 41, 55, .08); }
.workspace-tab:focus-visible { outline: 2px solid rgba(128, 101, 245, .42); outline-offset: 1px; }
.workspace-tab.active { background: #fff; color: #273142; box-shadow: 0 2px 8px rgba(31, 41, 55, .08); }
.workspace-product-spark { color: #8065f5; font-size: 14px; line-height: 1; }
.mode-dot, .customer-service-live i, .message-status i, .customer-browser-load-state i { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #8065f5; }
.customer-service-toolbar-actions { display: flex; min-width: 0; align-items: center; gap: 16px; margin-left: auto; -webkit-app-region: no-drag; }
.customer-service-live { display: inline-flex; align-items: center; gap: 7px; color: #287a5b; font-size: 10px; white-space: nowrap; }
.customer-service-live i { background: #2ac987; }
.customer-service-back { min-height: 34px; padding: 0 13px; border: 1px solid #dfe4ed; border-radius: 9px; background: #fff; color: #4a5568; cursor: pointer; font-size: 11px; font-weight: 600; white-space: nowrap; }
.customer-service-back:hover, .customer-service-back:focus-visible { border-color: #bdb2ff; background: #faf9ff; color: #5b3df5; outline: none; }
.customer-service-body { display: flex; min-width: 0; min-height: 0; flex: 1; }
.customer-service-store-rail { display: flex; width: 276px; min-width: 236px; min-height: 0; flex-direction: column; padding: 22px 14px 16px; border-right: 1px solid #e2e7f0; background: #fff; }
.store-rail-heading { display: flex; align-items: flex-start; justify-content: space-between; padding: 0 8px 15px; border-bottom: 1px solid #edf0f5; }
.store-rail-heading > div { display: grid; gap: 3px; }
.section-eyebrow { color: #98a2b3; font-size: 9px; font-weight: 800; letter-spacing: .1em; line-height: 1.2; }
.store-rail-heading strong { color: #172033; font-size: 15px; }
.store-count { display: inline-flex; min-width: 23px; height: 22px; align-items: center; justify-content: center; padding: 0 6px; border-radius: 7px; background: #f1efff; color: #694cf1; font-size: 11px; font-weight: 800; }
.customer-service-store-list { min-height: 0; flex: 1; overflow-y: auto; padding: 10px 0; scrollbar-width: thin; }
.customer-service-store { display: flex; width: 100%; min-height: 61px; align-items: center; gap: 10px; padding: 9px 8px; border: 1px solid transparent; border-radius: 12px; background: transparent; color: #273142; cursor: pointer; text-align: left; }
.customer-service-store:hover, .customer-service-store:focus-visible { border-color: #e4e1ff; background: #faf9ff; outline: none; }
.customer-service-store.active { border-color: #d6d0ff; background: #f6f4ff; box-shadow: inset 3px 0 #8065f5; }
.store-avatar { display: grid; width: 31px; height: 31px; flex: 0 0 31px; place-items: center; border-radius: 9px; color: #fff; font-size: 13px; font-weight: 800; }
.store-copy { display: grid; min-width: 0; flex: 1; gap: 3px; }
.store-copy strong, .store-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.store-copy strong { color: #273142; font-size: 12px; }
.store-copy small { color: #8a94a6; font-size: 10px; }
.store-state { display: grid; min-width: 39px; justify-items: end; gap: 3px; }
.store-state small { color: #9aa3b2; font-size: 8px; white-space: nowrap; }
.store-state-dot { width: 6px; height: 6px; border-radius: 50%; background: #e5a33a; }
.store-state-dot.available { background: #22b77a; }
.store-state-dot.error { background: #ef6b61; }
.store-state-dot.checking { background: #8065f5; }
.store-state-dot.changed { background: #e3a23a; }
.customer-service-rail-state { display: grid; justify-items: center; gap: 8px; padding: 30px 12px; color: #8a94a6; font-size: 11px; text-align: center; }
.customer-service-rail-state strong { color: #4a5568; font-size: 12px; }
.state-spinner { width: 20px; height: 20px; border: 2px solid #e1defb; border-top-color: #8065f5; border-radius: 50%; animation: customer-service-spin .8s linear infinite; }
.rail-empty-icon { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 10px; background: #f1efff; color: #8065f5; font-size: 19px; }
.store-rail-footnote { display: flex; align-items: flex-start; gap: 7px; margin: auto 5px 0; padding: 10px 8px 0; border-top: 1px solid #edf0f5; color: #8993a5; font-size: 10px; line-height: 1.55; }
.footnote-icon { display: grid; width: 15px; height: 15px; flex: 0 0 15px; place-items: center; border-radius: 50%; background: #f0edff; color: #7054eb; font-size: 10px; font-weight: 800; }
.customer-service-main { min-width: 0; min-height: 0; flex: 1; overflow: hidden; padding: 24px 30px 30px; background: radial-gradient(circle at 82% -10%, rgba(128, 101, 245, .1), transparent 33%), #f4f6fb; }
.customer-service-browser { display: flex; width: 100%; max-width: 1500px; min-width: 0; min-height: 0; height: 100%; flex-direction: column; margin: 0 auto; }
.browser-heading { display: flex; min-height: 54px; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.browser-heading h1 { margin-top: 5px; color: #172033; font-size: 22px; letter-spacing: -.04em; }
.browser-heading-meta { display: flex; align-items: center; gap: 9px; padding-top: 8px; }
.page-live-pill, .message-status { display: inline-flex; align-items: center; gap: 7px; min-height: 27px; padding: 0 9px; border-radius: 999px; font-size: 9px; font-weight: 700; white-space: nowrap; }
.page-live-pill { background: #eaf8f2; color: #18845a; }
.page-live-pill i { width: 6px; height: 6px; border-radius: 50%; background: #22b77a; }
.message-status { background: #fff5df; color: #9a671d; }
.message-status.available { background: #eaf8f2; color: #18845a; }
.message-status.available i { background: #22b77a; }
.message-status.error { background: #fff0ee; color: #b43c35; }
.message-status.error i { background: #ef6b61; }
.message-status.checking { background: #f0edff; color: #5b3df5; }
.message-status.checking i { background: #8065f5; }
.customer-browser-shell { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; border: 1px solid #dfe4ee; border-radius: 15px; background: #fff; box-shadow: 0 12px 32px rgba(31, 41, 55, .07); }
.customer-browser-tabs { display: flex; min-height: 42px; align-items: stretch; gap: 3px; overflow-x: auto; padding: 5px 8px 0; border-bottom: 1px solid #e5e9f1; background: #f8f9fc; scrollbar-width: thin; }
.customer-browser-tab { display: inline-flex; min-width: 130px; max-width: 190px; align-items: center; gap: 7px; padding: 0 11px; border: 1px solid transparent; border-bottom: 0; border-radius: 9px 9px 0 0; background: transparent; color: #7a8495; cursor: pointer; font-size: 10px; white-space: nowrap; }
.customer-browser-tab:hover, .customer-browser-tab:focus-visible { background: #fff; color: #4a5568; outline: none; }
.customer-browser-tab.active { border-color: #dfe4ee; background: #fff; color: #273142; font-weight: 700; }
.customer-tab-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; }
.tab-loading { width: 10px; height: 10px; margin-left: auto; border: 1px solid #dcd7ff; border-top-color: #7354ef; border-radius: 50%; animation: customer-service-spin .8s linear infinite; }
.customer-tabs-spacer { flex: 1; }
.customer-browser-session-note { display: inline-flex; align-items: center; gap: 6px; padding: 0 9px; color: #8791a1; font-size: 9px; white-space: nowrap; }
.customer-browser-session-note i { width: 6px; height: 6px; border-radius: 50%; background: #22b77a; }
.customer-browser-addressbar { display: flex; min-height: 48px; align-items: center; gap: 11px; padding: 7px 11px; border-bottom: 1px solid #e8ebf2; background: #fff; }
.browser-nav-actions { display: flex; gap: 2px; }
.browser-nav-button { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 7px; color: #586476; cursor: pointer; font-size: 21px; line-height: 1; }
.browser-nav-button:hover, .browser-nav-button:focus-visible { background: #f0edff; color: #5b3df5; outline: none; }
.browser-nav-button:disabled { background: transparent; color: #c4cbd6; cursor: not-allowed; }
.customer-browser-url { display: flex; min-width: 0; min-height: 31px; flex: 1; align-items: center; gap: 8px; padding: 0 11px; border: 1px solid #e2e6ee; border-radius: 9px; background: #f8f9fc; color: #667286; }
.url-lock { color: #8e98a9; font-size: 13px; }
.url-value { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.customer-browser-load-state { display: inline-flex; min-width: 52px; align-items: center; gap: 6px; color: #18845a; font-size: 9px; white-space: nowrap; }
.customer-browser-load-state.loading { color: #6951dc; }
.customer-browser-load-state.loading i { background: #8065f5; }
.customer-browser-load-state.failed { color: #b43c35; }
.customer-browser-load-state.failed i { background: #ef6b61; }
.customer-browser-viewport { position: relative; min-width: 0; min-height: 0; flex: 1; overflow: hidden; background: #f8f9fc; }
/* Keep each visited platform's webview mounted. Inactive pages are moved out of the hit/render path without unloading their session. */
.customer-service-webview { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; pointer-events: none; transform: translate3d(-200vw, 0, 0); will-change: transform, opacity; border: 0; background: #fff; }
.customer-service-webview.active { opacity: 1; pointer-events: auto; transform: translate3d(0, 0, 0); }
.customer-browser-loading, .customer-browser-error, .customer-browser-empty { position: absolute; inset: 0; display: grid; align-content: center; justify-items: center; gap: 9px; padding: 30px; background: #fff; color: #697586; font-size: 11px; text-align: center; }
.customer-browser-loading strong, .customer-browser-error strong, .customer-browser-empty strong { color: #273142; font-size: 14px; }
.customer-browser-loading .state-spinner { width: 28px; height: 28px; }
.customer-browser-empty-icon, .customer-browser-error-icon { display: grid; width: 45px; height: 45px; place-items: center; border-radius: 14px; background: #f0edff; color: #6a4cf3; font-size: 22px; font-weight: 800; }
.customer-browser-error-icon { background: #fff0ee; color: #c24d43; }
.customer-browser-error .customer-service-primary { margin-top: 5px; }
.customer-browser-footer { display: flex; min-height: 38px; align-items: center; gap: 8px; padding: 0 12px; border-top: 1px solid #e8ebf2; color: #8993a5; font-size: 9px; }
.footer-primary { display: inline-flex; align-items: center; gap: 6px; color: #18845a; font-weight: 700; white-space: nowrap; }
.footer-primary i { width: 6px; height: 6px; border-radius: 50%; background: #22b77a; }
.footer-spacer { flex: 1; }
.footer-error { overflow: hidden; max-width: 260px; color: #b43c35; text-overflow: ellipsis; white-space: nowrap; }
.footer-refresh { min-height: 25px; padding: 0 8px; border: 1px solid #dfe4ed; border-radius: 7px; background: #fff; color: #6a7587; cursor: pointer; font-size: 9px; }
.footer-refresh:hover, .footer-refresh:focus-visible { border-color: #bdb2ff; background: #faf9ff; color: #5b3df5; outline: none; }
.customer-service-state { display: grid; min-width: 0; min-height: 0; height: 100%; place-items: center; padding: 24px; }
.customer-service-state-card { display: grid; max-width: 460px; justify-items: center; gap: 9px; padding: 38px 44px; border: 1px solid #e5e9f2; border-radius: 20px; background: #fff; box-shadow: 0 16px 42px rgba(31, 41, 55, .07); text-align: center; }
.customer-service-state-icon { display: grid; width: 48px; height: 48px; place-items: center; border-radius: 15px; background: #f0edff; color: #6a4cf3; font-size: 23px; font-weight: 700; }
.customer-service-state-card strong { color: #172033; font-size: 17px; }
.customer-service-state-card > span:not(.customer-service-state-icon) { color: #697586; font-size: 11px; line-height: 1.65; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; clip-path: inset(50%); }
.customer-service-primary { min-height: 34px; margin-top: 9px; padding: 0 15px; border: 1px solid #6b4df4; border-radius: 9px; background: #6b4df4; color: #fff; cursor: pointer; font-size: 11px; font-weight: 700; }
.customer-service-primary:hover, .customer-service-primary:focus-visible { border-color: #5535df; background: #5535df; outline: none; }
@keyframes customer-service-spin { to { transform: rotate(360deg); } }
@media (max-width: 900px) {
  .customer-service-toolbar { gap: 10px; padding: 0 148px 0 14px; }
  .customer-service-brand { min-width: 0; }
  .customer-service-brand div span, .customer-service-live, .customer-service-mode > span:last-child { display: none; }
  .customer-service-mode { padding: 0 8px; }
  .customer-service-store-rail { width: 205px; min-width: 185px; padding-right: 9px; padding-left: 9px; }
  .customer-service-main { padding: 20px 18px 22px; }
  .browser-heading h1 { font-size: 19px; }
  .customer-browser-footer > span:nth-child(2) { display: none; }
}
</style>
