<template>
  <section :class="['unified-page unified-task-page', { workbench: props.overlay, 'task-overlay-page': props.overlay, 'picker-mode': picking }]" data-test="unified-tasks-page">
    <header class="unified-page-head"><div><span class="dashboard-eyebrow">WORKSPACE / TASKS</span><h1>AI 任务中心</h1><p>任务定义、运行状态、进度和人工确认都在同一工作区管理。</p></div><div class="unified-page-actions"><button type="button" class="unified-button ghost" @click="ws.refreshTasks()">刷新</button><button type="button" class="unified-button primary" data-test="task-new" :disabled="!ws.stores.length" @click="openCreate">＋ 新建自定义任务</button></div></header>
    <div class="task-summary-grid"><div class="task-summary"><span>全部任务</span><strong>{{ ws.tasks.length }}</strong></div><div class="task-summary"><span>运行中</span><strong>{{ activeTasks }}</strong></div><div class="task-summary"><span>等待确认</span><strong>{{ waitingTasks }}</strong></div><div class="task-summary"><span>已完成</span><strong>{{ completedTasks }}</strong></div></div>
    <div class="unified-toolbar-card"><label class="unified-search"><span>⌕</span><input v-model="query" type="search" placeholder="搜索任务名称…" /></label><select v-model="storeFilter" aria-label="任务店铺筛选"><option value="">全部店铺</option><option v-for="store in ws.stores" :key="store.id" :value="store.id">{{ store.name }}</option></select><select v-model="statusFilter" aria-label="任务状态筛选"><option value="">全部状态</option><option value="running">运行中</option><option value="queued">排队中</option><option value="waiting_confirmation">等待确认</option><option value="succeeded">已完成</option><option value="failed">执行失败</option><option value="cancelled">已取消</option></select></div>
    <div v-if="!filteredTasks.length" class="unified-empty">暂无匹配任务<span>创建任务后，进度与执行结果会由 TaskRunner 实时回传。</span></div>
    <div v-else class="unified-task-list"><article v-for="task in filteredTasks" :key="task.id" class="unified-task-card" data-test="unified-task-row"><div class="task-card-head"><div><strong>{{ task.name }}</strong><small>{{ storeName(task.storeScope) }} · {{ task.steps?.length || 0 }} 步</small></div><span class="task-status" :class="taskStatusClass(task)">{{ taskStatus(task) }}</span></div><div class="task-progress-line"><i :style="{ width: `${taskProgress(task)}%` }"></i></div><div class="task-card-meta"><span>{{ taskProgress(task) }}%</span><span>{{ latestRunTime(task) }}</span></div><div class="task-card-actions"><button v-if="!isActive(task)" type="button" class="unified-button primary" @click="runTask(task)">运行</button><button v-if="task.latestRun?.status === 'running'" type="button" class="unified-button ghost" @click="pauseTask(task)">暂停</button><button v-if="task.latestRun?.status === 'paused'" type="button" class="unified-button ghost" @click="resumeTask(task)">继续</button><button v-if="isActive(task)" type="button" class="unified-button ghost" @click="cancelTask(task)">取消</button><button v-if="task.latestRun?.status === 'waiting_confirmation'" type="button" class="unified-button primary" @click="confirmTask(task, true)">允许执行</button><button v-if="task.latestRun?.status === 'waiting_confirmation'" type="button" class="unified-button danger" @click="confirmTask(task, false)">拒绝</button><button type="button" class="unified-button ghost" @click="openStoreForTask(task)">打开店铺</button><button type="button" class="unified-icon-button" title="删除任务" @click="deleteTask(task)">×</button></div></article></div>

    <div v-if="createOpen" :class="['unified-overlay', { 'picker-overlay': picking }]" data-test="task-dialog" @click.self="closeCreate"><section class="unified-dialog modal task-create-modal" data-unified-test="unified-task-dialog"><div class="unified-dialog-head"><div><span class="dashboard-eyebrow">TASK BUILDER</span><h2>新建自定义任务</h2></div><button type="button" class="unified-icon-button" @click="closeCreate">×</button></div><div class="task-form-row"><label>任务类型<select data-test="task-flow" value="custom" disabled><option value="custom">自定义任务</option></select></label><label>绑定店铺<select v-model="draftStore"><option value="">选择店铺</option><option v-for="store in ws.stores" :key="store.id" :value="store.id">{{ store.name }}</option></select></label><label>任务名称<input v-model="draftName" data-test="custom-name" placeholder="例如：每日检查库存" /></label><label>间隔分钟（选填）<input v-model.number="draftEveryMin" type="number" min="1" max="43200" placeholder="手动运行可留空" /></label></div><div class="task-flow-blocked" data-test="task-flow-blocked">当前仅开放已实现的自定义任务流程；所有步骤仍由 TaskRunner 按真实状态执行。</div><div v-if="draftStore" class="task-editor-wrap"><CustomTaskEditor v-model:selected="selectedStep" :steps="draftSteps" :issues="draftIssues" :pick-element="pickElement" @update:steps="draftSteps = $event" @picking-change="setPicking" @notify="(text, kind) => ws.toast(text, kind)" /></div><div v-else class="unified-empty compact">先选择店铺，再开始编排步骤。</div><div class="unified-dialog-actions"><button type="button" class="unified-button ghost" data-test="task-cancel" @click="closeCreate">取消</button><button type="button" class="unified-button primary" data-test="task-submit" :disabled="!canSubmit" @click="submitTask">{{ submitting ? '创建中…' : '创建任务' }}</button></div></section></div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CustomTaskEditor from '../tasks/CustomTaskEditor.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { hasBlockingIssues, toEngineSteps, validateCustomSteps, type CustomStepDraft, type CustomStepIssue } from '@shared/custom-task'
