<script setup lang="ts">
/**
 * 应用商城 · 插件（2026-11-09）
 *
 * 把「插件中心」从设置里搬到应用商城的主位：内置目录安装/重装、已装扩展启停/重载、
 * 浏览器扩展总开关。本地导入与删除仍留在 设置 → 浏览器扩展（高级操作）。
 * 数据全部来自主进程现有 IPC，不在渲染层猜状态。
 */
import { computed, onMounted, ref } from 'vue'
import { isNewerVersion } from '@shared/version-compare'
import type {
  BrowserExtensionCatalogItem,
  BrowserExtensionCatalogResult,
  BrowserExtensionItem,
  BrowserExtensionListResult
} from '@shared/contracts/extensions'

const catalog = ref<BrowserExtensionCatalogItem[]>([])
const extensions = ref<BrowserExtensionItem[]>([])
const master = ref(false)
const loading = ref(true)
const busyKey = ref('')
const error = ref('')
const notice = ref('')

const installedCount = computed(() => extensions.value.length)
const enabledCount = computed(() => extensions.value.filter((item) => item.enabled).length)
const masterOff = computed(() => !master.value)
/** 内置目录版本 vs 本机已装清单版本：只做本地对比，不联网检查。 */
const installedVersionById = computed(() => new Map(extensions.value.map(item => [item.id, item.version])))
function installedVersion(entry: BrowserExtensionCatalogItem): string {
  return installedVersionById.value.get(entry.id) || ''
}
function updateAvailable(entry: BrowserExtensionCatalogItem): boolean {
  const current = installedVersion(entry)
  return !!current && isNewerVersion(entry.version, current)
}

const STATUS_LABEL: Record<string, string> = {
  loaded: '已加载',
  enabled: '已启用（打开店铺后生效）',
  disabled: '未启用',
  invalid: '清单不合法',
  load_failed: '加载失败',
  missing: '文件缺失'
}

function responseError(result: unknown, fallback: string): string {
  if (!result || typeof result !== 'object' || !('error' in result)) return fallback
  const detail = (result as { error?: unknown }).error
  if (!detail || typeof detail !== 'object') return fallback
  const fields = detail as { message?: unknown; code?: unknown }
  return String(fields.message || fields.code || fallback)
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] || status
}

function permissionLabel(permissions: string[]): string {
  return permissions.length ? permissions.join(' / ') : '无声明权限'
}

function applyList(result: BrowserExtensionListResult | null | undefined): void {
  master.value = result?.master === true
  extensions.value = Array.isArray(result?.items) ? result.items : []
}

function setNotice(text: string): void {
  notice.value = text
  window.setTimeout(() => {
    if (notice.value === text) notice.value = ''
  }, 2600)
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [catalogResult, extensionResult] = await Promise.all([
      window.shopilot.extensions.catalog(),
      window.shopilot.extensions.list()
    ])
    if (catalogResult.ok) {
      const data = catalogResult.data as BrowserExtensionCatalogResult
      catalog.value = Array.isArray(data?.entries) ? data.entries : []
      if (data?.sourceError) error.value = data.sourceError
    } else {
      error.value = responseError(catalogResult, '读取内置插件目录失败')
    }
    if (extensionResult.ok) applyList(extensionResult.data as BrowserExtensionListResult)
    else if (!error.value) error.value = responseError(extensionResult, '读取已安装扩展失败')
  } catch (e) {
    error.value = '读取插件状态失败：' + String((e as Error)?.message || e)
  } finally {
    loading.value = false
  }
}

async function install(entry: BrowserExtensionCatalogItem): Promise<void> {
  busyKey.value = 'install:' + entry.key
  error.value = ''
  try {
    const result = await window.shopilot.extensions.installFromCatalog(entry.key)
    if (!result.ok) throw new Error(responseError(result, '安装插件失败'))
    const data = result.data as { list?: BrowserExtensionListResult; masterOff?: boolean }
    applyList(data?.list)
    await refresh()
    setNotice(data?.masterOff
      ? `已安装「${entry.name}」；打开扩展总开关后生效`
      : `已安装并启用「${entry.name}」`)
  } catch (e) {
    error.value = String((e as Error)?.message || e)
  } finally {
    busyKey.value = ''
  }
}

