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
 * 内容边界（如实声明）：Cookie（含 HttpOnly，Chromium 解密后明文入容器）+ 指纹配置
 * + 店铺元信息 + **站点 localStorage**（v2，2026-11-08 起，有明确限额）。
 * IndexedDB / CacheStorage / Service Worker 仍不在包内：格式随 Chromium 版本变化，
 * 硬搬容易得到"看起来导入了、实际登录态是坏的"，宁缺毋假。
 * 异机导入后部分站点仍可能要求二次验证。
 */

import { app, BrowserWindow, session } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import { getDatabase } from '../db/database'
import { writeAudit } from '../services/audit-logger'
import { askConfirm, askPassword } from '../services/password-dialog'
import { getProfile, updateProfile } from '../stores/profile-manager'
import { assertSafeExportPath } from './diagnostics'
import { candidateStorageOrigins } from '@shared/session-storage'
import { collectStoreLocalStorage, restoreStoreLocalStorage } from './session-storage'
import { getEntryRoutes } from '../browser/bookmark-manager'
import { packSession, unpackSession, SessionPackageError, type SessionCookieEntry } from './session-package'

export type { SessionCookieEntry } from './session-package'

/** 会话包扩展名：.shopilot 是本实现实际产出的包名（.json 兼容历史/导出为 json 的场景） */
const SESSION_PACKAGE_EXTS = ['.shopilot', '.json']

function storeSession(storeId: string): Electron.Session {
  return session.fromPartition(`persist:store_${storeId}`, { cache: true })
}

/** 采集当前会话并加密写包。人工确认 + 密码采集均为主进程托管对话框。 */
export async function exportSessionPackage(
  storeId: string,
  opts: { outputPath?: string; validDays?: number } = {}
): Promise<{
  path: string
  cookieCount: number
  expiresAt: number
  storageOrigins: number
  storageItems: number
  storageSkipped: number
  storageSkippedOrigins: number
  storageFailedOrigins: number
}> {
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
    detail: `将导出 ${cookies.length} 条 Cookie、指纹配置与站点本地存储，封装为加密包（口令保护 + 有效期）。`,
    detail2: '导出包等同于登录凭据，请妥善保管；过期的包无法导入。',
    danger: true
  })
  if (!confirmed) { writeAudit('session.export', 'failure'); throw new Error('SESSION_CANCELLED: 用户取消了导出') }

  const password = await askPassword({ title: '设置导出密码', detail: '该密码用于解密导出包，遗失后包不可恢复', requireConfirm: true })
  if (!password) { writeAudit('session.export', 'failure'); throw new Error('SESSION_CANCELLED: 未输入导出密码') }

  const now = Date.now()
  const validDays = opts.validDays ?? 30

  // 站点本地存储（包 v2）：平台常把 token / 店铺上下文放在 localStorage，只带 Cookie
  // 换机后往往还要重登一次。用隐藏后台页采集——不碰用户正在看的标签页。
  // 采集失败/超限都如实计数，不假装导全了。
  const storageResult = await collectStoreLocalStorage(storeId, candidateStorageOrigins({
    adminUrl: store.admin_url,
    routeUrls: getEntryRoutes(store.platform).map(route => route.url),
    cookieDomains: cookies.map(cookie => cookie.domain)
  }))

  const prof = getProfile(storeId)
  const profile: Record<string, unknown> | null = prof ? {
    browserVersion: prof.browserVersion, osDisplay: prof.osDisplay, userAgent: prof.userAgent,
    uaClientHintsJson: prof.uaClientHintsJson, language: prof.language, timezone: prof.timezone,
    screenWidth: prof.screenWidth, screenHeight: prof.screenHeight, colorDepth: prof.colorDepth,
    hardwareConcurrency: prof.hardwareConcurrency, webglVendor: prof.webglVendor, webglRenderer: prof.webglRenderer
  } : null

  const { file, expiresAt } = packSession(password, {
    srcStoreId: storeId, srcStoreName: store.name, srcPlatform: store.platform, profile, cookies,
    storage: storageResult.entries
  }, validDays, now)

  let outPath = opts.outputPath
  const rendererProvidedPath = !!outPath
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
  // @types/node 22.20 下 outPath 的流收窄不再覆盖两条分支，这里显式收口一次（此处不可能为 undefined）
  if (!outPath) throw new Error('SESSION_CANCELLED: 未选择保存位置')
  if (rendererProvidedPath) {
    // 渲染层直传的路径在**落盘前**校验（第一次真正使用它之前）：未校验的路径绝不触碰文件系统，
    // 同时对话框流程（用户可取消）保持原样。
    // 注：m4 验收用 `xxx.shopilot.cancel` 这种临时后缀路径验证"取消对话 → SESSION_CANCELLED"
    //（tools/acceptance/m4-cdp-verify.js:259），入口即拦会把那条验收变成参数错误。
    outPath = assertSafeExportPath(outPath, SESSION_PACKAGE_EXTS, '会话包导出')
  }
  mkdirSync(join(app.getPath('userData'), 'exports'), { recursive: true })
  writeFileSync(outPath, file)

  writeAudit('session.export', 'success', {
    storeId,
    requestId: JSON.stringify({
      cookieCount: cookies.length,
      expiresAt,
      storageOrigins: storageResult.entries.length,
      storageItems: storageResult.items,
      storageSkipped: storageResult.skippedItems,
      storageSkippedOrigins: storageResult.skippedOrigins,
      storageFailedOrigins: storageResult.failedOrigins.length,
      storageReason: storageResult.reason
    })
  })
  return {
    path: outPath,
    cookieCount: cookies.length,
    expiresAt,
    storageOrigins: storageResult.entries.length,
    storageItems: storageResult.items,
    storageSkipped: storageResult.skippedItems,
    storageSkippedOrigins: storageResult.skippedOrigins,
    storageFailedOrigins: storageResult.failedOrigins.length
  }
}

