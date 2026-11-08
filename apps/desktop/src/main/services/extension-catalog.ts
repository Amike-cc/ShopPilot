/**
 * 插件中心（2026-11-08）：随安装包一起发送的内置插件目录。
 *
 * 为什么不做"从 URL 下载插件"：
 *   · 扩展能读写店铺页面，等于把任意远端代码引进登录态会话；本项目对扩展的安全边界
 *     （危险权限硬阻断、拒 MAIN world）是建立在"用户自己选的本地副本"之上的；
 *   · 随包发 = 可溯源到某个发布版本的安装包，离线也能装；升级插件就发新版本应用。
 *
 * 目录结构（repo：assets/browser-extensions，打包后：resources/browser-extensions）：
 *   catalog.json                    —— 条目声明（parseCatalogIndex 严格校验）
 *   <dir>/manifest.json + 扩展文件   —— 扩展本体（仍按 extension-manifest.ts 同一套规则校验）
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type {
  BrowserExtensionCatalogItem,
  BrowserExtensionCatalogResult,
  BrowserExtensionCatalogInstallResult
} from '@shared/contracts/extensions'
import { catalogSlug, parseCatalogIndex, type BrowserExtensionCatalogEntry } from '@shared/extension-catalog'
import { logMain } from './logger'
import {
  getExtensionsRoot,
  inspectExtensionSource,
  installExtensionFromDirectory,
  listExtensions,
  setExtensionEnabled
} from './extension-manager'

/** 目录根：开发态读仓库 assets/，打包后读 resources/（electron-builder extraResources）。 */
export function getCatalogRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'browser-extensions')
    : join(app.getAppPath(), 'assets', 'browser-extensions')
}

function readIndex(): { ok: true; entries: BrowserExtensionCatalogEntry[] } | { ok: false; message: string } {
  const indexPath = join(getCatalogRoot(), 'catalog.json')
  if (!existsSync(indexPath)) return { ok: false, message: '插件目录缺失（catalog.json 不存在）' }
  try {
    const parsed = parseCatalogIndex(JSON.parse(readFileSync(indexPath, 'utf8')))
    if (!parsed.ok) return { ok: false, message: parsed.message }
    return { ok: true, entries: parsed.index.entries }
  } catch (error) {
    return { ok: false, message: `插件目录无法解析：${String((error as Error)?.message || error).slice(0, 160)}` }
  }
}

export function listCatalog(): BrowserExtensionCatalogResult {
  const installed = listExtensions()
  const bySlug = new Map(installed.items.map(item => [item.id, item]))
  const index = readIndex()
  if (!index.ok) {
    logMain('warn', `[extensions] 插件目录不可用: ${index.message}`)
    return { master: installed.master, entries: [], sourceError: index.message }
  }
  const entries: BrowserExtensionCatalogItem[] = []
  for (const entry of index.entries) {
    const slug = catalogSlug(entry.key)
    const dir = join(getCatalogRoot(), entry.dir)
    const probe = inspectExtensionSource(dir)
    const existing = bySlug.get(slug)
    const manifest = probe.manifest
    entries.push({
      id: slug,
      key: entry.key,
      name: manifest?.name || entry.name,
      version: manifest?.version || '—',
      manifestVersion: manifest?.manifestVersion || 3,
      summary: entry.summary,
      ...(entry.description ? { description: entry.description } : {}),
      tags: entry.tags || [],
      permissions: manifest?.permissions || [],
      sizeBytes: probe.sizeBytes,
      installed: !!existing,
      enabled: existing?.enabled === true,
      status: existing?.status || 'missing',
      ...(manifest ? {} : { invalidReason: probe.message || '插件文件缺失或清单不合法' })
    })
  }
  return { master: installed.master, entries }
}

/**
 * 安装（或覆盖升级）一个内置插件。
 *
 * 顺序：按 key 找到目录条目 → 固定 slug 复制（重复安装覆盖同一目录）→ 启用 →
 * 由调用方重载已打开店铺标签让插件立刻生效。总开关关着时如实返回 masterOff，
 * 不替用户偷偷打开全局开关。
 */
export async function installCatalogEntry(key: string): Promise<BrowserExtensionCatalogInstallResult> {
  const index = readIndex()
  if (!index.ok) throw new Error(`EXTENSION_INVALID: ${index.message}`)
  const entry = index.entries.find(item => item.key === key)
  if (!entry) throw new Error('EXTENSION_NOT_FOUND: 插件目录里没有这个条目')
  const slug = catalogSlug(entry.key)
  const sourceDir = join(getCatalogRoot(), entry.dir)
  const probe = inspectExtensionSource(sourceDir)
  if (!probe.manifest) {
    throw new Error(`${probe.code || 'EXTENSION_INVALID'}: ${probe.message || '插件文件缺失或清单不合法'}`)
  }
  installExtensionFromDirectory(sourceDir, slug)
  // 装完即启用（用户点的是"安装"）；总开关仍由用户自己控制
  const list = await setExtensionEnabled(slug, true)
  return { list, id: slug, masterOff: list.master !== true }
}

/** 扩展根目录（诊断/日志用；不回渲染层）。 */
export function catalogInstallRoot(): string {
  return getExtensionsRoot()
}
