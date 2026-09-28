import type { WebContents } from 'electron'
import type {
  ObservationConfidence,
  ObservationParseStatus,
  ObservationValueType,
  ObservationArrayShape,
  ObservationFieldType,
  PddOrderObservationFieldStructure
} from '@shared/contracts/pdd-order-observation'

/** Main 内部的请求/响应结构摘要；不会包含响应正文。 */
export interface NetworkResponseObservation {
  urlPattern: string
  method: string
  statusCode: number
  contentType: string
  resourceType: string | null
  contentLength: number | null
  responseTimeMs: number | null
  isJson: boolean
  body: PddOrderObservationFieldStructure | null
}

export interface NetworkObservationOptions {
  /** 自动停止上限；start/observe 都必须是有界操作。 */
  timeoutMs: number
  maxResponses?: number
  maxBodyBytes?: number
  /** Main 内部回调，绝不通过 IPC 传递。 */
  onComplete?: (result: NetworkObservationResult) => void
}

export interface NetworkObservationResult {
  startedAt: number
  finishedAt: number
  requestCount: number
  jsonResponseCount: number
  candidateOrderInterfaceCount: number
  observations: NetworkResponseObservation[]
  reasonCode: 'NETWORK_OBSERVED' | 'NETWORK_OBSERVER_UNAVAILABLE' | 'NETWORK_OBSERVER_TIMEOUT'
}

export interface NetworkObserver {
  observe(options: NetworkObservationOptions): Promise<NetworkObservationResult>
  start?(options: NetworkObservationOptions): Promise<void>
  stop?(): Promise<NetworkObservationResult>
  isRunning?(): boolean
}

interface DebuggerApi {
  isAttached(): boolean
  attach(version: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'message', listener: (...args: unknown[]) => void): void
  removeListener(event: 'message', listener: (...args: unknown[]) => void): void
}

interface RequestMetadata {
  method: string
  urlPattern: string
  startedAtMonotonic: number | null
}

interface MutableObservation extends NetworkResponseObservation {
  requestId: string
  receivedAt: number
  startedAtMonotonic: number | null
}

interface ActiveObservation {
  startedAt: number
  options: Required<Pick<NetworkObservationOptions, 'timeoutMs' | 'maxResponses' | 'maxBodyBytes'>>
  debuggerApi: DebuggerApi
  attachedByObserver: boolean
  enabledByObserver: boolean
  listening: boolean
  observations: MutableObservation[]
  pendingByRequest: Map<string, MutableObservation>
  requestMetadata: Map<string, RequestMetadata>
  bodyJobs: Promise<void>[]
  requestCount: number
  jsonResponseCount: number
  bodyCandidateCount: number
  onMessage: (...args: unknown[]) => void
  timer: ReturnType<typeof setTimeout> | null
  completion: Promise<NetworkObservationResult>
  resolveCompletion: (result: NetworkObservationResult) => void
  finalizePromise: Promise<NetworkObservationResult> | null
  onComplete?: (result: NetworkObservationResult) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function asNullableNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function isJsonMime(mimeType: string): boolean {
  const mime = mimeType.toLowerCase()
  return mime.includes('json') || mime.includes('javascript')
}

/** URL 只保留 host 和脱敏后的 path，永远移除 query/hash，避免把 token 等参数带入报告。 */
export function safeUrlPattern(urlText: string): string {
  try {
    const url = new URL(urlText)
    const path = url.pathname.split('/').filter(Boolean).map(segment => {
      if (/token|auth|session|cookie|secret|credential|password/i.test(segment) || /@/.test(segment) || /^\+?\d{7,}$/.test(segment)) return ':redacted'
      if (/^\d+$/.test(segment) || /^[a-f0-9-]{16,}$/i.test(segment) || /^[a-z0-9_-]{20,}$/i.test(segment) || segment.length > 48) return ':id'
      return segment.replace(/[^a-z0-9_.-]/gi, '').slice(0, 48) || ':segment'
    }).join('/')
    return `${url.protocol}//${url.hostname.toLowerCase()}${path ? `/${path}` : '/'}`
  } catch {
    return 'unknown:///'
  }
}

function responseContentLength(response: Record<string, unknown>): number | null {
  const headers = isRecord(response.headers) ? response.headers : null
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'content-length') {
        const length = asNullableNumber(value)
        if (length != null) return length
      }
    }
  }
  return asNullableNumber(response.encodedDataLength)
}

