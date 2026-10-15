/**
 * 读**接口响应**的采集方式（`readApi` 步骤）。
 *
 * ## 为什么会有这个（它是 DOM 读表的补充，不是替代）
 *
 * 项目原本的采集模型是"打开页面 → 读表格"。2026-10-14 给微信小店做涉税报送时撞上一个新情况：
 * 页面**确实在请求数据**（`/shop-faas/mmchannelstradefunds/cgi/listQuarterTax` 返回 200、
 * 带着两个季度的结算额/退款额），但它是 `<micro-app>` 微前端，子应用在当前环境里
 * 只渲染出外壳（shadow 树 435 个元素、正文 0 字），**没有任何可读的表格结构**。
 * 数据只存在于响应体里 → 要么放弃这家平台，要么加一条"读响应"的路。
 *
 * ## 与读表相比，它**更脆、更需要诚实**（所以只在读表做不到时才用）
 *
 *  · 读表有表头文案兜底：平台改版时 `expectHeaders` 会**如实失败**，不会静默读错。
 *    接口没有这层——字段名改了就是取不到值，必须靠 `requireFields`（关键列必须有值）
 *    把"读到了但全是空"挡成失败，而不是当成"这家没数据"。
 *  · 接口没被调用（登录过期、功能未开通、页面没触发）就会超时。**超时不是"没有数据"**，
 *    必须分开报，否则界面上会显示成"这个季度是 0 元"。
 *  · 金额单位各家不同（实测微信小店是**分**）→ 单位靠 `as` 显式声明，不靠猜。
 *
 * 只读：只 attach debugger、Network.enable、必要时 reload 让页面自己重新发一次请求，
 * 然后把响应体读出来解析。**不构造/不重放任何请求，不改页面数据。**
 */

import type { WebContents } from 'electron'

/** 一个字段怎么从响应 JSON 里取出来、怎么变成界面上的文本 */
export interface ApiFieldSpec {
  /** 统一列 key（与 TAX_COLUMNS / 表格 headerMap 用的是同一套 key） */
  key: string
  /** 在**每一行对象**里的字段名（支持 `a.b` 取嵌套） */
  path: string
  /** 取值方式：`text` 原样（默认）/ `cents` 分转元 / `epochQuarter` 秒级时间戳 → 报送季度 */
  as?: 'text' | 'cents' | 'epochQuarter'
}

export interface ApiReadOptions {
  /** 响应 URL 必须包含它（够窄，避免抓到同名的别的接口） */
  urlMarker: string
  /** 行数组在响应 JSON 里的路径（如 `dataList`；空串 = 响应本身就是数组） */
  rowsPath: string
  fields: ApiFieldSpec[]
  /** 等多久（毫秒）。超时按"没抓到"如实返回，不当成"没有数据" */
  timeoutMs: number
  /** 抓之前是否 reload 一次页面（页面自己发请求；不 reload 就可能错过已发生的那次） */
  reload: boolean
  /** 响应体上限，超过就如实放弃（避免把超大响应读进内存） */
  maxBytes: number
  /**
   * 关键列：一次页面加载里同一接口可能被请求多次，**不是每次都带全字段**
   * （实测微信小店 getShopProfile 只有其中一次带 licenseInfo）。
   * 给了它就挑"这些列都有值"的那次响应；都没有就用最后一条，让上层如实失败。
   */
  requireFields?: readonly string[]
}

export interface ApiReadResult {
  ok: boolean
  /** 失败原因（ok=false 时给界面看的一句话） */
  why?: string
  /** 合成表头 = 字段 key，行 0 用它占位，这样下游的按列序映射一行都不用改 */
  rows: string[][]
  /** 命中的那个请求的 URL（留痕，出问题时能看出读的是哪次请求） */
  requestUrl?: string
  /** 抓到的原始对象行（`scalars` 用它写单值快照；主体信息这种就是一条） */
  rawRows?: unknown[]
  /**
   * 每次抓到的响应的**体检结果**（URL / 字节数 / 顶层字段 / 是否满足关键列）。
   *
   * 为什么留它：同一接口一次加载会被请求多次，而**不是每次都带全字段**。字段映射"看起来对、
   * 跑起来全空"时，光看报错分不清是"路径写错了"还是"抓到的是另一次响应"——
   * 有这份清单就能一眼看出来（2026-10-14 微信小店主体信息就是卡在这里）。
   */
  candidates?: Array<{ url: string; bytes: number; topKeys: string[]; satisfied: boolean }>
  /** 抓到响应但行数为 0（如 code!=0、或该季度还没生成）——与"没抓到"是两件事 */
  emptyButCaptured?: boolean
}

