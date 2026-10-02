/**
 * 图片本地化服务（方案 §5.9）
 *
 * 做三件事：把商品图**从平台链接下载到本地**、**同图只存一份**、把结果如实写进 `product_media`。
 *
 * 安全边界全部走 `@shared/product-media-rules`（纯函数、有单测）：scheme、私网地址、
 * magic bytes、体积上限、落盘路径只由 sha256 生成。
 * 这一层只负责"取字节"和"落盘"，判定逻辑不在这里重写一遍。
 *
 * 为什么走**店铺 Session** 而不是主进程直连：平台图常带防盗链与登录态，
 * 店铺 Session 里才有正确的 Cookie 与代理；同时它也避免主进程绕开代理直连出网
 * （与 Agent 的"主进程 fetch 不走店铺代理"这条已知边界一致）。
 *
 * 只读语义：只下载图片，不碰平台页面、不写平台任何数据。
 */

import { createHash } from 'crypto'
import { mkdir, writeFile, access, readdir, stat, unlink } from 'fs/promises'
import { join, dirname, relative, sep } from 'path'
import type { Session } from 'electron'
import {
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_REDIRECTS,
  detectImageType,
  exceedsSizeLimit,
  isAllowedImageScheme,
  isPrivateAddress,
  looksLikeSvg,
  mediaRelativePath
} from '@shared/product-media-rules'
import * as ShopSessionManager from '../browser/shop-session-manager'
import * as StoreManager from '../stores/store-manager'
import { getDatabase } from '../db/database'
import { decideOrphans, orphanCleanupSummary, type LocalMediaFile, type OrphanDecision } from '@shared/product-media-queue-rules'
import { logMain } from '../services/logger'
import { ProductRepository } from './product-repository'

export interface ProductMediaRuntime {
  ensureSession: (storeId: string) => Promise<Session>
  getStore: (storeId: string) => { adminUrl?: string | null } | null
  repository: ProductRepository
  /** 图片根目录（userData/product-media） */
  mediaRoot: string
}

export interface MediaLocalizeOutcome {
  total: number
  localized: number
  deduped: number
  failed: number
  blocked: number
  /** 逐张的如实结果（界面显示"哪张没本地化、为什么"） */
  details: Array<{ remoteUrl: string | null; state: string; reason: string | null }>
}

/** 单张下载的中间结果：成功带字节，失败带**如实的**原因码。 */
type FetchOutcome =
  | { ok: true; bytes: Uint8Array; finalUrl: string }
  | { ok: false; state: 'failed' | 'blocked'; reason: string }

function emptyOutcome(): MediaLocalizeOutcome {
  return { total: 0, localized: 0, deduped: 0, failed: 0, blocked: 0, details: [] }
}

/**
 * 下载一张图：手动跟重定向，**每一跳都重新校验** scheme 与主机名。
 *
 * 为什么手动跟：`redirect: 'follow'` 会让平台用 302 把我们送到内网地址，
 * 而首次校验只看了原始 URL —— 这是 SSRF 绕过最常见的一种。
 */
async function fetchImage(session: Session, url: string, referer: string | null): Promise<FetchOutcome> {
  let current = url
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    if (!isAllowedImageScheme(current)) return { ok: false, state: 'blocked', reason: 'bad_scheme' }
    let host = ''
    try { host = new URL(current).hostname } catch { return { ok: false, state: 'blocked', reason: 'bad_scheme' } }
    if (isPrivateAddress(host)) return { ok: false, state: 'blocked', reason: 'private_address' }

    let response: Response
    try {
      const headers: Record<string, string> = {}
      // 防盗链：带上店铺页面的 Referer。Chromium 有可能把它当受限头丢掉 —— 丢掉就如实失败，
      // 不假装成功（实测四平台的图都能直接下，这条只是尽力而为）。
      if (referer) headers.Referer = referer
      response = await session.fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS)
      })
    } catch (error) {
      const message = String((error as Error)?.name || (error as Error)?.message || error)
      return { ok: false, state: 'failed', reason: message.includes('Timeout') || message.includes('timed out') ? 'timeout' : 'network_error' }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return { ok: false, state: 'failed', reason: 'redirect_without_location' }
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) return { ok: false, state: 'failed', reason: `http_${response.status}` }

    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared && exceedsSizeLimit(declared)) return { ok: false, state: 'blocked', reason: 'too_large' }

    let buffer: Uint8Array
    try {
      buffer = new Uint8Array(await response.arrayBuffer())
    } catch {
      return { ok: false, state: 'failed', reason: 'body_read_failed' }
    }
    // 流式计数拿不到就退化成"读完再看大小"：宁可多占一次内存，也不放过超大文件
    if (buffer.byteLength === 0) return { ok: false, state: 'failed', reason: 'empty_body' }
    if (exceedsSizeLimit(buffer.byteLength, MAX_IMAGE_BYTES)) return { ok: false, state: 'blocked', reason: 'too_large' }
    return { ok: true, bytes: buffer, finalUrl: current }
  }
  return { ok: false, state: 'blocked', reason: 'too_many_redirects' }
}

