<template>
  <section class="unified-page unified-store-page" data-test="unified-store-page">
    <header class="unified-page-head">
      <div>
        <span class="dashboard-eyebrow">WORKSPACE / STORES</span>
        <h1>店铺管理</h1>
        <p>统一管理店铺、平台、登录态和本地浏览器工作区。</p>
      </div>
      <div class="unified-page-actions">
        <button type="button" class="unified-button ghost" @click="refresh">刷新</button>
        <button type="button" class="unified-button primary" @click="openCreate">＋ 添加店铺</button>
      </div>
    </header>

    <div v-if="state === 'error'" class="unified-alert error" role="alert">{{ errorMessage }} <button type="button" @click="refresh">重试</button></div>
    <div class="unified-toolbar-card">
      <label class="unified-search"><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="搜索店铺、平台、分组或标签…" /></label>
      <select v-model="platformFilter" aria-label="平台筛选">
        <option value="">全部平台</option>
        <option v-for="platform in platforms" :key="platform" :value="platform">{{ platform }}</option>
      </select>
      <div class="unified-segment" role="tablist" aria-label="店铺视图">
        <button type="button" :class="{ active: view === 'active' }" @click="view = 'active'">在用店铺</button>
        <button type="button" :class="{ active: view === 'trash' }" @click="view = 'trash'; void ws.refreshTrash()">回收站 <span>{{ ws.trashStores.length }}</span></button>
      </div>
    </div>

    <div v-if="state === 'loading'" class="unified-state"><span class="loader"></span>正在读取店铺…</div>
    <div v-else-if="view === 'trash'" class="unified-card-grid">
      <article v-for="store in ws.trashStores" :key="store.id" class="unified-store-card">
        <div class="unified-store-card-head"><PlatformIcon :name="store.platform" :size="34" /><div><strong>{{ store.name }}</strong><small>{{ store.platform }} · 已归档</small></div></div>
        <p class="unified-muted">{{ store.adminUrl || '没有后台地址' }}</p>
        <div class="unified-card-actions"><button type="button" class="unified-button ghost" @click="restore(store.id)">恢复</button><button type="button" class="unified-button danger" @click="purge(store)">彻底删除</button></div>
      </article>
      <div v-if="!ws.trashStores.length" class="unified-empty">回收站为空</div>
    </div>
    <div v-else-if="!filteredStores.length" class="unified-empty">暂无匹配店铺<button type="button" class="inline-link" @click="openCreate">添加第一家店铺</button></div>
    <div v-else class="unified-card-grid">
      <article v-for="store in filteredStores" :key="store.id" class="unified-store-card" :class="{ online: store.status === 'online' }">
        <div class="unified-store-card-head"><PlatformIcon :name="store.platform" :size="34" /><div><strong>{{ store.name }}</strong><small>{{ store.platform }} · {{ shortUrl(store.adminUrl) }}</small></div><span class="unified-status" :class="statusClass(store.status)"><i></i>{{ statusLabel(store.status) }}</span></div>
        <div class="unified-store-meta"><span>分组：{{ store.groupName || '未分组' }}</span><span>标签：{{ store.tags.length ? store.tags.join('、') : '—' }}</span></div>
        <div class="unified-card-actions"><button type="button" class="unified-button primary" @click="emit('open-store', store.id)">打开工作区</button><button type="button" class="unified-button ghost" @click="toggleArchive(store)">{{ store.status === 'archived' ? '恢复使用' : '归档' }}</button><button type="button" class="unified-icon-button" title="移入回收站" @click="remove(store)">×</button></div>
      </article>
    </div>

    <div v-if="createOpen" class="unified-overlay" @click.self="createOpen = false">
      <form class="unified-dialog" data-test="unified-create-store" @submit.prevent="submitCreate">
        <div class="unified-dialog-head"><div><span class="dashboard-eyebrow">STORE SETUP</span><h2>添加店铺</h2></div><button type="button" class="unified-icon-button" @click="createOpen = false">×</button></div>
        <label>店铺名称<input v-model="form.name" data-test="unified-store-name" required placeholder="例如：美国主站" /></label>
        <label>平台<select v-model="form.platform" data-test="unified-platform"><option v-for="platform in platformDefs" :key="platform.name" :value="platform.name">{{ platform.name }}</option><option value="其他">其他（自定义平台）</option></select></label>
        <label>后台地址<input v-model="form.adminUrl" data-test="unified-admin-url" required placeholder="https://…" /></label>
        <label>标签（逗号分隔）<input v-model="form.tags" placeholder="主账号, 售后组" /></label>
        <label>营业执照主体名称（选填）<input v-model="form.licenseName" placeholder="用于发票中心分账" /></label>
        <label>统一社会信用代码（选填）<input v-model="form.licenseNo" placeholder="18 位信用代码" /></label>
        <label>备注<textarea v-model="form.notes" rows="2"></textarea></label>
        <div v-if="createError" class="unified-alert error">{{ createError }}</div>
        <div class="unified-dialog-actions"><button type="button" class="unified-button ghost" @click="createOpen = false">取消</button><button type="submit" class="unified-button primary" :disabled="creating">{{ creating ? '创建中…' : '创建店铺' }}</button></div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PlatformIcon from '../../components/PlatformIcon.vue'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'

