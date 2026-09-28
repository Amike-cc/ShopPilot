import type {
  ObservationArrayShape,
  ObservationFieldType,
  PddOrderObservationFieldStructure,
  PddOrderObservationReport,
  PddOrderObservationResponse
} from '@shared/contracts/pdd-order-observation'
import type { PlatformAdapterContext } from '../platform-adapters/platform-adapter'
import { safeUrlPattern, type NetworkObservationResult, type NetworkResponseObservation } from './network-observer'

function safeFieldStructure(value: unknown): PddOrderObservationFieldStructure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<PddOrderObservationFieldStructure>
  if (!['JSON', 'INVALID_JSON', 'TRUNCATED'].includes(String(candidate.parseStatus))) return null
  const sensitiveField = /(token|cookie|authorization|auth|session|password|secret|credential|phone|mobile|telephone|tel|address|idcard|identity|email|buyer|recipient|receiver|name|姓名|手机|电话|地址|身份证|收货|认证|密码|令牌)/i
  const safePath = (path: string): string => path.split('.').map(segment => {
    const suffix = segment.endsWith('[]') ? '[]' : ''
    const key = suffix ? segment.slice(0, -2) : segment
    if (/^\d+$/.test(key) || key.length > 48) return ':id' + suffix
    return sensitiveField.test(key) ? '[REDACTED]' + suffix : key.slice(0, 80) + suffix
  }).join('.')
  const arrays = Array.isArray(candidate.arrays) ? candidate.arrays.filter(item => {
    if (!item || typeof item !== 'object') return false
    const entry = item as Partial<ObservationArrayShape>
    return typeof entry.path === 'string' && Number.isFinite(entry.length) && typeof entry.itemType === 'string'
  }).map(item => ({
    path: safePath(String((item as ObservationArrayShape).path)),
    length: Number((item as ObservationArrayShape).length),
    itemType: (['null', 'boolean', 'number', 'string', 'object', 'array', 'unknown'] as const).includes((item as ObservationArrayShape).itemType)
      ? (item as ObservationArrayShape).itemType
      : 'unknown'
  })).slice(0, 100) as ObservationArrayShape[] : []
  const fieldTypes = Array.isArray(candidate.fieldTypes) ? candidate.fieldTypes.filter(item => {
    if (!item || typeof item !== 'object') return false
    const entry = item as Partial<ObservationFieldType>
    return typeof entry.path === 'string' && typeof entry.type === 'string'
  }).map(item => ({
    path: safePath(String((item as ObservationFieldType).path)),
    type: (['null', 'boolean', 'number', 'string', 'object', 'array', 'unknown'] as const).includes((item as ObservationFieldType).type)
      ? (item as ObservationFieldType).type
      : 'unknown'
  })).slice(0, 200) as ObservationFieldType[] : []
  const list = (input: unknown, limit: number): string[] => Array.isArray(input)
    ? input.filter(item => typeof item === 'string').map(item => safePath(item as string)).slice(0, limit) as string[]
    : []
  return {
    parseStatus: candidate.parseStatus as PddOrderObservationFieldStructure['parseStatus'],
    topLevelKeys: list(candidate.topLevelKeys, 80),
    nestedKeys: list(candidate.nestedKeys, 200),
    arrays,
    fieldTypes,
    suspectedFields: list(candidate.suspectedFields, 30),
    candidate: candidate.candidate === true,
    confidence: candidate.confidence === 'medium' || candidate.confidence === 'high' ? candidate.confidence : 'low',
    redactedFieldCount: Number.isFinite(candidate.redactedFieldCount) ? Number(candidate.redactedFieldCount) : 0
  }
}

function responseSummary(response: NetworkResponseObservation): PddOrderObservationResponse {
  return {
    urlPattern: response.urlPattern,
    method: response.method,
    resourceType: response.resourceType,
    statusCode: response.statusCode,
    contentType: response.contentType,
    contentLength: response.contentLength,
    responseTimeMs: response.responseTimeMs,
    isJson: response.isJson,
    body: safeFieldStructure(response.body)
  }
}

/** 把 Main 内部观察结果转换成可安全展示的 PDD_ORDER_OBSERVATION_REPORT。 */
export function buildPddOrderObservationReport(
  context: Pick<PlatformAdapterContext, 'storeId' | 'currentUrl'>,
  result: NetworkObservationResult
): PddOrderObservationReport {
  const responses = result.observations.slice(0, 200).map(responseSummary)
  const fieldStructures = responses
    .filter(response => response.body != null)
    .map(response => ({ urlPattern: response.urlPattern, structure: response.body! }))
  return {
    reportType: 'PDD_ORDER_OBSERVATION_REPORT',
    storeId: context.storeId,
    platform: '拼多多',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    pageUrl: safeUrlPattern(context.currentUrl),
    requestCount: result.requestCount,
    jsonResponseCount: result.jsonResponseCount,
    candidateOrderInterfaceCount: result.candidateOrderInterfaceCount,
    responses,
    fieldStructures,
    reasonCode: result.reasonCode,
    safeMessage: '已生成脱敏网络结构报告；candidate 仅供人工确认，不代表已识别订单接口'
  }
}
