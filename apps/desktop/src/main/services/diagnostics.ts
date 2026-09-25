/**
 * 诊断包与审计导出 - §6.7 / §22
 * ZIP（store 模式，零依赖）：版本、系统信息、脱敏日志尾部、数据库迁移版本与规模、
 * 代理体检摘要、白名单设置、审计最近记录。
 * 红线：不含 profile/Cookie 值、代理凭据、订单原文、主密码及校验信息。
 */

import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, writeFileSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { extname, isAbsolute, resolve, sep } from 'path'
import { getDatabase } from '../db/database'
import * as ProxyManager from '../browser/proxy-manager'
import { queryAudit } from './audit-logger'
import { readLogTail } from './logger'
import { writeAudit } from './audit-logger'

// ---------- 最小 ZIP（STORE，无压缩） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function zipStore(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, e.data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(e.data.length, 20)
    cen.writeUInt32LE(e.data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)

    offset += 30 + name.length + e.data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBuf, eocd])
}

// ---------- 导出路径校验 ----------

/**
 * 校验渲染层直传的导出/导入路径（会话包、诊断包、审计导出共用这一份规则）。
 *
 * 为什么必须有：outputPath/filePath 由渲染层给，等于让页面指定主进程的写盘/读盘位置。
 * 只允许写进用户目录或系统临时目录（tools/acceptance 就传 TEMP 下的路径），
 * 扩展名按各功能实际使用的类型收口，且显式拒绝 `..` 跳过段——大小写与分隔符差异
 * 由 path.resolve 归一后再比前缀解决。
 *
 * 放在 diagnostics 的原因：services 目录里会话导出与诊断导出共用同一套规则，
 * 两份各自实现的安全校验迟早会漂移。校验失败抛 INVALID_ARGUMENT 前缀，
 * 由 IPC 层映射成参数错误（导入通道仍按 SESSION_IMPORT_INVALID 呈现，见 session-security-handlers）。
 */
export function assertSafeExportPath(rawPath: string, allowedExts: string[], what: string): string {
  const p = String(rawPath || '').trim()
  if (!p) throw new Error(`INVALID_ARGUMENT: ${what}路径为空`)
  if (p.includes('\0')) throw new Error(`INVALID_ARGUMENT: ${what}路径含非法字符`)
  // Windows 上 '\' 与 '/' 都是分隔符，`..` 跳过段两种写法都要拦
  if (p.split(/[\\/]+/).some(seg => seg === '..')) {
    throw new Error(`INVALID_ARGUMENT: ${what}路径不允许包含 .. 跳过段`)
  }
  if (!isAbsolute(p)) throw new Error(`INVALID_ARGUMENT: ${what}路径必须是绝对路径`)

  const resolved = resolve(p)
  const roots = [resolve(homedir()), resolve(tmpdir())]
  const inAllowedRoot = roots.some(root => {
    const cmp = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    const base = process.platform === 'win32' ? root.toLowerCase() : root
    return cmp === base || cmp.startsWith(base.endsWith(sep) ? base : base + sep)
  })
  if (!inAllowedRoot) throw new Error(`INVALID_ARGUMENT: ${what}路径必须位于用户目录或系统临时目录下`)

  const ext = extname(resolved).toLowerCase()
  if (!allowedExts.includes(ext)) {
    throw new Error(`INVALID_ARGUMENT: ${what}扩展名不被允许（仅支持 ${allowedExts.join(' / ')}）`)
  }
  return resolved
}

/** 供验收解析：列出 zip 内文件名与大小 */
export function zipList(buf: Buffer): Array<{ name: string; size: number }> {
  const out: Array<{ name: string; size: number }> = []
  let i = 0
  while (i + 4 <= buf.length) {
    if (buf.readUInt32LE(i) === 0x04034b50) {
      const nameLen = buf.readUInt16LE(i + 26)
      const extraLen = buf.readUInt16LE(i + 28)
      const compSize = buf.readUInt32LE(i + 18)
      const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8')
      out.push({ name, size: compSize })
      i += 30 + nameLen + extraLen + compSize
    } else break
  }
  return out
}

// ---------- 诊断包 ----------

const SETTING_WHITELIST_PREFIX = ['ui.', 'proxy.', 'task.', 'security.idleMinutes', 'app.']
const SETTING_DENY = ['security.master', 'proxy_cred.', 'ai_cred.']

/** 渲染层可指定路径的导出类型：扩展名与实现实际产出的文件类型对齐（诊断包 ZIP / 审计 JSONL） */
export const DIAGNOSTICS_EXTS = ['.zip', '.json']
export const AUDIT_EXPORT_EXTS = ['.jsonl', '.json']

function jdata(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj, null, 2), 'utf8')
}

