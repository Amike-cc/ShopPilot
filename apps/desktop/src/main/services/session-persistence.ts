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
import { closeCustomerServiceSession, getActiveCustomerServiceSession, getActiveStoreSession, getCustomerServiceSession, getStoreSession } from '../browser/session-manager'
import { getDatabase } from '../db/database'
import { logMain } from './logger'
import type { SessionCookieEntry } from './session-package'

/** 快照落盘位置：userData/stores/<storeId>/session-cookies.enc */
function snapshotPath(storeId: string, scope: 'store' | 'customer-service' = 'store'): string {
  return join(
    app.getPath('userData'),
    'stores',
    storeId,
    scope === 'customer-service' ? 'customer-service-session-cookies.enc' : 'session-cookies.enc'
  )
}

/** 只保留会话级 Cookie（有 expirationDate 的由 Chromium 自己持久化） */
async function readSessionCookies(ses: Electron.Session): Promise<SessionCookieEntry[]> {
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
async function snapshotSession(
  storeId: string,
  ses: Electron.Session,
  scope: 'store' | 'customer-service',
  label: string,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  try {
    const file = snapshotPath(storeId, scope)
    if (!shouldContinue()) return 0
    // 加密不可用时不能覆盖或删除已有快照。系统加密能力可能因用户配置文件、
    // 远程桌面或启动时序暂时不可用；此时保留旧快照，等下一轮恢复后再更新，
    // 否则一次短暂的 safeStorage 不可用就会把可恢复的登录态永久删掉。
    if (!safeStorage.isEncryptionAvailable()) {
      logMain('warn', `会话快照跳过 ${label}=${storeId}：系统加密不可用，保留既有快照`)
      return -1
    }
    const cookies = await readSessionCookies(ses)
    // Cookie 读取是异步的；清理/删除店铺可能在这里期间使本次快照失效。
    if (!shouldContinue()) return 0
    if (!cookies.length) {
      // 一个会话级 Cookie 都没有 → 快照必须**消失**，不能留着一份旧文件。
      // 此前这里直接 return 0，于是"用户点清空 Cookie → 快照文件还在 → 重启把它灌回"
      // 表现为"清掉的登录态自己回来了"（用户会以为软件偷偷存了登录凭据）。
      if (existsSync(file)) {
        try { rmSync(file, { force: true }) } catch { /* 删不掉也不阻塞 */ }
      }
      if (existsSync(`${file}.tmp`)) {
        try { rmSync(`${file}.tmp`, { force: true }) } catch { /* 临时文件清理失败不阻塞 */ }
      }
      return 0
    }
    if (!shouldContinue()) return 0
    const blob = safeStorage.encryptString(JSON.stringify({ v: 1, at: Date.now(), cookies }))
    mkdirSync(dirname(file), { recursive: true })
    // 先写临时文件再改名：中途断电/被杀不会留下半截文件（下次启动解不开=白丢登录态）
    const tmp = `${file}.tmp`
    writeFileSync(tmp, blob)
    if (!shouldContinue()) {
      try { rmSync(tmp, { force: true }) } catch { /* 失效快照的临时文件清理不阻塞 */ }
      return 0
    }
    renameSync(tmp, file)
    return cookies.length
  } catch (e: any) {
    logMain('warn', `会话快照失败 ${label}=${storeId}: ${String(e?.message || e).slice(0, 160)}`)
    return 0
  }
}

type SnapshotScope = 'store' | 'customer-service'
const snapshotQueues = new Map<string, Promise<unknown>>()
const snapshotGenerations = new Map<string, number>()

function snapshotKey(storeId: string, scope: SnapshotScope): string { return `${scope}\u0000${storeId}` }
function snapshotGeneration(storeId: string, scope: SnapshotScope): number { return snapshotGenerations.get(snapshotKey(storeId, scope)) || 0 }
function invalidateSnapshotGeneration(storeId: string, scope?: SnapshotScope): void {
  const scopes: SnapshotScope[] = scope ? [scope] : ['store', 'customer-service']
  for (const item of scopes) {
    const key = snapshotKey(storeId, item)
    snapshotGenerations.set(key, snapshotGeneration(storeId, item) + 1)
  }
}

/**
 * 同一店铺/分区的快照必须串行。Cookie 读取是异步的，定时快照、changed
 * 防抖、关闭和清理若同时运行，旧读取结果可能晚于新结果写回并覆盖登录态。
 * generation 还会让清理期间已经在途的写入失效。
 */
function enqueueSnapshot(storeId: string, scope: SnapshotScope, work: (shouldContinue: () => boolean) => Promise<number>): Promise<number> {
  const key = snapshotKey(storeId, scope)
  const generation = snapshotGeneration(storeId, scope)
  const previous = snapshotQueues.get(key) || Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(() => work(() => snapshotGeneration(storeId, scope) === generation))
  snapshotQueues.set(key, current)
  void current.finally(() => { if (snapshotQueues.get(key) === current) snapshotQueues.delete(key) }).catch(() => {})
  return current
}

export function snapshotStoreSession(storeId: string, existingSession?: Electron.Session): Promise<number> {
  return enqueueSnapshot(storeId, 'store', async shouldContinue => {
    const ses = existingSession || getActiveStoreSession(storeId)
    return ses && shouldContinue() ? snapshotSession(storeId, ses, 'store', 'store', shouldContinue) : 0
  })
}

/** 客服页面使用独立 partition；其会话级 Cookie 也必须独立快照，不能写入经营工作台。 */
export function snapshotCustomerServiceSession(storeId: string, existingSession?: Electron.Session): Promise<number> {
  return enqueueSnapshot(storeId, 'customer-service', async shouldContinue => {
    const ses = existingSession || getActiveCustomerServiceSession(storeId)
    return ses && shouldContinue() ? snapshotSession(storeId, ses, 'customer-service', 'customer-service', shouldContinue) : 0
  })
}

/**
 * 把快照灌回店铺分区。
 * @returns 恢复条数；无快照返回 0
 */
async function restoreSession(
  storeId: string,
  ses: Electron.Session,
  scope: 'store' | 'customer-service',
  label: string,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  const file = snapshotPath(storeId, scope)
  if (!existsSync(file)) return 0
  if (!safeStorage.isEncryptionAvailable()) return 0
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file)))
    const cookies: SessionCookieEntry[] = Array.isArray(parsed?.cookies) ? parsed.cookies : []
    let ok = 0
    for (const c of cookies) {
      if (!shouldContinue()) return 0
      try {
        // 与"导入会话包"同一套字段映射（url 由 domain+path 推出来，Electron 要求 url 合法）
        const url = `${c.secure ? 'https' : 'http'}://${String(c.domain).replace(/^\./, '')}${c.path || '/'}`
        // **保真域作用域**：带前导点的才是"域 Cookie"（对该域及其子域生效）；
        // 不带点的是 **host-only**（只对该主机生效，实测微信的登录凭据就是这种）。
        // 若一律把 domain 传进去，Electron/Chromium 会把 host-only 存成域 Cookie——
        // 作用域被悄悄放宽（凭据可能被发到子域），实测踩过。
        // 所以：host-only 时不传 domain，让 url 决定（Chromium 就存成 host-only）。
        const hostOnly = !String(c.domain).startsWith('.')
        await ses.cookies.set({
          url, name: c.name, value: c.value, path: c.path || '/',
          ...(hostOnly ? {} : { domain: c.domain }),
          secure: c.secure, httpOnly: c.httpOnly,
          expirationDate: undefined,
          sameSite: (c.sameSite as any) || undefined
        })
        ok++
      } catch { /* 单条失败不阻塞其余 */ }
    }
    if (ok) logMain('info', `会话已恢复 ${label}=${storeId} cookies=${ok}/${cookies.length}`)
    return ok
  } catch (e: any) {
    logMain('warn', `会话恢复失败 ${label}=${storeId}: ${String(e?.message || e).slice(0, 160)}`)
    return 0
  }
}

