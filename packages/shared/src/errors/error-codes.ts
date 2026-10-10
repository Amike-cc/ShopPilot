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
  TASK_SELECTION_SHORTFALL: {
    code: 'TASK_SELECTION_SHORTFALL',
    message: '可勾选的达人数量不足（少于本次要求），已在发送前中止',
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
  },
  SECURITY_STORAGE_UNAVAILABLE: {
    code: 'SECURITY_STORAGE_UNAVAILABLE',
    message: '系统安全存储不可用，拒绝保存主密码',
    retryable: true
  },
  AGENT_PERMISSION_DENIED: {
    code: 'AGENT_PERMISSION_DENIED',
    message: '当前 Agent 没有执行该操作的权限',
    retryable: false
  },
  AGENT_SINGLETON_ONLY: {
    code: 'AGENT_SINGLETON_ONLY',
    message: '当前系统仅支持 root-ceo 单 Agent 运行',
    retryable: false
  },
  AGENT_FORBIDDEN: {
    code: 'AGENT_FORBIDDEN',
    message: '当前调用方不能访问 Agent IPC',
    retryable: false
  },
  AI_FORBIDDEN: {
    code: 'AI_FORBIDDEN',
    message: '当前调用方不能访问 AI 配置 IPC（仅应用主窗口可调用）',
    retryable: false
  },
  IPC_FORBIDDEN: {
    code: 'IPC_FORBIDDEN',
    message: '当前调用方不能访问该 IPC 通道（仅应用主窗口可调用）',
    retryable: false
  },
  AGENT_INTERNAL_ERROR: {
    code: 'AGENT_INTERNAL_ERROR',
    message: 'Agent 操作失败',
    retryable: false
  },
  AGENT_CONFIRMATION_REQUIRED: {
    code: 'AGENT_CONFIRMATION_REQUIRED',
    message: '该 Agent 操作需要人工确认',
    retryable: false
  },
  AGENT_CONFIRMATION_INVALID: {
    code: 'AGENT_CONFIRMATION_INVALID',
    message: '人工确认凭证不匹配',
    retryable: false
  },
  AGENT_ROOT_IMMUTABLE: {
    code: 'AGENT_ROOT_IMMUTABLE',
    message: 'root-ceo 是固定根 Agent，不能删除、退休或改名',
    retryable: false
  },
  AGENT_ROOT_CANNOT_EXECUTE: {
    code: 'AGENT_ROOT_CANNOT_EXECUTE',
    message: '兼容错误码：当前单 Agent 架构由 root-ceo 统一执行；请检查主 Agent 状态、店铺范围和权限配置',
    retryable: false
  },
  AGENT_NO_EXECUTOR: {
    code: 'AGENT_NO_EXECUTOR',
    message: '兼容错误码：当前单 Agent 架构不创建子 Agent；请检查 root-ceo 状态和权限配置',
    retryable: false
  },
  AGENT_INVALID_STATE: {
    code: 'AGENT_INVALID_STATE',
    message: 'Agent 状态转移不合法',
    retryable: false
  },
  AGENT_NOT_FOUND: {
    code: 'AGENT_NOT_FOUND',
    message: 'Agent 不存在',
    retryable: false
  },
  AGENT_SKILL_NOT_FOUND: {
    code: 'AGENT_SKILL_NOT_FOUND',
    message: '技能不存在或已停用',
    retryable: false
  },
  AGENT_INVALID_SKILL_STEP: {
    code: 'AGENT_INVALID_SKILL_STEP',
    message: '技能步骤不在允许的自动执行工具内',
    retryable: false
  },
  AGENT_PACK_INVALID: {
    code: 'AGENT_PACK_INVALID',
    message: '技能/插件包格式不合法或包含不允许的动作',
    retryable: false
  },
  AGENT_INVITE_UNSUPPORTED: {
    code: 'AGENT_INVITE_UNSUPPORTED',
    message: '该平台尚未实测达人邀约',
    retryable: false
  },
  AGENT_INVITE_CONFIG_INCOMPLETE: {
    code: 'AGENT_INVITE_CONFIG_INCOMPLETE',
    message: '达人邀约配置不完整，请先在“达人邀约”面板补全',
    retryable: false
  },
  AGENT_ORDERS_UNSUPPORTED: {
    code: 'AGENT_ORDERS_UNSUPPORTED',
    message: '该平台尚未实测订单页锚点',
    retryable: false
  },
  AGENT_JOB_PAYLOAD_TOO_DEEP: {
    code: 'AGENT_JOB_PAYLOAD_TOO_DEEP',
    message: 'Job 载荷嵌套层级超过上限',
    retryable: false
  },
  AGENT_MODEL_NOT_FOUND: {
    code: 'AGENT_MODEL_NOT_FOUND',
    message: '模型 Profile 不存在或已停用',
    retryable: false
  },
  AGENT_MODEL_KEY_REQUIRED: {
    code: 'AGENT_MODEL_KEY_REQUIRED',
    message: '该模型 Profile 尚未配置 API Key',
    retryable: false
  },
  AGENT_MODEL_INCAPABLE: {
    code: 'AGENT_MODEL_INCAPABLE',
    message: '该模型 Profile 未通过能力探测（智能体需要对话与 JSON 输出），请重新测试或换一个 Profile',
    retryable: false
  },
  AGENT_INVALID_INPUT: {
    code: 'AGENT_INVALID_INPUT',
    message: 'Agent 输入不合法',
    retryable: false
  },
  AGENT_OPERATION_NOT_ALLOWED: {
    code: 'AGENT_OPERATION_NOT_ALLOWED',
    message: '该操作不在 Agent 允许的能力范围内',
    retryable: false
  },
  AGENT_SOFTWARE_TARGET_REQUIRED: {
    code: 'AGENT_SOFTWARE_TARGET_REQUIRED',
    message: '请指出要操作的店铺或标签页名称，Agent 不会猜测软件对象',
    retryable: false
  },
  AGENT_STORE_NOT_AUTHORIZED: {
    code: 'AGENT_STORE_NOT_AUTHORIZED',
    message: '目标店铺不存在、已移入回收站或不在授权范围',
    retryable: false
  },
  AGENT_STORE_NOT_OPEN: {
    code: 'AGENT_STORE_NOT_OPEN',
    message: '目标店铺浏览器尚未打开',
    retryable: false
  },
  AGENT_TAB_CLOSED: {
    code: 'AGENT_TAB_CLOSED',
    message: '目标标签页不存在或已关闭',
    retryable: false
  },
  AGENT_INVALID_SOFTWARE_ACTION: {
    code: 'AGENT_INVALID_SOFTWARE_ACTION',
    message: '软件操作不在允许列表中',
    retryable: false
  },
  AGENT_INVALID_PLAN: {
    code: 'AGENT_INVALID_PLAN',
    message: '计划结构不合法',
    retryable: false
  },
  AGENT_BAD_PLAN_STATE: {
    code: 'AGENT_BAD_PLAN_STATE',
    message: '计划状态不允许该操作',
    retryable: false
  },
  AGENT_PLAN_TOO_LARGE: {
    code: 'AGENT_PLAN_TOO_LARGE',
    message: '计划内容超过大小限制',
    retryable: false
  },
  AGENT_BOOKMARK_NOT_FOUND: {
    code: 'AGENT_BOOKMARK_NOT_FOUND',
    message: '目标书签不存在',
    retryable: false
  },
  AGENT_BACKUP_NOT_FOUND: {
    code: 'AGENT_BACKUP_NOT_FOUND',
    message: '目标备份不存在',
    retryable: false
  },
  AGENT_JOB_DUPLICATE: {
    code: 'AGENT_JOB_DUPLICATE',
    message: '幂等键已对应其他 Job',
    retryable: false
  },
  AGENT_JOB_NOT_FOUND: {
    code: 'AGENT_JOB_NOT_FOUND',
    message: 'Agent Job 不存在',
    retryable: false
  },
  AGENT_JOB_BAD_STATE: {
    code: 'AGENT_JOB_BAD_STATE',
    message: 'Agent Job 状态不允许该操作',
    retryable: false
  },
  AGENT_JOB_CONFLICT: {
    code: 'AGENT_JOB_CONFLICT',
    message: 'Agent Job 已被其他执行者更新',
    retryable: true
  },
  AGENT_JOB_LEASE_LOST: {
    code: 'AGENT_JOB_LEASE_LOST',
    message: 'Agent Job 租约已失效，拒绝写回旧 Worker 结果',
    retryable: false
  },
  AGENT_DAG_LIMIT: {
    code: 'AGENT_DAG_LIMIT',
    message: 'Agent Job DAG 超出深度或节点上限',
    retryable: false
  },
  AGENT_JOB_RESULT_NOT_FOUND: {
    code: 'AGENT_JOB_RESULT_NOT_FOUND',
    message: 'Agent Job 结果不存在',
    retryable: false
  },
  AGENT_JOB_DEPENDENCY_WAITING: {
    code: 'AGENT_JOB_DEPENDENCY_WAITING',
    message: 'Agent Job 依赖尚未完成',
    retryable: true
  },
  AGENT_JOB_DEPENDENCY_FAILED: {
    code: 'AGENT_JOB_DEPENDENCY_FAILED',
    message: 'Agent Job 依赖未成功完成',
    retryable: false
  },
  AGENT_MEMORY_PATH_INVALID: {
    code: 'AGENT_MEMORY_PATH_INVALID',
    message: '记忆目录路径不安全',
    retryable: false
  },
  AGENT_MEMORY_SENSITIVE: {
    code: 'AGENT_MEMORY_SENSITIVE',
    message: '记忆内容包含禁止保存的敏感字段',
    retryable: false
  },
  AGENT_MEMORY_NOT_FOUND: {
    code: 'AGENT_MEMORY_NOT_FOUND',
    message: '记忆记录不存在',
    retryable: false
  },
  AGENT_MEMORY_INTEGRITY_FAILED: {
    code: 'AGENT_MEMORY_INTEGRITY_FAILED',
    message: '记忆正文完整性校验失败，已隔离',
    retryable: false
  },
  AGENT_MEMORY_TOO_LARGE: {
    code: 'AGENT_MEMORY_TOO_LARGE',
    message: '记忆正文超过允许上限',
    retryable: false
  },
  AGENT_MEMORY_SNAPSHOT_UNAVAILABLE: {
    code: 'AGENT_MEMORY_SNAPSHOT_UNAVAILABLE',
    message: '系统安全存储不可用，不能操作记忆快照',
    retryable: false
  },
  AGENT_MEMORY_SNAPSHOT_INVALID: {
    code: 'AGENT_MEMORY_SNAPSHOT_INVALID',
    message: '记忆快照格式、密文或完整性校验失败',
    retryable: false
  },
  AGENT_MEMORY_IO_FAILED: {
    code: 'AGENT_MEMORY_IO_FAILED',
    message: '记忆写入未完成，已回滚文件和索引状态',
    retryable: true
  },
  AGENT_MODEL_KEY_STORAGE_UNAVAILABLE: {
    code: 'AGENT_MODEL_KEY_STORAGE_UNAVAILABLE',
    message: '系统安全存储不可用，拒绝保存模型 API Key',
    retryable: false
  },
  AGENT_BUDGET_BLOCKED: {
    code: 'AGENT_BUDGET_BLOCKED',
    message: 'Agent 或模型预算不足',
    retryable: false
  },
  AGENT_CONCURRENCY_LIMIT: {
    code: 'AGENT_CONCURRENCY_LIMIT',
    message: 'Agent 或模型 Profile 已达到并发上限',
    retryable: true
  }
} as const

export type ErrorCode = keyof typeof ERROR_CODES
