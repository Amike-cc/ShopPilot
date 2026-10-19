import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { businessProfileFor } from '@shared/constants/business'
import type { BusinessProfile } from '@shared/constants/business'
import { buildBusinessCollectSteps } from '@shared/business-steps'
import { invoiceProfileFor, INVOICE_TASK_PREFIX } from '@shared/constants/invoice'
import type { InvoiceProfile } from '@shared/constants/invoice'
import { TAX_TASK_PREFIX, taxProfileFor } from '@shared/constants/tax'
import type { TaxProfile } from '@shared/constants/tax'
import { AUTO_COLLECTION_SETTING, parseAutoCollectionEnabled, pickLatestCollectTask } from '@shared/constants/collection'
import { buildTaxCollectSteps } from '@shared/tax-steps'
import { buildInvoiceCollectSteps } from '@shared/invoice-steps'
import { entityProfileFor } from '@shared/constants/entity'
import { buildEntityCollectSteps } from '@shared/entity-steps'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import type { DataMode, InvoiceDetailApi } from './use-invoice-detail'
import type { TaxLicenseApi } from './use-tax-license'

/**
 * 数据中心 · 采集与导出域（从 UnifiedDataPage.vue 原样外移，行为不变）。
 *
 * 采集任务编排（经营/发票/涉税/实体报送）、发票定时采集开关、手工录入与 CSV 导出。
 */

