/**
 * 任务运行器常量配置
 * 提取魔法数字和重复配置，便于统一管理和调整
 */

/** 任务标签页复用策略 */
export const TAB_REUSE_CONFIG = {
  /** 是否启用标签页复用（按店铺复用单个标签页，避免渲染进程堆积） */
  ENABLED: true,
  /** 每个店铺保留的运行标签页数量 */
  TABS_PER_STORE: 1
} as const

/** 主窗口崩溃恢复配置 */
export const MAIN_WINDOW_CRASH_RECOVERY = {
  /** 单个时间窗口内的最大恢复次数 */
  MAX_RETRIES_PER_WINDOW: 3,
  /** 时间窗口长度（毫秒）*/
  WINDOW_MS: 5 * 60 * 1000,
  /** 绝对恢复次数上限（24小时内） */
  ABSOLUTE_MAX_RETRIES: 10,
  /** 绝对计数窗口（毫秒）*/
  ABSOLUTE_WINDOW_MS: 24 * 60 * 60 * 1000
} as const

/** 崩溃日志限流配置 */
export const CRASH_LOG_THROTTLE = {
  /** 单个时间窗口内记录的最大日志条数 */
  MAX_LOGS_PER_WINDOW: 20,
  /** 时间窗口长度（毫秒）*/
  WINDOW_MS: 10000
} as const

/** 标题栏配置 */
export const TITLEBAR_CONFIG = {
  /** 标题栏覆盖层高度（与标签栏对齐）*/
  OVERLAY_HEIGHT: 38
} as const

/** 视图挂载检测阈值 */
export const VIEW_MOUNT_DETECTION = {
  /** 视口宽度小于此值认为视图未挂载 */
  MIN_VIEWPORT_WIDTH: 50,
  /** 视口高度小于此值认为视图未挂载 */
  MIN_VIEWPORT_HEIGHT: 50
} as const

/** 任务步骤轮询配置 */
export const TASK_POLLING = {
  /** 轮询检查间隔（毫秒）*/
  INTERVAL_MS: 300,
  /** 等待页面加载的最小超时时间（毫秒）*/
  MIN_LOAD_TIMEOUT_MS: 5000
} as const

/** 窗口显示配置 */
export const WINDOW_SHOW_CONFIG = {
  /** did-finish-load 后延迟显示的时间（毫秒）*/
  FALLBACK_DELAY_MS: 1500
} as const

/** 元素可见性采样点配置 */
export const VISIBILITY_SAMPLING = {
  /** 水平采样点比例 */
  X_RATIOS: [0.12, 0.3, 0.5, 0.7, 0.88],
  /** 垂直采样点比例 */
  Y_RATIOS: [0.5, 0.25, 0.75],
  /** 向上查找父元素的最大层数 */
  MAX_PARENT_CLIMB: 4
} as const

/** 受信任输入配置 */
export const TRUSTED_INPUT = {
  /** 聚焦重试次数 */
  FOCUS_RETRY_COUNT: 3,
  /** 聚焦等待间隔（毫秒）*/
  FOCUS_WAIT_MS: 220,
  /** 输入后等待时间（毫秒）*/
  POST_INPUT_WAIT_MS: 200,
  /** 整体重试次数（处理竞态）*/
  OVERALL_RETRY_COUNT: 2
} as const

/** 标签页跟随配置 */
export const TAB_FOLLOW = {
  /** 轮询检查间隔（毫秒）*/
  POLL_INTERVAL_MS: 250
} as const

/** 允许空表格的等待时间 */
export const EMPTY_TABLE_WAIT = {
  /** 最大等待时间（毫秒）*/
  MAX_WAIT_MS: 12000
} as const

/** 文本长度限制 */
export const TEXT_LIMITS = {
  /** 读取文本的最大长度 */
  READ_TEXT_MAX_LENGTH: 100000,
  /** 表格单元格文本最大长度 */
  TABLE_CELL_MAX_LENGTH: 500,
  /** 表格最大行数 */
  TABLE_MAX_ROWS: 2000,
  /** 点击目标文本显示长度 */
  CLICKED_TEXT_DISPLAY_LENGTH: 40,
  /** 行容器文本去重键长度 */
  ROW_KEY_MAX_LENGTH: 200,
  /** 禁用原因说明长度 */
  DISABLED_REASON_MAX_LENGTH: 120
} as const

/** 错误消息常量 */
export const ERROR_MESSAGES = {
  DATABASE_NOT_INITIALIZED: 'Database not initialized. Call initDatabase() first.',
  BROWSER_CLOSED: 'BROWSER_CLOSED: 店铺浏览器或任务标签页已被关闭',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_BAD_STATE_ACTIVE: 'TASK_BAD_STATE: 该任务已有未结束的运行，请先等待、恢复或取消当前运行后再启动',
  TASK_BAD_STATE_NO_STORE: 'TASK_BAD_STATE: 任务未绑定店铺，请先在任务中指定店铺或运行时选择',
  TASK_BAD_STATE_OLD_SESSION: 'TASK_BAD_STATE: 该运行属于上一进程会话，无法原地恢复；请重新运行任务',
  TASK_BAD_STATE_NON_RESUMABLE: 'TASK_BAD_STATE: 失败步骤为副作用步骤（草稿填充/人工确认），按规范不进入可恢复重试范围，请重新运行任务',
  NAVIGATION_BLOCKED: 'NAVIGATION_BLOCKED: 仅允许 http/https'
} as const