export async function restoreStoreSession(storeId: string): Promise<number> {
  return restoreSession(storeId, getStoreSession(storeId), 'store', 'store')
}

export async function restoreCustomerServiceSession(storeId: string): Promise<number> {
  // 店铺可能在客服工作区首次打开与惰性恢复之间被移入回收站；
  // 先确认仍是活动店铺，避免恢复函数为已删除店铺重新创建 partition。
  const storeExists = getDatabase().prepare('SELECT id FROM stores WHERE id = ? AND deleted_at IS NULL').get(storeId)
  if (!storeExists) return 0
  if (restoredCustomerServiceSessions.has(storeId)) return 0
  const file = snapshotPath(storeId, 'customer-service')
  if (!existsSync(file)) {
    restoredCustomerServiceSessions.add(storeId)
    return 0
  }
  if (!safeStorage.isEncryptionAvailable()) return 0
  // 可见客服页与隐藏监控可能在同一时间首次使用同一家店铺。没有这个
  // in-flight 复用时，两条路径会同时灌入旧快照，后完成的那次还可能覆盖
  // 用户刚完成的登录 Cookie。只有一次恢复完成后才把店铺标记为已恢复。
  const inFlight = restoringCustomerServiceSessions.get(storeId)
  if (inFlight) return inFlight
  const generation = customerServiceRestoreGeneration.get(storeId) || 0
  const shouldContinue = () => customerServiceRestoreGeneration.get(storeId) === generation
  const restoring = (async (): Promise<number> => {
    try {
      const customerSession = getCustomerServiceSession(storeId)
      // 第一次存在性检查与惰性创建之间仍可能发生删除；释放刚创建的 Session，
      // 不让一个已删除店铺重新进入客服快照追踪集合。
      const stillExists = getDatabase().prepare('SELECT id FROM stores WHERE id = ? AND deleted_at IS NULL').get(storeId)
      if (!stillExists) {
        closeCustomerServiceSession(storeId, { persist: false })
        return 0
      }
      const restored = await restoreSession(storeId, customerSession, 'customer-service', 'customer-service', shouldContinue)
      if (shouldContinue()) restoredCustomerServiceSessions.add(storeId)
      return shouldContinue() ? restored : 0
    } finally {
      restoringCustomerServiceSessions.delete(storeId)
    }
  })()
  restoringCustomerServiceSessions.set(storeId, restoring)
  return restoring
}

