/**
 * 电商客服消息监控的安全摘要。
 *
 * 这里刻意不包含聊天正文、买家昵称、Cookie、WebContents 或任意页面快照。
 * 客服工作区只消费这些摘要，人工回复仍在用户选择的平台页面完成。
 */
export const CUSTOMER_MESSAGE_STATUSES = [
  'CHECKING',
  'AVAILABLE',
  'LOGIN_REQUIRED',
  'PAGE_CHANGED',
  'NOT_VERIFIED',
  'ERROR'
] as const

/**
 * 消息摘要的可用时间窗口：后台默认每 45 秒检查一次，给页面加载和重试留出
 * 余量；超过窗口后，界面必须隐藏旧数字并要求重新检查。
 */
export const CUSTOMER_MESSAGE_FRESHNESS_WINDOW_MS = 90_000

/** Renderer and Main must derive the same durable, per-store customer-service session partition. */
export const CUSTOMER_SERVICE_SESSION_PARTITION_PREFIX = 'persist:customer-service_'

/** Renderer, Main navigation guards, and the message monitor share one platform profile. */
export interface CustomerServicePlatformConfig {
  platform: string
  url: string
  keywords: readonly string[]
  /** Exact HTTPS hosts needed by the service page and its manual sign-in/OAuth flow. */
  allowedHosts: readonly string[]
}

export const CUSTOMER_SERVICE_PLATFORMS: Readonly<Record<string, CustomerServicePlatformConfig>> = {
  抖店: {
    platform: '抖店',
    url: 'https://im.jinritemai.com/pc_seller_v2/main/workspace',
    keywords: ['客服', '会话', '消息', '接待'],
    allowedHosts: ['im.jinritemai.com', 'fxg.jinritemai.com', 'login.jinritemai.com', 'passport.jinritemai.com', 'sso.jinritemai.com']
  },
  拼多多: {
    platform: '拼多多',
    url: 'https://mms.pinduoduo.com/chat-merchant/index.html',
    keywords: ['客服', '会话', '消息', '聊天'],
    allowedHosts: ['mms.pinduoduo.com', 'mai.pinduoduo.com', 'passport.pinduoduo.com']
  },
  快手小店: {
    platform: '快手小店',
    url: 'https://im.kwaixiaodian.com/workbench',
    keywords: ['客服', '会话', '消息', '接待'],
    allowedHosts: ['im.kwaixiaodian.com', 's.kwaixiaodian.com', 'passport.kuaishou.com', 'id.kuaishou.com', 'open.kuaishou.com']
  },
  微信小店: {
    platform: '微信小店',
    url: 'https://store.weixin.qq.com/shop/kf',
    keywords: ['客服', '会话', '消息', '接待'],
    allowedHosts: ['store.weixin.qq.com', 'weixin.qq.com', 'open.weixin.qq.com', 'login.weixin.qq.com', 'work.weixin.qq.com']
  }
}

/** Exact-host HTTPS allowlist for customer-service pages and known login/OAuth redirects. */
export function isAllowedCustomerServiceUrl(platform: string, rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') return false
  const config = CUSTOMER_SERVICE_PLATFORMS[platform]
  if (!config) return false
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:'
      && (url.port === '' || url.port === '443')
      && !url.username
      && !url.password
      && config.allowedHosts.includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function customerServiceSessionPartition(storeId: string): string {
  return `${CUSTOMER_SERVICE_SESSION_PARTITION_PREFIX}${storeId}`
}

export const CUSTOMER_MESSAGE_FRESHNESS = ['FRESH', 'STALE'] as const
export type CustomerMessageFreshness = (typeof CUSTOMER_MESSAGE_FRESHNESS)[number]

export function isCustomerMessageCheckFresh(capturedAt: number, now = Date.now()): boolean {
  return Number.isFinite(capturedAt)
    && capturedAt > 0
    && now >= capturedAt
    && now - capturedAt <= CUSTOMER_MESSAGE_FRESHNESS_WINDOW_MS
}

export type CustomerMessageStatus = (typeof CUSTOMER_MESSAGE_STATUSES)[number]

export interface CustomerMessageEvidence {
  /** 是否找到客服/消息上下文的结构化信号 */
  messageContext: boolean
  /** 识别到的未读数字信号数量，不是消息正文 */
  unreadSignals: number
  /** 识别到的会话列表/计数信号数量 */
  conversationSignals: number
  /** 页面登录信号数量 */
  loginSignals: number
  /** 采集页是否存在可读取的文档结构 */
  documentReady: boolean
}

export interface CustomerMessageCheck {
  storeId: string
  platform: string
  status: CustomerMessageStatus
  unreadCount: number | null
  conversationCount: number | null
  reasonCode: string
  message: string
  capturedAt: number
  /** 相对于本次列表/检查响应时间计算；旧快照不得继续冒充实时数字。 */
  freshness: CustomerMessageFreshness
  /** 来源地址只保留哈希，避免把平台路径写入客服台账 */
  sourceUrlHash: string | null
  evidence: CustomerMessageEvidence | null
}

export interface CustomerMessageStatusList {
  computedAt: number
  items: CustomerMessageCheck[]
}
