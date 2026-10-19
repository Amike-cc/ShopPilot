/**
 * 概览计算服务 - §6.6 / §6.7
 *
 * 从 ipc/profile-misc-handlers.ts 抽出的概览计算：工作台概览 / 发票中心 / 主体写回 / 数据中心。
 * 集中在这里是为了让 IPC 之外的调用方（例如智能体工具）复用同一份口径：字段名、SQL、
 * 审计事件与原处理器逐字一致。
 *
 * 2026-09-26 审计 P2（`overview-service ⇄ ipc` 成环）：取数 helper（collectInvoiceRows /
 * collectEntities）也搬进本文件。原先它们在 ipc/profile-misc-handlers.ts 里、本文件反过来
 * import，形成 service → ipc → service 的循环 import（当时靠"两个模块顶层只有函数声明、
 * 会被提升"来说明安全性）。现在方向是单向的 `ipc → services`，`overview:invoiceExport`
 * 仍用同一份取数逻辑（从本文件 import），口径没有第二处实现。
 */

import { getDatabase } from '../db/database'
import * as StoreManager from '../stores/store-manager'
import { writeAudit } from './audit-logger'
import { invoiceProfileFor, INVOICE_COLUMNS, INVOICE_TASK_PREFIX, INVOICE_UNSUPPORTED_NOTE, isPendingSection, normalizeCellText } from '@shared/constants/invoice'

/** 统一列 key 的集合：表头本身就是 key 时也要能识别（见 mapSection 的回退） */
const INVOICE_COLUMN_KEY_SET = new Set<string>(INVOICE_COLUMNS.map(c => c.key))
import { pickSectionRows } from '@shared/invoice-snapshot'
import type { InvoiceColumnKey } from '@shared/constants/invoice'
import { ENTITY_METRIC_NAME, ENTITY_METRIC_NO, entityProfileFor, entityUnsupportedNote } from '@shared/constants/entity'
import { decideLicenseWrite, normalizeLicenseName, normalizeLicenseNo } from '@shared/store-license'
import { TAX_COLUMNS, TAX_DATA_DISCLAIMER, TAX_REPORT_BASIS, TAX_TASK_PREFIX, TAX_UNSUPPORTED_NOTE, taxProfileFor } from '@shared/constants/tax'
import type { TaxColumnKey } from '@shared/constants/tax'

/**
 * overview:stats - 工作台概览
 */
export function overviewStatsSummary() {
  const db = getDatabase()
  const stats = {
    totalStores: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL').get() as any).c,
    onlineStores: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'online'").get() as any).c,
    archivedStores: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'archived'").get() as any).c,
    trashStores: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NOT NULL').get() as any).c,
    downloads24h: (db.prepare('SELECT COUNT(*) c FROM downloads WHERE created_at > ?').get(Date.now() - 86400000) as any).c,
    bookmarks: (db.prepare('SELECT COUNT(*) c FROM bookmarks').get() as any).c
  }
  return stats
}

/**
 * 汇总各店铺的待开票信息（发票中心与导出共用这一份取数逻辑）。
 *
 * 数据来源：采集任务在发票页 readTable(keepRows) 落下的快照。
 * **按开票方向分开**：每个方向一条独立指标（invoice.applyPlatform / invoice.toPlatform / invoice.toBuyer…），
 * 因为实测同一页的「申请平台开票」与「给平台开票」是不同数据，混在一起会漏记录。
 * 表头按该方向的实测映射转成统一列；映射不到的列不丢，放进 extras。
 * 没有快照的方向如实返回空 items（界面显示"还没采集"），绝不估算或伪造。
 *
 * 导出给 services/overview-service.ts 复用（发票中心与导出同一份口径）。
 *
 * 注意：overview-service 反过来 import 本文件（见那边的模块注释），构成循环 import。
 * 两个模块顶层只有 import / const / 函数声明、互不依赖对方的顶层求值，函数声明会被提升，
 * tsc 与 rollup 单文件打包下都安全；不要在这里加依赖 overview-service 的顶层常量。
 */
