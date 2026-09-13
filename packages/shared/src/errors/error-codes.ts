/**
 * 错误码定义 - §18
 * 每个错误码包含：code、message、retryable、触发条件
 */

export const ERROR_CODES = {
  STORE_NOT_FOUND: {
    code: 'STORE_NOT_FOUND',
    message: '店铺不存在或已删除',
    retryable: false
  },
  STORE_LOCKED: {
    code: 'STORE_LOCKED',
    message: '店铺正在被其他操作占用',
    retryable: true
  },
  PROFILE_NOT_READY: {
    code: 'PROFILE_NOT_READY',
    message: '浏览器环境尚未初始化',
    retryable: true
  },
  PROFILE_IN_USE: {
    code: 'PROFILE_IN_USE',
    message: '店铺浏览器正在运行',
    retryable: false
  },
  PROFILE_LOCKED: {
    code: 'PROFILE_LOCKED',
    message: '环境已锁定，请先解锁后再修改',
    retryable: false
  },
  PROXY_INVALID: {
    code: 'PROXY_INVALID',
    message: '代理格式不正确',
    retryable: false
  },
  PROXY_AUTH_FAILED: {
    code: 'PROXY_AUTH_FAILED',
    message: '代理认证失败',
    retryable: false
  },
  PROXY_UNREACHABLE: {
    code: 'PROXY_UNREACHABLE',
    message: '代理无法连接',
    retryable: true
  },
  SESSION_EXPIRED: {
    code: 'SESSION_EXPIRED',
    message: '登录会话已过期',
    retryable: false
  },
  SESSION_IMPORT_INVALID: {
    code: 'SESSION_IMPORT_INVALID',
    message: '会话包格式、密码或校验值错误',
    retryable: false
  },
  SESSION_PACKAGE_EXPIRED: {
    code: 'SESSION_PACKAGE_EXPIRED',
    message: '会话包已过期，拒绝导入',
    retryable: false
  },
  SESSION_CANCELLED: {
    code: 'SESSION_CANCELLED',
    message: '会话导出/导入已取消',
    retryable: false
  },
  TASK_CONFIRMATION_REQUIRED: {
    code: 'TASK_CONFIRMATION_REQUIRED',
    message: '任务等待人工确认',
    retryable: false
  },
  TASK_TIMEOUT: {
    code: 'TASK_TIMEOUT',
    message: '任务步骤超时',
    retryable: true
  },
  TASK_SELECTOR_CHANGED: {
    code: 'TASK_SELECTOR_CHANGED',
    message: '页面结构已变化',
    retryable: false
  },
  TASK_INVITE_PAGE_NOT_OPEN: {
    code: 'TASK_INVITE_PAGE_NOT_OPEN',
    message: '邀约表单页未打开（请先在店铺浏览器进到达人的邀约页）',
    retryable: false
  },
  TASK_INPUT_NOT_APPLIED: {
    code: 'TASK_INPUT_NOT_APPLIED',
    message: '受信任输入写入未生效',
    retryable: false
  },
  TASK_QUOTA_EXCEEDED: {
    code: 'TASK_QUOTA_EXCEEDED',
    message: '可邀约额度不足或平台限制该操作',
    retryable: false
  },
  BROWSER_CLOSED: {
    code: 'BROWSER_CLOSED',
    message: '店铺浏览器或任务标签页已被关闭（运行中止）',
    retryable: true
  },
  TASK_NOT_FOUND: {
    code: 'TASK_NOT_FOUND',
    message: '任务或运行记录不存在',
    retryable: false
  },
  TASK_INVALID_STEP: {
    code: 'TASK_INVALID_STEP',
    message: '任务步骤不合法',
    retryable: false
  },
  TASK_BAD_STATE: {
    code: 'TASK_BAD_STATE',
    message: '当前任务状态不允许该操作',
    retryable: false
  },
  NAVIGATION_BLOCKED: {
    code: 'NAVIGATION_BLOCKED',
    message: '导航目标不被允许',
    retryable: false
  },
  BACKUP_CHECKSUM_FAILED: {
    code: 'BACKUP_CHECKSUM_FAILED',
    message: '备份文件校验失败',
    retryable: false
  },
  APP_LOCKED: {
    code: 'APP_LOCKED',
    message: '应用已锁定',
    retryable: false
  },
  UPDATE_ERROR: {
    code: 'UPDATE_ERROR',
    message: '更新检查、下载或安装失败',
    retryable: true
  },
  INVALID_ARGUMENT: {
    code: 'INVALID_ARGUMENT',
    message: '参数不合法',
    retryable: false
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    message: '未分类内部错误',
    retryable: false
  }
} as const

export type ErrorCode = keyof typeof ERROR_CODES