async function runAction(key: string, action: () => Promise<{ ok: boolean; data?: unknown; error?: unknown }>, successText: string): Promise<void> {
  busyKey.value = key
  error.value = ''
  try {
    const result = await action()
    if (!result.ok) throw new Error(responseError(result, '操作失败'))
    applyList(result.data as BrowserExtensionListResult)
    setNotice(successText)
  } catch (e) {
    error.value = String((e as Error)?.message || e)
  } finally {
    busyKey.value = ''
  }
}

function toggleMaster(): Promise<void> {
  const next = !master.value
  return runAction(
    'master',
    () => window.shopilot.extensions.setMaster(next),
    next ? '已开启浏览器扩展（新打开/重载的店铺生效）' : '已关闭浏览器扩展，已打开的店铺页已重载'
  )
}

function toggleExtension(item: BrowserExtensionItem): Promise<void> {
  const next = !item.enabled
  return runAction(
    'toggle:' + item.id,
    () => window.shopilot.extensions.setEnabled(item.id, next),
    next ? `已启用「${item.name}」` : `已停用「${item.name}」，已打开的店铺页已重载`
  )
}

function reloadExtension(item: BrowserExtensionItem): Promise<void> {
  return runAction('reload:' + item.id, () => window.shopilot.extensions.reload(item.id), `已重载「${item.name}」`)
}

/** 卸载：删除本机副本并停用；已打开页面里已注入的脚本要刷新后完全消失 */
async function uninstallExtension(item: BrowserExtensionItem): Promise<void> {
  if (!window.confirm(`卸载「${item.name}」？\n本机副本会被删除，已打开的店铺页刷新后完全移除；此操作不可撤销。`)) return
  busyKey.value = 'remove:' + item.id
  error.value = ''
  try {
    const result = await window.shopilot.extensions.remove(item.id)
    if (!result.ok) throw new Error(responseError(result, '卸载失败'))
    await refresh()
    setNotice(`已卸载「${item.name}」`)
  } catch (e) {
    error.value = String((e as Error)?.message || e)
  } finally {
    busyKey.value = ''
  }
}

async function openDir(item?: BrowserExtensionItem): Promise<void> {
  busyKey.value = 'dir:' + (item?.id || 'root')
  error.value = ''
  try {
    const result = await window.shopilot.extensions.openDir(item?.id)
    if (!result.ok) throw new Error(responseError(result, '打开扩展目录失败'))
    const data = result.data as { opened?: boolean; reason?: string }
    if (!data?.opened) throw new Error(data?.reason || '系统文件管理器没有打开该目录')
    setNotice(item ? `已打开「${item.name}」的目录` : '已打开扩展目录')
  } catch (e) {
    error.value = String((e as Error)?.message || e)
  } finally {
    busyKey.value = ''
  }
}

onMounted(() => { void refresh() })
</script>

