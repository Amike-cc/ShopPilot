/**
 * 店铺状态枚举 - §9.1
 * 全局唯一来源，禁止散落字符串
 */
export enum StoreStatus {
  INCOMPLETE = 'incomplete',      // 配置不完整
  OFFLINE = 'offline',            // 离线
  LAUNCHING = 'launching',        // 启动中
  ONLINE = 'online',              // 在线
  NEEDS_LOGIN = 'needs_login',    // 需要登录
  PROXY_ERROR = 'proxy_error',    // 代理异常
  ARCHIVED = 'archived'           // 已归档
}

/**
 * 任务状态枚举 - §9.2
 */
export enum TaskStatus {
  DRAFT = 'draft',
  QUEUED = 'queued',
  RUNNING = 'running',
  WAITING_CONFIRMATION = 'waiting_confirmation',
  PAUSED = 'paused',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

/**
 * 下载状态枚举 - §5.9
 */
export enum DownloadState {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  INTERRUPTED = 'interrupted',
  CANCELLED = 'cancelled'
}

/**
 * 书签来源枚举 - §5.8
 */
export enum BookmarkSource {
  MANUAL = 'manual',
  ENTRY_ROUTE = 'entry_route'
}