import type { PickMode, ElementPickResult } from '@shared/element-pick'

const emit = defineEmits<{ 'open-store': [storeId: string]; close: []; 'picking-change': [value: boolean] }>()
const props = defineProps<{ autoCreate?: boolean; overlay?: boolean }>()
const ws = useWorkspaceStore()
const query = ref('')
const storeFilter = ref('')
const statusFilter = ref('')
const createOpen = ref(false)
const picking = ref(false)
const submitting = ref(false)
const draftStore = ref('')
const draftName = ref('')
const draftEveryMin = ref<number | null>(null)
const draftSteps = ref<CustomStepDraft[]>([])
const selectedStep = ref(0)
const draftIssues = computed<CustomStepIssue[]>(() => validateCustomSteps(draftSteps.value))
const filteredTasks = computed(() => ws.tasks.filter((task: any) => { const status = effectiveStatus(task); return (!query.value.trim() || String(task.name || '').toLowerCase().includes(query.value.trim().toLowerCase())) && (!storeFilter.value || task.storeScope === storeFilter.value) && (!statusFilter.value || status === statusFilter.value) }))
const activeTasks = computed(() => ws.tasks.filter((task: any) => isActive(task)).length)
const waitingTasks = computed(() => ws.tasks.filter((task: any) => effectiveStatus(task) === 'waiting_confirmation').length)
const completedTasks = computed(() => ws.tasks.filter((task: any) => effectiveStatus(task) === 'succeeded').length)
const canSubmit = computed(() => !!draftStore.value && draftSteps.value.length > 0 && !hasBlockingIssues(draftIssues.value) && !submitting.value && (!draftEveryMin.value || (Number.isInteger(Number(draftEveryMin.value)) && Number(draftEveryMin.value) >= 1 && Number(draftEveryMin.value) <= 43200)))
function effectiveStatus(task: any) { const run = task.latestRun; return run?.id ? ws.runLive[run.id]?.status || run.status : run?.status || 'idle' }
function isActive(task: any) { return ['queued', 'running', 'waiting_confirmation', 'paused'].includes(effectiveStatus(task)) }
function taskStatus(task: any) { return ({ running: '运行中', queued: '排队中', waiting_confirmation: '等待确认', paused: '已暂停', succeeded: '已完成', failed: '执行失败', cancelled: '已取消', idle: '尚未运行' } as Record<string, string>)[effectiveStatus(task)] || '未知状态' }
function taskStatusClass(task: any) { return `status-${effectiveStatus(task)}` }
function taskProgress(task: any) { const run = task.latestRun; if (!run) return 0; const live = run.id ? ws.runLive[run.id] : null; if ((live?.status || run.status) === 'succeeded') return 100; const step = live?.stepIndex ?? run.currentStep; return task.steps?.length && step != null ? Math.min(99, Math.max(0, Math.round(((step + 1) / task.steps.length) * 100))) : 0 }
function latestRunTime(task: any) { const at = task.latestRun?.finishedAt || task.latestRun?.finished_at || task.latestRun?.startedAt || task.latestRun?.started_at; return at ? new Date(at).toLocaleString('zh-CN') : '尚未运行' }
function storeName(id?: string) { return ws.stores.find(store => store.id === id)?.name || (id ? '店铺已删除' : '全部店铺') }
function nextFrame(): Promise<void> {
  return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}