<template>
  <section class="ace" data-test="apps-plugins">
    <div class="ace-head">
      <div class="ace-head-copy">
        <h2>插件</h2>
        <p>随应用内置、离线可装；支持下载安装与卸载（复制/删除本机副本）。插件能读写店铺页面，只安装你信任的来源；本地导入请到设置中心。</p>
      </div>
      <div class="ace-head-actions">
        <label class="ace-master">
          <span>启用浏览器扩展</span>
          <button
            type="button"
            :class="['ace-switch', { on: master }]"
            data-test="apps-plugin-master"
            :aria-pressed="master"
            :disabled="loading || !!busyKey"
            @click="toggleMaster"
          ><i></i></button>
        </label>
        <button type="button" class="ace-btn ghost" data-test="apps-plugins-refresh" :disabled="loading || !!busyKey" @click="refresh">刷新</button>
      </div>
    </div>

    <div v-if="loading" class="ace-note" role="status">正在读取插件…</div>
    <div v-else-if="error" class="ace-note error" role="alert" data-test="apps-plugins-error">{{ error }}</div>
    <div v-if="notice" class="ace-note ok" role="status" data-test="apps-plugins-notice">{{ notice }}</div>

    <div v-if="!loading" class="ace-catalog" data-test="apps-plugin-catalog">
      <article v-for="entry in catalog" :key="entry.key" class="ace-card">
        <div class="ace-card-main">
          <span class="ace-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 4h8l4 8-4 8H8l-4-8 4-8Z" /><path d="M9.5 12h5" /></svg>
          </span>
          <div class="ace-card-copy">
            <div class="ace-title-row">
              <h3>{{ entry.name }}</h3>
              <span class="ace-version">v{{ entry.version }}</span>
              <span v-if="entry.installed" class="ace-badge" :class="{ on: entry.enabled }">{{ entry.enabled ? '已启用' : '已安装' }}</span>
              <span v-if="updateAvailable(entry)" class="ace-badge update" data-test="apps-plugin-update-badge">可更新 v{{ installedVersion(entry) }} → v{{ entry.version }}</span>
            </div>
            <p>{{ entry.summary }}</p>
            <div class="ace-meta">
              <span>{{ permissionLabel(entry.permissions) }}</span>
              <span>{{ formatBytes(entry.sizeBytes) }}</span>
              <span v-for="tag in entry.tags" :key="tag" class="ace-tag">{{ tag }}</span>
            </div>
          </div>
          <div class="ace-card-actions">
            <button
              type="button"
              class="ace-btn primary"
              :data-test="'apps-plugin-install-' + entry.key"
              :title="updateAvailable(entry) ? `本机 v${installedVersion(entry)}，内置目录 v${entry.version}；点击覆盖安装内置新版本` : entry.installed ? '从应用内置目录重新复制安装' : '从应用内置目录复制安装，无需联网'"
              :disabled="!!busyKey || !!entry.invalidReason"
              @click="install(entry)"
            >{{ busyKey === 'install:' + entry.key ? '安装中…' : updateAvailable(entry) ? '更新到 v' + entry.version : entry.installed ? '重新安装' : '下载安装' }}</button>
            <span v-if="entry.invalidReason" class="ace-error">{{ entry.invalidReason }}</span>
          </div>
        </div>
      </article>
      <div v-if="!catalog.length" class="ace-note">当前版本没有内置插件。</div>
    </div>

    <div v-if="!loading" class="ace-installed" data-test="apps-plugin-installed">
      <div class="ace-subhead">
        <h3>已安装</h3>
        <span>{{ installedCount }} 个 · {{ enabledCount }} 个启用</span>
      </div>
      <div v-if="!extensions.length" class="ace-note" data-test="apps-plugin-empty">
        还没有已安装的扩展。上方「下载安装」内置插件；导入本地文件夹请到 设置 → 浏览器扩展。
      </div>
      <div v-for="item in extensions" :key="item.id" class="ace-row" :data-test="'apps-plugin-row-' + item.id">
        <div class="ace-row-copy">
          <strong>{{ item.name }} <em>v{{ item.version }}</em></strong>
          <span>{{ statusLabel(item.status) }} · {{ permissionLabel(item.permissions) }} · {{ formatBytes(item.sizeBytes) }}</span>
          <span v-if="item.loadError" class="ace-error">{{ item.loadError }}</span>
        </div>
        <button type="button" class="ace-btn ghost" :disabled="!!busyKey" @click="toggleExtension(item)">{{ item.enabled ? '停用' : '启用' }}</button>
        <button type="button" class="ace-btn ghost" :disabled="!!busyKey" @click="openDir(item)">目录</button>
        <button type="button" class="ace-btn ghost" :disabled="!!busyKey || !item.enabled" @click="reloadExtension(item)">重载</button>
        <button type="button" class="ace-btn danger" :data-test="'apps-plugin-remove-' + item.id" :disabled="!!busyKey" @click="uninstallExtension(item)">{{ busyKey === 'remove:' + item.id ? '卸载中…' : '卸载' }}</button>
      </div>
      <p v-if="masterOff && extensions.length" class="ace-hint">总开关关着：插件还不会加载进店铺页面。</p>
    </div>
  </section>
</template>

