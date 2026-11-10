<template>
  <div class="unified-overlay" data-test="collection-history-dialog" @click.self="emit('close')">
    <section class="unified-dialog collection-history">
      <div class="unified-dialog-head">
        <div><span class="dashboard-eyebrow">COLLECTION HISTORY</span><h2>{{ title }} · 采集记录</h2></div>
        <button type="button" class="unified-icon-button" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <p class="ch-sub">最近 {{ rows.length }} 次后台采集；失败原因按原错误码/消息展示，不含页面原文与买家信息。</p>
      <div v-if="error" class="unified-alert error" role="alert">{{ error }} <button type="button" @click="load">重试</button></div>
      <div v-else-if="loading" class="unified-state compact"><span class="loader"></span>正在读取采集记录…</div>
      <div v-else-if="!rows.length" class="unified-empty compact">还没有后台采集记录。开通自动更新或手动采集一次后再看。</div>
      <div v-else class="ch-table-wrap">
        <table class="ch-table">
          <thead><tr><th>时间</th><th>店铺</th><th>状态</th><th>错误 / 说明</th></tr></thead>
          <tbody>
            <tr v-for="row in rows" :key="row.runId">
              <td class="ch-time">{{ formatTime(row.finishedAt || row.startedAt) }}</td>
              <td>{{ row.storeName }}</td>
              <td><span class="ch-status" :class="`status-${row.status}`">{{ statusLabel(row.status) }}</span></td>
              <td class="ch-error" :class="{ 'has-error': row.status === 'failed' || row.status === 'cancelled' || !!row.errorCode || !!row.errorMessage }">
                <template v-if="row.errorCode || row.errorMessage">{{ row.errorCode || '' }}<template v-if="row.errorCode && row.errorMessage"> · </template>{{ row.errorMessage || '' }}</template>
                <template v-else>{{ row.statusReason || '—' }}</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="unified-dialog-actions"><button type="button" class="unified-button" @click="emit('close')">关闭</button></div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{ domain: 'invoice' | 'tax' }>()
const emit = defineEmits<{ close: [] }>()
interface HistoryRow {
  runId: string
  taskName: string
  storeName: string
  status: string
  startedAt: number | null
  finishedAt: number | null
  errorCode: string | null
  errorMessage: string | null
  statusReason: string | null
}
const rows = ref<HistoryRow[]>([])
const loading = ref(true)
const error = ref('')
const title = computed(() => props.domain === 'invoice' ? '发票中心' : '涉税信息')
const STATUS_LABEL: Record<string, string> = {
  queued: '排队中', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停',
  succeeded: '已完成', failed: '执行失败', cancelled: '已取消', idle: '尚未运行'
}
function statusLabel(status: string): string { return STATUS_LABEL[status] || status || '未知' }
function formatTime(value: number | null): string { return value ? new Date(value).toLocaleString('zh-CN') : '—' }
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await window.shopilot.overview.collectionHistory(props.domain, 20)
    if (!result.ok) throw new Error(result.error.message)
    rows.value = (result.data || []) as HistoryRow[]
  } catch (err) {
    error.value = String((err as Error)?.message || err)
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>

<style scoped>
.collection-history { width: min(900px, 100%); }
.unified-overlay { position: fixed; inset: 0; z-index: 120; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(15, 23, 41, .38); backdrop-filter: blur(7px); }
.unified-dialog { box-sizing: border-box; max-height: calc(100vh - 48px); overflow: auto; padding: 20px; border: 1px solid var(--dash-border-strong); border-radius: 16px; background: #fff; box-shadow: 0 24px 80px rgba(0, 0, 0, .45); }
.unified-dialog-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.unified-dialog-head h2 { margin: 5px 0 10px; }
.unified-icon-button { width: 30px; height: 30px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--dash-text-muted); font-size: 20px; cursor: pointer; }
.unified-icon-button:hover { border-color: var(--dash-border); color: var(--dash-text); }
.ch-sub { margin: 0 0 12px; color: var(--dash-text-muted); font-size: 11px; }
.unified-alert { padding: 10px 12px; border-radius: 9px; margin-bottom: 12px; font-size: 12px; }
.unified-alert.error { border: 1px solid rgba(239,99,119,.35); background: rgba(117,37,58,.2); color: #b42318; }
.unified-alert button { margin-left: 8px; border: 0; background: transparent; color: inherit; text-decoration: underline; cursor: pointer; }
.unified-state, .unified-empty { display: flex; min-height: 120px; align-items: center; justify-content: center; gap: 10px; flex-direction: column; color: var(--dash-text-muted); border: 1px dashed var(--dash-border); border-radius: 11px; }
.unified-state.compact, .unified-empty.compact { min-height: 100px; }
.loader { width: 18px; height: 18px; border: 2px solid rgba(163,143,255,.2); border-top-color: #7c5cff; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }
.ch-table-wrap { max-height: 420px; overflow: auto; }
.ch-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ch-table th, .ch-table td { padding: 8px; border-bottom: 1px solid rgba(111,137,177,.12); text-align: left; vertical-align: top; }
.ch-table th { position: sticky; top: 0; z-index: 1; background: #fff; color: var(--dash-text-muted); font-weight: 500; white-space: nowrap; }
.ch-time { white-space: nowrap; color: var(--dash-text-muted); }
.ch-status { padding: 2px 6px; border-radius: 5px; background: #eef1f7; color: var(--dash-text-muted); white-space: nowrap; }
.ch-status.status-succeeded { background: #e8f5ee; color: #027a48; }
.ch-status.status-failed { background: #fef3f2; color: #b42318; }
.ch-status.status-running { background: #eaf2ff; color: #1d6fe8; }
.ch-error { max-width: 420px; color: var(--dash-text-muted); word-break: break-word; }
.ch-error.has-error { color: #b42318; }
.unified-dialog-actions { display: flex; justify-content: flex-end; margin-top: 14px; }
</style>