/**
 * 等目标店铺的活动标签页真正注册成 guest。
 * 店铺页面现在是 Renderer DOM 里的 <webview>：开店 → 元素挂载 → did-attach → 主进程注册，
 * 中间有真实空档（渲染层刚重载、刚开店、正在切换店铺）。判据取主进程浏览器状态，
 * 不用固定毫秒数猜——猜空的时候任务会对着一个还没挂上的页面点。
 */
async function waitForStorePageReady(storeId: string, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await window.shopilot.browser.state()
    if (res.ok) {
      const entry = (res.data?.stores || []).find(item => item.storeId === storeId)
      const tabs = entry?.tabs || []
      const active = tabs.find(tab => tab.id === entry?.activeTabId) || tabs[0]
      if (active?.guestAttached) return true
    }
    if (Date.now() >= deadline) return false
    await new Promise<void>(resolve => window.setTimeout(resolve, 150))
  }
}
async function runTask(task: any) {
  if (task.storeScope) {
    if (ws.displayedStoreId !== task.storeScope) emit('open-store', task.storeScope)
    const ready = await waitForStorePageReady(task.storeScope)
    if (!ready) {
      ws.toast('店铺页面尚未就绪，任务未启动：请确认店铺浏览器已打开后重试', 'error')
      return
    }
  }
  const result = await window.shopilot.task.run(task.id, task.storeScope)
  if (!result.ok) ws.toast('运行失败：' + result.error.message, 'error'); else await ws.refreshTasks()
}
async function pauseTask(task: any) { const id = task.latestRun?.id; if (!id) return; const result = await window.shopilot.task.pause(id); if (!result.ok) ws.toast('暂停失败：' + result.error.message, 'error'); else await ws.refreshTasks() }
async function resumeTask(task: any) { const id = task.latestRun?.id; if (!id) return; const result = await window.shopilot.task.resume(id); if (!result.ok) ws.toast('继续失败：' + result.error.message, 'error'); else await ws.refreshTasks() }
async function cancelTask(task: any) { const id = task.latestRun?.id; if (!id) return; const result = await window.shopilot.task.cancel(id); if (!result.ok) ws.toast('取消失败：' + result.error.message, 'error'); else await ws.refreshTasks() }
async function confirmTask(task: any, approved: boolean) { const id = task.latestRun?.id; if (!id) return; const result = await window.shopilot.task.confirm(id, approved); if (!result.ok) ws.toast('确认失败：' + result.error.message, 'error'); else await ws.refreshTasks() }
async function deleteTask(task: any) { if (!window.confirm(`确认删除任务「${task.name}」？`)) return; const result = await window.shopilot.task.delete(task.id); if (!result.ok) ws.toast('删除失败：' + result.error.message, 'error'); else await ws.refreshTasks() }
function openStoreForTask(task: any) { if (task.storeScope) emit('open-store', task.storeScope); else ws.toast('这是全局任务，没有绑定店铺', 'info') }
function openCreate() { draftStore.value = ws.displayedStoreId || ws.stores[0]?.id || ''; draftName.value = ''; draftEveryMin.value = null; draftSteps.value = []; selectedStep.value = 0; createOpen.value = true }
function setPicking(value: boolean) {
  picking.value = value
  // 把编辑器完成回填后的状态继续传给 DashboardView；否则外层的
  // dashboard-shell.picker-mode 会一直保留，测试和用户看到的布局都不会恢复。
  emit('picking-change', value)
}
function closeCreate() { if (picking.value) return; createOpen.value = false; if (props.overlay) emit('close') }
async function pickElement(mode: PickMode): Promise<ElementPickResult> {
  if (!draftStore.value) return { ok: false, error: '请先选择店铺' } as unknown as ElementPickResult
  if (ws.displayedStoreId !== draftStore.value) await ws.showStore(draftStore.value)
  if (props.overlay) {
    picking.value = true
    emit('picking-change', true)
    // picker 布局（左侧留出真实页面、右栏收起）必须先落到 DOM 并合成两帧：
    // 用户点的是他看到的页面，布局没稳定就注入拾取层会点到旧位置。
    await nextTick()
    await nextFrame()
    await nextFrame()
  }
  // 页面可能是"元素刚挂上、主进程还没注册 guest"的状态：等注册完成再注入拾取脚本。
  const ready = await waitForStorePageReady(draftStore.value)
  if (!ready) {
    ws.toast('店铺页面尚未就绪，无法拾取元素：请确认店铺浏览器已打开后重试', 'error')
    if (props.overlay) { picking.value = false; emit('picking-change', false) }
    return { ok: false, reason: 'BROWSER_NOT_READY' } as ElementPickResult
  }
  try {
    const response = await window.shopilot.browser.pickElement(draftStore.value, mode)
    if (!response.ok) {
      ws.toast(`拾取失败：${response.error.message}`, 'error')
      return { ok: false, reason: 'INJECT_FAILED' } as ElementPickResult
    }
    const result = response.data as ElementPickResult
    if (result.cancelled) ws.toast('已取消拾取', 'info')
    return result
  } finally {
    if (props.overlay) {
      // 等调用方完成字段回填再退出 picker-mode：否则子编辑器还没 setField，
      // 外层就已恢复布局，读取字段的下一帧会拿到旧值。
      await nextTick()
      window.setTimeout(() => {
        if (picking.value) {
          picking.value = false
          emit('picking-change', false)
        }
      }, 0)
    }
  }
}
async function syncOverlay() {
  if (!props.overlay) return
  await nextTick()
  // 店铺页面现在是 Renderer DOM 里的 <webview>，弹窗靠 CSS 层级盖在上面即可；
  // 这里不再摘除/隐藏页面（旧的"原生视图摘挂"会让页面状态与登录流程一起丢）。
}
async function submitTask() { if (!canSubmit.value) return; submitting.value = true; const result = await window.shopilot.task.create({ name: draftName.value.trim() || `自定义任务 · ${new Date().toLocaleString('zh-CN')}`, storeScope: draftStore.value, steps: toEngineSteps(draftSteps.value), schedule: draftEveryMin.value ? { everyMs: Number(draftEveryMin.value) * 60000 } : null }); submitting.value = false; if (!result.ok) { ws.toast('创建失败：' + result.error.message, 'error'); return } createOpen.value = false; ws.toast('任务已创建', 'success'); await ws.refreshTasks(); if (props.overlay) emit('close') }
watch(() => [props.overlay, createOpen.value], () => { void syncOverlay() }, { immediate: true })
onBeforeUnmount(() => {
  // 弹层在拾取途中被卸载时复位布局状态；宿主页面本身不动（它是 DOM <webview>，不靠这里隐藏）。
  if (props.overlay && picking.value) {
    picking.value = false
    emit('picking-change', false)
  }
})
onMounted(() => { void ws.refreshTasks() })
watch(() => props.autoCreate, value => { if (value) openCreate() }, { immediate: true })
</script>

