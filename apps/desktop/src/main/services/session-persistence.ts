/**
 * 会话级 Cookie 的自动持久化（解决"重启应用就要重新扫码登录"）。
 *
 * 背景（2026-09-14 实测）：微信小店的登录 Cookie **全部是会话级**（无 expirationDate）。
 * Chromium 默认**不把会话 Cookie 写入磁盘**（分区目录下的 Cookies 库里 0 条持久行，抖店有 73 条），
 * 所以应用一重启，登录态就没了——哪怕分区用的是 `persist:`。这跟"服务端会话短"是两回事：
 * 登录期间实测 121 分钟不掉线，纯粹是客户端没保存。
 *
 * 做法：把会话级 Cookie（只要 expirationDate 为空的那批）快照到磁盘，下次启动再灌回分区。
 *  - **只存会话级**：有到期时间的 Cookie 本来就由 Chromium 落盘，不需要我们插手（也少存一份密钥）；
 *  - **DPAPI 加密**：safeStorage 可用才落盘，绝不明文写 Cookie（否则等于把登录凭据摊在磁盘上）；
 *  - 定期（60s）+ 退出前 + 关闭店铺浏览器时快照，任一路径都能兜住；
 *  - 恢复只做一次（启动时），避免把用户新登录的态覆盖成旧快照。
 *
 * 恢复不等于"一定能用"：服务端可能已让它失效——那种情况仍由既有的登录过期检测如实报出来。
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getStoreSession } from '../browser/session-manager'
import { logMain } from './logger'
import type { SessionCookieEntry } from './session-package'

/** 快照落盘位置：userData/stores/<storeId>/session-cookies.enc */
function snapshotPath(storeId: string): string {
  return join(app.getPath('userData'), 'stores', storeId, 'session-cookies.enc')
}

/** 只保留会话级 Cookie（有 expirationDate 的由 Chromium 自己持久化） */
async function readSessionCookies(storeId: string): Promise<SessionCookieEntry[]> {
  const ses = getStoreSession(storeId)
  const raw = await ses.cookies.get({})
  return raw
    .filter((c: any) => !c.expirationDate)
    .map((c: any) => ({
      name: c.name, domain: c.domain, path: c.path || '/', value: c.value,
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      expirationDate: null,
      sameSite: c.sameSite || null
    }))
}

/**
 * 快照某个店铺的会话 Cookie。
 * @returns 写入条数；safeStorage 不可用时返回 -1（拒绝明文落盘）
 */
export async function snapshotStoreSession(storeId: string): Promise<number> {
  try {
    const cookies = await readSessionCookies(storeId)
    if (!cookies.length) return 0
    if (!safeStorage.isEncryptionAvailable()) {
      logMain('warn', `会话快照跳过 store=${storeId}：系统加密不可用，拒绝明文写 Cookie`)
      return -1
    }
    const blob = safeStorage.encryptString(JSON.stringify({ v: 1, at: Date.now(), cookies }))
    const file = snapshotPath(storeId)
    mkdirSync(dirname(file), { recursive: true })
    // 先写临时文件再改名：中途断电/被杀不会留下半截文件（下次启动解不开=白丢登录态）
    const tmp = `${file}.tmp`
    writeFileSync(tmp, blob)
    renameSync(tmp, file)
    return cookies.length
  } catch (e: any) {
    logMain('warn', `会话快照失败 store=${storeId}: ${String(e?.message || e).slice(0, 160)}`)
    return 0
  }
}

/**
 * 把快照灌回店铺分区。
 * @returns 恢复条数；无快照返回 0
 */
export async function restoreStoreSession(storeId: string): Promise<number> {
  const file = snapshotPath(storeId)
  if (!existsSync(file)) return 0
  if (!safeStorage.isEncryptionAvailable()) return 0
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file)))
    const cookies: SessionCookieEntry[] = Array.isArray(parsed?.cookies) ? parsed.cookies : []
    const ses = getStoreSession(storeId)
    let ok = 0
    for (const c of cookies) {
      try {
        // 与"导入会话包"同一套字段映射（url 由 domain+path 推出来，Electron 要求 url 合法）
        const url = `${c.secure ? 'https' : 'http'}://${String(c.domain).replace(/^\./, '')}${c.path || '/'}`
        await ses.cookies.set({
          url, name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
          secure: c.secure, httpOnly: c.httpOnly,
          expirationDate: undefined,
          sameSite: (c.sameSite as any) || undefined
        })
        ok++
      } catch { /* 单条失败不阻塞其余 */ }
    }
    if (ok) logMain('info', `会话已恢复 store=${storeId} cookies=${ok}/${cookies.length}`)
    return ok
  } catch (e: any) {
    logMain('warn', `会话恢复失败 store=${storeId}: ${String(e?.message || e).slice(0, 160)}`)
    return 0
  }
}

/** 清除快照（用户主动清 Cookie 时必须一起删，否则下次启动会把刚清掉的登录态灌回来） */
export function clearStoreSessionSnapshot(storeId: string): void {
  try {
    const file = snapshotPath(storeId)
    if (existsSync(file)) rmSync(file)
    if (existsSync(`${file}.tmp`)) rmSync(`${file}.tmp`)
  } catch { /* 删不掉不影响主流程 */ }
}

// ---------- 生命周期编排 ----------

let snapshotTimer: NodeJS.Timeout | null = null
let wired = false
/** 当前需要定期快照的店铺（由 window-manager 在打开/关闭浏览器时登记/注销） */
const trackedStores = new Set<string>()

export function trackStoreSession(storeId: string): void { trackedStores.add(storeId) }
export function untrackStoreSession(storeId: string): void { trackedStores.delete(storeId) }

/**
 * 启动会话持久化：
 *  ① 启动时把所有已登记店铺的快照恢复回分区（在用户打开店铺浏览器之前就位）；
 *  ② 每 60s 快照一次（防止进程被强杀时丢掉最近的登录态）；
 *  ③ 退出前再快照一次（正常退出的常规路径）。
 */
export async function startSessionPersistence(storeIds: string[]): Promise<{ restored: number }> {
  let restored = 0
  for (const id of storeIds) {
    trackStoreSession(id)
    const n = await restoreStoreSession(id)
    if (n > 0) restored += n
  }
  if (wired) return { restored }
  wired = true
  snapshotTimer = setInterval(() => { void snapshotAll('定时') }, 60_000)
  // 退出前快照：用 preventDefault 拦一次，等异步写盘完成再真退出。
  // 必须带超时兜底——快照若卡住（磁盘/杀软占用），用户会看到"点了退出却退不掉"。
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    if (!trackedStores.size) return
    e.preventDefault()
    quitting = true
    const done = () => { try { app.quit() } catch { /* 已在退出中 */ } }
    const guard = setTimeout(done, 3000)
    void snapshotAll('退出前').finally(() => { clearTimeout(guard); done() })
  })
  return { restored }
}

export async function snapshotAll(_why = '手动'): Promise<void> {
  for (const id of Array.from(trackedStores)) {
    await snapshotStoreSession(id)
  }
}

export function stopSessionPersistence(): void {
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null }
}