export function useDataCollection(page: InvoiceDetailApi, tax: TaxLicenseApi, deps: { props: { mode: DataMode } }) {
  const props = deps.props
  const ws = useWorkspaceStore()
// 页码/等待中的采集流程会在切页时作废（原组件里的 generation 计数，随本域一起外移）
let entityCollectGeneration = 0
  const loading = page.loading
  const collecting = page.collecting
  const errorMessage = page.errorMessage
  const dataCenter = page.dataCenter
  const invoiceData = page.invoiceData
  const taxData = page.taxData
  const taxCollecting = page.taxCollecting
  const entityCollecting = page.entityCollecting
  const entityProgress = page.entityProgress
  const entityReport = page.entityReport
  const manual = page.manual
  const invoiceLicense = page.invoiceLicense
  const exporting = page.exporting
  const exportConfirm = page.exportConfirm
  const manualReady = page.manualReady
  const exportScope = page.exportScope
  const openExportConfirm = page.openExportConfirm
  const reloadInvoiceData = tax.reloadInvoiceData
  const reloadTaxData = tax.reloadTaxData

async function load() {
  // P1-7（2026-10-15 审查）：无 preload（纯渲染调试模式）时给出降级提示，而不是 TypeError 白屏
  if (!window.shopilot) {
    errorMessage.value = '原生桥接不可用（纯渲染模式）：数据中心无法加载'
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    const responses = await Promise.all([
      window.shopilot.overview.datacenter(),
      window.shopilot.overview.invoiceCenter(),
      window.shopilot.overview.taxReport(),
      window.shopilot.settings.get(AUTO_COLLECTION_SETTING)
    ])
    if (!responses[0].ok) throw new Error(responses[0].error.message)
    dataCenter.value = responses[0].data
    // B3：单个通道失败**不能**退化成空列表——发票中心读取失败与"确实没采过"在屏上必须能分辨
    const failed: string[] = []
    if (!responses[1].ok) failed.push(`发票数据读取失败：${responses[1].error.message}`)
    if (!responses[2].ok) failed.push(`涉税报送数据读取失败：${responses[2].error.message}`)
    invoiceData.value = responses[1].ok ? responses[1].data : null
    taxData.value = responses[2].ok ? responses[2].data : null    /**
     * 自动采集总开关（`collection.autoEnabled`，主进程 fail-closed 读它）。
     *
     * 为什么界面上要单独读它：任务上挂着 `everyMs` **不等于**会自动跑——总开关关着时
     * 调度器直接 return（scheduler.ts 的 isAutoCollectionEnabled 分支）。只看任务周期就会
     * 把"挂着但永远不会触发"显示成"已启用"（2026-10-15 审查确认的假状态）。
     * 读失败按**关**处理；解析用 shared 的 `parseAutoCollectionEnabled`——它兼容历史值
     * （1 / "true" / "1"），以前这里手写 `=== true`，存量值会让屏上显示"总开关是关的"
     * 而主进程实际在跑（与上面同一类假状态，2026-10-15 审查 M3）。
     */
    // 下标修正（2026-10-19）：请求数组只有 4 项（0 数据中心 / 1 发票中心 / 2 涉税报送 / 3 采集总开关），
    // 这里历史写成 responses[4]，取到 undefined 走 false 分支 → 界面永远显示"总开关关着"（假状态）。
    autoCollectionOn.value = responses[3]?.ok ? parseAutoCollectionEnabled(responses[3].data?.value) : false
    if (failed.length) errorMessage.value = failed.join('；')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally { loading.value = false }
}
/** 发票自动采集周期：3 小时（用户要求「发票中心三个小时更新一次」） */
const INVOICE_SCHEDULE_MS = 3 * 60 * 60 * 1000
/**
 * 自动采集总开关是否打开。**默认 false**（与主进程 fail-closed 同口径）：
 * 读不到就按"不会自动跑"显示，绝不乐观地告诉用户"已在自动更新"。
 * 键与解析都用 shared/constants/collection 的导出（单一事实来源，以前手抄字面量会漂移）。
 */
const autoCollectionOn = ref(false)
// INVOICE_TASK_PREFIX 来自 @shared/constants/invoice（单一事实来源）：
// 这里用它**认领**同一个采集任务，任务中心/概览那边用同一条规则把它**排除**在任务之外。

type CollectKind = 'business' | 'invoice' | 'tax'

/** 该平台在这个采集域下的档案（没有 = 抓不了；界面按域分别如实说明，不混成一句"暂不支持"） */
function collectProfileOf(kind: CollectKind, platform: string): any {
  if (kind === 'business') return businessProfileFor(platform)
  if (kind === 'tax') return taxProfileFor(platform)
  return invoiceProfileFor(platform)
}

/** 该采集域的步骤构造（每域一份；档案形状不同，各自有单测） */
function collectStepsOf(kind: CollectKind, profile: any): any[] {
  if (kind === 'business') return buildBusinessCollectSteps(profile as BusinessProfile)
  if (kind === 'tax') return buildTaxCollectSteps(profile as TaxProfile)
  return buildInvoiceCollectSteps(profile as InvoiceProfile)
}

/** 采集任务名（带前缀的域便于复用时按前缀认领同一个任务） */
function collectTaskName(kind: CollectKind, storeName: string) {
  if (kind === 'business') return `经营指标采集 · ${storeName}`
  if (kind === 'tax') return `${TAX_TASK_PREFIX}${storeName}`
  return `${INVOICE_TASK_PREFIX}${storeName}`
}

/**
 * 复用已有任务，而不是每点一次就新建一个。
 *
 * 原实现每次点「采集」都 task.create 一个新任务——实测点两轮就留下
 * 「发票采集 · 抖店」「发票采集 · 抖店 · 2026/9/15」一串同名任务：任务中心越堆越多，
 * 而定时更新只能挂在其中一个上（挂错就等于没挂）。这里按"店铺 + 名称前缀"认领一个，
 * 把步骤与周期一起更新到它身上。
 *
 * 认领口径与开关/状态条**必须一致**：统一走 shared 的 `pickLatestCollectTask`
 * （取 `updatedAt` 最新）——以前认领按 updatedAt、开关按列表序，库里若有历史重复
 * 任务，改周期的和跑数据的可能不是同一个（2026-10-15 审查 C3）。
 *
 * 返回值带 `updateWarning`：任务正有未结束的运行 → 含 steps 的更新会被主进程拒
 * （TASK_BAD_STATE，task-store.updateTask）；此时**去掉 steps 重试**（name/schedule
 * 在运行中本就允许改），两次都失败才把原因交给调用方如实展示——不能一边宣称
 * "每 3 小时自动更新"，一边实际什么都没写上（2026-10-15 审查 C2）。
 */
async function ensureCollectTask(kind: CollectKind, store: any, steps: any[], schedule: unknown): Promise<{ taskId: string; updateWarning: string | null }> {
  const name = collectTaskName(kind, store.name)
  const listed = await window.shopilot.task.list()
  const existing = pickLatestCollectTask(listed.ok ? (listed.data as any[]) : [], store.id, collectTaskName(kind, ''))
  if (existing) {
    const updated = await window.shopilot.task.update({ taskId: existing.id, name, steps, schedule })
    if (updated.ok) return { taskId: String(existing.id), updateWarning: null }
    // 含 steps 的更新被拒（多为正有未结束的运行）→ 不带 steps 重试：name/schedule 在运行中允许改，
    // 重试成功则周期确实挂上了，toast 才不是假话；仍失败才把原因带走如实展示。
    const retried = await window.shopilot.task.update({ taskId: existing.id, name, schedule })
    return { taskId: String(existing.id), updateWarning: retried.ok ? null : String(retried.error?.message || '配置更新被拒') }
  }
  const created = await window.shopilot.task.create({ name, storeScope: store.id, steps, schedule })
  return { taskId: created.ok ? String((created.data as any).id) : '', updateWarning: null }
}

async function createCollectionTasks(kind: CollectKind) {
  const supported = ws.stores.filter(store => !!collectProfileOf(kind, store.platform))
  if (!supported.length) { ws.toast('当前没有已实测的可采集平台，系统不会猜测页面选择器', 'info'); return }
  collecting.value = true
  let created = 0
  /** 任务配置没能写上的店（原因只记第一条）：toast 必须如实说，不能宣称"已挂上周期"（C2） */
  const stuck: string[] = []
  let stuckWhy = ''
  try {
    for (const store of supported) {
      const profile = collectProfileOf(kind, store.platform)
      if (!profile) continue
      if (!ws.openStoreIds.includes(store.id)) await window.shopilot.browser.open(store.id)
      const steps = collectStepsOf(kind, profile)
      // 只有发票采集挂周期（每 3 小时）：经营指标已有自己的 10 分钟调度器，给任务再挂一次
      // 会变成两套调度各跑一遍；涉税报送**按季度**更新，3 小时一轮没有意义，保持手动采集。
      const schedule = kind === 'invoice' ? { everyMs: INVOICE_SCHEDULE_MS, backgroundOpen: true } : undefined
      const claimed = await ensureCollectTask(kind, store, steps, schedule)
      if (!claimed.taskId) continue
      if (claimed.updateWarning) { stuck.push(store.name); stuckWhy = stuckWhy || claimed.updateWarning }
      const run = await window.shopilot.task.run(claimed.taskId)
      if (run.ok) created++
    }
    await ws.refreshTasks()
    /**
     * 只有**总开关确实打开**时才敢说"会自动更新"。
     *
     * 任务上挂了 `everyMs` ≠ 会自动跑：总开关关着时调度器直接 return（scheduler.ts）。
     * 以前这里无条件写"发票每 3 小时自动更新一次"——实测总开关是 false，这句是假话，
     * 用户会以为数据在自动刷新（2026-10-15 审查确认）。
     */
    const suffix = kind === 'invoice'
      ? (autoCollectionOn.value
          ? '；发票每 3 小时自动更新一次'
          : '；注意：自动采集总开关是关的，这批任务不会自动跑——要自动更新请点上方「开启每 3 小时自动更新」')
      : kind === 'tax' ? '；报送数据按季度更新，下一季再采一次即可' : ''
    // 配置没写上的店必须在同一条 toast 里点名（C2）：否则用户会以为周期已挂、却不知道哪家需要处理
    const stuckNote = stuck.length
      ? `；注意：${stuck.length} 家（${stuck.join('、')}）的任务配置未能更新（${stuckWhy}），本次先按原配置执行`
      : ''
    ws.toast(created ? `已启动 ${created} 个采集任务${suffix}${stuckNote}` : `采集任务未能启动，请在当前页面重试${stuckNote}`, created ? 'success' : 'error')
  } finally { collecting.value = false }
}

/** 主体采集任务名前缀（与发票采集同样"认领同一个"，避免重复创建后台任务） */
const ENTITY_TASK_PREFIX = '主体信息采集 ·'

async function ensureEntityCollectTask(store: any, steps: any[]): Promise<string> {
  const name = `${ENTITY_TASK_PREFIX}${store.name}`
  const listed = await window.shopilot.task.list()
  const existing = pickLatestCollectTask(listed.ok ? (listed.data as any[]) : [], store.id, ENTITY_TASK_PREFIX)
  if (existing) {
    // 任务正有未结束的运行 → 步骤改不了（主进程会拒），去掉 steps 重试一次把名字写上，
    // 仍用它跑一次：步骤由档案推导，本来就不随点击变化（与 C2 同一处置）
    const updated = await window.shopilot.task.update({ taskId: existing.id, name, steps })
    if (!updated.ok) await window.shopilot.task.update({ taskId: existing.id, name })
    return String(existing.id)
  }
  const created = await window.shopilot.task.create({ name, storeScope: store.id, steps })
  return created.ok ? String((created.data as any).id) : ''
}

/**
 * 「获取主体营业执照」：去平台后台把**本店自己的主体**读回来，再按主进程的判定写进店铺。
 *
 * 两步分开（都复用既有机制）：
 *  1. 采集：只对**已实测主体信息页**的平台建只读采集任务（navigate → readLabelValue×N → 快照 entity.name/no）；
 *  2. 写回：`overview.entityApply()` 按快照决定写不写——**空则填；与已填不一致不覆盖**，两边都报出来（错一个公司就是错票）。
 * 未实测的平台（微信小店：主体卡是 display:none 且代码掩码；抖店/拼多多：当时登录态过期，没测到页）
 * **不猜选择器**，它们的店铺会在结果里以 unsupported + 原因如实列出。
 */
async function collectStoreEntities() {
  const generation = ++entityCollectGeneration
  const supported = ws.stores.filter(store => !!entityProfileFor(store.platform))
  entityCollecting.value = true
  entityReport.value = []
  try {
    // 说明：即使一家都没有已实测的平台，也**仍然走一遍写回**——结果面板会把每家"为什么取不了"写清楚，
    // 而不是让用户对着一句"没有需要新填的主体"猜（最终提示见函数末尾）。
    const runIds: string[] = []
    /** runId → 店名：等待时要说清"还在等哪一家"，而不是只报一个数字 */
    const runStore = new Map<string, string>()
    // 逐店记"这次没能开始采集"的原因：不记的话，一家都没跑起来时界面会安安静静地
    // 回一句"没有需要新填的主体"，而那句结论其实来自上一次的旧快照（比报错更危险）。
    const startFailures = new Map<string, string>()
    for (const store of supported) {
      if (generation !== entityCollectGeneration) return
      if (!ws.openStoreIds.includes(store.id)) {
        // 引擎不静默拉起店铺浏览器（§4.4）：用户点这个按钮就是要采这几家 → 显式打开。
        // 注意 browser.open 是**返回 {ok:false}** 而不是抛异常，必须看返回值。
        const opened = await window.shopilot.browser.open(store.id)
        if (!opened.ok) {
          startFailures.set(store.id, `店铺浏览器没能打开（${opened.error?.message || '未知原因'}）——采集要等页面就绪`)
          continue
        }
      }
      const taskId = await ensureEntityCollectTask(store, buildEntityCollectSteps(entityProfileFor(store.platform)!) as any[])
      if (!taskId) { startFailures.set(store.id, '采集任务没能创建，请在当前页面重试'); continue }
      const run = await window.shopilot.task.run(taskId)
      const runId = run.ok ? String((run.data as any)?.runId || '') : ''
      if (!runId) {
        startFailures.set(store.id, `采集任务没能启动（${run.ok ? '没有返回运行 id' : run.error?.message || '未知原因'}）`)
        continue
      }
      runIds.push(runId)
      runStore.set(runId, store.name)
    }
    if (generation !== entityCollectGeneration) return
    await ws.refreshTasks()
    /**
     * 等待：**逐店各算各的超时**，不是一个总时限。
     *
     * 以前是一个固定 150 秒的总 deadline：只要有一家卡住（浏览器没开起来、任务排在别人后面），
     * 其余几家早就跑完了也要陪着等到 150 秒，用户看到的是一分多钟的"获取中…"。
     * 现在每家自己计时，超时就把它标成"未按时跑完"从等待集合里摘掉，其余的正常收尾。
     */
    const perStoreMs = 60000
    const timedOutNames: string[] = []
    let timedOut = false
    if (runIds.length) {
      const pending = new Set(runIds)
      const firstSeenPending = new Map<string, number>()
      entityProgress.value = { total: runIds.length, done: 0, waiting: [...runStore.values()] }
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 3000))
        if (generation !== entityCollectGeneration) return
        const list = await window.shopilot.task.list()
        const all = (list.ok ? (list.data as any[]) : [])
        for (const id of [...pending]) {
          const task = all.find(item => item.latestRun?.id === id)
          const status = task?.latestRun?.status
          if (status && ['succeeded', 'failed', 'cancelled'].includes(status)) { pending.delete(id); continue }
          if (!firstSeenPending.has(id)) firstSeenPending.set(id, Date.now())
          if (Date.now() - (firstSeenPending.get(id) as number) > perStoreMs) {
            pending.delete(id)
            timedOut = true
            const name = runStore.get(id)
            if (name) timedOutNames.push(name)
          }
        }
        entityProgress.value = {
          total: runIds.length,
          done: runIds.length - pending.size,
          waiting: [...pending].map(id => runStore.get(id) || '店铺')
        }
        if (!pending.size) break
      }
    }
    if (generation !== entityCollectGeneration) return
    // 写回：空则填、不一致不覆盖（判定在主进程，界面只如实展示结果）
    const applied = await window.shopilot.overview.entityApply()
    if (!applied.ok) { ws.toast('写回主体信息失败：' + applied.error.message, 'error'); return }
    if (generation !== entityCollectGeneration) return
    const appliedRows = ((applied.data as any)?.rows || []) as any[]
    // 没跑起来的店：把原因钉在它自己那一行上（每店一行，不加重复行）
    entityReport.value = appliedRows.map(row => startFailures.has(row.storeId)
      ? { ...row, status: 'start-failed', note: startFailures.get(row.storeId) }
      : row)
    const filled = Number((applied.data as any)?.filled || 0)
    // 超时也要如实说，而且要**说是哪家**：否则"采集完成"会把还在排队/跑着的店铺当成已采集
    const lateNote = timedOut ? `（${timedOutNames.join('、')} 未在 1 分钟内跑完，结果可能不全；稍后可再点一次）` : ''
    const toastText = !supported.length
      ? '当前没有已实测主体信息页的平台——不会去猜选择器（每家的原因见下方结果）'
      : startFailures.size
        ? `${startFailures.size} 家没能开始采集，结果里的结论来自上一次采集（详见下方结果）`
        : filled
          ? `已按平台读到的主体填入 ${filled} 家店铺的营业执照`
          : '没有需要新填的主体（详见下方结果）'
    ws.toast(toastText + lateNote, startFailures.size ? 'error' : (filled ? 'success' : 'info'))
    await Promise.all([ws.refreshStores(), reloadInvoiceData()])
  } finally {
    entityCollecting.value = false
    entityProgress.value = null
  }
}
function collectBusiness() { return createCollectionTasks('business') }
function collectInvoices() { return createCollectionTasks('invoice') }
/**
 * 采集涉税报送数据。
 *
 * 采集完**重新取一次**报送数据（`reloadTaxData`）：否则用户点完按钮，屏上还是"还没采集"，
 * 得手动刷新才能看到——"点了没反应"是这类只读采集最容易让人误判的地方。
 */