<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:16px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.unified-page-actions,.task-card-actions{display:flex;gap:8px;align-items:center}.unified-button{min-height:32px;padding:0 12px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:#fff;outline:none}.unified-button.primary{border-color:rgba(130,92,255,.75);background:linear-gradient(135deg,#f3f0fc,#8c5cff);color:#fff}.unified-button.danger{border-color:rgba(239,99,119,.35);color:#f04438}.unified-button:disabled{opacity:.55;cursor:not-allowed}.task-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.task-summary{display:flex;flex-direction:column;gap:7px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.task-summary span{color:var(--dash-text-muted);font-size:11px}.task-summary strong{font-size:25px}.unified-toolbar-card{display:flex;gap:10px;margin-bottom:14px;padding:12px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.unified-search{display:flex;align-items:center;gap:7px;min-width:260px;flex:1;height:34px;padding:0 10px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-muted)}.unified-search input,.unified-toolbar-card select,.task-form-row input,.task-form-row select{min-width:0;border:0;outline:0;background:transparent;color:var(--dash-text-soft)}.unified-toolbar-card select{height:34px;padding:0 8px;border:1px solid var(--dash-border);border-radius:8px;background:#ffffff}.unified-task-list{display:flex;flex-direction:column;gap:10px}.unified-task-card{padding:15px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}.task-card-head{display:flex;justify-content:space-between;gap:12px}.task-card-head strong,.task-card-head small{display:block}.task-card-head small{margin-top:5px;color:var(--dash-text-muted);font-size:10px}.task-status{padding:4px 8px;border-radius:6px;background:rgba(126,144,178,.15);color:var(--dash-text-muted);font-size:10px}.status-running{background:rgba(52,211,153,.14);color:#027a48}.status-waiting_confirmation{background:rgba(242,165,87,.14);color:#b54708}.status-failed{background:rgba(239,99,119,.15);color:#f04438}.status-succeeded{background:rgba(99,148,255,.14);color:#2e90fa}.task-progress-line{height:6px;margin-top:14px;overflow:hidden;border-radius:999px;background:rgba(120,137,173,.18)}.task-progress-line i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#f3f2ff,#25b9ff);transition:width .2s}.task-card-meta{display:flex;justify-content:space-between;margin-top:6px;color:var(--dash-text-muted);font-size:10px}.task-card-actions{justify-content:flex-end;margin-top:12px;flex-wrap:wrap}.unified-icon-button{width:30px;height:30px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dash-text-muted);cursor:pointer}.unified-icon-button:hover{color:#f04438;border-color:rgba(255,120,135,.45)}.unified-empty{display:flex;min-height:180px;align-items:center;justify-content:center;gap:8px;flex-direction:column;color:var(--dash-text-muted);border:1px dashed var(--dash-border);border-radius:12px}.unified-empty span{font-size:11px}.unified-overlay{position:fixed;inset:0;z-index:110;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(15, 23, 41, .38);backdrop-filter:blur(7px)}.unified-dialog{width:min(1180px,100%);max-height:calc(100vh - 40px);overflow:auto;padding:20px;border:1px solid var(--dash-border-strong);border-radius:16px;background:#ffffff;box-shadow:0 24px 80px rgba(0,0,0,.45)}.unified-dialog-head{display:flex;justify-content:space-between;align-items:flex-start}.unified-dialog-head h2{margin:5px 0 16px}.task-form-row{display:grid;grid-template-columns:1fr 1.5fr 180px;gap:10px;margin-bottom:14px}.task-form-row label{display:flex;flex-direction:column;gap:6px;color:var(--dash-text-soft);font-size:11px}.task-form-row input,.task-form-row select{height:34px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd}.task-editor-wrap{min-height:420px;border:1px solid var(--dash-border);border-radius:11px;overflow:hidden}.unified-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}.unified-button.ghost{background:#ffffff}
.task-overlay-page{position:fixed;inset:0;z-index:110;width:100vw;height:100vh;padding:0;overflow:visible;pointer-events:none}.task-overlay-page .unified-overlay{pointer-events:auto}.task-overlay-page .unified-overlay.picker-overlay{align-items:stretch;justify-content:flex-end;padding:0;background:transparent;backdrop-filter:none;pointer-events:none}.task-overlay-page .picker-overlay .task-create-modal{pointer-events:auto;width:min(980px,70vw);max-width:min(980px,70vw);height:100vh;max-height:100vh;box-sizing:border-box;margin:0;padding:48px 20px 20px;border-radius:0;overflow-y:auto}.task-overlay-page .picker-overlay .task-editor-wrap{min-height:0}.task-overlay-page .picker-overlay .unified-dialog-actions{padding-bottom:8px}.task-overlay-page .unified-dialog{pointer-events:auto}
@media(max-width:900px){.task-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.unified-toolbar-card{flex-wrap:wrap}.unified-search{min-width:100%}.task-form-row{grid-template-columns:1fr}}
</style>
