/**
 * 诊断包与审计导出 - §6.7 / §22
 * ZIP（store 模式，零依赖）：版本、系统信息、脱敏日志尾部、数据库迁移版本与规模、
 * 代理体检摘要、白名单设置、审计最近记录。
 * 红线：不含 profile/Cookie 值、代理凭据、订单原文、主密码及校验信息。
 */

import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, writeFileSync, readFileSync } from 'fs'
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
  const { zip, manifest } = buildDiagnosticsPackage()
  let out = outputPath
  if (!out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    out = require('electron').dialog.showSaveDialogSync(null as any, {
      title: '导出诊断包',
      defaultPath: require('path').join(app.getPath('documents'), `shopilot-diagnostics-${stamp}.zip`),
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    }) || ''
    if (!out) throw new Error('DIAG_CANCELLED: 未选择保存位置')
  }
  writeFileSync(out, zip)
  const sha256 = createHash('sha256').update(zip).digest('hex')
  writeAudit('diagnostics.export', 'success')
  return { path: out, files: manifest, sha256 }
}

/** audit:export - §6.7 */
export function exportAuditLogs(filter: any, outputPath?: string): { path: string; rows: number } {
  const rows = queryAudit(filter)
  let out = outputPath
  if (!out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    out = require('electron').dialog.showSaveDialogSync(null as any, {
      title: '导出审计日志',
      defaultPath: require('path').join(app.getPath('documents'), `shopilot-audit-${stamp}.jsonl`),
      filters: [{ name: 'JSONL', extensions: ['jsonl'] }]
    }) || ''
    if (!out) throw new Error('DIAG_CANCELLED: 未选择保存位置')
  }
  writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n'), 'utf8')
  writeAudit('audit.export', 'success')
  return { path: out, rows: rows.length }
}

void existsSync
void readFileSync