<style scoped>
.ace{border:1px solid var(--ui-border);border-radius:var(--r-lg);background:var(--ui-surface);padding:var(--sp-4);box-shadow:var(--e1)}
.ace-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:var(--sp-3)}
.ace-head-copy{min-width:0;flex:1}
.ace-head-copy h2{margin:0 0 4px;font-size:var(--text-16);font-weight:var(--weight-semibold);color:var(--ui-text)}
.ace-head-copy p{margin:0;max-width:680px;color:var(--ui-text-muted);font-size:var(--text-12);line-height:var(--leading-snug)}
.ace-head-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ace-master{display:inline-flex;align-items:center;gap:8px;color:var(--ui-text-secondary);font-size:var(--text-12);cursor:pointer;user-select:none}
.ace-switch{position:relative;width:34px;height:20px;padding:0;border:0;border-radius:999px;background:var(--ui-border-strong);cursor:pointer;transition:background .16s}
.ace-switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.2);transition:transform .16s}
.ace-switch.on{background:var(--brand)}
.ace-switch.on i{transform:translateX(14px)}
.ace-switch:disabled{opacity:.55;cursor:not-allowed}
.ace-btn{display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:0 11px;border:1px solid var(--ui-border-strong);border-radius:var(--r-sm);background:var(--ui-surface);color:var(--ui-text-secondary);font-size:var(--text-12);font-weight:var(--weight-medium);cursor:pointer;transition:border-color .14s,color .14s,background .14s}
.ace-btn:hover:not(:disabled){border-color:var(--brand-border);color:var(--ui-text)}
.ace-btn:disabled{opacity:.55;cursor:not-allowed}
.ace-btn.primary{border-color:var(--brand);background:var(--brand);color:#fff}
.ace-btn.primary:hover:not(:disabled){border-color:var(--brand);color:#fff;filter:brightness(.97)}
.ace-btn.danger{border-color:rgba(217,45,32,.35);color:var(--danger-text)}
.ace-btn.danger:hover:not(:disabled){border-color:var(--danger-text);color:var(--danger-text);background:rgba(217,45,32,.06)}
.ace-catalog{display:flex;flex-direction:column;gap:var(--sp-2)}
.ace-card{border:1px solid var(--ui-border);border-radius:var(--r-md);background:var(--ui-surface-sunken);padding:var(--sp-3)}
.ace-card-main{display:flex;align-items:flex-start;gap:12px}
.ace-icon{display:grid;place-items:center;width:38px;height:38px;flex:0 0 auto;border-radius:var(--r-md);background:var(--brand-50);color:var(--brand-text)}
.ace-icon svg{width:20px;height:20px}
.ace-card-copy{min-width:0;flex:1}
.ace-title-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.ace-title-row h3{margin:0;font-size:var(--text-14);font-weight:var(--weight-semibold);color:var(--ui-text)}
.ace-version{color:var(--ui-text-muted);font-size:var(--text-11);font-variant-numeric:tabular-nums}
.ace-badge{padding:1px 7px;border-radius:999px;background:var(--ui-border);color:var(--ui-text-muted);font-size:var(--text-11);font-weight:var(--weight-medium)}
.ace-badge.on{background:var(--success-soft);color:var(--success-text)}
.ace-badge.update{background:#fff4e5;color:#b54708}
.ace-card-copy p{margin:4px 0 6px;color:var(--ui-text-muted);font-size:var(--text-12);line-height:var(--leading-snug)}
.ace-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--ui-text-muted);font-size:var(--text-11)}
.ace-tag{padding:1px 6px;border-radius:var(--r-xs);background:var(--ui-border);color:var(--ui-text-secondary)}
.ace-card-actions{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:0 0 auto}
.ace-installed{margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--ui-border)}
.ace-subhead{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.ace-subhead h3{margin:0;font-size:var(--text-13);font-weight:var(--weight-semibold);color:var(--ui-text)}
.ace-subhead span{color:var(--ui-text-muted);font-size:var(--text-11);font-variant-numeric:tabular-nums}
.ace-row{display:flex;align-items:center;gap:8px;padding:9px 0;border-top:1px solid var(--ui-border)}
.ace-row:first-of-type{border-top:0}
.ace-row-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}
.ace-row-copy strong{font-size:var(--text-12);font-weight:var(--weight-semibold);color:var(--ui-text)}
.ace-row-copy em{color:var(--ui-text-muted);font-style:normal;font-weight:400}
.ace-row-copy span{overflow:hidden;color:var(--ui-text-muted);font-size:var(--text-11);text-overflow:ellipsis;white-space:nowrap}
.ace-note{padding:10px 0;color:var(--ui-text-muted);font-size:var(--text-12)}
.ace-note.error,.ace-error{color:var(--danger-text)}
.ace-note.ok{color:var(--success-text)}
.ace-error{font-size:var(--text-11)}
.ace-hint{margin:8px 0 0;color:var(--ui-text-muted);font-size:var(--text-11)}
@media (max-width:760px){
  .ace-card-main{flex-wrap:wrap}
  .ace-card-actions{width:100%;flex-direction:row;align-items:center;justify-content:flex-start}
}
</style>
