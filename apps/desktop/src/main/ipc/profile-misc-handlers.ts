/**
 * 环境配置 / 概览 / 设置 / 审计 IPC 处理器 - §6.6 / §6.7
 */

import { familyHandle } from './family-handle'
import { IpcMainInvokeEvent, BrowserWindow, dialog, app } from 'electron'
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
import { auditQueryFilterSchema } from '@shared/schemas/audit'
import { logMain } from '../services/logger'
import {
  overviewStatsSummary,
  overviewInvoiceCenter,
  applyEntityToStores,
  overviewDatacenterSummary,
  // 发票导出与发票中心共用同一份待开票取数（2026-09-26 审计 P2：helper 已搬进 services，
  // 方向变成单向的 ipc → services，不再有 overview-service ⇄ ipc 的循环 import）
  collectInvoiceRows
} from '../services/overview-service'
import { INVOICE_COLUMNS } from '@shared/constants/invoice'
import { buildInvoiceCsv, invoiceCsvRows } from '@shared/invoice-csv'
import { ordersProfileFor } from '@shared/constants/orders'
import { mapOrdersRows, orderColumnLabel } from '@shared/orders-steps'
import { randomUUID } from 'crypto'


function generateRequestId(): string {
  return randomUUID()
}

function success<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

function error(code: string, message: string, requestId: string): IPCResult {
  return { ok: false, error: { code, message }, requestId }
}

// ---------- 通用 settings 通道的键/值策略 ----------

const SETTING_KEY_MAX = 200
const SETTING_VALUE_MAX_BYTES = 64 * 1024

/**
 * 允许经通用 settings 通道读写的键前缀（白名单）。
 *
 * 为什么是白名单而不是黑名单：通用通道能读写全部 app_settings，而这张表里同时住着
 * 凭据记录（ai_cred.*、proxy_cred.*）、应用锁主密码与 Agent 运行配置——它们都有专用通道，
 * 从通用口子放行就等于绕开那些通道的校验。黑名单只能挡住想得到的那几个前缀，
 * 白名单能保证"没登记过的键进不来"。
 *
 * 这里列的就是渲染层实际用到的全部键族（含按店铺拼出来的 invite.config.store.<id>）：
 * - ui.*               左/右侧栏收起状态、Agent UI 之外的界面偏好
 * - update.*           更新通道与启动自动检查（§21 双通道）
 * - platform.homeUrls  各平台首页地址覆盖
 * - orders.profiles    订单页实测覆盖
 * - invite.*           邀约配置（配置树 / 广场地址 / 按店铺配置）
 * - security.idleMinutes 空闲自动锁定分钟数（应用锁的其它键仍被挡在门外）
 * - collection.*       采集口径（如 collection.autoEnabled 自动采集总开关，默认关）
 */
const SETTING_ALLOW_PREFIXES = ['ui.', 'update.', 'platform.homeUrls', 'orders.profiles', 'invite.', 'security.idleMinutes', 'collection.']

/** 前三段属于"非敏感但需要说明"的越权尝试；其余不在白名单里的一律按参数错误返回 */
const SETTING_SENSITIVE_PREFIXES = ['securi', 'ai_cred', 'ai.', 'proxy_cred', 'agent.']

type SettingKeyCheck = { ok: true; value: string } | { ok: false; sensitive: boolean; reason: string }

function checkSettingKey(raw: unknown): SettingKeyCheck {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, sensitive: false, reason: '设置键不合法（需为非空字符串）' }
  }
  if (raw.length > SETTING_KEY_MAX) {
    return { ok: false, sensitive: false, reason: `设置键过长（上限 ${SETTING_KEY_MAX} 字符）` }
  }
  const allowed = SETTING_ALLOW_PREFIXES.some(p => raw.startsWith(p))
  if (!allowed) {
    const sensitive = SETTING_SENSITIVE_PREFIXES.some(p => raw.startsWith(p))
    return {
      ok: false,
      sensitive,
      reason: sensitive
        ? '该设置为敏感键，不允许通过通用设置通道读写'
        : `设置键不在白名单内（${SETTING_ALLOW_PREFIXES.join(' / ')}）`
    }
  }
  return { ok: true, value: raw }
}

/**
 * 敏感键返回权限错误（而非参数错误）：键本身合法，只是这个通道没有权限碰它。
 * 共享错误码枚举里没有通用权限码，最接近的是 AGENT_PERMISSION_DENIED，沿用其码值。
 */
function keyError(check: { sensitive: boolean; reason: string }, requestId: string): IPCResult {
  return check.sensitive
    ? error(ERROR_CODES.AGENT_PERMISSION_DENIED.code, check.reason, requestId)
    : error(ERROR_CODES.INVALID_ARGUMENT.code, check.reason, requestId)
}

