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
import { invoiceProfileFor, INVOICE_COLUMNS, INVOICE_UNSUPPORTED_NOTE, normalizeCellText } from '@shared/constants/invoice'
import type { InvoiceColumnKey } from '@shared/constants/invoice'
import { ENTITY_METRIC_NAME, ENTITY_METRIC_NO, entityProfileFor, entityUnsupportedNote } from '@shared/constants/entity'
import { decideLicenseWrite, normalizeLicenseName, normalizeLicenseNo } from '@shared/store-license'

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

  // 每店**每指标**取最新一条（指标名形如 invoice.<方向>）
  const snapRows = db.prepare(`
    SELECT store_id, metric, value_json, captured_at, source_run_id FROM (
      SELECT store_id, metric, value_json, captured_at, source_run_id,
             ROW_NUMBER() OVER (PARTITION BY store_id, metric ORDER BY rowid DESC) AS rn
      FROM store_snapshots WHERE metric LIKE 'invoice.%'
    ) WHERE rn = 1
  `).all() as any[]
  // storeId -> metric -> snapshot
  const snapByStore = new Map<string, Map<string, any>>()
  for (const r of snapRows) {
    let v: any = r.value_json
    try { v = JSON.parse(r.value_json) } catch { /* 保底原样 */ }
    if (!snapByStore.has(r.store_id)) snapByStore.set(r.store_id, new Map())
    snapByStore.get(r.store_id)!.set(r.metric, { value: v, capturedAt: r.captured_at, manual: !r.source_run_id })
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
      WHERE t.name LIKE '发票采集 ·%'
    ) WHERE rn = 1
  `).all() as any[]
  const failByStore = new Map<string, any>()
  for (const f of lastRunRows) {
    if (failByStore.has(f.storeId)) continue
    failByStore.set(f.storeId, f.status === 'failed' ? f : null)   // 最近一次不是失败 → 不留旧失败
  }
  for (const [k, v] of [...failByStore]) if (!v) failByStore.delete(k)

  /** 把某个方向的原始表行映射成 {cells, extras} */
  const mapSection = (headerMap: Record<string, InvoiceColumnKey>, raw: any[]) => {
    const header: string[] = raw.length ? raw[0].map((x: any) => normalizeCellText(x)) : []
    const colOf = new Map<number, InvoiceColumnKey>()
    const extraIdx: number[] = []
    header.forEach((h, i) => {
      const k = headerMap[h]
      if (k) colOf.set(i, k)
      else if (h) extraIdx.push(i)
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
        pending: sec.pending !== false,
        notPendingNote: sec.notPendingNote || null
      }
      // labels 模式：该方向不是表格，值分散在 `<metricKey>.<列key>` 的快照里 → 拼成一行。
      // 一个标签都没读到时才视作"没采集"（有部分值也如实展示，缺的列留空）。
      if (sec.labels?.length) {
        const cells: Partial<Record<InvoiceColumnKey, string>> = {}
        let capturedAt: number | null = null
        let manual = false
        for (const l of sec.labels) {
          const snap = snaps.get(`${metricKey}.${l.key}`)
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
      const snap = snaps.get(metricKey) || null
      const raw: any[] = Array.isArray(snap?.value) ? snap.value : []
      const { header, items } = mapSection(sec.headerMap, raw)
      return {
        ...base,
        capturedAt: snap?.capturedAt || null,
        manual: snap ? !!snap.manual : false,
        header,
        items
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
    const count = sections.reduce((n: number, x: any) => n + (x.pending === false ? 0 : (x.items?.length || 0)), 0)
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
export function applyEntityToStores() {
  const db = getDatabase()
  const stores = db.prepare(
    `SELECT id, name, platform, license_name, license_no FROM stores WHERE deleted_at IS NULL ORDER BY platform, name`
  ).all() as any[]
  const entities = collectEntities()
  const rows = stores.map(s => {
    const profile = entityProfileFor(s.platform)
    const base = { storeId: s.id, storeName: s.name, platform: s.platform }
    if (!profile) {
      return { ...base, status: 'unsupported' as const, note: entityUnsupportedNote(s.platform) }
    }
    const got = entities.get(s.id) || null
    if (!got || (!got.name && !got.no)) {
      return { ...base, status: 'no-data' as const, note: '还没有采到该店的主体信息（先点「获取主体营业执照」跑一次采集）' }
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
    tasks: (db.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c
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

  // 邀约运行（任务名前缀「达人邀约 ·」）：状态分布 + 最近若干条
  const inviteWhere = "t.name LIKE '达人邀约 ·%'"
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