/** 解密并导入会话包（覆盖目标店铺现有 Cookie）。密码/人工确认均走主进程对话框。 */
export async function importSessionPackage(
  storeId: string,
  filePath: string,
  opts: { pickFile?: boolean } = {}
): Promise<{
  imported: number
  failed: number
  srcStoreName: string
  profileRestored: boolean
  storageOrigins: number
  storageItems: number
  storageFailedOrigins: number
}> {
  const db = getDatabase()
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId) as any
  if (!store) throw new Error('STORE_NOT_FOUND')

  const invalid = (why: string) => { writeAudit('session.import', 'failure', { storeId, requestId: JSON.stringify({ reason: why }) }); return new Error(`SESSION_IMPORT_INVALID: ${why}`) }

  if (filePath) {
    // 只校验**渲染层直传**的路径；对话框选出的路径是用户在本机原生对话框里选的，不受此限。
    // 失败按 SESSION_IMPORT_INVALID 呈现——导入通道的既有契约（含验收脚本）只认这个码，
    // 路径不合法同样属于"包不可用"
    try {
      filePath = assertSafeExportPath(filePath, SESSION_PACKAGE_EXTS, '会话包导入')
    } catch (e: any) {
      throw invalid(String(e?.message || e).replace(/^INVALID_ARGUMENT:\s*/, ''))
    }
  }

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

    const storageCount = Array.isArray(payload.storage) ? payload.storage.length : 0
    const confirmed = await askConfirm({
      title: `导入会话到「${store.name}」？`,
      detail: `来源「${payload.srcStoreName} / ${payload.srcPlatform}」，${payload.cookies.length} 条 Cookie、${storageCount} 个站点本地存储，有效期至 ${new Date(payload.expiresAt).toLocaleString('zh-CN')}。`,
      detail2: '目标店铺现有 Cookie 将被清除并覆盖；本地存储按同名键覆盖（不清空站点的其它键）。异机导入后部分站点可能要求二次验证。',
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

    // 站点本地存储（v2）：逐 origin 用隐藏后台页写回，失败按站点计数；
    // 包是 v1 或没有 storage 段时这里自然是 0，不报错也不提示"缺失"。
    const storageRestore = Array.isArray(payload.storage) && payload.storage.length
      ? await restoreStoreLocalStorage(storeId, payload.storage)
      : { origins: 0, items: 0, failedOrigins: [], reason: null }

    // 指纹配置回填：目标店铺环境锁定（profile.locked）时不覆盖
    let profileRestored = false
    if (payload.profile) {
      const target = getProfile(storeId)
      if (target && !target.locked) {
        try { updateProfile(storeId, payload.profile as any); profileRestored = true } catch { /* 锁定竞态：保留目标配置不覆盖 */ }
      }
    }

    writeAudit('session.import', 'success', {
      storeId,
      requestId: JSON.stringify({
        src: payload.srcStoreName,
        imported,
        failed,
        storageOrigins: storageRestore.origins,
        storageItems: storageRestore.items,
        storageFailedOrigins: storageRestore.failedOrigins.length,
        storageReason: storageRestore.reason
      })
    })
    return {
      imported,
      failed,
      srcStoreName: payload.srcStoreName,
      profileRestored,
      storageOrigins: storageRestore.origins,
      storageItems: storageRestore.items,
      storageFailedOrigins: storageRestore.failedOrigins.length
    }
  } catch (e: any) {
    if (String(e?.message).startsWith('SESSION_') || String(e?.message).startsWith('STORE_NOT_FOUND')) throw e
    throw invalid(`包解析失败（${String(e?.message || e).slice(0, 80)}）`)
  }
}