export class ProductMediaService {
  constructor(private readonly runtimeFactory: () => ProductMediaRuntime) {}

  /** 把一个**本地商品**的所有图片本地化（编辑抽屉里点"下载图片到本地"走这条）。 */
  async localizeProduct(productId: string, options: { maxItems?: number } = {}): Promise<MediaLocalizeOutcome> {
    const runtime = this.runtimeFactory()
    const product = runtime.repository.getProduct(productId)
    if (!product) throw new Error('PRODUCT_NOT_FOUND')

    // 归属店铺：从该商品已归并的平台商品里取（图片要用那家店的 Session 下载）
    const rows = runtime.repository.listLinks({ limit: 200 }).rows.filter(row => row.productId === productId)
    const storeId = rows[0]?.storeId ?? null
    if (!storeId) {
      // **必须落库**（2026-09-30 实测踩到）：这个分支以前是"直接返回结果、不写回"，
      // 后果是——界面说"22 张被拒"，库里却还是 `pending`，队列下一轮又原样重试，
      // 永远卡在同一批图上（而且排查时看不到任何写回日志，非常难查）。
      // 现在把 `blocked` 与原因写进台账：状态可见、队列也不会再无限重试。
      const blockedMedia = product.draft.media.map(item => ({ ...item, state: 'blocked' as const, failReason: 'no_store' }))
      runtime.repository.updateProduct({ productId, draft: { ...product.draft, media: blockedMedia }, draftHash: product.draftHash })
      logMain('warn', `[product-media] 这个商品没有归并任何平台商品（没有店铺 → 没有 Session），已把 ${blockedMedia.length} 张标为 blocked/no_store`)
      return {
        ...emptyOutcome(),
        total: product.draft.media.length,
        blocked: product.draft.media.length,
        details: product.draft.media.map(item => ({ remoteUrl: item.remoteUrl ?? null, state: 'blocked', reason: 'no_store' }))
      }
    }

    let session: Session
    try {
      session = await runtime.ensureSession(storeId)
    } catch {
      return { ...emptyOutcome(), total: product.draft.media.length, failed: product.draft.media.length,
        details: product.draft.media.map(item => ({ remoteUrl: item.remoteUrl ?? null, state: 'failed', reason: 'session_unavailable' })) }
    }

    const outcome = emptyOutcome()
    // 防盗链用的 Referer：取该店铺**后台地址的 origin**（不是猜的域名）。
    // 取不到就不带 Referer —— 实测四平台的商品图都能直接下，这条只是尽力而为。
    const adminUrl = runtime.getStore(storeId)?.adminUrl ?? ''
    let referer: string | null = null
    try { referer = adminUrl ? new URL(adminUrl).origin + '/' : null } catch { referer = null }
    const updated = [...product.draft.media]

    // **只处理需要处理的那些**，并且尊重调用方给的批大小上限。
    //
    // 为什么必须真的按上限截断（2026-09-30 实测踩到）：队列的 `maxItems` 只限制了"计划里的条数"，
    // 而这里会把该商品**全部**待处理图都跑一遍 —— 一个 500 张图的商品会把上限彻底绕过，
    // 用户点了"这一批 6 张"结果跑了一小时。
    const pendingIndexes = product.draft.media
      .map((item, index) => ({ item, index }))
      .filter(entry => entry.item.state !== 'localized' && !!entry.item.remoteUrl)
      .map(entry => entry.index)
    const limit = options.maxItems == null ? pendingIndexes.length : Math.max(0, Math.floor(options.maxItems))
    const indexesToProcess = new Set(pendingIndexes.slice(0, limit))

    for (const [index, item] of product.draft.media.entries()) {
      if (!indexesToProcess.has(index)) continue
      outcome.total += 1
      const url = item.remoteUrl ?? null
      if (!url) {
        outcome.blocked += 1
        outcome.details.push({ remoteUrl: null, state: 'blocked', reason: 'no_remote_url' })
        updated[index] = { ...item, state: 'blocked' }
        continue
      }
      const result = await this.storeOne({ runtime, session, url, referer })
      outcome[result.state === 'localized' ? (result.deduped ? 'deduped' : 'localized') : result.state === 'blocked' ? 'blocked' : 'failed'] += 1
      outcome.details.push({ remoteUrl: url, state: result.state, reason: result.reason })
      updated[index] = {
        ...item,
        state: result.state,
        ...(result.relativePath ? { localPath: result.relativePath, sha256: result.sha256 } : {}),
        ...(result.reason ? { failReason: result.reason } : {})
      } as typeof item
    }

    // 回写状态（草稿内容没变，所以指纹不用重算）
    runtime.repository.updateProduct({ productId, draft: { ...product.draft, media: updated }, draftHash: product.draftHash })
    return outcome
  }