/**
 * 使客服快照恢复失效，并等待已经开始的灌入完成。
 * 清 Cookie/删除店铺前必须调用，避免旧快照在清理动作之后又把 Cookie 灌回来。
 */
export async function cancelCustomerServiceSessionRestore(storeId: string): Promise<void> {
  customerServiceRestoreGeneration.set(storeId, (customerServiceRestoreGeneration.get(storeId) || 0) + 1)
  restoredCustomerServiceSessions.delete(storeId)
  await restoringCustomerServiceSessions.get(storeId)
}

/** 同步使恢复失效，供同步 Session 关闭/快照删除路径使用。 */
function invalidateCustomerServiceSessionRestore(storeId: string): void {
  customerServiceRestoreGeneration.set(storeId, (customerServiceRestoreGeneration.get(storeId) || 0) + 1)
  restoredCustomerServiceSessions.delete(storeId)
}

/**
 * 删除会话快照。默认清理经营与客服两个独立分区；显式指定 scope 时只影响该分区。
 * 按域清理 Cookie 在无法重新加密快照时必须只删除经营快照，不能误删未请求清理的客服登录态。
 */
export function clearStoreSessionSnapshot(storeId: string, scope: SnapshotScope | 'all' = 'all'): void {
  if (scope !== 'store') invalidateCustomerServiceSessionRestore(storeId)
  invalidateSnapshotGeneration(storeId, scope === 'all' ? undefined : scope)
  // 两个分区彼此独立：一个文件被占用/权限异常时，不能阻止另一个范围清理。
  const scopes: SnapshotScope[] = scope === 'all' ? ['store', 'customer-service'] : [scope]
  for (const item of scopes) {
    try {
      const file = snapshotPath(storeId, item)
      if (existsSync(file)) rmSync(file, { force: true })
      if (existsSync(`${file}.tmp`)) rmSync(`${file}.tmp`, { force: true })
    } catch { /* 单个范围删不掉不影响另一个范围 */ }
  }
}

/** 清理客服分区快照而不影响经营工作台的会话快照。 */
export function clearCustomerServiceSessionSnapshot(storeId: string): void {
  clearStoreSessionSnapshot(storeId, 'customer-service')
}

// ---------- 生命周期编排 ----------

let snapshotTimer: NodeJS.Timeout | null = null
let wired = false
/** 当前需要定期快照的店铺（由 window-manager 在打开/关闭浏览器时登记/注销） */
const trackedStores = new Set<string>()
/** 客服页面独立登记；切换到经营工作台时不能注销，否则 Cookie 快照会停止。 */
const trackedCustomerServiceSessions = new Set<string>()
/** 每个客服分区只恢复一次；重复 prepare 不能把旧快照覆盖到用户刚完成的新登录。 */
const restoredCustomerServiceSessions = new Set<string>()
/** 同一客服分区的并发首次恢复共享 Promise，避免重复灌入旧 Cookie。 */
const restoringCustomerServiceSessions = new Map<string, Promise<number>>()
/** 清理/删除使正在进行的客服快照恢复失效，防止旧 Cookie 在清理后回灌。 */
const customerServiceRestoreGeneration = new Map<string, number>()

export function trackStoreSession(storeId: string): void { trackedStores.add(storeId) }
export function untrackStoreSession(storeId: string): void { trackedStores.delete(storeId) }
export function trackCustomerServiceSession(storeId: string): void { trackedCustomerServiceSessions.add(storeId) }
export function untrackCustomerServiceSession(storeId: string): void { trackedCustomerServiceSessions.delete(storeId) }

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
    // 客服分区按需恢复：启动时不能为每家店无条件创建客服 Session，
    // 否则用户从未打开客服页面也会被登记为客服运行时并触发后台追踪。
    // waitForCustomerServiceSessionReady() 在客服页面/监控真正使用时惰性恢复。
  }
  if (wired) return { restored }
  wired = true
  snapshotTimer = setInterval(() => { void snapshotAll('定时') }, 60_000)
  // 退出前快照：用 preventDefault 拦一次，等异步写盘完成再真退出。
  // 必须带超时兜底——快照若卡住（磁盘/杀软占用），用户会看到"点了退出却退不掉"。
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    if (!trackedStores.size && !trackedCustomerServiceSessions.size) return
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
  for (const id of Array.from(trackedCustomerServiceSessions)) {
    await snapshotCustomerServiceSession(id)
  }
}

export function stopSessionPersistence(): void {
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null }
}