async function collectTaxReport() {
  if (taxCollecting.value) return
  taxCollecting.value = true
  try {
    await createCollectionTasks('tax')
    await reloadTaxData()
  } finally { taxCollecting.value = false }
}

/** 发票自动更新现状（逐店一条：哪几家挂着周期、上次什么时候触发） */
const invoiceSchedule = computed(() => {
  const supported = ws.stores.filter(store => !!invoiceProfileFor(store.platform))
  // 认领口径与采集、开关统一（shared.pickLatestCollectTask，取 updatedAt 最新）——口径不一致时
  // 状态条看的是 A 任务、开关改的是 B 任务，用户会看到"开了自动更新但数据不动"（C3）
  const tasks = supported.map(store => pickLatestCollectTask(ws.tasks, store.id, INVOICE_TASK_PREFIX))
  const scheduled = tasks.filter(task => Number((task?.schedule as any)?.everyMs || 0) === INVOICE_SCHEDULE_MS)
  const fired = scheduled.map(task => Number((task as any)?.lastFiredAt || 0)).filter(value => value > 0)
  /**
   * `enabled` 只说明"任务上挂没挂 3 小时周期"；**能不能真的自动跑还要看总开关**。
   * 两者都满足才算"自动更新生效"——只看前者会在总开关关着时显示成"已启用"
   * （实测：总开关 false、4 家全挂着周期，界面写着「已启用 4/4 家」而调度器一次都不会触发）。
   */
  const autoEnabled = autoCollectionOn.value
  return {
    total: supported.length,
    enabled: scheduled.length,
    /** 挂着周期**且**总开关打开 = 真的会自动更新 */
    active: scheduled.length > 0 && autoEnabled,
    autoEnabled,
    lastFiredAt: fired.length ? Math.max(...fired) : 0
  }
})