  /** 下载 + 校验 + 去重 + 落盘一张图。 */
  private async storeOne(input: {
    runtime: ProductMediaRuntime
    session: Session
    url: string
    referer: string | null
  }): Promise<{ state: 'localized' | 'failed' | 'blocked'; reason: string | null; deduped?: boolean; relativePath?: string; sha256?: string }> {
    // **先查有没有现成的本地文件**（同一个图片地址可能已经被别的商品下过了）。
    //
    // 实测（2026-09-30）：没有这一步时，队列会把同一张图反复下载 ——
    // 连着下三遍同一批 22 张，平台 CDN 从第三遍开始返回非图片内容，
    // 44 张全被判成"格式不支持"而拒绝。有映射就一次网络请求都不用发。
    const known = input.runtime.repository.mediaByRemoteUrl(input.url)
    if (known) {
      const absolute = join(input.runtime.mediaRoot, known.localPath)
      const onDisk = await access(absolute).then(() => true).catch(() => false)
      if (onDisk) {
        return { state: 'localized', reason: null, deduped: true, relativePath: known.localPath, sha256: known.sha256 }
      }
      // 表里有记录但文件没了（被清掉/换过机器）→ 老老实实重新下
    }

    const fetched = await fetchImage(input.session, input.url, input.referer)
    if (!fetched.ok) {
      return { state: fetched.state, reason: fetched.reason }
    }
    const type = detectImageType(fetched.bytes)
    if (!type) {
      // SVG 单独给原因：它能内嵌脚本，而这个应用会渲染这些图 —— 明确拒绝，不是"没认出来"
      const reason = looksLikeSvg(fetched.bytes) ? 'svg_rejected' : 'unsupported_type'
      return { state: 'blocked', reason }
    }

    const sha256 = createHash('sha256').update(fetched.bytes).digest('hex')
    const relativePath = mediaRelativePath(sha256, type.ext)
    const absolute = join(input.runtime.mediaRoot, relativePath)
    const alreadyOnDisk = await access(absolute).then(() => true).catch(() => false)

    if (!alreadyOnDisk) {
      try {
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, fetched.bytes)
      } catch (error) {
        logMain('warn', `[product-media] 写盘失败 path=${relativePath} error=${String((error as Error)?.message || error)}`)
        return { state: 'failed', reason: 'write_failed' }
      }
    }
    // 同一张图（同 sha256）第二次下载时，磁盘上已经有文件 → 记为 deduped，但仍算"已本地化"
    return { state: 'localized', reason: null, deduped: alreadyOnDisk, relativePath, sha256 }
  }

  /**
   * 扫一遍 `product-media` 目录，判出**孤儿文件**（保留策略，方案 §5.9）。
   *
   * 三条安全边界（缺一不可）：
   *   ① **只在 `mediaRoot` 目录内遍历**（不碰用户任何其它路径）；
   *   ② **表里还在引用的文件一律不删**（有商品在用它）；
   *   ③ 不在表里但**还在宽限期内**的也不删（写盘与入库之间有窗口，并发跑时窗口更明显）。
   *
   * 本方法**只判定、不删除** —— 删除要用户确认（见 `cleanupOrphans`）。
   */
  async scanOrphans(): Promise<{ orphans: OrphanDecision[]; keepCount: number; orphanBytes: number; summary: string }> {
    const runtime = this.runtimeFactory()
    const files = await walkMediaFiles(runtime.mediaRoot)
    const decision = decideOrphans({
      files,
      referencedPaths: runtime.repository.referencedMediaPaths(),
      now: Date.now()
    })
    return { ...decision, summary: orphanCleanupSummary(decision) }
  }

  /**
   * 按保留策略清理孤儿文件。
   *
   * **删文件 + 删台账**，且只删 `scanOrphans` 判出来的那些（每次重新判定，不用旧结论 ——
   * 避免"判定之后又有商品引用了它"这种情况被误删）。
   */
  async cleanupOrphans(): Promise<{ deleted: number; bytes: number; failed: number; summary: string }> {
    const runtime = this.runtimeFactory()
    const scan = await this.scanOrphans()
    let deleted = 0
    let bytes = 0
    let failed = 0
    const deletedPaths: string[] = []
    for (const orphan of scan.orphans) {
      const absolute = join(runtime.mediaRoot, orphan.relativePath)
      // 双保险：删之前再确认绝对路径确实落在 mediaRoot 里（防相对路径里有 `..`）
      if (!isInside(runtime.mediaRoot, absolute)) { failed += 1; continue }
      try {
        await unlink(absolute)
        deleted += 1
        bytes += orphan.bytes
        deletedPaths.push(orphan.relativePath)
      } catch {
        failed += 1
      }
    }
    if (deletedPaths.length) runtime.repository.deleteMediaByPath(deletedPaths)
    logMain('info', `[product-media] 清理孤儿 deleted=${deleted} bytes=${bytes} failed=${failed}`)
    return {
      deleted, bytes, failed,
      summary: deleted
        ? `已清理 ${deleted} 个孤儿文件、释放 ${(bytes / 1024 / 1024).toFixed(2)} MB${failed ? `；${failed} 个删失败（可能被占用）` : ''}`
        : '没有可清理的孤儿文件（本地图片都在用）'
    }
  }
}

/** 递归列出 `product-media` 里的所有文件（相对路径 + 大小 + 修改时间）。 */
async function walkMediaFiles(root: string): Promise<LocalMediaFile[]> {
  const out: LocalMediaFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return                       // 目录结构是 `<2位>/<sha256>.<ext>`，不需要更深
    let entries: Awaited<ReturnType<typeof readdir>>
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(absolute, depth + 1); continue }
      if (!entry.isFile()) continue
      try {
        const info = await stat(absolute)
        out.push({ relativePath: relative(root, absolute).split(sep).join('/'), bytes: info.size, modifiedAt: info.mtimeMs })
      } catch { /* 读不到就跳过，不影响其它文件 */ }
    }
  }
  await walk(root, 0)
  return out
}

/** `child` 是否在 `parent` 目录内（清理前的双保险）。 */
function isInside(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(normalizedParent)
}

export function createDefaultProductMediaRuntime(): ProductMediaRuntime {  return {
    ensureSession: ShopSessionManager.ensureSession,
    getStore: storeId => StoreManager.getStore(storeId),
    repository: new ProductRepository(getDatabase()),
    mediaRoot: ''   // 由调用方注入（那里能拿到 app.getPath('userData')）
  }
}