const SENSITIVE_KEY_RE = /(token|cookie|authorization|auth|session|password|secret|credential|phone|mobile|telephone|tel|address|idcard|identity|email|buyer|recipient|receiver|name|姓名|手机|电话|地址|身份证|收货|认证|密码|令牌)/i
const SENSITIVE_KEY_EXACT_RE = /^(token|cookie|authorization|auth|session|password|secret|credential|phone|mobile|telephone|tel|address|idcard|identity|email|buyer|recipient|receiver|name|姓名|手机|电话|地址|身份证|收货|认证|密码|令牌)$/i
const SUSPICIOUS_FIELD_RE = /(order|订单|status|状态|amount|金额|price|价格|item|商品|sku|支付|付款|发货|退款|refund|created|create|time|时间)/i

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_EXACT_RE.test(key) || SENSITIVE_KEY_RE.test(key)
}

function valueType(value: unknown): ObservationValueType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'boolean': return 'boolean'
    case 'number': return 'number'
    case 'string': return 'string'
    case 'object': return 'object'
    default: return 'unknown'
  }
}

function emptyStructure(parseStatus: ObservationParseStatus, redactedFieldCount = 0): PddOrderObservationFieldStructure {
  return {
    parseStatus,
    topLevelKeys: [],
    nestedKeys: [],
    arrays: [],
    fieldTypes: [],
    suspectedFields: [],
    candidate: false,
    confidence: 'low',
    redactedFieldCount
  }
}

function analyzeJsonBody(body: string, maxNodes = 1000): PddOrderObservationFieldStructure {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return emptyStructure('INVALID_JSON')
  }

  const topLevelKeys: string[] = []
  const nestedKeys: string[] = []
  const arrays: ObservationArrayShape[] = []
  const fieldTypes: ObservationFieldType[] = []
  const suspectedFields = new Set<string>()
  let redactedFieldCount = 0
  let nodes = 0

  const addUnique = (list: string[], value: string, limit: number): void => {
    if (list.length < limit && !list.includes(value)) list.push(value)
  }

  const walk = (value: unknown, path: string, depth: number): void => {
    if (nodes++ >= maxNodes || depth > 5) return
    const type = valueType(value)
    if (path !== '$' && fieldTypes.length < 200 && !fieldTypes.some(item => item.path === path)) {
      fieldTypes.push({ path, type })
    }

    if (Array.isArray(value)) {
      const itemType = value.length ? valueType(value[0]) : 'unknown'
      if (arrays.length < 100) arrays.push({ path, length: value.length, itemType })
      for (const item of value.slice(0, 3)) walk(item, `${path}[]`, depth + 1)
      return
    }
    if (!isRecord(value)) return

    const entries = Object.entries(value).slice(0, 80)
    for (const [key, child] of entries) {
      if (isSensitiveKey(key)) {
        redactedFieldCount++
        continue
      }
      const safeKey = key.replace(/[^a-z0-9_.-\u4e00-\u9fff]/gi, '').slice(0, 48) || ':field'
      const childPath = path === '$' ? safeKey : `${path}.${safeKey}`
      if (path === '$') addUnique(topLevelKeys, safeKey, 80)
      else addUnique(nestedKeys, childPath, 200)
      if (SUSPICIOUS_FIELD_RE.test(key)) suspectedFields.add(safeKey)
      walk(child, childPath, depth + 1)
    }
  }

  walk(parsed, '$', 0)
  const recordArrayCount = arrays.filter(item => item.itemType === 'object').length
  // candidate 只表示「值得人工查看的结构」，不表示订单接口；单个 order 字段不会触发候选。
  const candidate = recordArrayCount > 0 && suspectedFields.size >= 2
  const confidence: ObservationConfidence = candidate && suspectedFields.size >= 4 ? 'medium' : 'low'
  return {
    parseStatus: 'JSON',
    topLevelKeys,
    nestedKeys,
    arrays,
    fieldTypes,
    suspectedFields: [...suspectedFields].slice(0, 30),
    candidate,
    confidence,
    redactedFieldCount
  }
}

function parseBody(body: string, maxBodyBytes: number): PddOrderObservationFieldStructure {
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > maxBodyBytes) return emptyStructure('TRUNCATED')
  return analyzeJsonBody(body)
}

