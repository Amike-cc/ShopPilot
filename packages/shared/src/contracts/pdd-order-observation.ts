/**
 * 拼多多订单数据源发现阶段的跨进程安全契约。
 *
 * 这里只描述请求/响应的结构，不保存响应正文。所有字段名都已经在 Main
 * 进程经过脱敏；Renderer 不会接触 Cookie、Token、Header 或完整响应体。
 */

export const PDD_ORDER_OBSERVATION_REPORT = 'PDD_ORDER_OBSERVATION_REPORT' as const

export const OBSERVATION_VALUE_TYPES = [
  'null',
  'boolean',
  'number',
  'string',
  'object',
  'array',
  'unknown'
] as const

export type ObservationValueType = typeof OBSERVATION_VALUE_TYPES[number]

export const OBSERVATION_PARSE_STATUSES = ['JSON', 'INVALID_JSON', 'TRUNCATED'] as const
export type ObservationParseStatus = typeof OBSERVATION_PARSE_STATUSES[number]

export const OBSERVATION_CONFIDENCE = ['low', 'medium', 'high'] as const
export type ObservationConfidence = typeof OBSERVATION_CONFIDENCE[number]

export interface ObservationArrayShape {
  path: string
  length: number
  itemType: ObservationValueType
}

export interface ObservationFieldType {
  path: string
  type: ObservationValueType
}

/** JSON 正文的结构摘要；不包含任何字段值。 */
export interface PddOrderObservationFieldStructure {
  parseStatus: ObservationParseStatus
  topLevelKeys: string[]
  nestedKeys: string[]
  arrays: ObservationArrayShape[]
  fieldTypes: ObservationFieldType[]
  suspectedFields: string[]
  candidate: boolean
  confidence: ObservationConfidence
  redactedFieldCount: number
}

/** 单个网络响应的安全摘要。 */
export interface PddOrderObservationResponse {
  urlPattern: string
  method: string
  resourceType: string | null
  statusCode: number
  contentType: string
  contentLength: number | null
  responseTimeMs: number | null
  isJson: boolean
  body: PddOrderObservationFieldStructure | null
}

export interface PddOrderObservationReport {
  reportType: typeof PDD_ORDER_OBSERVATION_REPORT
  storeId: string
  platform: '拼多多'
  startedAt: number
  finishedAt: number
  pageUrl: string
  requestCount: number
  jsonResponseCount: number
  candidateOrderInterfaceCount: number
  /** 受数量限制的响应摘要，不包含正文。 */
  responses: PddOrderObservationResponse[]
  /** 只包含有 JSON 结构的响应，便于人工比对字段。 */
  fieldStructures: Array<{
    urlPattern: string
    structure: PddOrderObservationFieldStructure
  }>
  reasonCode: string
  safeMessage: string
}

export const PDD_OBSERVATION_STATUSES = [
  'STARTED',
  'ALREADY_RUNNING',
  'STOPPED',
  'NOT_RUNNING',
  'FAILED'
] as const

export type PddObservationStatus = typeof PDD_OBSERVATION_STATUSES[number]

export interface PddOrderObservationStartOptions {
  timeoutMs: number
  maxResponses: number
}

export interface PddOrderObservationStartResult {
  status: Extract<PddObservationStatus, 'STARTED' | 'ALREADY_RUNNING' | 'FAILED'>
  storeId: string
  platform: '拼多多'
  startedAt: number | null
  expiresAt: number | null
  reasonCode: string
  safeMessage: string
}

export interface PddOrderObservationStopResult {
  status: Extract<PddObservationStatus, 'STOPPED' | 'NOT_RUNNING' | 'FAILED'>
  storeId: string
  platform: '拼多多'
  report: PddOrderObservationReport | null
  reasonCode: string
  safeMessage: string
}
