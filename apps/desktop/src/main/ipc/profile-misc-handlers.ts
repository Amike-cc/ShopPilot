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
  overviewTaxReport,
  applyEntityToStores,
  overviewDatacenterSummary,
  // 发票导出与发票中心共用同一份待开票取数（2026-09-26 审计 P2：helper 已搬进 services，
  // 方向变成单向的 ipc → services，不再有 overview-service ⇄ ipc 的循环 import）
  collectInvoiceRows
} from '../services/overview-service'
import { INVOICE_COLUMNS } from '@shared/constants/invoice'
import { buildInvoiceCsv, ensureCsvExtension, invoiceCsvRows } from '@shared/invoice-csv'
import { filterRowsByLicenseKey, licenseScopeLabel } from '@shared/store-license'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { ipcOk as success, ipcFail as error } from './envelope'
import { refreshProfileRuntime } from '../browser/session-manager'

const profileStoreIdSchema = z.string().trim().min(1).max(200)
const profilePatchSchema = z.object({
  userAgent: z.string().trim().min(1).max(512).refine(ProfileManager.isValidProfileUserAgent, 'userAgent 格式不合法').optional(),
  language: z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).optional(),
  timezone: z.string().trim().min(1).max(100).refine(ProfileManager.isValidIanaTimezone, 'timezone 必须是有效的 IANA 时区').optional(),
  screenWidth: z.number().int().min(1).max(16384).optional(),
  screenHeight: z.number().int().min(1).max(16384).optional(),
  hardwareConcurrency: z.number().int().min(1).max(256).optional(),
  colorDepth: z.number().int().min(1).max(64).optional(),
  webglVendor: z.string().trim().min(1).max(256).optional(),
  webglRenderer: z.string().trim().min(1).max(512).optional()
}).strict()
const profileUpdateInputSchema = z.object({ storeId: profileStoreIdSchema, patch: profilePatchSchema }).strict()
const profileStoreInputSchema = z.object({ storeId: profileStoreIdSchema }).strict()
const profileLockInputSchema = z.object({ storeId: profileStoreIdSchema, locked: z.boolean() }).strict()
const profileCopyInputSchema = z.object({
  sourceStoreId: profileStoreIdSchema,
  targetStoreIds: z.array(profileStoreIdSchema).max(200)
}).strict()


