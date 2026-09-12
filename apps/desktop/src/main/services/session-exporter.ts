/**
 * 会话导出/导入加密包 - §10.2 / §6.3 / §13
 *
 * 包格式（.shopilot）：
 *   'SHSP'(4B) | u32le headerLen | header(JSON, 同时作为 GCM AAD) | u32le ctLen | AES-256-GCM 密文 | tag(16B)
 *   header: { v, kdf:'scrypt', N, r, p, keyLen, salt(b64), nonce(b64), exportedAt, expiresAt, srcStoreName, srcPlatform }
 *
 * 口令：主进程托管密码对话框采集（不经 Renderer / 业务 IPC）。KDF 参数入包。
 * 有效期：header 明文携带且被 AAD 认证，过期包一律拒绝导入。
 *
 * 内容边界（如实声明）：Cookie（含 HttpOnly，Chromium 解密后明文入容器）+ 指纹配置 + 店铺元信息。
 * localStorage/IndexedDB 不在包内（跨机可迁移性无法保证，宁缺毋假）；异机导入后部分站点可能仍需二次验证。
 */

import { app, BrowserWindow, session } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import { getDatabase } from '../db/database'
import { writeAudit } from '../services/audit-logger'
import { askConfirm, askPassword } from '../services/password-dialog'
import { getProfile, updateProfile } from '../stores/profile-manager'
import { packSession, unpackSession, SessionPackageError, type SessionCookieEntry } from './session-package'

export type { SessionCookieEntry } from './session-package'

function storeSession(storeId: string): Electron.Session {
  return session.fromPartition(`persist:store_${storeId}`, { cache: true })
}

/** 采集当前会话并加密写包。人工确认 + 密码采集均为主进程托管对话框。 */
export async function exportSessionPackage(
  storeId: string,
  opts: { outputPath?: string; validDays?: number } = {}
): Promise<{ path: string; cookieCount: number; expiresAt: number }> {
  const db = getDatabase()
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId) as any
  if (!store) throw new Error('STORE_NOT_FOUND')

  const ses = storeSession(storeId)
  const raw = await ses.cookies.get({})
  const cookies: SessionCookieEntry[] = raw.map((c: any) => ({
    name: c.name, domain: c.domain, path: c.path, value: c.value,
    secure: !!c.secure, httpOnly: !!c.httpOnly,
    expirationDate: c.expirationDate ?? null,
    sameSite: c.sameSite ?? null
  }))

  // §6.3 人工确认（导出即凭据外带，属高风险动作）
  const confirmed = await askConfirm({
    title: `导出「${store.name}」的登录会话？`,
    detail: `将导出 ${cookies.length} 条 Cookie 与指纹配置，封装为加密包（口令保护 + 有效期）。`,
    detail2: '导出包等同于登录凭据，请妥善保管；过期的包无法导入。',
    danger: true
  })
  if (!confirmed) { writeAudit('session.export', 'failure'); throw new Error('SESSION_CANCELLED: 用户取消了导出') }

  const password = await askPassword({ title: '设置导出密码', detail: '该密码用于解密导出包，遗失后包不可恢复', requireConfirm: true })
  if (!password) { writeAudit('session.export', 'failure'); throw new Error('SESSION_CANCELLED: 未输入导出密码') }

  const now = Date.now()
  const validDays = opts.validDays ?? 30

  const prof = getProfile(storeId)
  const profile: Record<string, unknown> | null = prof ? {
    browserVersion: prof.browserVersion, osDisplay: prof.osDisplay, userAgent: prof.userAgent,
    uaClientHintsJson: prof.uaClientHintsJson, language: prof.language, timezone: prof.timezone,
    screenWidth: prof.screenWidth, screenHeight: prof.screenHeight, colorDepth: prof.colorDepth,
    hardwareConcurrency: prof.hardwareConcurrency, webglVendor: prof.webglVendor, webglRenderer: prof.webglRenderer
  } : null

  const { file, expiresAt } = packSession(password, {
    srcStoreId: storeId, srcStoreName: store.name, srcPlatform: store.platform, profile, cookies
  }, validDays, now)

  let outPath = opts.outputPath
  if (!outPath) {
    const win = BrowserWindow.getFocusedWindow() || undefined
    const { dialog } = require('electron')
    const stamp = new Date().toISOString().slice(0, 10)
    const r = await dialog.showSaveDialog(win!, {
      title: '选择导出包保存位置',
      defaultPath: join(app.getPath('documents'), `shopilot-session-${store.name}-${stamp}.shopilot`),
      filters: [{ name: 'ShopPilot 会话包', extensions: ['shopilot'] }]
    })
    if (r.canceled || !r.filePath) throw new Error('SESSION_CANCELLED: 未选择保存位置')
    outPath = r.filePath
  }
  mkdirSync(join(app.getPath('userData'), 'exports'), { recursive: true })
  writeFileSync(outPath, file)

  writeAudit('session.export', 'success', { storeId, requestId: JSON.stringify({ cookieCount: cookies.length, expiresAt }) })
  return { path: outPath, cookieCount: cookies.length, expiresAt }
}

