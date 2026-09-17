/**
 * 环境配置 / 概览 / 设置 / 审计 IPC 处理器 - §6.6 / §6.7
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow, dialog, app } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as ProfileManager from '../stores/profile-manager'
import * as StoreManager from '../stores/store-manager'
import * as TaskStore from '../tasks/task-store'
import { verifyStoreFingerprint } from '../browser/fingerprint-injector'
import { getDatabase } from '../db/database'
import { writeAudit, queryAudit } from '../services/audit-logger'
import { invoiceProfileFor, INVOICE_COLUMNS, INVOICE_UNSUPPORTED_NOTE, normalizeCellText } from '@shared/constants/invoice'
import type { InvoiceColumnKey } from '@shared/constants/invoice'
import { ENTITY_METRIC_NAME, ENTITY_METRIC_NO, entityProfileFor, entityUnsupportedNote } from '@shared/constants/entity'
import { decideLicenseWrite, normalizeLicenseName, normalizeLicenseNo } from '@shared/store-license'
import { buildInvoiceCsv, invoiceCsvRows } from '@shared/invoice-csv'
import { randomUUID } from 'crypto'

/**
 * 汇总各店铺的待开票信息（发票中心与导出共用这一份取数逻辑）。
 *
 * 数据来源：采集任务在发票页 readTable(keepRows) 落下的快照。
 * **按开票方向分开**：每个方向一条独立指标（invoice.applyPlatform / invoice.toPlatform / invoice.toBuyer…），
 * 因为实测同一页的「申请平台开票」与「给平台开票」是不同数据，混在一起会漏记录。
 * 表头按该方向的实测映射转成统一列；映射不到的列不丢，放进 extras。
 * 没有快照的方向如实返回空 items（界面显示"还没采集"），绝不估算或伪造。
 */