function checkSettingValue(value: unknown): { ok: true; json: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: false, reason: 'value 不合法（undefined 无法 JSON 序列化）' }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { ok: false, reason: 'value 不合法（必须是可 JSON 序列化的对象）' }
  }
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return { ok: false, reason: 'value 不合法（无法 JSON 序列化，可能含循环引用）' }
  }
  if (typeof json !== 'string') return { ok: false, reason: 'value 不合法（必须是可 JSON 序列化的对象）' }
  if (Buffer.byteLength(json, 'utf8') > SETTING_VALUE_MAX_BYTES) {
    return { ok: false, reason: `value 过大（序列化后上限 ${SETTING_VALUE_MAX_BYTES / 1024}KB）` }
  }
  return { ok: true, json }
}

const handle = familyHandle('店铺配置与设置')

export function registerProfileAndMiscHandlers(): void {
  // profile:get
  handle(IPC_CHANNELS.PROFILE_GET, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
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
  handle(IPC_CHANNELS.PROFILE_UPDATE, async (_e: IpcMainInvokeEvent, input: { storeId: string, patch: ProfileManager.ProfilePatch }): Promise<IPCResult> => {
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
  handle(IPC_CHANNELS.PROFILE_VERIFY, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success({ items: await verifyStoreFingerprint(input.storeId) }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:lock
  handle(IPC_CHANNELS.PROFILE_LOCK, async (_e: IpcMainInvokeEvent, input: { storeId: string, locked: boolean }): Promise<IPCResult> => {
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
  handle(IPC_CHANNELS.PROFILE_COPY_CONFIG, async (_e: IpcMainInvokeEvent, input: { sourceStoreId: string, targetStoreIds: string[] }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const result = ProfileManager.copyProfileConfig(input.sourceStoreId, input.targetStoreIds)
      writeAudit('profile.copyConfig', 'success', { storeId: input.sourceStoreId, requestId })
      return success(result, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // overview:stats - 工作台概览（计算在 services/overview-service.ts）
  handle(IPC_CHANNELS.OVERVIEW_STATS, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(overviewStatsSummary(), requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  /**
   * overview:orders - 订单明细：汇总各店铺**最近一次**订单页整表采集的行（只读）。
   *
   * 数据来源：订单明细采集任务 readTable(keepRows, metric='orders.detail') 落下的快照。
   * 列按平台**实测档案**的列顺序映射到统一列（见 shared/constants/orders.ts 的红线）；
   * 未实测的平台如实返回 supported:false（界面显示"未实测"），绝不估算或伪造。
   */
  handle(IPC_CHANNELS.OVERVIEW_ORDERS, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const db = getDatabase()
      let overrides: Record<string, any> = {}
      try {
        const row = db.prepare('SELECT value_json FROM app_settings WHERE key=?').get('orders.profiles') as any
        if (row?.value_json) overrides = JSON.parse(row.value_json)
      } catch { /* 覆盖配置损坏时按内置档案走 */ }
      const stores = db.prepare('SELECT id, name, platform FROM stores WHERE deleted_at IS NULL ORDER BY platform, name').all() as any[]
      const snaps = db.prepare(`
        SELECT store_id, value_json, captured_at FROM (
          SELECT store_id, value_json, captured_at, ROW_NUMBER() OVER (PARTITION BY store_id ORDER BY rowid DESC) AS rn
          FROM store_snapshots WHERE metric = 'orders.detail'
        ) WHERE rn = 1
      `).all() as any[]
      const snapByStore = new Map(snaps.map(item => [item.store_id, item]))
      const rows = stores.map(store => {
        const profile = ordersProfileFor(store.platform, overrides)
        const snapshot = snapByStore.get(store.id)
        let raw: unknown = null
        if (snapshot?.value_json) { try { raw = JSON.parse(snapshot.value_json) } catch { raw = null } }
        const columns = profile ? profile.columns.map(column => ({ key: column.key, label: orderColumnLabel(column.key), header: column.header })) : []
        const mapped = profile && Array.isArray(raw) ? mapOrdersRows(profile.columns, raw) : []
        return {
          storeId: store.id,
          storeName: store.name,
          platform: store.platform,
          supported: !!profile,
          measuredAt: profile?.measuredAt || null,
          note: profile?.note || null,
          columns,
          rows: mapped,
          capturedAt: snapshot?.captured_at || null
        }
      })
      // 最近一次采集失败：只有最近一次确实是失败才回报（不把已被成功覆盖的旧失败一直挂着）。
      // 用窗口函数在 SQL 里取每店最新一条（rn=1）：原写法物化全部历史 run 再在 JS 去重，
      // 定时采集跑几个月后这张列表会拖慢数据中心首屏。
      const lastRuns = db.prepare(`
        SELECT storeId, status, error_code, error_message FROM (
          SELECT s.id AS storeId, r.status, r.error_code, r.error_message,
                 ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY r.rowid DESC) AS rn
          FROM task_runs r
          JOIN tasks t ON t.id = r.task_id
          JOIN stores s ON s.id = r.store_id
          WHERE t.name LIKE '订单明细采集 ·%'
        ) WHERE rn = 1
      `).all() as any[]
      const failByStore = new Map<string, any>()
      for (const run of lastRuns) {
        if (failByStore.has(run.storeId)) continue
        failByStore.set(run.storeId, run.status === 'failed' ? run : null)
      }
      for (const row of rows) {
        const fail = failByStore.get(row.storeId)
        if (fail) (row as any).error = { code: fail.error_code, message: fail.error_message }
      }
      return success({ generatedAt: Date.now(), stores: rows }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // overview:invoiceCenter - 发票中心（计算在 services/overview-service.ts）
  handle(IPC_CHANNELS.OVERVIEW_INVOICE_CENTER, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(overviewInvoiceCenter(), requestId)
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
  handle(IPC_CHANNELS.OVERVIEW_INVOICE_EXPORT, async (): Promise<IPCResult> => {
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

  // overview:entityApply - 主体写回店铺营业执照（计算与写入在 services/overview-service.ts）
  handle(IPC_CHANNELS.OVERVIEW_ENTITY_APPLY, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(applyEntityToStores(), requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // overview:datacenter - 数据中心（计算在 services/overview-service.ts）
  handle(IPC_CHANNELS.OVERVIEW_DATACENTER, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(overviewDatacenterSummary(), requestId)
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
  handle(IPC_CHANNELS.OVERVIEW_MANUAL_METRIC, async (_e: IpcMainInvokeEvent, input: { storeId: string; metric: string; value: number }): Promise<IPCResult> => {
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
  handle(IPC_CHANNELS.SETTINGS_GET, async (_e: IpcMainInvokeEvent, input: { key: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const key = checkSettingKey(input?.key)
      if (!key.ok) return keyError(key, requestId)
      const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key.value) as any
      return success({ key: key.value, value: row ? JSON.parse(row.value_json) : null }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  handle(IPC_CHANNELS.SETTINGS_SET, async (_e: IpcMainInvokeEvent, input: { key: string, value: any }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const key = checkSettingKey(input?.key)
      if (!key.ok) return keyError(key, requestId)
      const value = checkSettingValue(input?.value)
      if (!value.ok) return error(ERROR_CODES.INVALID_ARGUMENT.code, value.reason, requestId)

      getDatabase().prepare(`
        INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(key.value, value.json, Date.now())

      // 每次写入留痕：设置项直接决定主进程行为，事后要能查到写过哪个键；
      // 只记键名与体积，值可能含业务数据（如店铺名单）不落日志
      logMain('info', `[settings] set key=${key.value} bytes=${Buffer.byteLength(value.json, 'utf8')}`)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // audit:query - §6.7
  handle(IPC_CHANNELS.AUDIT_QUERY, async (_e: IpcMainInvokeEvent, input: { filter?: unknown }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      // strict schema：多余键拒绝、limit/时间戳必须是数字（原先 any 直通 SQL 构造）
      // 兼容旧版渲染层曾经把 query({ filter: {...} }) 再包进 preload 的调用形状；
      // 新 API 仍使用 query({...})，这里只在外层恰好只有 filter 时解一层，
      // 不放宽审计字段或权限边界。
      const rawFilter = input?.filter && typeof input.filter === 'object' && !Array.isArray(input.filter)
        && Object.keys(input.filter as Record<string, unknown>).length === 1
        && 'filter' in (input.filter as Record<string, unknown>)
        ? (input.filter as { filter?: unknown }).filter
        : input?.filter
      const filter = auditQueryFilterSchema.parse(rawFilter || {})
      return success(queryAudit(filter), requestId)
    } catch (err: any) {
      if (err?.name === 'ZodError') {
        return error(ERROR_CODES.INVALID_ARGUMENT.code, String(err.issues?.[0]?.message || '查询条件不合法'), requestId)
      }
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // window:setTitlebarOverlay - §17 顶部融合：右上角原生窗口按钮（WCO）的
  // 底色随 UI 状态切换（欢迎页 #1a1a1a / 工作台 #242424 / 应用锁 #101218）。
  // 纯装饰通道：**锁定态必须放行**——App.vue 在 appLocked 变化时会调它把标题栏
  // 刷成锁屏底色 #101218；若被 APP_LOCKED 拒掉，锁屏期间标题栏会停在旧底色。
  handle(IPC_CHANNELS.WINDOW_SET_TITLEBAR_OVERLAY, async (e: IpcMainInvokeEvent, input: { color?: string, symbolColor?: string }): Promise<IPCResult> => {
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
  }, { allowWhenLocked: true })
}