/** 解密并导入会话包（覆盖目标店铺现有 Cookie）。密码/人工确认均走主进程对话框。 */
export async function importSessionPackage(
  storeId: string,
  filePath: string,
  opts: { pickFile?: boolean } = {}
): Promise<{ imported: number; failed: number; srcStoreName: string; profileRestored: boolean }> {
  const db = getDatabase()
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId) as any
  if (!store) throw new Error('STORE_NOT_FOUND')

  if (opts.pickFile && !filePath) {
    const { dialog } = require('electron')
    const win = BrowserWindow.getFocusedWindow() || undefined
    const r = await dialog.showOpenDialog(win!, {
      title: '选择会话包', filters: [{ name: 'ShopPilot 会话包', extensions: ['shopilot'] }], properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) throw new Error('SESSION_CANCELLED: 未选择文件')
    filePath = r.filePaths[0]
  }
  if (!existsSync(filePath)) throw new Error('SESSION_IMPORT_INVALID: 文件不存在')

  const buf = readFileSync(filePath)
  const invalid = (why: string) => { writeAudit('session.import', 'failure', { storeId, requestId: JSON.stringify({ reason: why }) }); return new Error(`SESSION_IMPORT_INVALID: ${why}`) }

  const headMeta = (() => {
    try {
      const headerLen = buf.readUInt32LE(4)
      return JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8'))
    } catch { return null }
  })()

  try {
    const password = await askPassword({ title: '输入导入包密码', detail: `来源：「${headMeta?.srcStoreName ?? '未知'}」（${basename(filePath)}）` })
    if (!password) throw new Error('SESSION_CANCELLED: 未输入密码')

    const { payload } = (() => {
      try {
        return unpackSession(password, buf)
      } catch (e: any) {
        if (e instanceof SessionPackageError && e.code === 'SESSION_PACKAGE_EXPIRED') {
          writeAudit('session.import', 'failure', { storeId, requestId: JSON.stringify({ reason: 'expired' }) })
          throw new Error(e.message)
        }
        throw invalid(String(e?.message || e).replace(/^SESSION_IMPORT_INVALID:\s*/, ''))
      }
    })()

    const confirmed = await askConfirm({
      title: `导入会话到「${store.name}」？`,
      detail: `来源「${payload.srcStoreName} / ${payload.srcPlatform}」，${payload.cookies.length} 条 Cookie，有效期至 ${new Date(payload.expiresAt).toLocaleString('zh-CN')}。`,
      detail2: '目标店铺现有 Cookie 将被清除并覆盖。异机导入后部分站点可能要求二次验证；localStorage 不在包内。',
      danger: true
    })
    if (!confirmed) throw new Error('SESSION_CANCELLED: 用户取消了导入')

    const ses = storeSession(storeId)
    await ses.clearStorageData({ storages: ['cookies'] })
    let imported = 0
    let failed = 0
    for (const c of payload.cookies) {
      try {
        const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`
        await ses.cookies.set({
          url, name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
          secure: c.secure, httpOnly: c.httpOnly,
          expirationDate: c.expirationDate ?? undefined,
          sameSite: (c.sameSite as any) || undefined
        })
        imported++
      } catch { failed++ }
    }

    // 指纹配置回填：目标店铺环境锁定（profile.locked）时不覆盖
    let profileRestored = false
    if (payload.profile) {
      const target = getProfile(storeId)
      if (target && !target.locked) {
        try { updateProfile(storeId, payload.profile as any); profileRestored = true } catch { /* 锁定竞态：保留目标配置不覆盖 */ }
      }
    }

    writeAudit('session.import', 'success', { storeId, requestId: JSON.stringify({ src: payload.srcStoreName, imported, failed }) })
    return { imported, failed, srcStoreName: payload.srcStoreName, profileRestored }
  } catch (e: any) {
    if (String(e?.message).startsWith('SESSION_') || String(e?.message).startsWith('STORE_NOT_FOUND')) throw e
    throw invalid(`包解析失败（${String(e?.message || e).slice(0, 80)}）`)
  }
}
