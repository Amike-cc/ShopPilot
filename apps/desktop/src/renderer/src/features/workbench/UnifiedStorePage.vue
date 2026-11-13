<template>
  <section class="unified-page unified-store-page" data-test="unified-store-page">
    <header class="unified-page-head">
      <div>
        <span class="dashboard-eyebrow">WORKSPACE / STORES</span>
        <h1>店铺管理</h1>
        <p>统一管理店铺、平台、登录态和本地浏览器工作区。</p>
      </div>
      <div class="unified-page-actions">
        <button type="button" class="unified-button ghost" data-test="store-export-csv" :disabled="!bridgeAvailable || exportingStores || !ws.stores.length" @click="exportStoreList">{{ exportingStores ? '导出中…' : '导出清单' }}</button>
        <button type="button" class="unified-button ghost" data-test="store-import-csv" :disabled="!bridgeAvailable || importBusy" @click="openImport">{{ importBusy ? '读取中…' : '导入清单' }}</button>
        <button type="button" class="unified-button ghost" data-test="store-bulk-toggle" :disabled="!bridgeAvailable || view === 'trash' || bulkBusy" @click="toggleBulkMode">{{ bulkMode ? '退出批量' : '批量操作' }}</button>
        <button type="button" class="unified-button ghost" data-test="store-sort-toggle" :disabled="!bridgeAvailable || view !== 'active' || filteredStores.length < 2 || bulkMode" @click="sortMode = !sortMode">{{ sortMode ? '完成排序' : '调整顺序' }}</button>
        <button type="button" class="unified-button ghost" data-test="store-batch-login" :title="`最多检测 ${BATCH_LOGIN_LIMIT} 家（按当前筛选顺序），超出部分本轮不检测`" :disabled="!bridgeAvailable || batchRunning || !ws.stores.length" @click="runBatchLogin">{{ batchRunning ? `检测中 ${batchDone}/${batchTotal}` : '批量检测登录' }}</button>
        <button type="button" class="unified-button ghost" :disabled="!bridgeAvailable" @click="refresh"><AppIcon name="refresh" :size="15" />刷新</button>
        <button type="button" class="unified-button primary" :disabled="!bridgeAvailable" @click="openCreate"><AppIcon name="plus" :size="15" />添加店铺</button>
      </div>
    </header>

    <div v-if="state === 'error'" class="unified-alert error" role="alert">{{ errorMessage }} <button type="button" @click="refresh"><AppIcon name="refresh" :size="14" />重试</button></div>
    <div class="unified-toolbar-card">
      <label class="unified-search"><AppIcon name="search" :size="15" /><input v-model="query" type="search" placeholder="搜索店铺、平台、分组或标签…" /></label>
      <select v-model="platformFilter" aria-label="平台筛选">
        <option value="">全部平台</option>
        <option v-for="platform in platforms" :key="platform" :value="platform">{{ platform }}</option>
      </select>
      <select v-model="groupFilter" aria-label="分组筛选" data-test="store-group-filter">
        <option value="">全部分组</option>
        <option value="__ungrouped__">未分组</option>
        <option v-for="group in groupOptions" :key="group" :value="group">{{ group }}</option>
      </select>
      <div class="unified-segment" role="tablist" aria-label="店铺视图">
        <button type="button" :class="{ active: view === 'active' }" @click="view = 'active'">在用店铺</button>
        <button type="button" :class="{ active: view === 'archived' }" @click="showArchived">已归档 <span>{{ archivedStores.length }}</span></button>
        <button type="button" :disabled="!bridgeAvailable" :class="{ active: view === 'trash' }" @click="showTrash">回收站 <span>{{ ws.trashStores.length }}</span></button>
      </div>
    </div>

    <div v-if="bulkMode" class="bulk-bar" data-test="store-bulk-bar">
      <strong>已选 {{ selectedIds.length }} 家</strong>
      <button type="button" class="unified-button ghost" data-test="store-bulk-select-all" @click="selectAllVisible">{{ bulkVisibleStores.length && bulkVisibleStores.every(store => isSelected(store.id)) ? '取消全选' : '全选当前' }}</button>
      <button v-if="view === 'active'" type="button" class="unified-button ghost" data-test="store-bulk-group" :disabled="!selectedIds.length || bulkBusy" @click="openBulkGroup">批量分组</button>
      <button v-if="view === 'active'" type="button" class="unified-button ghost" data-test="store-bulk-proxy" :disabled="!selectedIds.length || bulkBusy" @click="openBulkProxy">绑定代理</button>
      <button v-if="view === 'active'" type="button" class="unified-button ghost" data-test="store-bulk-archive" :disabled="!selectedIds.length || bulkBusy" @click="bulkArchive">批量归档</button>
      <button v-if="view === 'archived'" type="button" class="unified-button primary" data-test="store-bulk-restore" :disabled="!selectedIds.length || bulkBusy" @click="bulkRestore">批量恢复</button>
      <button type="button" class="unified-button danger" data-test="store-bulk-trash" :disabled="!selectedIds.length || bulkBusy" @click="bulkTrash">移入回收站</button>
      <button type="button" class="unified-button ghost" data-test="store-bulk-exit" @click="toggleBulkMode">取消批量</button>
    </div>

    <!-- 批量登录检测结果（2026-11-08）：未检测/未识别与"未登录"分开写，别让用户白跑重登 -->
    <div v-if="batchItems.length" class="unified-alert" :class="{ error: batchHasIssues, info: !batchHasIssues }" data-test="store-batch-login-result">
      <span>{{ batchText }}</span>
      <span v-if="batchNeedsLogin.length" class="batch-login-detail" data-test="store-batch-login-needs">需处理：{{ batchNeedsLogin.join('、') }}</span>
    </div>

    <div v-if="!bridgeAvailable" class="unified-alert error" role="alert">原生桥接不可用（纯渲染预览模式）：店铺数据无法加载</div>
    <div v-else-if="state === 'loading'" class="unified-state"><span class="loader"></span>正在读取店铺…</div>
    <div v-else-if="view === 'trash'" class="unified-card-grid">
      <article v-for="store in ws.trashStores" :key="store.id" class="unified-store-card">
        <div class="unified-store-card-head"><PlatformIcon :name="store.platform" :size="34" /><div><strong>{{ store.name }}</strong><small>{{ store.platform }} · 已删除</small></div></div>
        <p class="unified-muted">{{ store.adminUrl || '没有后台地址' }}</p>
        <div class="unified-card-actions"><button type="button" class="unified-button ghost" @click="restore(store.id)"><AppIcon name="refresh" :size="15" />恢复</button><button type="button" class="unified-button danger" @click="purge(store)"><AppIcon name="trash" :size="15" />彻底删除</button></div>
      </article>
      <div v-if="!ws.trashStores.length" class="unified-empty">回收站为空</div>
    </div>
    <div v-else-if="view === 'archived'" class="unified-card-grid" data-test="store-archived-view">
      <article v-for="store in archivedStores" :key="store.id" class="unified-store-card">
        <div class="unified-store-card-head"><label v-if="bulkMode" class="store-select"><input type="checkbox" :checked="isSelected(store.id)" @change="toggleSelect(store.id)" /></label><PlatformIcon :name="store.platform" :size="34" /><div><strong>{{ store.name }}</strong><small>{{ store.platform }} · 已归档</small></div><span class="unified-status warning"><i></i>已归档</span><button type="button" class="unified-icon-button" title="移入回收站" aria-label="移入回收站" @click="remove(store)"><AppIcon name="trash" :size="15" /></button></div>
        <div class="unified-store-meta"><span>分组：{{ store.groupName || '未分组' }}</span><span>标签：{{ store.tags.length ? store.tags.join('、') : '—' }}</span></div>
        <div class="unified-card-actions"><button type="button" class="unified-button primary" data-test="store-restore" @click="restore(store.id)"><AppIcon name="refresh" :size="15" />恢复使用</button><button type="button" class="unified-button ghost" data-test="store-edit-open" @click="openEdit(store)"><AppIcon name="edit" :size="15" />编辑</button></div>
      </article>
      <div v-if="!archivedStores.length" class="unified-empty">暂无已归档店铺</div>
    </div>
    <div v-else-if="!filteredStores.length" class="unified-empty">暂无匹配店铺<button type="button" class="inline-link" @click="openCreate"><AppIcon name="plus" :size="15" />添加第一家店铺</button></div>
    <div v-else class="unified-card-grid">
      <article v-for="store in filteredStores" :key="store.id" class="unified-store-card" :class="{ online: store.status === 'online' }">
        <div class="unified-store-card-head"><label v-if="bulkMode" class="store-select"><input type="checkbox" :checked="isSelected(store.id)" @change="toggleSelect(store.id)" /></label><PlatformIcon :name="store.platform" :size="34" /><div><strong>{{ store.name }}</strong><small>{{ store.platform }} · {{ shortUrl(store.adminUrl) }}</small></div><button type="button" class="unified-status status-check" :class="[statusClass(store.status), { checking: isLoginChecking(store.id) }]" :disabled="isLoginChecking(store.id)" :title="`点击检测「${store.name}」的登录状态`" :data-test="`store-login-check-${store.id}`" @click.stop="checkStoreLogin(store)"><span v-if="isLoginChecking(store.id)" class="status-spinner" aria-hidden="true"></span><i v-else></i>{{ isLoginChecking(store.id) ? '检测中…' : statusLabel(store.status) }}<AppIcon v-if="!isLoginChecking(store.id)" class="status-refresh" name="refresh" :size="10" /></button><button type="button" class="unified-icon-button" title="移入回收站" aria-label="移入回收站" @click="remove(store)"><AppIcon name="trash" :size="15" /></button></div>
        <div class="unified-store-meta"><span>分组：{{ store.groupName || '未分组' }}</span><span>标签：{{ store.tags.length ? store.tags.join('、') : '—' }}</span><span class="store-recent" :title="store.lastActiveAt ? `最近活动：${new Date(store.lastActiveAt).toLocaleString('zh-CN')}` : '尚无活动记录'">最近活动：{{ storeLastActiveLabel(store.lastActiveAt) }}</span></div>
        <div class="unified-card-actions"><button type="button" class="unified-button primary" :disabled="ws.openingStoreId === store.id" @click="emit('open-store', store.id)"><AppIcon :name="ws.openStoreIds.includes(store.id) ? 'panel' : 'external'" :size="15" />{{ ws.openingStoreId === store.id ? '正在打开…' : ws.openStoreIds.includes(store.id) ? '切回工作区' : store.status === 'needs_login' ? '去登录' : '打开工作区' }}</button><button v-if="sortMode" type="button" class="unified-button ghost" data-test="store-move-up" title="上移" @click="moveStore(store, -1)">↑</button><button v-if="sortMode" type="button" class="unified-button ghost" data-test="store-move-down" title="下移" @click="moveStore(store, 1)">↓</button><button type="button" class="unified-button ghost" data-test="store-edit-open" @click="openEdit(store)"><AppIcon name="edit" :size="15" />编辑</button><button type="button" class="unified-button ghost" data-test="store-group-open" :disabled="!bridgeAvailable" :title="`设置分组（当前：${store.groupName || '未分组'}）`" @click="openGroupEditor(store)"><AppIcon name="folder" :size="15" />分组</button><button type="button" class="unified-button ghost" @click="toggleArchive(store)"><AppIcon name="archive" :size="15" />归档</button></div>
      </article>
    </div>

    <div v-if="createOpen" class="unified-overlay" @click.self="createOpen = false">
      <form class="unified-dialog" data-test="unified-create-store" @submit.prevent="submitCreate">
        <div class="unified-dialog-head"><div><span class="dashboard-eyebrow">STORE SETUP</span><h2>添加店铺</h2></div><button type="button" class="unified-icon-button" @click="createOpen = false"><AppIcon name="close" :size="16" /></button></div>
        <label>店铺名称<input v-model="form.name" data-test="unified-store-name" required placeholder="例如：美国主站" /></label>
        <label>平台<select v-model="form.platform" data-test="unified-platform"><option v-for="platform in platformDefs" :key="platform.name" :value="platform.name">{{ platform.name }}</option><option value="其他">其他（自定义平台）</option></select></label>
        <label>后台地址<input v-model="form.adminUrl" data-test="unified-admin-url" required placeholder="https://…" /></label>
        <label>标签（逗号分隔）<input v-model="form.tags" placeholder="主账号, 售后组" /></label>
        <label>营业执照主体名称（选填）<input v-model="form.licenseName" placeholder="用于发票中心分账" /></label>
        <label>统一社会信用代码（选填）<input v-model="form.licenseNo" placeholder="18 位信用代码" /></label>
        <label>备注<textarea v-model="form.notes" rows="2"></textarea></label>
        <div v-if="createError" class="unified-alert error">{{ createError }}</div>
        <div class="unified-dialog-actions"><button type="button" class="unified-button ghost" @click="createOpen = false"><AppIcon name="close" :size="15" />取消</button><button type="submit" class="unified-button primary" :disabled="creating"><AppIcon name="plus" :size="15" />{{ creating ? '创建中…' : '创建店铺' }}</button></div>
      </form>
    </div>

    <div v-if="groupOpen" class="unified-overlay" @click.self="closeGroupEditor">
      <form class="unified-dialog" data-test="store-group-dialog" @submit.prevent="submitGroup">
        <div class="unified-dialog-head"><div><span class="dashboard-eyebrow">STORE GROUP</span><h2>设置分组</h2></div><button type="button" class="unified-icon-button" @click="closeGroupEditor"><AppIcon name="close" :size="16" /></button></div>
        <p class="unified-muted">{{ groupEditingName }} · 当前分组：{{ groupEditingCurrent || '未分组' }}</p>
        <label>分组名<input v-model="groupDraft" data-test="store-group-input" :maxlength="STORE_GROUP_MAX_LENGTH" list="store-group-options" placeholder="例如：华东区；留空保存 = 清除分组" /></label>
        <datalist id="store-group-options"><option v-for="group in groupOptions" :key="group" :value="group"></option></datalist>
        <div v-if="groupError" class="unified-alert error" role="alert">{{ groupError }}</div>
        <div class="unified-dialog-actions"><button type="button" class="unified-button ghost" data-test="store-group-clear" :disabled="groupSaving" @click="clearGroup">清除分组</button><button type="button" class="unified-button ghost" data-test="store-group-cancel" @click="closeGroupEditor"><AppIcon name="close" :size="15" />取消</button><button type="submit" class="unified-button primary" data-test="store-group-save" :disabled="groupSaving || !bridgeAvailable"><AppIcon name="folder" :size="15" />{{ groupSaving ? '保存中…' : '保存' }}</button></div>
      </form>
    </div>
    <div v-if="editOpen" class="unified-overlay" @click.self="editOpen = false">
      <form class="unified-dialog" data-test="store-edit-dialog" @submit.prevent="submitEdit">
        <div class="unified-dialog-head"><div><span class="dashboard-eyebrow">STORE PROFILE</span><h2>编辑店铺</h2></div><button type="button" class="unified-icon-button" @click="editOpen = false"><AppIcon name="close" :size="16" /></button></div>
        <label>店铺名称<input v-model="editForm.name" data-test="store-edit-name" required maxlength="120" /></label>
        <label>平台<select v-model="editForm.platform" data-test="store-edit-platform"><option v-for="platform in platformDefs" :key="platform.name" :value="platform.name">{{ platform.name }}</option><option value="其他">其他（自定义平台）</option></select></label>
        <label>后台地址<input v-model="editForm.adminUrl" data-test="store-edit-admin-url" placeholder="https://…" /></label>
        <label>标签（逗号分隔）<input v-model="editForm.tags" data-test="store-edit-tags" placeholder="主账号, 售后组" /></label>
        <div class="unified-form-grid">
          <label>分组<input v-model="editForm.groupName" data-test="store-edit-group" maxlength="120" placeholder="留空 = 未分组" /></label>
          <label>负责人<input v-model="editForm.owner" data-test="store-edit-owner" maxlength="120" /></label>
          <label>地区<input v-model="editForm.region" data-test="store-edit-region" maxlength="120" /></label>
          <label>外部编码<input v-model="editForm.externalCode" data-test="store-edit-external" maxlength="256" /></label>
        </div>
        <label>营业执照主体名称（选填）<input v-model="editForm.licenseName" maxlength="120" /></label>
        <label>统一社会信用代码（选填）<input v-model="editForm.licenseNo" maxlength="64" /></label>
        <label>备注<textarea v-model="editForm.notes" data-test="store-edit-notes" rows="2" maxlength="5000"></textarea></label>
        <div v-if="editError" class="unified-alert error" role="alert">{{ editError }}</div>
        <div class="unified-dialog-actions"><button type="button" class="unified-button ghost" @click="editOpen = false"><AppIcon name="close" :size="15" />取消</button><button type="submit" class="unified-button primary" data-test="store-edit-save" :disabled="editSaving"><AppIcon name="edit" :size="15" />{{ editSaving ? '保存中…' : '保存修改' }}</button></div>
      </form>
    </div>
    <div v-if="importOpen" class="unified-overlay" @click.self="importOpen = false">
      <section class="unified-dialog store-import-dialog" data-test="store-import-dialog">
        <div class="unified-dialog-head"><div><span class="dashboard-eyebrow">IMPORT STORES</span><h2>导入店铺清单</h2></div><button type="button" class="unified-icon-button" @click="importOpen = false"><AppIcon name="close" :size="16" /></button></div>
        <p class="unified-muted">预览来自 CSV，只导入选中的「可新增」行；重复与不合法行不会写入。导入只创建店铺元数据，不含登录态与代理凭据。</p>
        <div v-if="importCounts" class="import-summary" data-test="store-import-summary">可新增 {{ importCounts.new }} · 重复 {{ importCounts.duplicate }} · 不合法 {{ importCounts.invalid }}</div>
        <div v-if="importError" class="unified-alert error" role="alert">{{ importError }}</div>
        <div class="import-table-wrap">
          <table class="import-table" data-test="store-import-table">
            <thead><tr><th><input type="checkbox" aria-label="全选可新增" :checked="importRows.filter(row => row.status === 'new').length > 0 && importRows.filter(row => row.status === 'new').every(row => isImportSelected(Number(row.line)))" @change="toggleImportAll" /></th><th>行</th><th>店铺</th><th>平台</th><th>状态</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="row in importRows" :key="row.line" :class="`import-${row.status}`">
                <td><input type="checkbox" :data-test="'store-import-row-' + row.line" :disabled="row.status !== 'new'" :checked="isImportSelected(Number(row.line))" @change="toggleImportLine(Number(row.line))" /></td>
                <td>{{ row.line }}</td>
                <td>{{ row.name || '—' }}</td>
                <td>{{ row.platform || '—' }}</td>
                <td><span :class="['import-status', row.status]">{{ row.status === 'new' ? '可新增' : row.status === 'duplicate' ? '重复' : '不合法' }}</span></td>
                <td class="import-reasons">{{ (row.reasons || []).join('；') || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="unified-dialog-actions"><button type="button" class="unified-button ghost" @click="importOpen = false">取消</button><button type="button" class="unified-button primary" data-test="store-import-apply" :disabled="importBusy || !importSelected.length" @click="submitImport">{{ importBusy ? '导入中…' : `导入 ${importSelected.length} 家` }}</button></div>
      </section>
    </div>
    <div v-if="bulkProxyOpen" class="unified-overlay" @click.self="bulkProxyOpen = false">
      <form class="unified-dialog" data-test="store-bulk-proxy-dialog" @submit.prevent="submitBulkProxy">
        <div class="unified-dialog-head"><div><span class="dashboard-eyebrow">BULK PROXY</span><h2>批量绑定代理</h2></div><button type="button" class="unified-icon-button" @click="bulkProxyOpen = false"><AppIcon name="close" :size="16" /></button></div>
        <p class="unified-muted">为所选 {{ selectedIds.length }} 家店铺统一设置网络出口；选「直连」= 解除现有代理绑定。</p>
        <label>网络出口
          <select v-model="bulkProxyId" data-test="store-bulk-proxy-select">
            <option value="">直连（不使用代理 / 解绑）</option>
            <option v-for="proxy in bulkProxyList" :key="proxy.id" :value="proxy.id">{{ proxy.label || `${proxy.host}:${proxy.port}` }} · {{ proxy.type }}</option>
          </select>
        </label>
        <div v-if="!bulkProxyList.length" class="unified-muted">暂无已保存代理；先到店铺工作台「环境与安全」添加。</div>
        <div class="unified-dialog-actions"><button type="button" class="unified-button ghost" @click="bulkProxyOpen = false"><AppIcon name="close" :size="15" />取消</button><button type="submit" class="unified-button primary" data-test="store-bulk-proxy-save" :disabled="bulkBusy"><AppIcon name="folder" :size="15" />{{ bulkBusy ? '应用中…' : '应用到所选店铺' }}</button></div>
      </form>
    </div>
    <div v-if="bulkGroupOpen" class="unified-overlay" @click.self="bulkGroupOpen = false">
      <form class="unified-dialog" data-test="store-bulk-group-dialog" @submit.prevent="submitBulkGroup">
        <div class="unified-dialog-head"><div><span class="dashboard-eyebrow">BULK GROUP</span><h2>批量设置分组</h2></div><button type="button" class="unified-icon-button" @click="bulkGroupOpen = false"><AppIcon name="close" :size="16" /></button></div>
        <p class="unified-muted">将 {{ selectedIds.length }} 家店铺统一归入一个分组；留空保存 = 清除分组。</p>
        <label>分组名<input v-model="bulkGroupDraft" data-test="store-bulk-group-input" maxlength="120" placeholder="例如：华东区" /></label>
        <div class="unified-dialog-actions"><button type="button" class="unified-button ghost" @click="bulkGroupOpen = false"><AppIcon name="close" :size="15" />取消</button><button type="submit" class="unified-button primary" data-test="store-bulk-group-save" :disabled="bulkBusy"><AppIcon name="folder" :size="15" />{{ bulkBusy ? '保存中…' : '应用到所选店铺' }}</button></div>
      </form>
    </div>
    <div v-if="bulkConfirm.open" class="unified-overlay" @click.self="closeBulkConfirm">
      <section class="unified-dialog" data-test="store-bulk-confirm">
        <div class="unified-dialog-head"><h2>{{ bulkConfirm.title }}</h2><button type="button" class="unified-icon-button" @click="closeBulkConfirm"><AppIcon name="close" :size="16" /></button></div>
        <p class="unified-muted">{{ bulkConfirm.detail }}</p>
        <div class="unified-dialog-actions"><button type="button" class="unified-button ghost" data-test="store-bulk-confirm-cancel" :disabled="bulkBusy" @click="closeBulkConfirm">取消</button><button type="button" class="unified-button danger" data-test="store-bulk-confirm-ok" :disabled="bulkBusy" @click="confirmBulk">{{ bulkBusy ? '处理中…' : '确认' }}</button></div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import PlatformIcon from '../../components/PlatformIcon.vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'
import { storeStatusLabel } from '@shared/enums/store-status'
import { batchLoginSummaryText, summarizeBatchLogin } from '@shared/batch-login'
// 分组输入口径（规范化 / 白名单校验 / 已有分组建议）统一走纯模块，见 features/stores/store-group.ts
import { STORE_GROUP_MAX_LENGTH, listStoreGroups, validateGroupName } from '../stores/store-group'
import { storeLastActiveLabel } from './store-activity'

const emit = defineEmits<{ 'open-store': [storeId: string] }>()
const ws = useWorkspaceStore()
const state = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const query = ref('')
const platformFilter = ref('')
const groupFilter = ref('')
const sortMode = ref(false)
const bulkMode = ref(false)
const selectedIds = ref<string[]>([])
const bulkBusy = ref(false)
const bulkGroupOpen = ref(false)
const bulkGroupDraft = ref('')
const bulkConfirm = reactive({ open: false, title: '', detail: '', action: null as null | (() => Promise<void>) })
const bulkProxyOpen = ref(false)
const bulkProxyId = ref('')
const bulkProxyList = ref<Array<{ id: string; label: string | null; host: string; port: number; type: string }>>([])
const exportingStores = ref(false)
const importOpen = ref(false)
const importBusy = ref(false)
const importError = ref('')
interface ImportPreviewRow {
  line: number
  name: string
  platform: string
  status: 'new' | 'duplicate' | 'invalid'
  reasons: string[]
  [key: string]: unknown
}
const importRows = ref<ImportPreviewRow[]>([])
const importCounts = ref<{ new: number; duplicate: number; invalid: number } | null>(null)
const importSelected = ref<number[]>([])
const view = ref<'active' | 'archived' | 'trash'>('active')
const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
// P1-7（2026-10-15 审查）：无 preload（纯渲染调试模式）时不再整页 TypeError 白屏，
// 平台目录退化为空数组，页面以禁用态渲染。
const bridgeAvailable = typeof window !== 'undefined' && !!window.shopilot
const platformDefs = (window.shopilot?.platforms || []) as Array<{ name: string; adminUrl: string }>
const form = ref({ name: '', platform: platformDefs[0]?.name || '拼多多', adminUrl: platformDefs[0]?.adminUrl || '', tags: '', notes: '', licenseName: '', licenseNo: '' })
const platforms = computed(() => [...new Set(ws.stores.map(store => store.platform))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const archivedStores = computed(() => ws.stores.filter(store => store.status === 'archived'))
const activeStores = computed(() => ws.stores.filter(store => store.status !== 'archived'))
const filteredStores = computed(() => activeStores.value.filter(store => {
  const q = query.value.trim().toLowerCase()
  const matchesQuery = !q || [store.name, store.platform, store.groupName || '', ...store.tags].join(' ').toLowerCase().includes(q)
  const matchesGroup = !groupFilter.value
    || (groupFilter.value === '__ungrouped__' ? !store.groupName : store.groupName === groupFilter.value)
  return matchesQuery && matchesGroup && (!platformFilter.value || store.platform === platformFilter.value)
}))

/* ---------------- 批量登录检测（2026-11-08） ----------------
 * 逐店调一次主进程（不是一次塞 N 家）：这样进度是真实的，而且每家用完的隐藏页
 * 立刻归还，不会同时挂着 N 个 guest。超过 20 家只查前 20 家（主进程上限同值）。
 */
const BATCH_LOGIN_LIMIT = 20
interface BatchLoginRow {
  storeId: string
  storeName: string
  platform: string
  status: string
  reasonCode: string | null
  safeMessage: string | null
  skippedReason: string | null
}
const batchRunning = ref(false)
const batchDone = ref(0)
const batchTotal = ref(0)
const batchItems = ref<BatchLoginRow[]>([])
/** 单店「点状态徽标重新检测」：按店铺区分，互不影响 */
const loginCheckingIds = ref<string[]>([])
function isLoginChecking(storeId: string): boolean { return loginCheckingIds.value.includes(storeId) }
const batchSummary = computed(() => summarizeBatchLogin(batchItems.value))
const batchText = computed(() => batchLoginSummaryText(batchSummary.value))
const batchNeedsLogin = computed(() => batchItems.value
  .filter(item => item.status === 'LOGIN_REQUIRED' || item.status === 'VERIFY_REQUIRED')
  .map(item => item.storeName))
const batchHasIssues = computed(() => batchSummary.value.needsLogin > 0
  || batchSummary.value.verify > 0
  || batchSummary.value.error > 0
  || batchSummary.value.skipped > 0)

async function runBatchLogin(): Promise<void> {
  if (!bridgeAvailable || batchRunning.value) return
  const targets = filteredStores.value.filter(store => store.status !== 'archived').slice(0, BATCH_LOGIN_LIMIT)
  if (!targets.length) return
  batchRunning.value = true
  batchTotal.value = targets.length
  batchDone.value = 0
  batchItems.value = []
  try {
    for (const store of targets) {
      try {
        const response = await window.shopilot.session.batchCheckLogin([store.id])
        if (response.ok) {
          batchItems.value = [...batchItems.value, ...((response.data?.items || []) as BatchLoginRow[])]
        } else {
          batchItems.value = [...batchItems.value, {
            storeId: store.id, storeName: store.name, platform: store.platform,
            status: 'ERROR', reasonCode: null, safeMessage: response.error?.message || '检测失败', skippedReason: null
          }]
        }
      } catch (error) {
        batchItems.value = [...batchItems.value, {
          storeId: store.id, storeName: store.name, platform: store.platform,
          status: 'ERROR', reasonCode: null, safeMessage: String((error as Error)?.message || error), skippedReason: null
        }]
      }
      batchDone.value = batchItems.value.length
    }
    // 检测只按**明确证据**更新店铺状态：刷新后卡片徽标才会跟着变
    await ws.refreshStores()
  } finally {
    batchRunning.value = false
  }
}

async function checkStoreLogin(store: StoreRow): Promise<void> {
  if (!bridgeAvailable || isLoginChecking(store.id)) return
  loginCheckingIds.value = [...loginCheckingIds.value, store.id]
  batchItems.value = []
  try {
    const response = await window.shopilot.session.batchCheckLogin([store.id])
    if (response.ok) {
      batchItems.value = ((response.data?.items || []) as BatchLoginRow[])
    } else {
      batchItems.value = [{
        storeId: store.id, storeName: store.name, platform: store.platform,
        status: 'ERROR', reasonCode: null, safeMessage: response.error?.message || '检测失败', skippedReason: null
      }]
    }
    // 与批量检测同口径：只按明确证据更新状态，刷新后徽标才会变
    await ws.refreshStores()
  } catch (error) {
    batchItems.value = [{
      storeId: store.id, storeName: store.name, platform: store.platform,
      status: 'ERROR', reasonCode: null, safeMessage: String((error as Error)?.message || error), skippedReason: null
    }]
  } finally {
    loginCheckingIds.value = loginCheckingIds.value.filter(id => id !== store.id)
  }
}

function shortUrl(value: string) { try { return new URL(value).host } catch { return value || '未配置后台地址' } }function statusLabel(value: string) { return storeStatusLabel(value) }
function statusClass(value: string) { return value === 'online' ? 'online' : ['needs_login', 'proxy_error'].includes(value) ? 'warning' : 'offline' }
function openCreate() { createError.value = ''; createOpen.value = true }
function showTrash() { view.value = 'trash'; if (bridgeAvailable) void ws.refreshTrash() }
function showArchived() { view.value = 'archived'; sortMode.value = false }
/**
 * 排序：在当前筛选结果里找相邻店，再交换两者在全量序列中的位置。
 * 只按全量相邻交换的话，中间夹着被筛选掉的店铺时，屏上看起来"没动"。
 */
async function moveStore(store: StoreRow, delta: -1 | 1): Promise<void> {
  const visibleIds = filteredStores.value.map(item => item.id)
  const visibleIndex = visibleIds.indexOf(store.id)
  const targetId = visibleIds[visibleIndex + delta]
  if (!targetId) return
  const ids = ws.stores.map(item => item.id)
  const index = ids.indexOf(store.id)
  const target = ids.indexOf(targetId)
  if (index < 0 || target < 0) return
  const next = [...ids]
  ;[next[index], next[target]] = [next[target], next[index]]
  await ws.reorderStores(next)
}

/* ---------------- 批量选择与操作（2026-11-10） ---------------- */
const bulkVisibleStores = computed(() => view.value === 'archived' ? archivedStores.value : filteredStores.value)
function toggleBulkMode(): void {
  bulkMode.value = !bulkMode.value
  selectedIds.value = []
  if (bulkMode.value) sortMode.value = false
}
function isSelected(storeId: string): boolean { return selectedIds.value.includes(storeId) }
function toggleSelect(storeId: string): void {
  selectedIds.value = isSelected(storeId)
    ? selectedIds.value.filter(id => id !== storeId)
    : [...selectedIds.value, storeId]
}
function selectAllVisible(): void {
  const visible = bulkVisibleStores.value.map(store => store.id)
  selectedIds.value = visible.every(id => isSelected(id)) ? [] : visible
}
function openBulkGroup(): void {
  if (!selectedIds.value.length) return
  bulkGroupDraft.value = ''
  bulkGroupOpen.value = true
}
async function submitBulkGroup(): Promise<void> {
  if (bulkBusy.value || !selectedIds.value.length) return
  bulkBusy.value = true
  try {
    await ws.setStoresGroup([...selectedIds.value], bulkGroupDraft.value)
    bulkGroupOpen.value = false
    selectedIds.value = []
  } finally {
    bulkBusy.value = false
  }
}
async function openBulkProxy(): Promise<void> {
  if (!selectedIds.value.length) return
  const result = await window.shopilot.proxy.list()
  if (!result.ok) { ws.toast('读取代理列表失败：' + result.error.message, 'error'); return }
  bulkProxyList.value = (result.data || []) as typeof bulkProxyList.value
  bulkProxyId.value = ''
  bulkProxyOpen.value = true
}
async function submitBulkProxy(): Promise<void> {
  if (bulkBusy.value || !selectedIds.value.length) return
  bulkBusy.value = true
  try {
    await ws.bindStoresProxy([...selectedIds.value], bulkProxyId.value || null)
    bulkProxyOpen.value = false
    selectedIds.value = []
  } finally {
    bulkBusy.value = false
  }
}
function askBulk(title: string, detail: string, action: () => Promise<void>): void {
  bulkConfirm.title = title
  bulkConfirm.detail = detail
  bulkConfirm.action = action
  bulkConfirm.open = true
}
function bulkArchive(): void {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  askBulk(`归档 ${ids.length} 家店铺？`, '归档后从左侧栏与「在用店铺」移除，可在「已归档」恢复。', async () => {
    bulkBusy.value = true
    try {
      await ws.archiveStores(ids)
      selectedIds.value = []
      bulkMode.value = false
    } finally { bulkBusy.value = false }
  })
}
function bulkRestore(): void {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  askBulk(`恢复 ${ids.length} 家店铺？`, '恢复后回到「在用店铺」与左侧栏。', async () => {
    bulkBusy.value = true
    try {
      await ws.restoreStores(ids)
      selectedIds.value = []
    } finally { bulkBusy.value = false }
  })
}
function bulkTrash(): void {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  askBulk(`把 ${ids.length} 家店铺移入回收站？`, '店铺会从列表移除并关闭已打开的页面；可在回收站恢复或彻底删除。', async () => {
    bulkBusy.value = true
    try {
      await ws.moveStoresToTrash(ids)
      selectedIds.value = []
      bulkMode.value = false
    } finally { bulkBusy.value = false }
  })
}
async function confirmBulk(): Promise<void> {
  if (bulkBusy.value || !bulkConfirm.action) return
  const action = bulkConfirm.action
  bulkConfirm.open = false
  bulkConfirm.action = null
  await action()
}
function closeBulkConfirm(): void {
  if (bulkBusy.value) return
  bulkConfirm.open = false
  bulkConfirm.action = null
}
function refresh() {
  if (!bridgeAvailable) return
  state.value = 'loading'
  void ws.refreshStores().then(() => { state.value = 'ready' }).catch(error => { state.value = 'error'; errorMessage.value = error instanceof Error ? error.message : String(error) })
}
async function exportStoreList(): Promise<void> {
  if (!bridgeAvailable || exportingStores.value) return
  exportingStores.value = true
  try {
    const result = await window.shopilot.store.exportCsv()
    if (!result.ok) { ws.toast('导出店铺清单失败：' + result.error.message, 'error'); return }
    if (result.data?.canceled) return
    ws.toast(`已导出 ${Number(result.data?.rows || 0)} 家店铺清单`, 'success')
  } catch (error) {
    ws.toast('导出店铺清单失败：' + String((error as Error)?.message || error), 'error')
  } finally {
    exportingStores.value = false
  }
}
async function openImport(): Promise<void> {
  if (!bridgeAvailable || importBusy.value) return
  importBusy.value = true
  importError.value = ''
  try {
    const result = await window.shopilot.store.importPreview()
    if (!result.ok) { ws.toast('读取店铺清单失败：' + result.error.message, 'error'); return }
    if (result.data?.canceled) return
    importRows.value = Array.isArray(result.data?.rows) ? result.data.rows : []
    importCounts.value = result.data?.counts || null
    importSelected.value = importRows.value.filter(row => row.status === 'new').map(row => Number(row.line))
    importOpen.value = true
  } catch (error) {
    ws.toast('读取店铺清单失败：' + String((error as Error)?.message || error), 'error')
  } finally {
    importBusy.value = false
  }
}
function isImportSelected(line: number): boolean { return importSelected.value.includes(line) }
function toggleImportLine(line: number): void {
  importSelected.value = isImportSelected(line)
    ? importSelected.value.filter(item => item !== line)
    : [...importSelected.value, line]
}
function toggleImportAll(): void {
  const newLines = importRows.value.filter(row => row.status === 'new').map(row => Number(row.line))
  importSelected.value = newLines.every(line => isImportSelected(line)) ? [] : newLines
}
async function submitImport(): Promise<void> {
  if (importBusy.value) return
  const chosen = importRows.value.filter(row => row.status === 'new' && isImportSelected(Number(row.line)))
  if (!chosen.length) return
  importBusy.value = true
  importError.value = ''
  try {
    // Vue reactive proxy 不能直接 structured clone 过 IPC；先转成普通 JSON。
    const result = await window.shopilot.store.importApply(JSON.parse(JSON.stringify(chosen)))
    if (!result.ok) throw new Error(result.error.message)
    const created = Number(result.data?.created || 0)
    const failedCount = Array.isArray(result.data?.failed) ? result.data.failed.length : 0
    await ws.refreshStores()
    importOpen.value = false
    importRows.value = []
    ws.toast(`已导入 ${created} 家店铺${failedCount ? `，${failedCount} 家失败` : ''}`, failedCount ? 'info' : 'success')
  } catch (error) {
    importError.value = String((error as Error)?.message || error)
  } finally {
    importBusy.value = false
  }
}
function onPlatformChange(next: string, previous: string) {
  const platform = platformDefs.find(item => item.name === next)
  // 和"上一个平台"的默认地址比，而不是和目录第一家比：连续切换三次平台时，
  // 旧实现从第二次起就认不出地址仍是默认值，会保留上一平台的地址。
  const previousUrl = platformDefs.find(item => item.name === previous)?.adminUrl
  if (platform && (!form.value.adminUrl || (previousUrl && form.value.adminUrl === previousUrl))) {
    form.value.adminUrl = platform.adminUrl
  }
}
async function submitCreate() {
  if (!bridgeAvailable) return
  creating.value = true; createError.value = ''
  const response = await ws.createStore({ ...form.value, name: form.value.name.trim(), adminUrl: form.value.adminUrl.trim(), tags: form.value.tags.split(',').map(item => item.trim()).filter(Boolean) })
  creating.value = false
  if (!response?.ok) { createError.value = response?.error?.message || '创建失败'; return }
  createOpen.value = false
  form.value = { name: '', platform: platformDefs[0]?.name || '拼多多', adminUrl: platformDefs[0]?.adminUrl || '', tags: '', notes: '', licenseName: '', licenseNo: '' }
}
async function toggleArchive(store: StoreRow) {
  if (store.status === 'archived') { await ws.restoreStore(store.id); return }
  askBulk(`归档「${store.name}」？`, '归档后从左侧栏与「在用店铺」移除，可在「已归档」恢复。', async () => {
    await ws.archiveStore(store.id)
  })
}
async function remove(store: StoreRow) {
  askBulk(`将「${store.name}」移入回收站？`, '店铺会从列表移除并关闭已打开的页面；可在回收站恢复或彻底删除。', async () => {
    await ws.moveToTrash(store.id)
  })
}
async function restore(id: string) { await ws.restoreStore(id) }
async function purge(store: StoreRow) {
  askBulk(`彻底删除「${store.name}」？`, '彻底删除后不可恢复，店铺数据与本地浏览器分区都会被清理。', async () => {
    await ws.purgeStore(store.id)
  })
}

/**
 * 分组编辑浮层：页内轻量输入，不用 window.confirm/prompt（那会阻塞渲染进程并卡 CDP）。
 * 校验失败留在浮层里显示中文原因；成功/清除后关浮层并 toast。
 */
const groupOpen = ref(false)
const groupEditingId = ref<string | null>(null)
const groupEditingName = ref('')
const groupEditingCurrent = ref<string | null>(null)
const groupDraft = ref('')
const groupError = ref('')
const groupSaving = ref(false)
const groupOptions = computed(() => listStoreGroups(ws.stores))

function openGroupEditor(store: StoreRow) {
  groupEditingId.value = store.id
  groupEditingName.value = store.name
  groupEditingCurrent.value = store.groupName ?? null
  groupDraft.value = store.groupName || ''
  groupError.value = ''
  groupOpen.value = true
}
function closeGroupEditor() { groupOpen.value = false; groupEditingId.value = null; groupError.value = '' }
async function submitGroup() {
  if (!bridgeAvailable || !groupEditingId.value || groupSaving.value) return
  const checked = validateGroupName(groupDraft.value)
  if (!checked.ok) { groupError.value = checked.message; return }
  groupError.value = ''
  groupSaving.value = true
  const ok = await ws.setStoreGroup(groupEditingId.value, checked.value)
  groupSaving.value = false
  if (!ok) { groupError.value = '保存分组失败，请重试（详情见提示）'; return }
  ws.toast(checked.value ? `已归入分组「${checked.value}」` : '已清除分组', 'success')
  closeGroupEditor()
}
/** 清除 = 用空值走同一条保存路径（validate 把空值归一成 null） */
async function clearGroup() { groupDraft.value = ''; await submitGroup() }

/* ---------------- 完整编辑店铺（2026-11-09） ---------------- */
const editOpen = ref(false)
const editSaving = ref(false)
const editError = ref('')
const editStoreId = ref('')
const editForm = ref({
  name: '', platform: '', adminUrl: '', tags: '', groupName: '',
  owner: '', region: '', externalCode: '', licenseName: '', licenseNo: '', notes: ''
})
function openEdit(store: StoreRow): void {
  editStoreId.value = store.id
  editForm.value = {
    name: store.name,
    platform: store.platform,
    adminUrl: store.adminUrl,
    tags: store.tags.join(', '),
    groupName: store.groupName || '',
    owner: store.owner || '',
    region: store.region || '',
    externalCode: store.externalCode || '',
    licenseName: store.licenseName || '',
    licenseNo: store.licenseNo || '',
    notes: store.notes || ''
  }
  editError.value = ''
  editOpen.value = true
}
function onEditPlatformChange(next: string, previous: string): void {
  const platform = platformDefs.find(item => item.name === next)
  const previousUrl = platformDefs.find(item => item.name === previous)?.adminUrl
  if (platform && (!editForm.value.adminUrl || (previousUrl && editForm.value.adminUrl === previousUrl))) {
    editForm.value.adminUrl = platform.adminUrl
  }
}
async function submitEdit(): Promise<void> {
  if (!bridgeAvailable || !editStoreId.value || editSaving.value) return
  editSaving.value = true
  editError.value = ''
  const current = editForm.value
  const result = await ws.updateStore(editStoreId.value, {
    name: current.name.trim(),
    platform: current.platform,
    adminUrl: current.adminUrl.trim(),
    tags: current.tags.split(',').map(item => item.trim()).filter(Boolean),
    groupName: current.groupName.trim() || null,
    owner: current.owner.trim(),
    region: current.region.trim(),
    externalCode: current.externalCode.trim(),
    licenseName: current.licenseName.trim(),
    licenseNo: current.licenseNo.trim(),
    notes: current.notes.trim()
  })
  editSaving.value = false
  if (!result.ok) { editError.value = result.message || '保存失败'; return }
  ws.toast(`已更新「${current.name.trim()}」`, 'success')
  editOpen.value = false
}
watch(() => editForm.value.platform, onEditPlatformChange)
watch(() => form.value.platform, onPlatformChange)
// 切视图/改筛选后，之前选中的店铺可能已不可见；批量操作绝不能作用到看不见的行。
watch(view, () => { bulkMode.value = false; selectedIds.value = [] })
watch([query, platformFilter, groupFilter], () => { selectedIds.value = [] })
onMounted(() => { if (bridgeAvailable) { refresh(); void ws.refreshTrash() } else state.value = 'ready' })
</script>

<style scoped>
.unified-page { min-width: 0; min-height: 0; height: 100%; overflow: auto; padding: 22px 24px 32px; color: var(--dash-text); }
.unified-page-head { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; margin-bottom:18px; }.unified-page-head h1 { margin:5px 0 7px; font-size:25px; }.unified-page-head p { margin:0; color:var(--dash-text-muted); font-size:12px; }.unified-page-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}.unified-card-actions{display:flex;align-items:center;gap:8px}.unified-button { display:inline-flex; align-items:center; gap:5px; min-height:32px; padding:0 11px; border:1px solid var(--dash-border); border-radius:9px; background:#ffffff; color:var(--dash-text-soft); cursor:pointer; }.unified-button:hover,.unified-button:focus-visible { border-color:rgba(151,120,255,.7); color:var(--dash-text); outline:none; }.unified-button.primary { border-color:#5b3df5; background:#6d4aff; color:#ffffff; }.unified-button.danger { border-color:rgba(217,45,32,.35); color:#d92d20; }.unified-button:disabled { opacity:.55; cursor:not-allowed; }.unified-toolbar-card { display:flex; align-items:center; gap:10px; padding:12px; margin-bottom:14px; border:1px solid var(--dash-border); border-radius:12px; background:#ffffff; }.unified-search .ui-icon { flex:0 0 auto; color:var(--dash-text-muted); }.unified-search { display:flex; align-items:center; gap:7px; min-width:260px; flex:1; height:34px; padding:0 10px; border:1px solid var(--dash-border); border-radius:8px; background:#f7f9fd; color:var(--dash-text-muted); }.unified-search input { min-width:0; flex:1; width:100%; border:0; outline:0; background:transparent; color:var(--dash-text-soft); }.unified-toolbar-card select,.unified-dialog input,.unified-dialog select,.unified-dialog textarea { min-width:0; border:0; outline:0; background:transparent; color:var(--dash-text-soft); }.unified-toolbar-card select { height:34px; padding:0 8px; border:1px solid var(--dash-border); border-radius:8px; background:#ffffff; }.unified-segment { display:flex; gap:3px; padding:3px; border-radius:9px; background:#ebeced; }.unified-segment button { height:28px; padding:0 10px; border:0; border-radius:6px; background:transparent; color:var(--dash-text-muted); cursor:pointer; }.unified-segment button.active { background:#ffffff; color:var(--brand-text); box-shadow:var(--e1); }.unified-segment span { color:var(--dash-cyan-text); }.unified-card-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }.unified-store-card { padding:16px; border:1px solid var(--dash-border); border-radius:13px; background:#ffffff; box-shadow:var(--e1); transition:border-color .16s var(--ease, ease), box-shadow .16s var(--ease, ease), transform .16s var(--ease, ease); }.unified-store-card:hover { border-color:var(--brand-border); box-shadow:var(--e2); transform:translateY(-1px); }.unified-store-card-head { display:flex; align-items:center; gap:10px; min-width:0; }.unified-store-card-head > div { min-width:0; flex:1; }.unified-store-card-head strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:600; }.unified-store-card-head small { display:block; margin-top:4px; color:var(--dash-text-muted); font-size:11px; }.unified-status { display:flex; align-items:center; gap:4px; flex:0 0 auto; color:var(--dash-text-muted); font-size:11px; }.unified-status i { width:7px; height:7px; border-radius:50%; background:#64748b; }.unified-status.online { color:#027a48; }.unified-status.online i { background:#12b76a; }.unified-status.warning { color:#b54708; }.unified-status.warning i { background:#f79009; }.unified-store-meta { display:flex; flex-wrap:wrap; gap:5px 14px; margin:14px 0; color:var(--dash-text-muted); font-size:11px; }.unified-icon-button { display:grid; place-items:center; width:30px; height:30px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--dash-text-muted); cursor:pointer; }.unified-icon-button .ui-icon { color:inherit; }.unified-icon-button:hover,.unified-icon-button:focus-visible { border-color:rgba(255,120,135,.45); color:#f04438; outline:none; }.unified-muted { min-height:30px; margin:13px 0; color:var(--dash-text-muted); font-size:11px; }.unified-empty,.unified-state { display:flex; min-height:190px; align-items:center; justify-content:center; gap:12px; flex-direction:column; color:var(--dash-text-muted); border:1px dashed var(--dash-border); border-radius:13px; background:var(--ui-surface-subtle); }.unified-alert { padding:10px 12px; border-radius:9px; margin-bottom:12px; font-size:12px; }.unified-alert.error { border:1px solid var(--danger-border); background:var(--danger-soft); color:var(--danger-text); }.unified-alert button { display:inline-flex; align-items:center; gap:4px; margin-left:9px; border:0; background:transparent; color:inherit; cursor:pointer; text-decoration:underline; }.unified-overlay { position:fixed; inset:0; z-index:110; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(15, 23, 41, .38); backdrop-filter:blur(7px); }.unified-dialog { width:min(560px,100%); max-height:calc(100vh - 40px); overflow:auto; padding:20px; border:1px solid var(--dash-border-strong); border-radius:16px; background:#ffffff; box-shadow:0 24px 80px rgba(0,0,0,.45); }.unified-dialog-head { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:15px; }.unified-dialog h2 { margin:4px 0 0; }.unified-dialog label { display:flex; flex-direction:column; gap:6px; margin:11px 0; color:var(--dash-text-soft); font-size:12px; }.unified-dialog input,.unified-dialog select,.unified-dialog textarea { width:100%; min-height:34px; padding:0 10px; border:1px solid var(--dash-border); border-radius:8px; background:#f7f9fd; }.unified-dialog textarea { padding:8px 10px; resize:vertical; }.unified-dialog input:focus,.unified-dialog select:focus,.unified-dialog textarea:focus { border-color:rgba(145,113,255,.78); box-shadow:0 0 0 2px rgba(145,113,255,.14); }.unified-dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }.inline-link { border:0; background:transparent; color:#5b3df5; cursor:pointer; }.loader { width:18px; height:18px; border:2px solid rgba(163,143,255,.2); border-top-color:#7c5cff; border-radius:50%; animation:spin .8s linear infinite; }@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:900px){.unified-page{padding:16px}.unified-toolbar-card{flex-wrap:wrap}.unified-search{min-width:100%}.unified-segment{margin-left:auto}}
@media (max-width:1360px){.unified-card-grid{grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}}
.unified-alert.info { border:1px solid rgba(76,157,255,.23); background:rgba(33,91,158,.08); color:var(--dash-text-soft); }
.batch-login-detail { display:block; margin-top:5px; color:var(--dash-text-muted); }
.unified-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:0 10px; }
[data-test="store-edit-dialog"] { width:min(660px,100%); }
/* 卡片按钮不允许把中文压成竖排：整颗按钮不换行，放不下就整体换到下一行。 */
.unified-button { white-space: nowrap; flex: 0 0 auto; }
.unified-card-actions { flex-wrap: wrap; row-gap: 6px; }
.unified-store-card .unified-card-actions .unified-button { padding: 0 10px; }
.bulk-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px;padding:10px 12px;border:1px solid rgba(124,92,255,.35);border-radius:10px;background:#f6f3ff}
.bulk-bar strong{margin-right:4px;color:#4c1d95;font-size:12px}
.store-select{display:flex;align-items:center;justify-content:center;width:22px;height:22px;flex:0 0 22px;border-radius:6px;background:#ffffff;border:1px solid var(--dash-border)}
.store-select input{width:14px;height:14px;accent-color:#6d4aff;cursor:pointer}
.store-import-dialog{width:min(920px,100%)}
.import-summary{margin:6px 0 10px;color:var(--dash-text-soft);font-size:11px}
.import-table-wrap{max-height:420px;overflow:auto;border:1px solid var(--dash-border);border-radius:10px}
.import-table{width:100%;border-collapse:collapse;font-size:11px}
.import-table th,.import-table td{padding:7px 8px;border-bottom:1px solid rgba(111,137,177,.12);text-align:left;vertical-align:top}
.import-table th{position:sticky;top:0;background:#f7f9fd;color:var(--dash-text-muted);font-weight:500;white-space:nowrap}
.import-status{display:inline-block;padding:1px 6px;border-radius:5px;font-size:10px;white-space:nowrap}
.import-status.new{background:#e8f5ee;color:#027a48}
.import-status.duplicate{background:#fff4e5;color:#b54708}
.import-status.invalid{background:#fef3f2;color:#b42318}
.import-reasons{max-width:340px;color:var(--dash-text-muted);word-break:break-word}
.import-duplicate .import-reasons{color:#b54708}
.import-invalid .import-reasons{color:#b42318}
@media (max-width:600px){.unified-form-grid{grid-template-columns:1fr}}
/* 状态徽标可点：单店补一次登录检测；检测中保持同一位置，不改变卡片高度 */
.status-check{padding:3px 7px;border:1px solid transparent;border-radius:999px;background:transparent;cursor:pointer;font:inherit;line-height:1.2;transition:border-color .15s,background .15s}
.status-check:hover:not(:disabled),.status-check:focus-visible{border-color:var(--dash-border);background:#f7f9fd;outline:none}
.status-check:disabled{cursor:wait}
.status-check.checking{color:var(--dash-text-muted)}
.status-refresh{opacity:.5;transition:opacity .15s}
.status-check:hover .status-refresh,.status-check:focus-visible .status-refresh{opacity:1}
.status-spinner{width:8px;height:8px;flex:0 0 8px;border:1.5px solid rgba(109,74,255,.28);border-top-color:#6d4aff;border-radius:50%;animation:spin .8s linear infinite}
.store-recent{color:#667085}
</style>