export function buildDiagnosticsPackage(): { zip: Buffer; manifest: Record<string, number> } {
  const db = getDatabase()
  const counts: Record<string, number | string> = {}
  for (const t of ['stores', 'browser_profiles', 'tabs', 'bookmarks', 'downloads', 'proxies', 'store_proxies', 'proxy_checks', 'tasks', 'task_runs', 'task_step_results', 'store_snapshots', 'audit_logs', 'backups']) {
    try { counts[t] = (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c } catch { counts[t] = 'n/a' }
  }
  const schemaVersion = (db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as any)?.v ?? 0

  const settings = (db.prepare('SELECT key, updated_at FROM app_settings').all() as any[])
    .filter(r => SETTING_DENY.every(d => !String(r.key).startsWith(d)))
    .filter(r => SETTING_WHITELIST_PREFIX.some(p => String(r.key).startsWith(p)))
    .map(r => ({ key: r.key, updatedAt: r.updated_at })) // 值可能是敏感 JSON：诊断包只列键与时间

  const proxies = ProxyManager.boundProxyRecords().concat(ProxyManager.listProxies().filter(p => p.status === 'error'))
  const uniq = new Map<string, any>()
  for (const p of proxies) uniq.set(p.id, p)
  const proxySummary = Array.from(uniq.values()).map(p => ({
    id: p.id, label: p.label, type: p.type, host: p.host, port: p.port,
    status: p.status, lastLatencyMs: p.lastLatencyMs, hasCredential: p.hasCredential,
    recent: ProxyManager.proxyHistory(p.id, 5).map((c: any) => ({ ok: c.ok, latencyMs: c.latencyMs, errorCode: c.errorCode, checkedAt: c.checkedAt }))
  }))

  const auditRecent = queryAudit({ limit: 200 }).map(a => ({ at: (a as any).createdAt, action: (a as any).action, result: (a as any).result, storeId: (a as any).storeId ?? null }))

  const logTail = readLogTail()
  const redLine = /(password|passwd|secret|token|cookie|authorization|credential)/i

  const entries = [
    { name: 'version.json', data: jdata({ app: 'ShopPilot', version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }) },
    { name: 'system.json', data: jdata({ platform: process.platform, release: require('os').release(), arch: process.arch, totalMemoryGB: Math.round(require('os').totalmem() / 1073741824 * 10) / 10, cpus: require('os').cpus().length, locale: app.getLocale(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) },
    { name: 'database.json', data: jdata({ schemaVersion, counts }) },
    { name: 'proxies.json', data: jdata(proxySummary) },
    { name: 'settings.json', data: jdata(settings) },
    { name: 'audit-recent.jsonl', data: Buffer.from(auditRecent.map(r => JSON.stringify(r)).join('\n'), 'utf8') },
    // 日志最后过滤：诊断导出时再扫一遍，含敏感字样的行整行剔除（双保险）
    { name: 'app.log', data: Buffer.from(logTail.split('\n').filter(l => !redLine.test(l)).join('\n'), 'utf8') }
  ]
  const manifest: Record<string, number> = {}
  for (const e of entries) manifest[e.name] = e.data.length
  return { zip: zipStore(entries), manifest }
}

export function exportDiagnostics(outputPath?: string): { path: string; files: Record<string, number>; sha256: string } {
  // 渲染层直传的路径先用后信：校验不过直接返回参数错误，连包都不构建
  const out = outputPath ? assertSafeExportPath(outputPath, DIAGNOSTICS_EXTS, '诊断包导出') : ''
  const { zip, manifest } = buildDiagnosticsPackage()
  let target = out
  if (!target) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    target = require('electron').dialog.showSaveDialogSync(null as any, {
      title: '导出诊断包',
      defaultPath: require('path').join(app.getPath('documents'), `shopilot-diagnostics-${stamp}.zip`),
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    }) || ''
    if (!target) throw new Error('DIAG_CANCELLED: 未选择保存位置')
  }
  writeFileSync(target, zip)
  const sha256 = createHash('sha256').update(zip).digest('hex')
  writeAudit('diagnostics.export', 'success')
  return { path: target, files: manifest, sha256 }
}

/** audit:export - §6.7 */
export function exportAuditLogs(filter: any, outputPath?: string): { path: string; rows: number } {
  const rows = queryAudit(filter)
  let target = outputPath ? assertSafeExportPath(outputPath, AUDIT_EXPORT_EXTS, '审计导出') : ''
  if (!target) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    target = require('electron').dialog.showSaveDialogSync(null as any, {
      title: '导出审计日志',
      defaultPath: require('path').join(app.getPath('documents'), `shopilot-audit-${stamp}.jsonl`),
      filters: [{ name: 'JSONL', extensions: ['jsonl'] }]
    }) || ''
    if (!target) throw new Error('DIAG_CANCELLED: 未选择保存位置')
  }
  writeFileSync(target, rows.map(r => JSON.stringify(r)).join('\n'), 'utf8')
  writeAudit('audit.export', 'success')
  return { path: target, rows: rows.length }
}

void existsSync
void readFileSync