const emit = defineEmits<{ 'open-store': [storeId: string] }>()
const ws = useWorkspaceStore()
const state = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const query = ref('')
const platformFilter = ref('')
const view = ref<'active' | 'trash'>('active')
const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
const platformDefs = (window.shopilot.platforms || []) as Array<{ name: string; adminUrl: string }>
const form = ref({ name: '', platform: platformDefs[0]?.name || '拼多多', adminUrl: platformDefs[0]?.adminUrl || '', tags: '', notes: '', licenseName: '', licenseNo: '' })
const platforms = computed(() => [...new Set(ws.stores.map(store => store.platform))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const filteredStores = computed(() => ws.stores.filter(store => {
  const q = query.value.trim().toLowerCase()
  const matchesQuery = !q || [store.name, store.platform, store.groupName || '', ...store.tags].join(' ').toLowerCase().includes(q)
  return matchesQuery && (!platformFilter.value || store.platform === platformFilter.value)
}))

function shortUrl(value: string) { try { return new URL(value).host } catch { return value || '未配置后台地址' } }
function statusLabel(value: string) { return ({ online: '在线', launching: '启动中', needs_login: '登录失效', proxy_error: '代理异常', offline: '离线', incomplete: '离线', archived: '已归档' } as Record<string, string>)[value] || '未知状态' }
function statusClass(value: string) { return value === 'online' ? 'online' : ['needs_login', 'proxy_error'].includes(value) ? 'warning' : 'offline' }
function openCreate() { createError.value = ''; createOpen.value = true }
function refresh() { state.value = 'loading'; void ws.refreshStores().then(() => { state.value = 'ready' }).catch(error => { state.value = 'error'; errorMessage.value = error instanceof Error ? error.message : String(error) }) }
function onPlatformChange() { const platform = platformDefs.find(item => item.name === form.value.platform); if (platform && (!form.value.adminUrl || form.value.adminUrl === platformDefs[0]?.adminUrl)) form.value.adminUrl = platform.adminUrl }
async function submitCreate() {
  creating.value = true; createError.value = ''
  const response = await ws.createStore({ ...form.value, name: form.value.name.trim(), adminUrl: form.value.adminUrl.trim(), tags: form.value.tags.split(',').map(item => item.trim()).filter(Boolean) })
  creating.value = false
  if (!response?.ok) { createError.value = response?.error?.message || '创建失败'; return }
  createOpen.value = false
  form.value = { name: '', platform: platformDefs[0]?.name || '拼多多', adminUrl: platformDefs[0]?.adminUrl || '', tags: '', notes: '', licenseName: '', licenseNo: '' }
}
async function toggleArchive(store: StoreRow) { if (store.status === 'archived') await ws.restoreStore(store.id); else if (window.confirm(`确认归档「${store.name}」？`)) await ws.archiveStore(store.id) }
async function remove(store: StoreRow) { if (window.confirm(`确认将「${store.name}」移入回收站？`)) await ws.moveToTrash(store.id) }
async function restore(id: string) { await ws.restoreStore(id) }
async function purge(store: StoreRow) { if (window.confirm(`彻底删除「${store.name}」后不可恢复，确认继续？`)) await ws.purgeStore(store.id) }
watch(() => form.value.platform, onPlatformChange)
onMounted(() => { refresh(); void ws.refreshTrash() })
</script>

<style scoped>
.unified-page { min-width: 0; min-height: 0; height: 100%; overflow: auto; padding: 22px 24px 32px; color: var(--dash-text); }
.unified-page-head { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; margin-bottom:18px; }.unified-page-head h1 { margin:5px 0 7px; font-size:25px; }.unified-page-head p { margin:0; color:var(--dash-text-muted); font-size:12px; }.unified-page-actions,.unified-card-actions { display:flex; align-items:center; gap:8px; }.unified-button { min-height:32px; padding:0 13px; border:1px solid var(--dash-border); border-radius:9px; background:#ffffff; color:var(--dash-text-soft); cursor:pointer; }.unified-button:hover,.unified-button:focus-visible { border-color:rgba(151,120,255,.7); color:#fff; outline:none; }.unified-button.primary { border-color:rgba(130,92,255,.75); background:linear-gradient(135deg,#f3f0fc,#8c5cff); color:#fff; }.unified-button.danger { border-color:rgba(239,99,119,.35); color:#f04438; }.unified-button:disabled { opacity:.55; cursor:not-allowed; }.unified-toolbar-card { display:flex; align-items:center; gap:10px; padding:12px; margin-bottom:14px; border:1px solid var(--dash-border); border-radius:12px; background:#ffffff; }.unified-search { display:flex; align-items:center; gap:7px; min-width:260px; flex:1; height:34px; padding:0 10px; border:1px solid var(--dash-border); border-radius:8px; background:#f7f9fd; color:var(--dash-text-muted); }.unified-search input,.unified-toolbar-card select,.unified-dialog input,.unified-dialog select,.unified-dialog textarea { min-width:0; border:0; outline:0; background:transparent; color:var(--dash-text-soft); }.unified-toolbar-card select { height:34px; padding:0 8px; border:1px solid var(--dash-border); border-radius:8px; background:#ffffff; }.unified-segment { display:flex; gap:3px; padding:3px; border-radius:9px; background:#ebeced; }.unified-segment button { height:28px; padding:0 10px; border:0; border-radius:6px; background:transparent; color:var(--dash-text-muted); cursor:pointer; }.unified-segment button.active { background:rgba(120,85,238,.35); color:#fff; }.unified-segment span { color:var(--dash-cyan); }.unified-card-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }.unified-store-card { padding:15px; border:1px solid var(--dash-border); border-radius:13px; background:#ecedef; box-shadow:0 12px 28px rgba(0,0,0,.12); }.unified-store-card:hover { border-color:var(--dash-border-strong); transform:translateY(-1px); }.unified-store-card-head { display:flex; align-items:center; gap:10px; min-width:0; }.unified-store-card-head > div { min-width:0; flex:1; }.unified-store-card-head strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.unified-store-card-head small { display:block; margin-top:4px; color:var(--dash-text-muted); font-size:10px; }.unified-status { display:flex; align-items:center; gap:4px; flex:0 0 auto; color:var(--dash-text-muted); font-size:10px; }.unified-status i { width:7px; height:7px; border-radius:50%; background:#64748b; }.unified-status.online { color:#027a48; }.unified-status.online i { background:#12b76a; }.unified-status.warning { color:#b54708; }.unified-status.warning i { background:#f9f0eb; }.unified-store-meta { display:flex; flex-direction:column; gap:6px; margin:16px 0; color:var(--dash-text-muted); font-size:11px; }.unified-icon-button { width:30px; height:30px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--dash-text-muted); cursor:pointer; }.unified-icon-button:hover,.unified-icon-button:focus-visible { border-color:rgba(255,120,135,.45); color:#f04438; outline:none; }.unified-muted { min-height:30px; margin:13px 0; color:var(--dash-text-muted); font-size:11px; }.unified-empty,.unified-state { display:flex; min-height:190px; align-items:center; justify-content:center; gap:12px; flex-direction:column; color:var(--dash-text-muted); border:1px dashed var(--dash-border); border-radius:13px; background:#ececee; }.unified-alert { padding:10px 12px; border-radius:9px; margin-bottom:12px; font-size:12px; }.unified-alert.error { border:1px solid rgba(239,99,119,.35); background:rgba(117,37,58,.2); color:#b42318; }.unified-alert button { margin-left:9px; border:0; background:transparent; color:#fff; cursor:pointer; text-decoration:underline; }.unified-overlay { position:fixed; inset:0; z-index:110; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(15, 23, 41, .38); backdrop-filter:blur(7px); }.unified-dialog { width:min(560px,100%); max-height:calc(100vh - 40px); overflow:auto; padding:20px; border:1px solid var(--dash-border-strong); border-radius:16px; background:#ffffff; box-shadow:0 24px 80px rgba(0,0,0,.45); }.unified-dialog-head { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:15px; }.unified-dialog h2 { margin:4px 0 0; }.unified-dialog label { display:flex; flex-direction:column; gap:6px; margin:11px 0; color:var(--dash-text-soft); font-size:12px; }.unified-dialog input,.unified-dialog select,.unified-dialog textarea { width:100%; min-height:34px; padding:0 10px; border:1px solid var(--dash-border); border-radius:8px; background:#f7f9fd; }.unified-dialog textarea { padding:8px 10px; resize:vertical; }.unified-dialog input:focus,.unified-dialog select:focus,.unified-dialog textarea:focus { border-color:rgba(145,113,255,.78); box-shadow:0 0 0 2px rgba(145,113,255,.14); }.unified-dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }.inline-link { border:0; background:transparent; color:#5b3df5; cursor:pointer; }.loader { width:18px; height:18px; border:2px solid rgba(163,143,255,.2); border-top-color:#7c5cff; border-radius:50%; animation:spin .8s linear infinite; }@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:900px){.unified-page{padding:16px}.unified-toolbar-card{flex-wrap:wrap}.unified-search{min-width:100%}.unified-segment{margin-left:auto}}
</style>