export function collectInvoiceRows(): any[] {
  const db = getDatabase()
  const stores = db.prepare(
    `SELECT id, name, platform, status, admin_url, license_name, license_no FROM stores WHERE deleted_at IS NULL ORDER BY platform, name`
  ).all() as any[]
  const entities = collectEntities()

  // 每店**每指标**取最新两条（指标名形如 invoice.<方向>）。
  // 为什么要两条：采集侧"这次没读到"时写的是**标记**（{empty:true,why}），不是空数组——
  // 读取侧要能跳过标记、继续用上一份真数据（见 shared/invoice-snapshot.ts 的说明）。
  const snapRows = db.prepare(`
    SELECT store_id, metric, value_json, captured_at, source_run_id FROM (
      SELECT store_id, metric, value_json, captured_at, source_run_id,
             ROW_NUMBER() OVER (PARTITION BY store_id, metric ORDER BY rowid DESC) AS rn
      FROM store_snapshots WHERE metric LIKE 'invoice.%'
    ) WHERE rn <= 2
  `).all() as any[]
  // storeId -> metric -> 快照（新的在前）
  const snapByStore = new Map<string, Map<string, any[]>>()
  for (const r of snapRows) {
    let v: any = r.value_json
    try { v = JSON.parse(r.value_json) } catch { /* 保底原样 */ }
    if (!snapByStore.has(r.store_id)) snapByStore.set(r.store_id, new Map())
    const byMetric = snapByStore.get(r.store_id)!
    const list = byMetric.get(r.metric) || []
    list.push({ value: v, capturedAt: r.captured_at, manual: !r.source_run_id })
    byMetric.set(r.metric, list)
  }

  // 采集失败信息：取该店铺**最近一次**「发票采集 ·」运行，只有它确实是失败时才回报。
  //
  // 为什么不能直接筛 status='failed'：那样会把**早已被后续成功覆盖**的旧失败一直挂在界面上
  // （实测：微信/抖店这次采集已经成功抓到数据，界面却还显示上一次的 TASK_TARGET_COVERED，
  // 看起来像"现在也坏了"）。取最近一次运行再看它的状态，才是如实描述"当前状态"。
  const lastRunRows = db.prepare(`
    SELECT storeId, status, error_code, error_message, finished_at FROM (
      SELECT s.id AS storeId, r.status AS status, r.error_code AS error_code,
             r.error_message AS error_message, r.finished_at AS finished_at,
             ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY r.rowid DESC) AS rn
      FROM task_runs r
      JOIN tasks t ON t.id = r.task_id
      JOIN stores s ON s.id = r.store_id
      WHERE t.name LIKE ?
    ) WHERE rn = 1
  `).all(`${INVOICE_TASK_PREFIX}%`) as any[]
  const failByStore = new Map<string, any>()
  for (const f of lastRunRows) {
    if (failByStore.has(f.storeId)) continue
    failByStore.set(f.storeId, f.status === 'failed' ? f : null)   // 最近一次不是失败 → 不留旧失败
  }
  for (const [k, v] of [...failByStore]) if (!v) failByStore.delete(k)

  /** 把某个方向的原始表行映射成 {cells, extras} */
  const mapSection = (headerMap: Record<string, InvoiceColumnKey>, raw: any[]) => {
    const header: string[] = raw.length ? raw[0].map((x: any) => normalizeCellText(x)) : []
    /**
     * 「操作」列**不是数据**，是页面上的按钮（实测列里躺着
     * `开票` / `申请开票` / `上传发票` / `录入发票` / `提交发票 支付违约金 账单导出` / `导出明细 查看详情`）。
     * 不挡住它，它就会进「其他信息」→ 再进导出的 CSV，每一行都拖一句操作按钮文案，
     * 而这份 CSV 是交给代账/报税用的，那些字对他们毫无意义（2026-10-15 审查确认）。
     */
    const ACTION_HEADER_RE = /^(?:操作|操作栏|操作列|更多操作)$/
    const colOf = new Map<number, InvoiceColumnKey>()
    const extraIdx: number[] = []
    header.forEach((h, i) => {
      // 首选按**平台表头文案**映射（平台加列也不会错位）。
      // 回退：表头本身就是**统一列 key** —— `readCards` / `readApi` 这类读取器直接产出
      // 统一 key 当表头（实测拼多多「申请发票」的卡片：period / amount / title），
      // 档案的 headerMap 是空的，没有这一步就会整行映射不出来、界面显示 0 条。
      const k = headerMap[h] || (INVOICE_COLUMN_KEY_SET.has(h) ? (h as InvoiceColumnKey) : undefined)
      if (k) colOf.set(i, k)
      else if (h && !ACTION_HEADER_RE.test(h)) extraIdx.push(i)
    })
    const items = raw.slice(1)
      .filter(r => Array.isArray(r) && r.some(c => String(c ?? '').trim() !== ''))
      .map(r => {
        const cells: Partial<Record<InvoiceColumnKey, string>> = {}
        for (const [i, k] of colOf) cells[k] = normalizeCellText(r[i])
        const extras = extraIdx
          .map(i => ({ label: header[i], value: normalizeCellText(r[i]) }))
          .filter(x => x.value && x.value !== '-')
        return { cells, extras }
      })
    return { header, items }
  }

  return stores.map(s => {
    const profile = invoiceProfileFor(s.platform)
    const snaps = snapByStore.get(s.id) || new Map<string, any>()
    // 按档案登记的方向逐个取（没档案的平台给空数组，界面如实说明）
    const sections = (profile?.sections || []).map(sec => {
      const name = sec.name
      const metricKey = sec.metricKey
      // pending 默认 true；false = 该方向是**已提交、商家无需操作**的流水（如快手「处理中」「处理记录」），
      // 展示照常，但不计入"待开票条数/可开金额合计"，否则合计虚高
      const base = {
        name, metricKey, measuredRows: sec.measuredRows,
        pending: isPendingSection(sec),
        notPendingNote: sec.notPendingNote || null
      }
      // labels 模式：该方向不是表格，值分散在 `<metricKey>.<列key>` 的快照里 → 拼成一行。
      // 一个标签都没读到时才视作"没采集"（有部分值也如实展示，缺的列留空）。
      if (sec.labels?.length) {
        const cells: Partial<Record<InvoiceColumnKey, string>> = {}
        let capturedAt: number | null = null
        let manual = false
        for (const l of sec.labels) {
          const list: any[] = snaps.get(`${metricKey}.${l.key}`) || []
          // labels 方向的值是字符串；表格方向那套"空标记"不适用于它，这里跳过非字符串的脏值
          const snap = list.find((item: any) => typeof item.value === 'string' || (item.value != null && !(typeof item.value === 'object' && item.value.empty)))
          if (!snap) continue
          const v = typeof snap.value === 'string' ? snap.value : String(snap.value ?? '')
          if (v) cells[l.key] = v
          if (snap.capturedAt && (!capturedAt || snap.capturedAt > capturedAt)) capturedAt = snap.capturedAt
          manual = manual || !!snap.manual
        }
        const hasAny = Object.keys(cells).length > 0
        return {
          ...base,
          capturedAt,
          manual,
          header: [],
          items: hasAny ? [{ cells, extras: [] }] : []
        }
      }
      // 表格方向：取最新的一份**数组**快照；"这次没读到"的标记不覆盖数据，只作提示（见 shared/invoice-snapshot.ts）
      const picked = pickSectionRows(snaps.get(metricKey) || [])
      const { header, items } = mapSection(sec.headerMap, picked.rows)
      return {
        ...base,
        capturedAt: picked.capturedAt,
        manual: (snaps.get(metricKey) || []).some((item: any) => item.manual && Array.isArray(item.value)),
        header,
        items,
        // 上一次跑没读到这个方向（页签没切成功等）→ 界面如实说明"下面是上一次的数据"
        emptyNote: picked.emptyNote,
        emptyAt: picked.emptyAt
      }
    })
    const fail = failByStore.get(s.id) || null
    // 该店所有方向的最新采集时间（用于头部展示）
    const capturedAt = sections.reduce((acc: number | null, x: any) => (x.capturedAt && (!acc || x.capturedAt > acc) ? x.capturedAt : acc), null)
    // **待办条数**：界面头部显示"N 条待办"用的就是它。
    // 此前界面读 `row.count`，而主进程从来不返回这个字段 → 每家店恒显示「0 条待办」，
    // 即使下面的分方向明细里躺着几十条（2026-09-28 审查确认的"恒错数字"，比报错更危险：
    // 用户会据此以为没有待办）。口径与 sections.pending 一致——只数需要商家动手的方向，
    // 「处理中/处理记录」这类已提交流水不计入。
    const count = sections.reduce((n: number, x: any) => n + (isPendingSection(x) ? (x.items?.length || 0) : 0), 0)
    return {
      storeId: s.id,
      storeName: s.name,
      platform: s.platform,
      count,
      // 营业执照：发票按**开票主体**分账（同一个执照下常挂多家店），导出也带这两列
      licenseName: normalizeLicenseName(s.license_name) || null,
      licenseNo: normalizeLicenseNo(s.license_no) || null,
      // 平台自己说这个店的主体是谁（采集到才有；界面在主体标签旁如实展示，用于核对）
      entity: entities.get(s.id) || null,
      /** 该平台能不能自动取主体（不能的照实说明原因） */
      entitySupported: !!entityProfileFor(s.platform),
      entityNote: entityProfileFor(s.platform)?.note || null,
      entityUnsupported: entityProfileFor(s.platform) ? null : entityUnsupportedNote(s.platform),
      // 该平台是否有实测的发票档案（没有 = 抓不了，界面如实说明）
      supported: !!profile,
      unsupportedReason: profile ? null : (INVOICE_UNSUPPORTED_NOTE[s.platform] || '该平台尚未实测到可读取的发票页'),
      measuredAt: profile?.measuredAt || null,
      pageUrl: profile?.pageUrl || null,
      adminUrl: s.admin_url || null,
      note: profile?.note || null,
      capturedAt,
      manual: sections.some((x: any) => x.manual),
      sections,
      // 最近一次采集失败的原因（界面在"没有数据"时如实展示，而不是只说"暂无"）
      lastFail: fail ? { code: fail.error_code || null, message: String(fail.error_message || '').slice(0, 240), at: fail.finished_at || null } : null,
      // 登录态失效是可以由用户自己解决的一件事 → 单独标出来，界面直接给「去登录」，
      // 而不是让用户对着一句"超时"猜。
      loginRequired: fail ? String(fail.error_code || '').includes('LOGIN_REQUIRED') : false
    }
  })
}