/** 一键开关自动更新：给每家的发票任务挂上/摘掉 3 小时周期 */
async function toggleInvoiceSchedule(enabled: boolean) {
  collecting.value = true
  try {
    /**
     * 打开时必须**连总开关一起打开**：只挂任务周期、总开关还关着的话，
     * 调度器根本不会触发（scheduler.ts 的 isAutoCollectionEnabled 分支直接 return），
     * 用户点了"开启"却发现数据永远不更新——这正是 2026-10-15 审查确认的假状态。
     */
    if (enabled) {
      const setResult = await window.shopilot.settings.set(AUTO_COLLECTION_SETTING, true)
      if (!setResult?.ok) {
        ws.toast('打开自动采集总开关失败：' + (setResult?.error?.message || '未知原因'), 'error')
        return
      }
      autoCollectionOn.value = true
    }
    let changed = 0
    for (const store of ws.stores.filter(item => !!invoiceProfileFor(item.platform))) {
      // 与采集认领用同一个口径（C3）：开关改的必须正是当前后台采集任务
      const task = pickLatestCollectTask(ws.tasks, store.id, INVOICE_TASK_PREFIX)
      if (!task) continue
      const result = await window.shopilot.task.update({ taskId: task.id, schedule: enabled ? { everyMs: INVOICE_SCHEDULE_MS, backgroundOpen: true } : null })
      if (result.ok) changed++
    }
    await ws.refreshTasks()
    if (!changed) {
      // 一家都没挂上（还没有发票任务）→ 把刚打开的总开关退回去，别留下"开着但不干活"的状态
      if (enabled) {
        await window.shopilot.settings.set(AUTO_COLLECTION_SETTING, false)
        autoCollectionOn.value = false
      }
      ws.toast('还没有发票采集任务——先点一次「采集发票数据」', 'info')
      return
    }
    ws.toast(enabled
      ? `已开启每 3 小时自动更新（${changed} 家，总开关已一并打开）`
      : `已关闭这 ${changed} 家的自动更新（自动采集总开关保持原样）`, 'success')
  } finally { collecting.value = false }
}
async function saveManual() { if (!manualReady.value) return; const result = await window.shopilot.overview.manualMetric(manual.storeId, manual.metric, Number(manual.value)); if (!result.ok) { ws.toast('录入失败：' + result.error.message, 'error'); return } ws.toast('已录入手动指标', 'success'); manual.value = null; await load() }
/**
 * 导出**跟随屏上的营业执照筛选**（申报是分主体做的，导出的表也就该按主体分开）。
 *
 * 为什么要跟：用户在屏上点了某个主体，看到的条数/金额只剩这个主体的，导出却给全部主体——
 * 文件自带「营业执照 / 统一社会信用代码」两列，把 A 公司的清单交给 A 的代账时就会带出别家的单号与税号。
 * 主进程按同一个 key 用共享的归属规则（shared/store-license.groupStoresByLicense）再筛一遍，
 * 不信任渲染层传店铺 id。
 */