/** int64 在 JSON 里常被拆成 {low, high}（实测微信小店就是）——按无符号拼回来 */
function readInt64(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (value && typeof value === 'object') {
    const low = (value as { low?: unknown }).low
    const high = (value as { high?: unknown }).high
    if (typeof low === 'number') return low + (typeof high === 'number' ? high * 0x1_0000_0000 : 0)
  }
  return null
}

/** 按 `a.b` 取嵌套字段；路径上碰到数组就返回 undefined（一行里不该再套数组） */
function readPath(row: unknown, path: string): unknown {
  if (!path) return row
  let cur: unknown = row
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** 金额两位小数 + 千分位。**取不到就返回空串**（下游按"没读到"处理，不是 0） */
function formatYuan(cents: number): string {
  const yuan = cents / 100
  return `¥${yuan.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

/**
 * 秒级时间戳 → 报送季度文本，形如 `2026年第三季度(7-9月)`。
 *
 * 为什么要转成这个形状：抖店那页的「报送数据时间」就是 `2026年第三季度(7-9月)`，
 * 两家用同一种写法，按主体统计里的"期间范围"（按文本比较取最早/最新）才排得对。
 * 时间戳是**季度末**（实测微信小店 2026-06-30 / 2026-09-30）→ 落到对应的那个季度。
 */
export function epochToQuarterText(seconds: number): string {
  const d = new Date(seconds * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const year = d.getFullYear()
  const quarter = Math.floor(d.getMonth() / 3) + 1
  const startMonth = (quarter - 1) * 3 + 1
  return `${year}年第${['一', '二', '三', '四'][quarter - 1]}季度(${startMonth}-${startMonth + 2}月)`
}

function toCell(value: unknown, as: ApiFieldSpec['as']): string {
  if (value == null) return ''
  switch (as) {
    case 'cents': {
      const n = readInt64(value)
      return n == null ? '' : formatYuan(n)
    }
    case 'epochQuarter': {
      const n = readInt64(value)
      return n == null ? '' : epochToQuarterText(n)
    }
    default:
      return typeof value === 'object' ? '' : String(value)
  }
}

/**
 * 从响应里取**单值**（`metricKey → 取值路径`），供"一条记录就是全部内容"的接口用。
 *
 * 为什么单独给这个：主体信息这类接口返回的是一条对象（不是列表），而下游的
 * 「主体信息采集」读的是 `entity.name` / `entity.no` 两个**标量**快照——
 * 用 scalars 就能直接接上，不必为它改一条新的数据通路。
 */
export function readScalarValues(rawRows: unknown[], scalars: Record<string, string>): Record<string, string> {
  const row = Array.isArray(rawRows) ? rawRows[0] : null
  const out: Record<string, string> = {}
  if (!row) return out
  for (const [metric, path] of Object.entries(scalars)) {
    out[metric] = toCell(readPath(row, path), 'text')
  }
  return out
}

interface DebuggerLike {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void
  /** 精确摘除自己的监听器。**不要**用 removeAllListeners——同一 debugger 上还有别人的订阅
   *  （如 network-observer 的 onMessage，2026-10-15 审查发现会被它一并摘掉）。 */
  removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void
}

/**
 * 抓一次接口响应并转成**与读表同构的行**。
 *
 * 返回的 `rows[0]` 是字段 key（合成表头），`rows[1..]` 是数据 —— 这样档案里
 * `columns: [...字段key]` 的按列序映射原样生效，主进程的 mapSection、快照、界面都不用知道
 * "这次数据是从接口来的还是从表格来的"。
 */
export async function readApiResponse(wc: WebContents, options: ApiReadOptions): Promise<ApiReadResult> {
  if (wc.isDestroyed()) return { ok: false, why: '店铺窗口已关闭，读不到接口响应', rows: [] }
  const dbg = wc.debugger as unknown as DebuggerLike
  let attachedByUs = false
  let enabledByUs = false
  /** 我们自己注册的 message 监听器；清理时**精确摘除**，不碰同一 debugger 上别人的订阅。 */
  let onMessage: ((event: unknown, method: string, params: unknown) => void) | null = null

  const cleanup = async (): Promise<void> => {
    /**
     * `Network.disable` 只在"会话是我们自己挂的、Network 也是我们开的"时才发。
     *
     * 为什么（2026-10-15 审查发现）：调试器是**别的模块先挂**的时（network-observer 观察订单/指标、
     * fingerprint-injector 的常驻会话），`enabledByUs` 只是"我们的 enable 命令成功"——
     * 此时 Network 可能是别人正在用的，我们 disable 掉会把它们的事件流**静默掐断**。
     * 与 network-observer 自己的纪律一致（`enabledByObserver && attachedByObserver` 才 disable）。
     */
    try { if (enabledByUs && attachedByUs) await dbg.sendCommand('Network.disable') } catch { /* 窗口可能已关 */ }
    try { if (onMessage) dbg.removeListener('message', onMessage) } catch { /* 同上 */ }
    try { if (attachedByUs && dbg.isAttached()) dbg.detach() } catch { /* 同上 */ }
  }

  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedByUs = true
    }
    await dbg.sendCommand('Network.enable')
    enabledByUs = true

    /**
     * 收集**所有**匹配的响应，而不是取第一个。
     *
     * 为什么（2026-10-14 踩到）：同一个接口一次页面加载会被请求多次，而**不是每次都带全字段**
     * （实测微信小店 getShopProfile：刷新时先后发了多次，只有其中一次带 licenseInfo）。
     * 取第一个的写法会稳定地挑到空的那次，然后报"字段映射失效"——而映射其实是对的。
     * 所以按 `requireFields` 挑：谁的关键列有值就用谁；都没有就用最后一条，让上层如实失败。
     */
    const matches: Array<{ requestId: string; url: string }> = []
    /** 已收到 `Network.loadingFinished` 的请求：正文收完再读，避免"请求没完成"被误跳过 */
    const finishedRequests = new Set<string>()
    let waiters: Array<() => void> = []
    const notify = (): void => { const list = waiters; waiters = []; for (const fn of list) fn() }
    onMessage = (_event, method, params) => {
      if (method === 'Network.loadingFinished') {
        const requestId = (params as { requestId?: string } | null)?.requestId
        if (requestId) { finishedRequests.add(requestId); notify() }
        return
      }
      if (method !== 'Network.responseReceived') return
      const p = params as { requestId?: string; response?: { url?: string } }
      const url = p?.response?.url || ''
      if (!url.includes(options.urlMarker)) return
      matches.push({ requestId: p.requestId || '', url })
      notify()
    }
    dbg.on('message', onMessage)

    /**
     * 等这个请求的响应体收完再读正文。
     *
     * 为什么（2026-10-15 审查发现）：对 `responseReceived` 立刻 `getResponseBody` 时，
     * 大/慢响应会因"请求未完成"抛错而被当成"这条读不了"跳过——最坏情况把唯一一条可用的响应跳过、
     * 误报成"没抓到"。这里等有界预算（没等到也继续尝试，不无限阻塞）。
     */
    const waitForFinished = async (requestId: string, budgetMs: number): Promise<void> => {
      if (!requestId || finishedRequests.has(requestId)) return
      const budgetDeadline = Date.now() + budgetMs
      while (!finishedRequests.has(requestId) && Date.now() < budgetDeadline) {
        const remaining = budgetDeadline - Date.now()
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(remaining, 300))
          waiters.push(() => { clearTimeout(timer); resolve() })
        })
      }
    }

    // 页面**自己**发这次请求；我们只是把它引出来（不构造、不重放）
    if (options.reload) {
      try { wc.reload() } catch { /* 窗口可能正在导航 */ }
    }

    /** 这份响应里，requireFields 的每一列是否都有值（没给 requireFields 就算通过） */
    const satisfies = (parsed: unknown): boolean => {
      const required = options.requireFields
      if (!required?.length) return true
      const raw = options.rowsPath ? readPath(parsed, options.rowsPath) : parsed
      const container = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : null)
      if (!container?.length) return false
      return container.every(item => required.every(key => {
        const field = options.fields.find(f => f.key === key)
        return field ? toCell(readPath(item, field.path), field.as) !== '' : true
      }))
    }

    const deadline = Date.now() + options.timeoutMs
    let seen = 0
    let chosen: { url: string; parsed: unknown } | null = null
    let lastCandidate: { url: string; parsed: unknown } | null = null
    const candidates: Array<{ url: string; bytes: number; topKeys: string[]; satisfied: boolean }> = []
    while (Date.now() < deadline) {
      if (seen >= matches.length) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        // 有新响应就立刻醒，没新的就等到超时（或 1.5 秒后再看一次）
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(remaining, 1500))
          waiters.push(() => { clearTimeout(timer); resolve() })
        })
        if (seen >= matches.length) continue
      }
      const match = matches[seen++]
      await waitForFinished(match.requestId, 4000)
      let body = ''
      try {
        const bodyResult = await dbg.sendCommand('Network.getResponseBody', { requestId: match.requestId }) as
          { body?: string; base64Encoded?: boolean }
        if (typeof bodyResult?.body !== 'string') continue
        body = bodyResult.base64Encoded === true
          ? Buffer.from(bodyResult.body, 'base64').toString('utf8')
          : bodyResult.body
      } catch { continue }   // 请求被取消/正文已淘汰：换下一条
      const bytes = Buffer.byteLength(body, 'utf8')
      if (bytes > options.maxBytes) continue
      let parsed: unknown
      try { parsed = JSON.parse(body) } catch { continue }
      const satisfied = satisfies(parsed)
      candidates.push({
        url: match.url,
        bytes,
        topKeys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed as object).slice(0, 16) : [],
        satisfied
      })
      lastCandidate = { url: match.url, parsed }
      if (satisfied) { chosen = lastCandidate; break }
    }

    if (!chosen && !lastCandidate) {
      return {
        ok: false,
        why: matches.length
          ? `抓到 ${matches.length} 次含「${options.urlMarker}」的响应，但没有一次能读出内容`
          : `等了 ${Math.round(options.timeoutMs / 1000)} 秒没抓到含「${options.urlMarker}」的响应——可能是登录过期、该功能未开通，或页面没触发这次请求（这不等于"没有数据"）`,
        rows: [],
        candidates
      }
    }
    // 没有一条满足关键列时，用最后一条：上层会按 requireFields 如实报"字段映射可能失效"，
    // 而不是把空值当成"这家没有数据"（这才是诚实的行为）
    const { url: matchedUrl, parsed } = (chosen || lastCandidate) as { url: string; parsed: unknown }

    const raw = options.rowsPath ? readPath(parsed, options.rowsPath) : parsed
    /**
     * 行数组**或者单个对象**都收：主体信息这类接口返回的就是一条对象
     * （实测微信小店 getShopProfile：整条响应里主体信息只有一个）。
     * 不是数组也不是对象（null / 数字 / 字符串）才算"结构变了"。
     */
    const container = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : null)
    if (!container) {
      return {
        ok: false,
        why: `响应里没有 ${options.rowsPath || '(根)'} 数组/对象（平台可能改了返回结构）`,
        rows: [],
        requestUrl: matchedUrl
      }
    }

    const headers = options.fields.map(f => f.key)
    const rows: string[][] = [headers]
    for (const item of container) {
      rows.push(options.fields.map(f => toCell(readPath(item, f.path), f.as)))
    }
    return { ok: true, rows, requestUrl: matchedUrl, emptyButCaptured: container.length === 0, rawRows: container, candidates }
  } catch (error) {
    return { ok: false, why: `读接口响应失败：${(error as Error)?.message || String(error)}`, rows: [] }
  } finally {
    await cleanup()
  }
}