/**
 * 各店铺最近一次采到的**主体信息**（entity.name / entity.no 快照）——发票中心与主体写回共用。
 * 没有就返回空表（界面如实显示"还没采集"），不做任何推断。
 *
 * 导出给 services/overview-service.ts 复用（发票中心与主体写回同一份口径）。
 */
export function collectEntities(): Map<string, { name: string | null; no: string | null; capturedAt: number | null }> {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT store_id, metric, value_json, captured_at FROM (
      SELECT store_id, metric, value_json, captured_at,
             ROW_NUMBER() OVER (PARTITION BY store_id, metric ORDER BY rowid DESC) AS rn
      FROM store_snapshots WHERE metric IN (?, ?)
    ) WHERE rn = 1
  `).all(ENTITY_METRIC_NAME, ENTITY_METRIC_NO) as any[]
  const out = new Map<string, { name: string | null; no: string | null; capturedAt: number | null }>()
  for (const r of rows) {
    let v: any = r.value_json
    try { v = JSON.parse(r.value_json) } catch { /* 保底原样 */ }
    const text = String(v ?? '').trim()
    const hit = out.get(r.store_id) || { name: null, no: null, capturedAt: null }
    if (r.metric === ENTITY_METRIC_NAME && text) hit.name = text
    if (r.metric === ENTITY_METRIC_NO && text) hit.no = text
    if (r.captured_at && (!hit.capturedAt || r.captured_at > hit.capturedAt)) hit.capturedAt = r.captured_at
    out.set(r.store_id, hit)
  }
  return out
}
/**
 * overview:invoiceCenter - 发票中心：汇总各店铺的**待开票信息**（只读）。
 *
 * 数据来源：采集任务在发票页 readTable(keepRows) 落下的快照（metric = invoice.rows）。
 * 这里把**原始表行**按该平台实测的表头映射到统一列（见 shared/constants/invoice.ts）；
 * 映射不到的列不丢，放进 extras 一并展示——平台加列不会让数据消失。
 * 没有任何快照就如实返回空数组（界面显示"还没采集"），绝不估算或伪造。
 */
export function overviewInvoiceCenter() {
  return { generatedAt: Date.now(), columns: INVOICE_COLUMNS, rows: collectInvoiceRows() }
}

/**
 * 汇总各店铺的**涉税信息报送**数据（发票中心里的「涉税信息报送」分区用）。
 *
 * 数据来源：采集任务在平台的涉税信息报送页 readTable(keepRows) 落下的快照（metric = tax.report）。
 * 与发票同一套机制：表头按**实测映射**转成统一列、整表保留、映射不到的列不丢。
 *
 * 三条如实原则：
 *  1. 未实测到该页的平台 → `supported: false` + 具体原因，界面照实说"抓不了"，
 *     绝不显示成"该店没有涉税数据"（那是两件事）；
 *  2. 没有任何快照 → 空 items（"还没采集"），不估算、不伪造；
 *  3. **把平台自己的用途限制（disclaimer）随数据一起返回**——快手该页写明这份数据
 *     "不得作为税务申报…使用"。把数据摆到申报场景旁边却不带这句，等于应用在误导用户。
 */
export function collectTaxRows(): any[] {
  const db = getDatabase()
  const stores = db.prepare(
    `SELECT id, name, platform, admin_url, license_name, license_no FROM stores WHERE deleted_at IS NULL ORDER BY platform, name`
  ).all() as any[]

  // 每店每指标取最新两条：采集侧"没读到"写的是带原因的标记而不是空数组，
  // 读取侧要能跳过标记继续用上一份真数据（复用发票那一份 pickSectionRows 的语义）。
  const snapRows = db.prepare(`
    SELECT store_id, metric, value_json, captured_at, source_run_id FROM (
      SELECT store_id, metric, value_json, captured_at, source_run_id,
             ROW_NUMBER() OVER (PARTITION BY store_id, metric ORDER BY rowid DESC) AS rn
      FROM store_snapshots WHERE metric LIKE 'tax.%'
    ) WHERE rn <= 2
  `).all() as any[]
  const snapByStore = new Map<string, Map<string, any[]>>()
  for (const r of snapRows) {
    let v: any = r.value_json
    try { v = JSON.parse(r.value_json) } catch { /* 保底原样 */ }
    if (!snapByStore.has(r.store_id)) snapByStore.set(r.store_id, new Map())
    const byMetric = snapByStore.get(r.store_id)!
    const list = byMetric.get(r.metric) || []
    list.push({ value: v, capturedAt: r.captured_at, manual: !r.source_run_id })
    byMetric.set(r.metric, list)
  }

  // 最近一次「涉税报送采集 ·」运行：只有它确实失败时才回报（旧失败不挂在界面上，口径同发票）
  const lastRunRows = db.prepare(`
    SELECT storeId, status, error_code, error_message, finished_at FROM (
      SELECT s.id AS storeId, r.status AS status, r.error_code AS error_code,
             r.error_message AS error_message, r.finished_at AS finished_at,
             ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY r.rowid DESC) AS rn
      FROM task_runs r
      JOIN tasks t ON t.id = r.task_id
      JOIN stores s ON s.id = r.store_id
      WHERE t.name LIKE ?
    ) WHERE rn = 1
  `).all(`${TAX_TASK_PREFIX}%`) as any[]
  const failByStore = new Map<string, any>()
  for (const f of lastRunRows) if (!failByStore.has(f.storeId) && f.status === 'failed') failByStore.set(f.storeId, f)

  /**
   * 把报送表的原始行映射成 {cells, extras}。
   *
   * 两种映射方式：
   *  · 默认按**表头文案**（`headerMap`）——平台加列也不会错位，首选；
   *  · 方向给了 `columns` 时按**列序**（合并单元格表头的表只能这样，见 TaxSection.columns 的说明）。
   */
  const mapSection = (section: { headerMap: Record<string, TaxColumnKey | string>; columns?: readonly string[]; requireFields?: readonly string[] }, raw: any[]) => {
    const header: string[] = raw.length ? raw[0].map((x: any) => normalizeCellText(x)) : []
    const useIndex = Array.isArray(section.columns) && section.columns.length > 0
    const colOf = new Map<number, string>()
    const extraIdx: number[] = []
    if (useIndex) {
      // 按列序：第 i 格 → columns[i]（空串 = 该列不要，如「操作」按钮列）
      section.columns!.forEach((key, i) => { if (key) colOf.set(i, key) })
    } else {
      header.forEach((h, i) => {
        const k = section.headerMap[h]
        if (k) colOf.set(i, k)
        else if (h) extraIdx.push(i)
      })
    }
    const items = raw.slice(1)
      // 空行（实测快手数据表第一行是全空占位）与重复表头行都在这里被挡掉
      .filter(r => Array.isArray(r) && r.some(c => String(c ?? '').trim() !== ''))
      .map(r => {
        const cells: Record<string, string> = {}
        for (const [i, k] of colOf) cells[k] = normalizeCellText(r[i])
        const extras = extraIdx
          .map(i => ({ label: header[i], value: normalizeCellText(r[i]) }))
          .filter(x => x.value && x.value !== '-')
        return { cells, extras }
      })
      // requireFields：必填列有一格为空 → 这一行不是记录。
      // 实测抖店：季度行下面挂着「结算明细…」的展开行，「报送数据时间」为空，
      // 既不是全空行也不是表头行，通用清洗拦不住，会被算成一个"金额未解析"的报送期。
      .filter(item => {
        const required = section.requireFields
        if (!required?.length) return true
        return required.every(key => String(item.cells[key] ?? '').trim() !== '')
      })
    return { header, items }
  }

  return stores.map(s => {
    const profile = taxProfileFor(s.platform)
    const snaps = snapByStore.get(s.id) || new Map<string, any>()
    const sections = (profile?.sections || []).map(sec => {
      const picked = pickSectionRows(snaps.get(sec.metricKey) || [])
      const { header, items } = mapSection(sec, picked.rows)
      return {
        name: sec.name,
        metricKey: sec.metricKey,
        header,
        items,
        capturedAt: picked.capturedAt,
        manual: (snaps.get(sec.metricKey) || []).some((item: any) => item.manual && Array.isArray(item.value)),
        emptyNote: picked.emptyNote || null,
        emptyAt: picked.emptyAt || null
      }
    })
    const fail = failByStore.get(s.id) || null
    const capturedAt = sections.reduce((acc: number | null, x: any) => (x.capturedAt && (!acc || x.capturedAt > acc) ? x.capturedAt : acc), null)
    return {
      storeId: s.id,
      storeName: s.name,
      platform: s.platform,
      // 营业执照：用来与**平台报送的主体**核对（同一个主体常挂好几家店，
      // 而"平台报的是哪家公司"和"你以为填的是哪家公司"不一致时，申报前必须先看见）
      licenseName: normalizeLicenseName(s.license_name) || null,
      licenseNo: normalizeLicenseNo(s.license_no) || null,
      supported: !!profile,
      // 未实测 → 说清是哪一家、为什么；实测过但这次没采到 → sections 为空，界面照实说
      unsupportedReason: profile ? null : (TAX_UNSUPPORTED_NOTE[s.platform] || '该平台尚未实测到可读取的涉税信息报送页'),
      measuredAt: profile?.measuredAt || null,
      pageUrl: profile?.pageUrl || null,
      adminUrl: s.admin_url || null,
      note: profile?.note || null,
      capturedAt,
      count: sections.reduce((n: number, x: any) => n + (x.items?.length || 0), 0),
      sections,
      lastFail: fail ? { code: fail.error_code || null, message: String(fail.error_message || '').slice(0, 240), at: fail.finished_at || null } : null,
      loginRequired: fail ? String(fail.error_code || '').includes('LOGIN_REQUIRED') : false
    }
  })
}

/** overview:taxReport - 涉税信息报送（只读）；随数据一起给出平台自己的用途限制 */
export function overviewTaxReport() {
  const rows = collectTaxRows()
  return {
    generatedAt: Date.now(),
    columns: TAX_COLUMNS,
    /** 平台页面原文的用途限制——界面必须与数据同屏显示，不能只放在文档里 */
    disclaimer: TAX_DATA_DISCLAIMER,
    basis: TAX_REPORT_BASIS,
    rows
  }
}

/**
 * overview:entityApply - 把**已经采到的**店铺主体（entity.name / entity.no 快照）写进
 * stores.license_name / license_no，并如实回报每一家的情况。
 *
 * 写入规则（宁可少填，不可填错——错一个公司就是错票）：
 *  - 店铺该字段空着 → 写入；
 *  - 已填且与平台一致 → 不动，报 same；
 *  - 已填但与平台不同 → **不覆盖**，把两个值都回报给界面，由用户判断；
 *  - 平台给的是掩码 / 形态不对 → 不写，如实说明（实测微信的信用代码是掩码）。
 * 只读快照、只改这两列，不做任何页面操作（采集在任务里）。
 */
export function applyEntityToStores(storeIds?: readonly string[]) {
  const db = getDatabase()
  const selected = [...new Set((storeIds || []).filter(Boolean))]
  const stores = (selected.length
    ? db.prepare(`SELECT id, name, platform, license_name, license_no FROM stores WHERE deleted_at IS NULL AND id IN (${selected.map(() => '?').join(',')}) ORDER BY platform, name`).all(...selected)
    : db.prepare(`SELECT id, name, platform, license_name, license_no FROM stores WHERE deleted_at IS NULL ORDER BY platform, name`).all()) as any[]
  const entities = collectEntities()
  const rows = stores.map(s => {
    const profile = entityProfileFor(s.platform)
    const base = { storeId: s.id, storeName: s.name, platform: s.platform }
    if (!profile) {
      return { ...base, status: 'unsupported' as const, note: entityUnsupportedNote(s.platform) }
    }
    const got = entities.get(s.id) || null
    if (!got || (!got.name && !got.no)) {
      return { ...base, status: 'no-data' as const, note: '没有采到该店的主体信息（个人店铺本来就没有这两行；页面上读不到时不会写入任何值，可点「获取主体营业执照」再读一次）' }
    }
    const decision = decideLicenseWrite({ licenseName: s.license_name, licenseNo: s.license_no }, got)
    if (Object.keys(decision.write).length) {
      StoreManager.updateStore({ storeId: s.id, patch: decision.write })
    }
    return {
      ...base,
      status: decision.action,
      entity: { name: got.name, no: got.no, capturedAt: got.capturedAt, source: profile.pageUrl, measuredAt: profile.measuredAt },
      written: decision.write,
      conflicts: decision.conflicts,
      rejected: decision.rejected
    }
  })
  const filled = rows.filter(r => r.status === 'fill').length
  writeAudit('store.licenseFromEntity', 'success', { requestId: JSON.stringify({ filled, total: rows.length }) })
  return { appliedAt: Date.now(), filled, rows }
}

/**
 * overview:datacenter - 数据中心：汇总**所有店铺**的数据（只读）。
 * 数据来源都是本机既有表：stores / store_snapshots（任务 readText·readTable 的指标快照）/
 * task_runs（任务与邀约运行）。不做任何估算或补数：没有数据就如实返回空数组，由界面显示空状态。
 */
export function overviewDatacenterSummary() {
  const db = getDatabase()
  const weekAgo = Date.now() - 7 * 86400000

  const byPlatform = db.prepare(
    'SELECT platform, COUNT(*) c, SUM(CASE WHEN status = \'online\' THEN 1 ELSE 0 END) online FROM stores WHERE deleted_at IS NULL GROUP BY platform ORDER BY c DESC'
  ).all() as any[]

  const totals = {
    stores: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL').get() as any).c,
    online: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'online'").get() as any).c,
    archived: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'archived'").get() as any).c,
    trash: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NOT NULL').get() as any).c,
    platforms: byPlatform.length,
    snapshots: (db.prepare('SELECT COUNT(*) c FROM store_snapshots').get() as any).c,
    // 「发票采集」（每 3 小时）与「涉税报送采集」（按季度）都是**后台刷新**，不是用户要管理的
    // 任务 → 不计入任务总数。前缀分别见 shared/constants/invoice 与 shared/constants/tax；
    // 渲染层列表/统计用同一个口径的 isBackgroundCollectTask（shared/constants/collection），
    // 两边由 tests/unit/invoice-task-exclusion.test.ts 钉住一致
    // （2026-10-15 审查 M5 修复：以前只排发票，涉税采集任务会把总数撑大）
    tasks: (db.prepare("SELECT COUNT(*) c FROM tasks WHERE COALESCE(name, '') NOT LIKE ? AND COALESCE(name, '') NOT LIKE ?")
      .get(`${INVOICE_TASK_PREFIX}%`, `${TAX_TASK_PREFIX}%`) as any).c
  }

  // 每店每指标的最新一条 + **上一条**（用于数据中心显示"较上次采集的增减"）。
  // 必须带 store_id：界面按 storeId 归位，两家同名店铺的指标才不会串到同一行。
  const snapRows = db.prepare(`
    SELECT storeId, storeName, platform, metric, value_json, captured_at, source_run_id, rn FROM (
      SELECT s.id AS storeId, s.name AS storeName, s.platform AS platform, sn.metric AS metric,
             sn.value_json AS value_json, sn.captured_at AS captured_at,
             sn.source_run_id AS source_run_id,
             ROW_NUMBER() OVER (PARTITION BY sn.store_id, sn.metric ORDER BY sn.rowid DESC) AS rn
      FROM store_snapshots sn
      JOIN stores s ON s.id = sn.store_id
      -- B5：发票快照（整张表，最大 2000 行 × 500 字符）不进"指标快照"列表：
      -- 它们不是经营指标，界面上会被 JSON.stringify 成一坨原文（还带买家填的抬头/税号），
      -- 而发票中心自己有地方展示（方向 + 明细）。
      -- tax.* 同理（2026-10-15 审查 M4）：tax.report 是涉税报送整表（含主体名称/纳税人识别号），
      -- 涉税分区自己展示，漏进这里同样是一坨 JSON。
      WHERE sn.metric NOT LIKE 'invoice.%' AND sn.metric NOT LIKE 'tax.%'
    ) WHERE rn <= 2
    ORDER BY storeName, metric, rn
    LIMIT 600
  `).all() as any[]
  const parseVal = (json: any) => { try { return JSON.parse(json) } catch { return json } }
  const snapMap = new Map<string, any>()
  const snapshots: any[] = []
  for (const r of snapRows) {
    // 键带上店铺 id：按名字做键时同名店铺会互相覆盖（后一条把前一条的 prevValue 写错）
    const key = String(r.storeId) + '\u0000' + r.metric
    if (r.rn === 1) {
      const item = {
        storeId: r.storeId, storeName: r.storeName, platform: r.platform, metric: r.metric,
        value: parseVal(r.value_json), capturedAt: r.captured_at,
        // 来源：无关联运行 = 手动录入（界面据此标记，绝不与自动采集的数字混淆）
        manual: !r.source_run_id,
        prevValue: null as unknown
      }
      snapMap.set(key, item)
      snapshots.push(item)
    } else {
      const item = snapMap.get(key)
      if (item) item.prevValue = parseVal(r.value_json)
    }
  }

  // 邀约运行：用迁移 v33 的显式 kind（名称前缀只做展示，改名/智能体建任务不再影响统计）
  const inviteWhere = "t.kind = 'creator_invite'"
  const inviteByStatus = db.prepare(`
    SELECT r.status, COUNT(*) c FROM task_runs r JOIN tasks t ON t.id = r.task_id
    WHERE ${inviteWhere} GROUP BY r.status
  `).all() as any[]
  const inviteRecent = db.prepare(`
    SELECT s.name AS storeName, t.name AS taskName, r.status, r.error_code, r.status_reason, r.started_at, r.finished_at
    FROM task_runs r JOIN tasks t ON t.id = r.task_id LEFT JOIN stores s ON s.id = r.store_id
    WHERE ${inviteWhere} ORDER BY r.rowid DESC LIMIT 10
  `).all() as any[]

  // 任务运行（近 7 天）状态分布 + 最近失败
  const runsByStatus = db.prepare(
    'SELECT status, COUNT(*) c FROM task_runs WHERE started_at > ? GROUP BY status'
  ).all(weekAgo) as any[]
  const recentIssues = db.prepare(`
    SELECT s.name AS storeName, t.name AS taskName, r.status, r.error_code, r.error_message, r.finished_at
    FROM task_runs r JOIN tasks t ON t.id = r.task_id LEFT JOIN stores s ON s.id = r.store_id
    WHERE r.status IN ('failed','cancelled') ORDER BY r.rowid DESC LIMIT 8
  `).all() as any[]

  return {
    generatedAt: Date.now(),
    totals,
    byPlatform,
    snapshots,
    invite: { byStatus: inviteByStatus, recent: inviteRecent },
    runs: { byStatus: runsByStatus, recentIssues }
  }
}
