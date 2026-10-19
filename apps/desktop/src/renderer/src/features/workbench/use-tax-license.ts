import { invoiceProfileFor } from '@shared/constants/invoice'
import { TAX_SUPPORTED_PLATFORMS } from '@shared/constants/tax'
import { taxAmountText, taxIncomeFromCells, taxPeriodNetOf } from '@shared/tax-income'
import { UNKNOWN_TAX_SUBJECT_KEY, UNKNOWN_TAX_SUBJECT_LABEL, groupTaxPeriodsBySubject, taxSubjectTotals } from '@shared/tax-subject'
import { entityUnsupportedNote, ENTITY_SUPPORTED_PLATFORMS } from '@shared/constants/entity'
import { NO_LICENSE_KEY, entityVerdictText, normalizeLicenseName } from '@shared/store-license'
import { invoiceAmountText, parseInvoiceAmount } from '@shared/invoice-amount'
import { computed, ref } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import type { InvoiceDetailApi } from './use-invoice-detail'

/**
 * 数据中心 · 涉税与证照域（从 UnifiedDataPage.vue 原样外移，行为不变）。
 *
 * 涉税报送视图（按主体分组/核对）、主体与店铺的证照编辑、实体报送文案。
 */

export function useTaxLicense(page: InvoiceDetailApi) {
  const ws = useWorkspaceStore()
  const invoiceData = page.invoiceData
  const taxData = page.taxData
  const invoiceRows = page.invoiceRows
  const invoiceAllRows = page.invoiceAllRows
  const licenseEditingId = page.licenseEditingId
  const licenseDraft = page.licenseDraft
  const licenseSaving = page.licenseSaving
  const licenseEditError = page.licenseEditError
  const isSubjectCollapsed = page.isSubjectCollapsed
  const toggleSubjectGroup = page.toggleSubjectGroup
  const licenseGroups = page.licenseGroups
  const licenseSummary = page.licenseSummary
  const activeLicense = page.activeLicense
  const invoiceRowAmountText = page.invoiceRowAmountText
  const formatTime = page.formatTime

function sectionAmount(section: any): { text: string; parsed: boolean } {
  let total = 0
  let parsed = 0
  for (const item of section?.items || []) {
    const value = parseInvoiceAmount(item?.cells?.amount)
    if (value == null) continue
    total += value
    parsed++
  }
  return { text: invoiceAmountText(total, parsed > 0), parsed: parsed > 0 }
}

/**
 * 「按主体」分组的行模型：一个主体一组，组下挂该主体的**全部店铺**（店铺行可点击进入店铺详情）。
 *
 * 三条纪律：
 *   · 归属用 licenseGroups.keyByStore 这**一张**归属表（见 shared/store-license.ts 文件头——
 *     不能各店各算一遍 licenseKeyOf，否则"胶囊写 2 家、组里只有 1 家"）；同一执照下的多家店
 *     自动并到一块，没填执照的单独一组固定排最后（排序规则在 shared 的 groupStoresByLicense 里）。
 *   · **不许静默丢行**：行对应的店铺若暂时不在 ws.stores（刷新时序），兜底归入「未填写」组里显示，
 *     而不是像旧实现那样 `|| ''` + continue 无声吞掉（那会让"店里有票、屏上没店"变成无痕迹的假象）。
 *   · 数字口径与 KPI / 胶囊 / 导出完全一致（待开票条数与金额来自 licenseSummary）。
 *     「金额占比」的分母必须是**金额**，不是条数（2026-10-15 审查 BUG，实测按条数会把结论看反）；
 *     总额 ≤ 0（整批退款冲正、或全是 0 元）时不给比例：分母没有意义，条只能画最小宽度。
 *
 * 口径跟随左侧选中的主体（选了 A 就只汇总 A）——与 KPI 一致，避免两处数字对不上。
 */
const invoiceSubjectGroups = computed(() => {
  const groups = licenseSummary.value.items
  const totalAmount = groups.reduce((sum, group) => sum + group.amount, 0)
  const shareOf = (amount: number): { width: string; pct: number | null } => {
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return { width: '2%', pct: null }
    const pct = amount / totalAmount * 100
    return { width: `${Math.max(2, Math.min(100, Math.round(pct)))}%`, pct }
  }
  // 行 → 组：每行必须落到一个组里（兜底 NO_LICENSE_KEY，见上方说明），组内保持载荷顺序（不擅自重排）
  const rowsByKey = new Map<string, any[]>()
  for (const row of invoiceAllRows.value) {
    const key = licenseGroups.value.keyByStore.get(row.storeId) || NO_LICENSE_KEY
    const list = rowsByKey.get(key) || []
    list.push(row)
    rowsByKey.set(key, list)
  }
  return groups
    .filter(group => !activeLicense.value || group.key === activeLicense.value)
    .map(group => {
      const share = shareOf(group.amount)
      const label = group.label || '未填写营业执照'
      const groupRows = rowsByKey.get(group.key) || []
      const stores = groupRows.map((row: any) => ({
        storeId: String(row.storeId),
        storeName: String(row.storeName || row.storeId),
        platform: String(row.platform || ''),
        count: Number(row.count || 0),
        amountText: invoiceRowAmountText(row),
        capturedAt: Number(row.capturedAt) || null,
        loginRequired: !!row.loginRequired,
        lastFailed: !!row.lastFail,
        failTitle: row.lastFail
          ? `最近一次采集失败${row.lastFail.at ? `（${formatTime(Number(row.lastFail.at))}）` : ''}：${row.lastFail.message || row.lastFail.code || '未知原因'}`
          : '',
        supported: row.supported !== false,
        unsupportedReason: String(row.unsupportedReason || ''),
        // 「本次没读到」如实上屏（与按店铺视图同一条规矩：不能把上一次的数据静默当成本次结果）
        emptyNote: (row.sections || [])
          .filter((sec: any) => !!sec.emptyNote)
          .map((sec: any) => `「${sec.name}」${sec.emptyNote}`)
          .join('；'),
        needsLicense: !row.licenseName && !row.licenseNo
      }))
      return {
        key: group.key,
        label,
        no: group.no || '',
        // 家数以**列出来的店铺行**为准：屏上"N 家"与下面实际有几行必须对得上
        storeCount: stores.length,
        pendingCount: group.pendingCount,
        amountText: group.amountText,
        unparsed: group.unparsed,
        historyCount: groupRows.reduce((sum: number, row: any) => sum + Number(row.historyCount || 0), 0),
        share: share.width,
        shareText: share.pct == null ? '占比 —' : `占比 ${share.pct >= 10 ? Math.round(share.pct) : share.pct.toFixed(1)}%`,
        // 条上没有数字，把确切比例挂到 title 上——否则用户只能看个大概长短
        shareTitle: share.pct == null
          ? `${label}：本口径下可开金额合计不大于 0，算不出占比`
          : `${label}：可开金额 ${group.amountText}，占本口径 ${share.pct.toFixed(1)}%（按金额，不是按条数）`,
        stores
      }
    })
})

/** 平台覆盖：哪个平台登记了真机实测档案、有几个开票方向（没档案的如实说明，不给假锚点） */
const invoicePlatformCoverage = computed(() => {
  const names = new Set<string>()
  for (const store of ws.stores) names.add(String(store.platform || ''))
  for (const row of invoiceRows.value) names.add(String(row.platform || ''))
  return [...names].filter(Boolean).map(platform => {
    const profile = invoiceProfileFor(platform)
    return {
      platform,
      measured: !!profile,
      note: profile
        ? `${profile.sections.length} 个开票方向 · 实测日期 ${profile.measuredAt}`
        : '尚未实测到可读取的发票页——不登记假锚点，界面如实说明而不是拿猜的选择器去试'
    }
  })
})

/** 导出 CSV 的列（照着主进程给的统一列拼，列名不在这里硬编码） */
const invoiceCsvColumns = computed(() => {
  const labels = ((invoiceData.value?.columns || []) as Array<{ label?: string }>).map(col => String(col.label || '')).filter(Boolean)
  return [...labels, '店铺', '营业执照', '统一社会信用代码', '是否待办'].join(' · ')
})

/** 行内排序：按"该店待开票金额"；一条金额都解析不出的店排在最后，而不是当 0 排在最前 */
const taxDisclaimer = computed(() => String(taxData.value?.disclaimer || ''))
/** 报送依据（同页原文），用来交代这份数据到底是什么 */
const taxBasis = computed(() => String(taxData.value?.basis || ''))
const taxRows = computed<any[]>(() => taxData.value?.rows || [])
/** 已实测可采集涉税报送的平台（说明文案里如实列出，未实测的照实说不支持） */
const taxSupportedPlatforms = TAX_SUPPORTED_PLATFORMS
/**
 * 涉税数据的看法：**按主体** / 按店铺。
 *
 * 默认按主体：平台按季度报送的是"你这个纳税人"的收入，同一家公司在几家店的数据
 * 在税务机关眼里是**同一个主体的一份收入**；按店铺列，用户得自己拿计算器加。
 */
const taxView = ref<'subject' | 'stores'>('subject')
/** 展开查看某主体的逐期明细（空 = 都收起） */
const taxExpandedSubject = ref('')

/**
 * 按主体归组的报送数据（归组规则与金额口径在 shared/tax-subject.ts，有 19 条单测）。
 * 入参里的 licenseName/licenseNo 来自主进程，用来核对"平台报的主体"与"你填的执照"。
 */
const taxSubjectGroups = computed(() => groupTaxPeriodsBySubject(taxRows.value as any))
const taxSubjectTotal = computed(() => taxSubjectTotals(taxSubjectGroups.value))

/** 主体显示名（读不到主体信息时给一个明确的桶名，而不是空着） */
function taxSubjectLabel(group: any): string {
  return group?.label || (group?.key === UNKNOWN_TAX_SUBJECT_KEY ? UNKNOWN_TAX_SUBJECT_LABEL : '（未读到主体名称）')
}

/**
 * 平台报送主体 vs 店铺营业执照。
 *
 * 为什么单独做这一句：申报是按主体报的，而"平台报的是哪家公司"与"你执照里填的是哪家公司"
 * 不一致时，报出去就是错的主体——这件事必须在申报前被看见，而不是等税务比对出异常。
 */
function taxLicenseVerdictText(group: any): { text: string; tone: 'ok' | 'warn' | 'err' } {
  if (!group) return { text: '', tone: 'warn' }
  // 主体是**从店铺营业执照推来的**（平台页面没给主体信息，实测抖店就是这种）→
  // 必须说清来源。写成"与执照一致"是循环论证：那个主体本来就是拿执照填的。
  if (group.subjectSource === 'license') return { text: '主体取自店铺营业执照（平台页面未给主体）', tone: 'warn' }
  // 走到这里只有一种可能：页面没给主体、店里也没填营业执照（填了就会标 license）。
  // 所以直接给可执行的下一步，而不是一句"没有可核对的主体信息"。
  if (group.subjectSource === 'unknown') return { text: '平台页面未给主体，且店铺未填营业执照 —— 补填后即可归入主体', tone: 'warn' }
  if (group.licenseVerdict === 'mismatch') {
    return { text: `与执照不一致：${group.mismatchedStores.join('、')}`, tone: 'err' }
  }
  if (group.licenseVerdict === 'store-empty') {
    return { text: `还没填营业执照：${group.unlicensedStores.join('、')}`, tone: 'warn' }
  }
  if (group.licenseVerdict === 'match') return { text: '与已填执照一致', tone: 'ok' }
  return { text: '没有可核对的主体信息', tone: 'warn' }
}

function taxCellOf(row: any, key: string): string {
  return String(row?.cells?.[key] ?? '')
}
/** 货物口径的三段：快手是"一格三段式文本"、抖店是"三列分开"——统一走 taxIncomeFromCells 适配 */
function taxGoods(row: any) { return taxIncomeFromCells(row?.cells, 'goods') }
/** 服务口径的三段（同上） */
function taxService(row: any) { return taxIncomeFromCells(row?.cells, 'service') }
/**
 * 该报送期的申报口径净额：**平台给了「收入净额合计」就用它的**（实测抖店有这一列），
 * 没给才用 货物净额 + 服务净额（实测快手）。任一段缺失且平台也没给 → null（宁可显示「—」）
 */
function taxRowNet(row: any): number | null { return taxPeriodNetOf(row?.cells, taxGoods(row), taxService(row)) }
/**
 * 平台给的三段是否自洽（`金额 − 退款 = 净额`）。false = 平台自己的数对不上——
 * 申报前正是要被看见的那种事，所以单独标出来而不是替它圆过去。
 */
function taxRowReconciles(row: any): boolean | null {
  const goods = taxGoods(row); const service = taxService(row)
  if (goods.reconciles === false || service.reconciles === false) return false
  if (goods.reconciles === null && service.reconciles === null) return null
  return true
}
/** 某店的报送期汇总：期数 + 能算出来的净额合计（解析不出的期**不计入**并单独计数） */
function taxStoreSummary(storeRow: any) {
  let periods = 0; let net = 0; let netParsed = 0; let unparsed = 0
  for (const section of storeRow?.sections || []) {
    for (const item of section.items || []) {
      periods++
      const value = taxRowNet(item)
      if (value == null) unparsed++
      else { net += value; netParsed++ }
    }
  }
  return { periods, netParsed, unparsed, netText: taxAmountText(netParsed ? Math.round(net * 100) / 100 : null) }
}
/** 该店**有数据**的报送方向（没数据的整段不渲染，避免一大片空表） */
function taxSectionsWithItems(storeRow: any): any[] {
  return (storeRow?.sections || []).filter((section: any) => (section.items?.length || 0) > 0)
}
/**
 * 该店**本次没读到**的报送方向（采集侧 expected=false 的空标记，读取侧带出来的 emptyNote）。
 *
 * 为什么必须有它（2026-10-15 审查 H2）：发票分区对"本次没读到但有旧数据"会标红提示
 * （inv-sec-empty），涉税分区此前漏了——"本次没读到"时界面把**上一次的数据连旧时间一起**
 * 当当前结果显示，用户以为读到了。这里逐方向如实列出。
 */
function taxEmptyNotes(storeRow: any): Array<{ metricKey: string; name: string; emptyNote: string; emptyAt: number | null }> {
  return (storeRow?.sections || [])
    .filter((section: any) => !!section.emptyNote)
    .map((section: any) => ({
      metricKey: String(section.metricKey || ''),
      name: String(section.name || '涉税信息报送'),
      emptyNote: String(section.emptyNote),
      emptyAt: section.emptyAt || null
    }))
}

/**
 * 打开行内补录时，**从 `ws.stores` 取最新值**，不用一次性 IPC 载荷里的旧值。
 *
 * 为什么：这一行如果刚从行内保存过（或刚被「获取主体营业执照」写过），载荷里的 row 还是旧的。
 * 按旧 row 回填会把编辑框填成旧的空值——用户看着"没填上"再点一次保存，就把刚落库的主体清空了
 * （空串在 schema 里合法）。旧实现刻意避开过这一点（见已废弃弹窗的注释）。
 */
function openLicenseEditor(row: any) {
  const fresh = ws.stores.find(item => item.id === row.storeId)
  licenseEditingId.value = row.storeId
  // 店铺在 ws.stores 里就以它为准（哪怕它是空的）——否则"清空执照 + 载荷还是旧值"时，
  // 回填会把已清空的旧主体塞回输入框，再点一次保存就等于把清空撤销了
  licenseDraft.name = fresh ? (fresh.licenseName || '') : (row.licenseName || '')
  licenseDraft.no = fresh ? (fresh.licenseNo || '') : (row.licenseNo || '')
  licenseEditError.value = ''
}

/** 只重取发票载荷（不整页 loading、不重置滚动位置）：行内改完主体、取完主体后用 */
async function reloadInvoiceData() {
  const res = await window.shopilot.overview.invoiceCenter()
  if (res.ok) invoiceData.value = res.data
}

/** 只重取涉税报送载荷（同上：采集完刷新，但不整页 loading） */
async function reloadTaxData() {
  const res = await window.shopilot.overview.taxReport()
  if (res.ok) taxData.value = res.data
}

async function saveLicense(row: any) {
  licenseSaving.value = true
  licenseEditError.value = ''
  const result = await ws.setStoreLicense(row.storeId, licenseDraft.name.trim(), licenseDraft.no.trim())
  licenseSaving.value = false
  if (!result.ok) { licenseEditError.value = result.message || '保存失败'; return }
  licenseEditingId.value = ''
  // 保存成功后只重取发票载荷：行上的主体标签与「营业执照」胶囊都跟着刷新，而又不会把整页
  // 换成"正在读取本机数据…"（那会丢掉滚动位置）。
  await reloadInvoiceData()
  ws.toast('营业执照已保存', 'success')
}

/**
 * 「按主体」分组视图里正在编辑的店铺属于哪个组（编辑器挂在那一组下面）。
 * 兜底 NO_LICENSE_KEY 与行分桶同口径——绝不出现"编辑框开了、但不在任何组里"。
 */
const licenseEditingGroupKey = computed(() => (
  licenseEditingId.value ? (licenseGroups.value.keyByStore.get(licenseEditingId.value) || NO_LICENSE_KEY) : ''
))

/** 分组视图的「保存」：没有行对象，按正在编辑的 storeId 找回那一行，走同一套 saveLicense 纪律 */
async function saveLicenseInGroup(): Promise<void> {
  const row = invoiceAllRows.value.find(item => item.storeId === licenseEditingId.value)
  if (!row) return
  await saveLicense(row)
}

/** 未填写组的「去补录」：先展开该组（收起来了就看不见编辑器），再打开第一家未填执照店铺的行内编辑器 */
function startFillLicense(group: any): void {
  if (isSubjectCollapsed(group.key)) toggleSubjectGroup(group.key)
  const first = (group.stores || []).find((row: any) => row.needsLicense) || group.stores?.[0]
  if (first) openLicenseEditor(first)
}

/** 店铺名（结果面板里按 storeId 反查；取不到就退回主进程给的名字） */
function storeNameOf(storeId: string): string {
  return ws.stores.find(store => store.id === storeId)?.name || storeId
}

/**
 * 「平台读到的主体」与「已填主体」的对照结论——规则在 shared（compareStoreEntity/entityVerdictText，有单测）：
 * 平台没读到的字段说"未比对"，店里空着而平台读到的是"可补录"，只有真比过的字段才配说"一致"。
 */
function entityVerdict(row: any): string {
  return entityVerdictText(row, row.entity)
}

/** 「获取主体营业执照」结果里每行的一句话（照实说：填了什么、哪不一致、为什么取不了） */
function entityReportText(r: any): string {
  const written = r.written || {}
  // 平台值是哪次读的：写回可能用的是**旧快照**（这次没采到），不说清时间就会被当成"刚读到的"
  const readAt = r.entity?.capturedAt ? `（平台值读于 ${formatTime(r.entity.capturedAt)}）` : ''
  if (r.status === 'fill') {
    const parts: string[] = []
    if (written.licenseName) parts.push(`名称「${written.licenseName}」`)
    if (written.licenseNo) parts.push(`统一社会信用代码「${written.licenseNo}」`)
    return `已填入 ${parts.join(' + ')}${readAt}`
  }
  if (r.status === 'same') {
    // 「一致」只留给**比过的**字段：平台只读到一项时，另一项明说没比对
    const readName = !!r.entity?.name
    const readNo = !!r.entity?.no
    if (readName && readNo) return `平台读到的主体与已填一致，未改动${readAt}`
    const read = readName ? '名称' : '信用代码'
    const notRead = readName ? '信用代码' : '名称'
    return `平台读到的${read}与已填一致，未改动${readAt}；${notRead}平台没读到，未比对`
  }
  if (r.status === 'start-failed') return `这次没能开始采集：${r.note || '未知原因'}——结果里的结论来自上一次采集`
  if (r.status === 'conflict') {
    return '平台读到的与你已填的不一致——没有覆盖你的填写，请自己核对：' +
      (r.conflicts || []).map((c: any) => `${c.field === 'licenseName' ? '名称' : '信用代码'}：已填「${c.existing}」／平台「${c.fetched}」`).join('；')
  }
  if (r.status === 'nothing') {
    if (!(r.rejected || []).length) return '平台页面上没读到主体信息——该店可能是个人店铺（本来没有营业执照），也可能页面已改版；没有写入任何值'
    return '平台给的值不可用（未写入）：' + (r.rejected || []).map((x: any) => `${x.field === 'licenseName' ? '名称' : '信用代码'} ${x.raw}——${x.why}`).join('；')
  }
  if (r.status === 'no-data') return r.note || '还没有采到该店的主体信息'
  if (r.status === 'unsupported') return '该平台暂不能自动获取：' + (r.note || entityUnsupportedNote(r.platform))
  return String(r.status)
}

/** 已实测主体信息页的平台（按钮 tooltip 里如实写出来，免得用户以为"某家没处理"） */
const entitySupportedPlatforms = ENTITY_SUPPORTED_PLATFORMS

/** 补录主体时的名称候选：已填过的 + 平台读回来的（都去重、去空） */
const licenseNameOptions = computed<string[]>(() => {
  const names = new Set<string>()
  for (const store of ws.stores) {
    const name = normalizeLicenseName(store.licenseName)
    if (name) names.add(name)
  }
  for (const row of invoiceAllRows.value) {
    const name = normalizeLicenseName(row.entity?.name)
    if (name) names.add(name)
  }
  return [...names]
})

/**
 * 跳转该店的「开票地址」。地址口径（与采集口径一致，宁缺毋滥）：
 *   ① 有实测档案的平台 → 档案里的发票页（就是采集读的那一页，如 store.weixin.qq.com/shop/bill/home）；
 *   ② 没档案的平台 → 退回该店自己的后台地址，并在 tooltip 里如实写明"尚未实测到发票页"；
 *   ③ 两者都没有 → 返回空串，按钮置灰（不猜地址）。
 */

  return {
    sectionAmount,

    invoiceSubjectGroups,

    invoicePlatformCoverage,

    invoiceCsvColumns,

    taxDisclaimer,

    taxBasis,

    taxRows,

    taxSupportedPlatforms,

    taxView,

    taxExpandedSubject,

    taxSubjectGroups,

    taxSubjectTotal,

    taxSubjectLabel,

    taxLicenseVerdictText,

    taxCellOf,

    taxGoods,

    taxService,

    taxRowNet,

    taxRowReconciles,

    taxStoreSummary,

    taxSectionsWithItems,

    taxEmptyNotes,

    openLicenseEditor,

    reloadInvoiceData,

    reloadTaxData,

    saveLicense,

    licenseEditingGroupKey,

    saveLicenseInGroup,

    startFillLicense,

    storeNameOf,

    entityVerdict,

    entityReportText,

    entitySupportedPlatforms,

    licenseNameOptions,

  }
}

export type TaxLicenseApi = ReturnType<typeof useTaxLicense>