function generateRequestId(): string {
  return randomUUID()
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
 * - invite.*           邀约配置（配置树 / 广场地址 / 按店铺配置）
 * - security.idleMinutes 空闲自动锁定分钟数（应用锁的其它键仍被挡在门外）
 * - collection.*       采集口径（如 collection.autoEnabled 自动采集总开关，默认关）
 */
const SETTING_ALLOW_PREFIXES = ['ui.', 'update.', 'platform.homeUrls', 'invite.', 'security.idleMinutes', 'collection.']

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
    const parsed = profileStoreInputSchema.safeParse(input)
    if (!parsed.success) return error(ERROR_CODES.INVALID_ARGUMENT.code, 'storeId 无效', requestId)
    try {
      const profile = ProfileManager.getProfile(parsed.data.storeId)
      if (!profile) return error(ERROR_CODES.PROFILE_NOT_READY.code, ERROR_CODES.PROFILE_NOT_READY.message, requestId)
      return success(profile, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:update（locked 拒绝 + config_version 递增，§6.6）
  handle(IPC_CHANNELS.PROFILE_UPDATE, async (_e: IpcMainInvokeEvent, input: { storeId: string, patch: ProfileManager.ProfilePatch }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    const parsed = profileUpdateInputSchema.safeParse(input)
    if (!parsed.success) return error(ERROR_CODES.INVALID_ARGUMENT.code, '环境配置参数不合法', requestId)
    try {
      const profile = ProfileManager.updateProfile(parsed.data.storeId, parsed.data.patch)
      await refreshProfileRuntime(parsed.data.storeId)
      writeAudit('profile.update', 'success', { storeId: parsed.data.storeId, requestId })
      return success(profile, requestId)
    } catch (err: any) {
      if (err instanceof ProfileManager.ProfileLockedError) {
        writeAudit('profile.update', 'failure', { storeId: parsed.data.storeId, requestId })
        return error(ERROR_CODES.PROFILE_LOCKED.code, ERROR_CODES.PROFILE_LOCKED.message, requestId)
      }
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:verify - 逐字段 实际/期望/已验证|未验证（§4.3：浏览器未开或注入失败如实标未验证）
  handle(IPC_CHANNELS.PROFILE_VERIFY, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    const parsed = profileStoreInputSchema.safeParse(input)
    if (!parsed.success) return error(ERROR_CODES.INVALID_ARGUMENT.code, 'storeId 无效', requestId)
    try {
      return success({ items: await verifyStoreFingerprint(parsed.data.storeId) }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:lock
  handle(IPC_CHANNELS.PROFILE_LOCK, async (_e: IpcMainInvokeEvent, input: { storeId: string, locked: boolean }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    const parsed = profileLockInputSchema.safeParse(input)
    if (!parsed.success) return error(ERROR_CODES.INVALID_ARGUMENT.code, '锁定参数不合法', requestId)
    try {
      const profile = ProfileManager.lockProfile(parsed.data.storeId, parsed.data.locked)
      writeAudit(parsed.data.locked ? 'profile.lock' : 'profile.unlock', 'success', { storeId: parsed.data.storeId, requestId })
      return success(profile, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:copyConfig - 只复制配置，不含会话/凭据（§6.6）
  handle(IPC_CHANNELS.PROFILE_COPY_CONFIG, async (_e: IpcMainInvokeEvent, input: { sourceStoreId: string, targetStoreIds: string[] }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    const parsed = profileCopyInputSchema.safeParse(input)
    if (!parsed.success) return error(ERROR_CODES.INVALID_ARGUMENT.code, '复制配置参数不合法', requestId)
    try {
      const result = ProfileManager.copyProfileConfig(parsed.data.sourceStoreId, parsed.data.targetStoreIds)
      await Promise.all(parsed.data.targetStoreIds.map(storeId => refreshProfileRuntime(storeId)))
      writeAudit('profile.copyConfig', 'success', { storeId: parsed.data.sourceStoreId, requestId })
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

  // overview:invoiceCenter - 发票中心（计算在 services/overview-service.ts）
  handle(IPC_CHANNELS.OVERVIEW_INVOICE_CENTER, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(overviewInvoiceCenter(), requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // overview:taxReport - 涉税信息报送（只读；计算在 services/overview-service.ts）
  // 返回体里带平台自己的用途限制（不得作为税务申报依据），界面与数据同屏显示
  handle(IPC_CHANNELS.OVERVIEW_TAX_REPORT, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(overviewTaxReport(), requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  /**
   * overview:invoiceExport - 把当前待开票清单导出为 **CSV**（弹保存框；只落本地文件，不上传）。
   *
   * 为什么用 CSV 而不是 xlsx：不引依赖、Excel/WPS 都能直接打开、用户可自己再加工。
   * 带 UTF-8 BOM——否则 Excel 打开中文会乱码（实测过）。
   *
   * `licenseKey`：**导出跟随屏上的营业执照筛选**（2026-10-14 加）。导出的表是给代账按主体分账用的，
   * 用户在发票中心点了某个主体再导出，拿到的就必须只有那个主体的行——否则 A 公司的清单里
   * 会混进别家的单号/金额/税号（文件自带营业执照/信用代码两列，混了就是交叉泄露）。
   * 归属规则与屏上同源：shared/store-license 的 groupStoresByLicense（"没填代码但同名"的店要并进有代码的主体）。
   */
  handle(IPC_CHANNELS.OVERVIEW_INVOICE_EXPORT, async (_e: IpcMainInvokeEvent, input: { licenseKey?: unknown }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const rawKey = input?.licenseKey
      if (rawKey !== undefined && rawKey !== null && typeof rawKey !== 'string') {
        return error(ERROR_CODES.INVALID_ARGUMENT.code, '导出范围不合法（licenseKey 必须是字符串）', requestId)
      }
      const licenseKey = typeof rawKey === 'string' ? rawKey.trim().slice(0, 200) : ''
      const rows = filterRowsByLicenseKey(collectInvoiceRows(), licenseKey)
      // 行组装与转义都在 shared/invoice-csv.ts（纯函数、有单测）：导出的表是拿去报税/给代账的，
      // 必须带「营业执照 / 统一社会信用代码」两列——代账按主体分账，光有店铺名他们得再问一遍。
      const dataRows = invoiceCsvRows(rows, INVOICE_COLUMNS)
      if (!dataRows.length) {
        return error(ERROR_CODES.INVALID_ARGUMENT.code, licenseKey
          ? '当前主体下没有可导出的待开票数据（换个主体，或先点「采集发票数据」）'
          : '当前没有可导出的待开票数据（先点「采集发票数据」）', requestId)
      }
      // 文件名带上主体：一个主体一份文件，代账不会拿错；主体名里的路径非法字符要洗掉。
      // 标签算法在 shared（含"只填了信用代码的主体"这种情况），纯函数、有单测。
      const scopeLabel = licenseScopeLabel(rows, licenseKey)
      const fileTag = String(scopeLabel).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 40)
      const csv = buildInvoiceCsv(dataRows)
      const stamp = new Date().toISOString().slice(0, 10)
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const res = await dialog.showSaveDialog(win, {
        title: scopeLabel ? `导出发票中心待开票清单（${scopeLabel}）` : '导出发票中心待开票清单',
        defaultPath: join(app.getPath('documents'), `待开票清单-${fileTag ? `${fileTag}-` : ''}${stamp}.csv`),
        filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
      })
      if (res.canceled || !res.filePath) return success({ canceled: true }, requestId)
      // C6（2026-10-15 审查）：保存框不强制扩展名——用户可能得到 `报表` 或 `报表.txt` 里装着 CSV。
      // 统一补成 `.csv`（已有 .csv 后缀不动），写盘与返回都用补过名的路径。
      const filePath = ensureCsvExtension(res.filePath)
      try {
        writeFileSync(filePath, csv, 'utf8')
      } catch (writeErr: any) {
        // 写盘失败以前只回错误、不留审计——失败的导出尝试同样要可查（C6）
        writeAudit('invoice.export', 'failure', {
          // request_id 会在审计中心展示；不要把 Node 的绝对路径/用户名写进可见审计记录。
          requestId: JSON.stringify({ rows: dataRows.length, scope: licenseKey || 'all', stage: 'write', errorCode: String(writeErr?.code || 'WRITE_FAILED').slice(0, 40) })
        })
        return error(ERROR_CODES.INTERNAL_ERROR.code, '写入文件失败，请检查保存位置和文件权限后重试', requestId)
      }
      // B2：把"待开票 / 无需操作"两个数都写进审计与提示——文件名与界面合计都叫"待开票"，
      // 而 CSV 里同时含已提交的流水（pending:false），只说总数会让人对不上账。
      const pendingRows = dataRows.filter(row => row['是否待办'] === '待开票').length
      writeAudit('invoice.export', 'success', {
        requestId: JSON.stringify({ rows: dataRows.length, pendingRows, scope: licenseKey || 'all', scopeLabel: scopeLabel || null })
      })
      return success({ path: filePath, rows: dataRows.length, pendingRows, scope: licenseKey || null, scopeLabel: scopeLabel || '全部主体' }, requestId)
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