function emptyResult(reasonCode: NetworkObservationResult['reasonCode']): NetworkObservationResult {
  const now = Date.now()
  return {
    startedAt: now,
    finishedAt: now,
    requestCount: 0,
    jsonResponseCount: 0,
    candidateOrderInterfaceCount: 0,
    observations: [],
    reasonCode
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('NETWORK_OBSERVER_TIMEOUT')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 基于当前店铺 WebContents 的只读 CDP Network 观察器。
 *
 * start/stop 用于人工数据源发现；observe 是有界的兼容调用。两种入口都只保留
 * 请求/响应元数据和 JSON 结构摘要，正文在 Main 内分析后立即丢弃。
 */
export class ElectronNetworkObserver implements NetworkObserver {
  private active: ActiveObservation | null = null
  private lastResult: NetworkObservationResult | null = null

  constructor(private readonly webContents: WebContents) {}

  isRunning(): boolean { return this.active !== null }

  async observe(options: NetworkObservationOptions): Promise<NetworkObservationResult> {
    await this.start(options)
    const active = this.active
    return active?.completion || this.lastResult || emptyResult('NETWORK_OBSERVER_UNAVAILABLE')
  }

  async start(options: NetworkObservationOptions): Promise<void> {
    if (this.active) throw new Error('OBSERVATION_ALREADY_RUNNING')
    if (this.webContents.isDestroyed()) throw new Error('NETWORK_OBSERVER_UNAVAILABLE')

    const normalized = {
      timeoutMs: Math.max(1000, Math.min(Math.floor(options.timeoutMs || 60000), 300000)),
      maxResponses: Math.max(1, Math.min(Math.floor(options.maxResponses || 200), 500)),
      maxBodyBytes: Math.max(16 * 1024, Math.min(Math.floor(options.maxBodyBytes || 512 * 1024), 2 * 1024 * 1024))
    }
    let resolveCompletion!: (result: NetworkObservationResult) => void
    const active: ActiveObservation = {
      startedAt: Date.now(),
      options: normalized,
      debuggerApi: this.webContents.debugger as unknown as DebuggerApi,
      attachedByObserver: false,
      enabledByObserver: false,
      listening: false,
      observations: [],
      pendingByRequest: new Map(),
      requestMetadata: new Map(),
      bodyJobs: [],
      requestCount: 0,
      jsonResponseCount: 0,
      bodyCandidateCount: 0,
      onMessage: () => undefined,
      timer: null,
      completion: new Promise(resolve => { resolveCompletion = resolve }),
      resolveCompletion,
      finalizePromise: null,
      onComplete: options.onComplete
    }
    this.active = active

    const readResponseBody = (observation: MutableObservation): void => {
      const job = (async () => {
        try {
          const bodyResult = await withTimeout(
            active.debuggerApi.sendCommand('Network.getResponseBody', { requestId: observation.requestId }),
            Math.min(5000, active.options.timeoutMs)
          )
          if (!isRecord(bodyResult) || typeof bodyResult.body !== 'string') return
          const decoded = bodyResult.base64Encoded === true
            ? Buffer.from(bodyResult.body, 'base64').toString('utf8')
            : bodyResult.body
          observation.body = parseBody(decoded, active.options.maxBodyBytes)
          if (observation.body.candidate) active.bodyCandidateCount++
        } catch {
          // 页面导航或请求取消时可能无法读取正文；元数据仍然保留。
        }
      })()
      active.bodyJobs.push(job)
    }

    active.onMessage = (...args: unknown[]): void => {
      const method = asString(args[1])
      const params = isRecord(args[2]) ? args[2] : null
      const requestId = asString(params?.requestId)
      if (!requestId) return

      if (method === 'Network.requestWillBeSent') {
        active.requestCount++
        if (active.requestMetadata.size < active.options.maxResponses * 4) {
          const request = params && isRecord(params.request) ? params.request : null
          active.requestMetadata.set(requestId, {
            method: asString(request?.method).toUpperCase() || 'UNKNOWN',
            urlPattern: safeUrlPattern(asString(request?.url)),
            startedAtMonotonic: asNullableNumber(params?.timestamp)
          })
        }
        return
      }

      if (method === 'Network.responseReceived') {
        if (active.observations.length >= active.options.maxResponses) return
        const response = params && isRecord(params.response) ? params.response : null
        if (!response) return
        const contentType = asString(response.mimeType)
        const isJson = isJsonMime(contentType)
        const request = active.requestMetadata.get(requestId)
        const observation: MutableObservation = {
          requestId,
          urlPattern: request?.urlPattern || safeUrlPattern(asString(response.url)),
          method: request?.method || 'UNKNOWN',
          statusCode: asNumber(response.status),
          contentType,
          resourceType: asString(params?.type) || null,
          contentLength: responseContentLength(response),
          responseTimeMs: null,
          isJson,
          body: null,
          receivedAt: Date.now(),
          startedAtMonotonic: request?.startedAtMonotonic || asNullableNumber(params?.timestamp)
        }
        active.observations.push(observation)
        if (isJson) active.jsonResponseCount++
        active.pendingByRequest.set(requestId, observation)
        return
      }

      if (method === 'Network.loadingFinished') {
        const observation = active.pendingByRequest.get(requestId)
        if (!observation) return
        active.pendingByRequest.delete(requestId)
        const finishedAtMonotonic = asNullableNumber(params?.timestamp)
        if (finishedAtMonotonic != null && observation.startedAtMonotonic != null) {
          observation.responseTimeMs = Math.max(0, Math.round((finishedAtMonotonic - observation.startedAtMonotonic) * 1000))
        } else {
          observation.responseTimeMs = Math.max(0, Date.now() - observation.receivedAt)
        }
        const encodedLength = asNullableNumber(params?.encodedDataLength)
        if (observation.contentLength == null && encodedLength != null) observation.contentLength = encodedLength
        if (observation.isJson) readResponseBody(observation)
        return
      }

      if (method === 'Network.loadingFailed') {
        const observation = active.pendingByRequest.get(requestId)
        if (observation) observation.responseTimeMs = Math.max(0, Date.now() - observation.receivedAt)
        active.pendingByRequest.delete(requestId)
      }
    }

    try {
      let alreadyAttached = false
      try { alreadyAttached = active.debuggerApi.isAttached() } catch { alreadyAttached = false }
      if (!alreadyAttached) {
        active.debuggerApi.attach('1.3')
        active.attachedByObserver = true
      }
      active.debuggerApi.on('message', active.onMessage)
      active.listening = true
      await withTimeout(active.debuggerApi.sendCommand('Network.enable'), Math.min(5000, normalized.timeoutMs))
      active.enabledByObserver = true
      active.timer = setTimeout(() => { void this.stop().catch(() => undefined) }, normalized.timeoutMs)
    } catch {
      await this.finalize(active, 'NETWORK_OBSERVER_UNAVAILABLE')
      throw new Error('NETWORK_OBSERVER_UNAVAILABLE')
    }
  }

  async stop(): Promise<NetworkObservationResult> {
    const active = this.active
    if (!active) return this.lastResult || emptyResult('NETWORK_OBSERVER_UNAVAILABLE')
    return this.finalize(active)
  }

  private async finalize(active: ActiveObservation, forcedReason?: NetworkObservationResult['reasonCode']): Promise<NetworkObservationResult> {
    if (active.finalizePromise) return active.finalizePromise
    active.finalizePromise = (async () => {
      if (active.timer) clearTimeout(active.timer)
      active.timer = null
      for (const observation of active.pendingByRequest.values()) {
        if (observation.responseTimeMs == null) observation.responseTimeMs = Math.max(0, Date.now() - observation.receivedAt)
      }
      active.pendingByRequest.clear()

      if (active.listening) {
        try { active.debuggerApi.removeListener('message', active.onMessage) } catch { /* 页面关闭时忽略 */ }
        active.listening = false
      }
      await Promise.allSettled(active.bodyJobs)

      if (active.enabledByObserver && active.attachedByObserver) {
        try { await withTimeout(active.debuggerApi.sendCommand('Network.disable'), 1000) } catch { /* ignore */ }
      }
      if (active.attachedByObserver) {
        try { active.debuggerApi.detach() } catch { /* ignore */ }
      }

      const result: NetworkObservationResult = {
        startedAt: active.startedAt,
        finishedAt: Date.now(),
        requestCount: active.requestCount,
        jsonResponseCount: active.jsonResponseCount,
        candidateOrderInterfaceCount: active.bodyCandidateCount,
        observations: active.observations.map(({ requestId: _requestId, receivedAt: _receivedAt, startedAtMonotonic: _startedAtMonotonic, ...safe }) => safe),
        reasonCode: forcedReason || (active.observations.length ? 'NETWORK_OBSERVED' : 'NETWORK_OBSERVER_TIMEOUT')
      }
      this.lastResult = result
      if (this.active === active) this.active = null
      active.resolveCompletion(result)
      try { active.onComplete?.(result) } catch { /* 观察回调不能影响清理 */ }
      return result
    })()
    return active.finalizePromise
  }
}