function collectInvoiceRows(): any[] {
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
    SELECT s.id AS storeId, r.status, r.error_code, r.error_message, r.finished_at FROM task_runs r
    JOIN tasks t ON t.id = r.task_id
    JOIN stores s ON s.id = r.store_id
    WHERE t.name LIKE '发票采集 ·%'
    ORDER BY r.rowid DESC
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
    return {
      storeId: s.id,
      storeName: s.name,
      platform: s.platform,
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
 */
function collectEntities(): Map<string, { name: string | null; no: string | null; capturedAt: number | null }> {
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

function generateRequestId(): string {
  return randomUUID()
}

function success<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

function error(code: string, message: string, requestId: string): IPCResult {
  return { ok: false, error: { code, message }, requestId }
}

export function registerProfileAndMiscHandlers(): void {
  // profile:get
  ipcMain.handle(IPC_CHANNELS.PROFILE_GET, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const profile = ProfileManager.getProfile(input.storeId)
      if (!profile) return error(ERROR_CODES.PROFILE_NOT_READY.code, ERROR_CODES.PROFILE_NOT_READY.message, requestId)
      return success(profile, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:update（locked 拒绝 + config_version 递增，§6.6）
  ipcMain.handle(IPC_CHANNELS.PROFILE_UPDATE, async (_e: IpcMainInvokeEvent, input: { storeId: string, patch: ProfileManager.ProfilePatch }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const profile = ProfileManager.updateProfile(input.storeId, input.patch)
      writeAudit('profile.update', 'success', { storeId: input.storeId, requestId })
      return success(profile, requestId)
    } catch (err: any) {
      if (err instanceof ProfileManager.ProfileLockedError) {
        writeAudit('profile.update', 'failure', { storeId: input.storeId, requestId })
        return error(ERROR_CODES.PROFILE_LOCKED.code, ERROR_CODES.PROFILE_LOCKED.message, requestId)
      }
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:verify - 逐字段 实际/期望/已验证|未验证（§4.3：浏览器未开或注入失败如实标未验证）
  ipcMain.handle(IPC_CHANNELS.PROFILE_VERIFY, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success({ items: await verifyStoreFingerprint(input.storeId) }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:lock
  ipcMain.handle(IPC_CHANNELS.PROFILE_LOCK, async (_e: IpcMainInvokeEvent, input: { storeId: string, locked: boolean }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const profile = ProfileManager.lockProfile(input.storeId, input.locked)
      writeAudit(input.locked ? 'profile.lock' : 'profile.unlock', 'success', { storeId: input.storeId, requestId })
      return success(profile, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:copyConfig - 只复制配置，不含会话/凭据（§6.6）
  ipcMain.handle(IPC_CHANNELS.PROFILE_COPY_CONFIG, async (_e: IpcMainInvokeEvent, input: { sourceStoreId: string, targetStoreIds: string[] }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const result = ProfileManager.copyProfileConfig(input.sourceStoreId, input.targetStoreIds)
      writeAudit('profile.copyConfig', 'success', { storeId: input.sourceStoreId, requestId })
      return success(result, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // overview:stats - 工作台概览
  ipcMain.handle(IPC_CHANNELS.OVERVIEW_STATS, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const db = getDatabase()
      const stats = {
        totalStores: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL').get() as any).c,
        onlineStores: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'online'").get() as any).c,
        archivedStores: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'archived'").get() as any).c,
        trashStores: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NOT NULL').get() as any).c,
        downloads24h: (db.prepare('SELECT COUNT(*) c FROM downloads WHERE created_at > ?').get(Date.now() - 86400000) as any).c,
        bookmarks: (db.prepare('SELECT COUNT(*) c FROM bookmarks').get() as any).c
      }
      return success(stats, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  /**
   * overview:invoiceCenter - 发票中心：汇总各店铺的**待开票信息**（只读）。
   *
   * 数据来源：采集任务在发票页 readTable(keepRows) 落下的快照（metric = invoice.rows）。
   * 这里把**原始表行**按该平台实测的表头映射到统一列（见 shared/constants/invoice.ts）；
   * 映射不到的列不丢，放进 extras 一并展示——平台加列不会让数据消失。
   * 没有任何快照就如实返回空数组（界面显示"还没采集"），绝不估算或伪造。
   */
  ipcMain.handle(IPC_CHANNELS.OVERVIEW_INVOICE_CENTER, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success({ generatedAt: Date.now(), columns: INVOICE_COLUMNS, rows: collectInvoiceRows() }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  /**
   * overview:invoiceExport - 把当前待开票清单导出为 **CSV**（弹保存框；只落本地文件，不上传）。
   *
   * 为什么用 CSV 而不是 xlsx：不引依赖、Excel/WPS 都能直接打开、用户可自己再加工。
   * 带 UTF-8 BOM——否则 Excel 打开中文会乱码（实测过）。
   */
  ipcMain.handle(IPC_CHANNELS.OVERVIEW_INVOICE_EXPORT, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const rows = collectInvoiceRows()
      // 行组装与转义都在 shared/invoice-csv.ts（纯函数、有单测）：导出的表是拿去报税/给代账的，
      // 必须带「营业执照 / 统一社会信用代码」两列——代账按主体分账，光有店铺名他们得再问一遍。
      const dataRows = invoiceCsvRows(rows, INVOICE_COLUMNS)
      if (!dataRows.length) {
        return error(ERROR_CODES.INVALID_ARGUMENT.code, '当前没有可导出的待开票数据（先点「抓取待开票信息」）', requestId)
      }
      const csv = buildInvoiceCsv(dataRows)
      const stamp = new Date().toISOString().slice(0, 10)
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const res = await dialog.showSaveDialog(win, {
        title: '导出发票中心待开票清单',
        defaultPath: join(app.getPath('documents'), `待开票清单-${stamp}.csv`),
        filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
      })
      if (res.canceled || !res.filePath) return success({ canceled: true }, requestId)
      writeFileSync(res.filePath, csv, 'utf8')
      writeAudit('invoice.export', 'success', { requestId: JSON.stringify({ rows: dataRows.length }) })
      return success({ path: res.filePath, rows: dataRows.length }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

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
  ipcMain.handle(IPC_CHANNELS.OVERVIEW_ENTITY_APPLY, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
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
      return success({ appliedAt: Date.now(), filled, rows }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  /**
   * overview:datacenter - 数据中心：汇总**所有店铺**的数据（只读）。
   * 数据来源都是本机既有表：stores / store_snapshots（任务 readText·readTable 的指标快照）/
   * task_runs（任务与邀约运行）。不做任何估算或补数：没有数据就如实返回空数组，由界面显示空状态。
   */
  ipcMain.handle(IPC_CHANNELS.OVERVIEW_DATACENTER, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
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

      // 每店每指标的最新一条 + **上一条**（用于数据中心显示"较上次采集的增减"）
      const snapRows = db.prepare(`
        SELECT storeName, platform, metric, value_json, captured_at, source_run_id, rn FROM (
          SELECT s.name AS storeName, s.platform AS platform, sn.metric AS metric,
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
        const key = r.storeName + '\u0000' + r.metric
        if (r.rn === 1) {
          const item = {
            storeName: r.storeName, platform: r.platform, metric: r.metric,
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

      return success({
        generatedAt: Date.now(),
        totals,
        byPlatform,
        snapshots,
        invite: { byStatus: inviteByStatus, recent: inviteRecent },
        runs: { byStatus: runsByStatus, recentIssues }
      }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  /**
   * overview:manualMetric - 手动录入经营指标。
   * 存在的理由：个别平台（实测拼多多）把数字用**反抓取字体的私有区码位**渲染，DOM 与接口
   * 里都不是数字字符，自动读取必须持续对抗平台的反自动化措施——本应用不做这种绕过，
   * 改为让用户自己看页面录入。录入值同样落 store_snapshots（source_run_id 留空 = 手动来源），
   * 界面会明确标注"手动"，绝不与自动采集的数字混淆。
   */
  ipcMain.handle(IPC_CHANNELS.OVERVIEW_MANUAL_METRIC, async (_e: IpcMainInvokeEvent, input: { storeId: string; metric: string; value: number }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const storeId = String(input?.storeId || '')
      const metric = String(input?.metric || '')
      const value = Number(input?.value)
      const store = storeId ? StoreManager.getStore(storeId) : null
      if (!store) return error(ERROR_CODES.STORE_NOT_FOUND.code, '店铺不存在或已删除', requestId)
      if (!/^biz\.[a-zA-Z]+$/.test(metric)) return error(ERROR_CODES.INVALID_ARGUMENT.code, '指标名不合法（仅允许 biz.* 经营指标）', requestId)
      if (!Number.isFinite(value) || value < 0 || value > 1e12) return error(ERROR_CODES.INVALID_ARGUMENT.code, '指标值不合法（需为 0 ～ 1e12 的数字）', requestId)
      TaskStore.insertSnapshot(storeId, metric, value, null)
      writeAudit('task.create', 'success', { storeId, requestId: JSON.stringify({ kind: 'manual_metric', metric, value }) })
      return success({ storeId, metric, value, manual: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // settings:get / settings:set
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_e: IpcMainInvokeEvent, input: { key: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(input.key) as any
      return success({ key: input.key, value: row ? JSON.parse(row.value_json) : null }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_e: IpcMainInvokeEvent, input: { key: string, value: any }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      getDatabase().prepare(`
        INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(input.key, JSON.stringify(input.value), Date.now())
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // audit:query - §6.7
  ipcMain.handle(IPC_CHANNELS.AUDIT_QUERY, async (_e: IpcMainInvokeEvent, input: { filter?: any }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(queryAudit(input?.filter || {}), requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // window:setTitlebarOverlay - §17 顶部融合：右上角原生窗口按钮（WCO）的
  // 底色随 UI 状态切换（欢迎页 #1a1a1a / 工作台 #242424 / 应用锁 #101218）。
  // 纯装饰通道：锁定门禁已放行（bg-services ALLOW_WHEN_LOCKED）。
  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_TITLEBAR_OVERLAY, async (e: IpcMainInvokeEvent, input: { color?: string, symbolColor?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const HEX = /^#[0-9a-fA-F]{6}$/
      const overlay: Record<string, string> = {}
      if (input?.color && HEX.test(input.color)) overlay.color = input.color
      if (input?.symbolColor && HEX.test(input.symbolColor)) overlay.symbolColor = input.symbolColor
      if (Object.keys(overlay).length === 0) {
        return error(ERROR_CODES.INVALID_ARGUMENT.code, 'color/symbolColor 必须是 #RRGGBB', requestId)
      }
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win || win.isDestroyed()) {
        return error(ERROR_CODES.INTERNAL_ERROR.code, 'Window not available', requestId)
      }
      win.setTitleBarOverlay(overlay as Electron.TitleBarOverlay)
      return success({ applied: overlay }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
}