function exportSubject(key: string) {
  invoiceLicense.value = key
  openExportConfirm()
}

async function confirmExportInvoices() {
  if (exporting.value) return
  exporting.value = true
  try {
    if (await exportInvoices()) exportConfirm.open = false
  } finally {
    exporting.value = false
  }
}

async function exportInvoices(): Promise<boolean> {
  const result = await window.shopilot.overview.invoiceExport(exportScope.value ? { licenseKey: exportScope.value.key } : {})
  if (!result.ok) { ws.toast('导出失败：' + result.error.message, 'error'); return false }
  if (result.data?.canceled) return false
  // 导出里既有"待开票"也有"无需操作"（已提交/已通过）的行，两个数都报出来，免得与屏上合计对不上
  const rows = Number(result.data.rows || 0)
  const pending = Number(result.data.pendingRows ?? rows)
  const suffix = pending === rows ? '' : `（其中待开票 ${pending} 条、无需操作 ${rows - pending} 条）`
  ws.toast(`已导出 ${rows} 条记录${suffix}（${result.data.scopeLabel || '全部主体'}）`, 'success')
  return true
}
function onTaskProgress(event: any) { if (event?.phase === 'finished' || event?.phase === 'failed') void load() }
watch(() => props.mode, () => { void load() })
onMounted(() => {
  if (!window.shopilot) return
  window.shopilot.on(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress)
  void load()
  void ws.refreshTasks()
})
onBeforeUnmount(() => {
  entityCollectGeneration++
  window.shopilot?.off?.(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress)
})

  return {
    entityCollectGeneration,

    load,

    INVOICE_SCHEDULE_MS,

    autoCollectionOn,

    collectProfileOf,

    collectStepsOf,

    collectTaskName,

    ensureCollectTask,

    createCollectionTasks,

    ENTITY_TASK_PREFIX,

    ensureEntityCollectTask,

    collectStoreEntities,

    collectBusiness,

    collectInvoices,

    collectTaxReport,

    invoiceSchedule,

    toggleInvoiceSchedule,

    saveManual,

    exportSubject,

    confirmExportInvoices,

    exportInvoices,

    onTaskProgress,

  }
}

export type DataCollectionApi = ReturnType<typeof useDataCollection>
