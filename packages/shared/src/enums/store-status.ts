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
 * 状态的界面文案（唯一来源，2026-10-15 审查 P2-2 收敛）
 *
 * 此前 UnifiedAppsPage / UnifiedStorePage / DashboardView 各写了一份映射，
 * 且 DashboardView 那份缺 `proxy_error` / `archived` 分支——「代理异常」在总览页
 * 显示成「离线」，同一店铺在不同页文案互相矛盾。改文案只改这一处。
 */
export const STORE_STATUS_LABEL: Readonly<Record<string, string>> = {
  [StoreStatus.ONLINE]: '在线',
  [StoreStatus.LAUNCHING]: '启动中',
  [StoreStatus.NEEDS_LOGIN]: '登录失效',
  [StoreStatus.PROXY_ERROR]: '代理异常',
  [StoreStatus.OFFLINE]: '离线',
  [StoreStatus.INCOMPLETE]: '离线',
  [StoreStatus.ARCHIVED]: '已归档'
}

/** 未知状态回「未知状态」——与三处旧实现的兜底一致 */
export function storeStatusLabel(status: string): string {
  return STORE_STATUS_LABEL[status] || '未知状态'
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
