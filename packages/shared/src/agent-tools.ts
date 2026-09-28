/**
 * AI 工具目录（Tool Catalog）。
 *
 * AI 只能调用这里登记的工具：每个工具对应一个闭合的软件动作，参数是固定 JSON 形状，
 * 没有脚本、Shell、文件或任意代码。技能（Skill）只能由“自动执行类”工具组成，
 * 涉及资金或不可逆操作（审批清单）的工具不允许写进技能。
 */
import { AGENT_CONFIRM_REQUIRED_ACTIONS, APPROVAL_REQUIRED_SOFTWARE_ACTIONS, MONEY_ACTION_RE } from './agent-domain-rules'

export interface AgentToolSpec {
  type: string
  label: string
  description: string
  /** 示例 JSON（直接进提示词，模型照抄形状、参数取自上下文） */
  example: string
}

export const AGENT_TOOL_CATALOG: readonly AgentToolSpec[] = [
  { type: 'listStores', label: '查看店铺列表', description: '读取店铺、打开状态和标签页摘要', example: '{"type":"listStores"}' },
  { type: 'listTasks', label: '查看任务列表', description: '读取最近任务与运行状态', example: '{"type":"listTasks"}' },
  { type: 'listAgents', label: '查看子 Agent 列表', description: '读取子 Agent 岗位、状态和模型绑定', example: '{"type":"listAgents"}' },
  { type: 'listJobs', label: '查看 Job 列表', description: '读取最近 Job、执行者和结果数量', example: '{"type":"listJobs"}' },
  { type: 'listTrashStores', label: '查看回收站', description: '读取回收站里的店铺', example: '{"type":"listTrashStores"}' },
  { type: 'listBackups', label: '查看备份列表', description: '读取本地备份摘要', example: '{"type":"listBackups"}' },
  { type: 'getTaskDetail', label: '查看任务详情', description: '读取任务步骤和最近运行结果', example: '{"type":"getTaskDetail","taskId":"..."}' },
  { type: 'createTask', label: '创建任务', description: '创建经过 TaskRunner 白名单校验的持久化浏览器任务（需要用户确认）', example: '{"type":"createTask","name":"库存巡检","storeScope":"store_...","steps":[{"type":"navigate","input":{"url":"https://example.com"}}]}' },
  { type: 'searchMemory', label: '检索记忆', description: '检索已审核长期记忆', example: '{"type":"searchMemory","query":"库存规则"}' },
  { type: 'writeMemory', label: '写入记忆', description: '写入待人工审核的记忆', example: '{"type":"writeMemory","title":"...","content":"..."}' },
  { type: 'openStore', label: '打开店铺', description: '打开目标店铺浏览器', example: '{"type":"openStore","storeId":"..."}' },
  { type: 'displayStore', label: '切换店铺', description: '切换当前显示的店铺', example: '{"type":"displayStore","storeId":"..."}' },
  { type: 'activateTab', label: '切换标签页', description: '切换店铺内的标签页', example: '{"type":"activateTab","storeId":"...","tabId":"..."}' },
  { type: 'createTab', label: '新建标签页', description: '在已打开的店铺浏览器中新建标签页，可指定 http/https 地址', example: '{"type":"createTab","storeId":"...","url":"https://example.com"}' },
  { type: 'navigateTab', label: '导航标签页', description: '在指定标签页打开 http/https 地址', example: '{"type":"navigateTab","storeId":"...","tabId":"...","url":"https://example.com"}' },
  { type: 'controlTab', label: '控制标签页导航', description: '让标签页后退、前进或重新加载', example: '{"type":"controlTab","storeId":"...","tabId":"...","action":"reload"}' },
  { type: 'pinTab', label: '固定标签页', description: '固定或取消固定标签页', example: '{"type":"pinTab","storeId":"...","tabId":"...","pinned":true}' },
  { type: 'closeTab', label: '关闭标签页', description: '关闭指定标签页（需要用户确认）', example: '{"type":"closeTab","storeId":"...","tabId":"..."}' },
  { type: 'closeStore', label: '关闭店铺', description: '关闭店铺浏览器', example: '{"type":"closeStore","storeId":"..."}' },
  { type: 'openPanel', label: '打开面板', description: '打开设置/AI 配置/Agent 团队/任务面板/发票中心/数据中心', example: '{"type":"openPanel","panel":"agentTeam"}' },
  { type: 'createAgent', label: '创建子 Agent', description: '创建 probation 执行岗位', example: '{"type":"createAgent","role":"analyst","name":"...","description":"..."}' },
  { type: 'activateAgent', label: '激活子 Agent', description: '激活 probation/paused 子 Agent', example: '{"type":"activateAgent","agentId":"..."}' },
  { type: 'pauseAgent', label: '暂停子 Agent', description: '暂停子 Agent', example: '{"type":"pauseAgent","agentId":"..."}' },
  { type: 'resumeAgent', label: '恢复子 Agent', description: '恢复已暂停的子 Agent', example: '{"type":"resumeAgent","agentId":"..."}' },
  { type: 'retireAgent', label: '退休子 Agent', description: '退休子 Agent，历史保留可读', example: '{"type":"retireAgent","agentId":"..."}' },
  { type: 'createStore', label: '新建店铺', description: '新建店铺记录', example: '{"type":"createStore","name":"...","platform":"..."}' },
  { type: 'updateStore', label: '修改店铺', description: '改名或设置分组', example: '{"type":"updateStore","storeId":"...","name":"..."}' },
  { type: 'archiveStore', label: '移入回收站', description: '软删除店铺，可恢复', example: '{"type":"archiveStore","storeId":"..."}' },
  { type: 'restoreStore', label: '恢复店铺', description: '从回收站恢复店铺', example: '{"type":"restoreStore","storeId":"..."}' },
  { type: 'deleteStorePermanent', label: '彻底删除店铺', description: '从回收站彻底删除（不可恢复）', example: '{"type":"deleteStorePermanent","storeId":"..."}' },
  { type: 'deleteTask', label: '删除任务', description: '删除任务及其运行记录', example: '{"type":"deleteTask","taskId":"..."}' },
  { type: 'runTask', label: '派单运行任务', description: '把任务派给子 Agent 运行', example: '{"type":"runTask","taskId":"..."}' },
  { type: 'pauseTaskRun', label: '暂停任务运行', description: '暂停当前运行', example: '{"type":"pauseTaskRun","taskId":"..."}' },
  { type: 'resumeTaskRun', label: '恢复任务运行', description: '恢复已暂停的运行', example: '{"type":"resumeTaskRun","taskId":"..."}' },
  { type: 'cancelTaskRun', label: '取消任务运行', description: '取消当前运行', example: '{"type":"cancelTaskRun","taskId":"..."}' },
  { type: 'collectInvoices', label: '采集发票', description: '按已实测锚点采集各店发票数据', example: '{"type":"collectInvoices","storeIds":[]}' },
  { type: 'collectBusiness', label: '采集经营数据', description: '采集订单/销量/销售额/退款指标', example: '{"type":"collectBusiness","storeIds":[]}' },
  { type: 'collectEntity', label: '采集主体信息', description: '采集店铺营业执照主体', example: '{"type":"collectEntity","storeIds":[]}' },
  { type: 'collectOrders', label: '采集订单明细', description: '逐条读取订单列表整表（仅已实测订单页的平台；明细落在任务结果里）', example: '{"type":"collectOrders","storeIds":[]}' },
  { type: 'getOrderDetails', label: '查看订单明细', description: '读取最近一次采集到的订单明细（只读；买家列不进入上下文）', example: '{"type":"getOrderDetails","storeId":"...","limit":5}' },
  { type: 'listDownloads', label: '查看下载列表', description: '读取店铺下载记录', example: '{"type":"listDownloads"}' },
  { type: 'listBookmarks', label: '查看书签', description: '读取店铺书签', example: '{"type":"listBookmarks"}' },
  { type: 'createBookmark', label: '新建书签', description: '为店铺新建书签', example: '{"type":"createBookmark","storeId":"...","title":"...","url":"..."}' },
  { type: 'deleteBookmark', label: '删除书签', description: '删除书签', example: '{"type":"deleteBookmark","bookmarkId":"..."}' },
  { type: 'createBackup', label: '创建备份', description: '创建本地数据备份', example: '{"type":"createBackup"}' },
  { type: 'restoreBackup', label: '恢复备份', description: '从备份恢复数据', example: '{"type":"restoreBackup","backupId":"..."}' },
  { type: 'listTools', label: '查看工具', description: '列出 AI 可调用的所有工具', example: '{"type":"listTools"}' },
  { type: 'listSkills', label: '查看技能', description: '列出已创建的技能', example: '{"type":"listSkills"}' },
  { type: 'createSkill', label: '制作技能', description: '用现有工具组合一个新技能（只能包含自动执行类工具）', example: '{"type":"createSkill","name":"每日巡检","description":"...","intent":"...","steps":[{"type":"collectBusiness","input":{"storeIds":[]}},{"type":"listJobs","input":{}}]}' },
  { type: 'runSkill', label: '运行技能', description: '按顺序执行技能里的工具', example: '{"type":"runSkill","skillId":"skill_..."}' },
  { type: 'updateSkill', label: '更新技能', description: '改名/改描述/启用或停用技能', example: '{"type":"updateSkill","skillId":"skill_...","status":"disabled"}' },
  { type: 'deleteSkill', label: '删除技能', description: '删除技能', example: '{"type":"deleteSkill","skillId":"skill_..."}' },
  { type: 'createPlugin', label: '制作插件', description: '把多个技能打包成插件', example: '{"type":"createPlugin","name":"店铺日报","description":"...","skillIds":["skill_..."]}' },
  { type: 'listPlugins', label: '查看插件', description: '列出插件及其技能', example: '{"type":"listPlugins"}' },
  { type: 'runInvite', label: '发送达人邀约', description: '按店铺已保存的邀约配置构造任务并派给子 Agent（提交类，额度用尽自动停止）', example: '{"type":"runInvite","storeId":"...","count":5}' },
  { type: 'getJobDetail', label: '查看 Job 详情', description: '读取某个 Job 的状态、执行者、步骤结果和是否需要人工确认', example: '{"type":"getJobDetail","jobId":"job_..."}' },
  { type: 'jobFeedback', label: '提交 Job 反馈', description: '给 Job 结果打分并可写纠正意见（可进入记忆学习，仍需人工审核）', example: '{"type":"jobFeedback","jobId":"job_...","rating":5,"correction":"下次按店铺分组汇总"}' },
  { type: 'reviewJobResult', label: '审阅 Job 结果', description: '通过或驳回某条 Job 结果的审阅（需要用户确认）', example: '{"type":"reviewJobResult","resultId":"res_...","approved":true}' },
  { type: 'approveJob', label: '批准或驳回 Job', description: '处理等待人工确认的高风险 Job；只能处理真正处于等待确认状态的 Job（需要用户确认）', example: '{"type":"approveJob","jobId":"job_...","approved":false}' },
  { type: 'resumeJob', label: '安全恢复 Job', description: '恢复没有页面副作用的失败/受阻 Job；已有页面副作用的会被拒绝', example: '{"type":"resumeJob","jobId":"job_..."}' },
  { type: 'cancelJob', label: '取消 Job', description: '取消 Job 及其页面运行（需要用户确认）', example: '{"type":"cancelJob","jobId":"job_..."}' },
  { type: 'updateAgent', label: '修改子 Agent', description: '改岗位名称/描述、店铺范围、日预算、工具权限、并发或超时（需要用户确认）', example: '{"type":"updateAgent","agentId":"...","maxConcurrency":2}' },
  { type: 'bindAgentModel', label: '绑定模型 Profile', description: '给子 Agent 绑定模型 Profile，或用 null 解绑回退继承（需要用户确认）', example: '{"type":"bindAgentModel","agentId":"...","modelProfileId":"model_..."}' },
  { type: 'updatePlugin', label: '修改插件', description: '改插件名称、说明或成员技能（插件只是技能分组；需要用户确认）', example: '{"type":"updatePlugin","name":"店铺日报","skillNames":["每日巡检"]}' },
  { type: 'deletePlugin', label: '删除插件', description: '删除插件但保留成员技能（需要用户确认）', example: '{"type":"deletePlugin","name":"店铺日报"}' },
  { type: 'updateTask', label: '修改任务', description: '改任务名称、店铺范围、步骤或计划；有运行中记录时不能改步骤（需要用户确认）', example: '{"type":"updateTask","taskId":"task_...","name":"库存巡检（改）"}' },
  { type: 'overviewStats', label: '查看概览统计', description: '读取首页概览统计（店铺/任务/邀约等本机计数）', example: '{"type":"overviewStats"}' },
  { type: 'overviewDatacenter', label: '查看数据中心', description: '读取所有店铺的分布、指标快照与任务/邀约运行汇总', example: '{"type":"overviewDatacenter"}' },
  { type: 'overviewInvoiceCenter', label: '查看发票中心', description: '读取待开票清单（来自发票页快照，没有采集就如实为空）', example: '{"type":"overviewInvoiceCenter"}' },
  { type: 'applyEntity', label: '回填店铺主体', description: '把已采到的营业执照主体写进店铺记录：空则填、一致不动、不一致不覆盖（需要用户确认）', example: '{"type":"applyEntity"}' },
  { type: 'qualityMetrics', label: '查看质量指标', description: '读取 Job、记忆、技能的本地质量指标', example: '{"type":"qualityMetrics"}' },
  { type: 'qualityReview', label: '生成质量复盘', description: '生成 CEO 质量复盘摘要并写入本地记录（不改业务数据）', example: '{"type":"qualityReview"}' },
  { type: 'memoryRebuild', label: '重建记忆索引', description: '重建本地记忆索引与清单（维护动作，不删除记忆）', example: '{"type":"memoryRebuild"}' },
  { type: 'memorySnapshot', label: '创建记忆快照', description: '把本地记忆打包成系统加密快照（维护动作，不修改记忆）', example: '{"type":"memorySnapshot","skipInvalidRecords":false}' }
] as const

/**
 * 技能步骤禁止嵌套技能/插件管理与提交类动作，也禁止 Job 管理、组织变更和记忆维护类动作：
 * 技能是“对软件数据可重复执行的声明式流程”，不该把组织/权限/维护动作固化进去。
 * （另有确认门禁类动作由 skillStepEligible 的 AGENT_CONFIRM_REQUIRED_ACTIONS 判定排除。）
 */
export const AGENT_SKILL_FORBIDDEN_STEPS: readonly string[] = [
  'createSkill', 'runSkill', 'updateSkill', 'deleteSkill',
  'createPlugin', 'listPlugins', 'listSkills', 'listTools',
  'runInvite',
  'resumeJob', 'jobFeedback',
  'memoryRebuild', 'memorySnapshot'
]

export function isSkillStepAllowed(type: string): boolean {
  return !AGENT_SKILL_FORBIDDEN_STEPS.includes(type)
}

export function toolApprovalRequired(type: string): boolean {
  // 必须与真正的门禁（AGENT_CONFIRM_REQUIRED_ACTIONS）同源：提示词里漏标「需确认」，
  // 模型就会以为某动作能直接落地，实际却弹计划卡等确认（反之更糟：以为要确认而不敢提）。
  // 资金类动作按名称动态判定，与门禁的静态清单叠加。
  return AGENT_CONFIRM_REQUIRED_ACTIONS.has(type) || APPROVAL_REQUIRED_SOFTWARE_ACTIONS.includes(type) || MONEY_ACTION_RE.test(type)
}

/**
 * 只读采集：用户点过计划卡的确认即一次性消费了 Job 的人工确认门禁，
 * 因此它们虽然带副作用（派 Job）仍允许写进技能（§5.4）。
 */
export const AGENT_SKILL_COLLECT_STEPS: readonly string[] = ['collectInvoices', 'collectBusiness', 'collectEntity', 'collectOrders']

/**
 * 技能步骤资格：只有“自动执行类”工具能进技能。
 * Main 的技能校验与面板表单的工具下拉都走这里，保证表单不会给出提交时才被拒的步骤。
 */
export function skillStepEligible(type: string): boolean {
  if (!isSkillStepAllowed(type)) return false
  if (toolApprovalRequired(type)) return false
  if (AGENT_CONFIRM_REQUIRED_ACTIONS.has(type) && !AGENT_SKILL_COLLECT_STEPS.includes(type)) return false
  return true
}

/** 面板「新建技能」表单里的一个可选工具：参数模板来自目录示例，去掉 type 本身。 */
export interface AgentSkillToolSpec {
  type: string
  label: string
  description: string
  /** 预填参数（字符串占位清空，数组/数字/布尔保留，避免把占位符当真实参数提交） */
  params: string
  /** 目录里的原始示例，用作输入框提示 */
  example: string
}

function neutralizeTemplate(value: unknown): unknown {
  if (typeof value === 'string') return ''
  if (Array.isArray(value)) return value.map(neutralizeTemplate)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, neutralizeTemplate(item)]))
  }
  return value
}

/** 技能可用工具目录：表单只渲染这些，用户在界面上无法选到会被拒的步骤。 */
export function listSkillStepTools(): AgentSkillToolSpec[] {
  return AGENT_TOOL_CATALOG.filter(tool => skillStepEligible(tool.type)).map(tool => {
    let params = '{}'
    try {
      const example = JSON.parse(tool.example) as Record<string, unknown>
      delete example.type
      params = JSON.stringify(neutralizeTemplate(example), null, 2)
    } catch { params = '{}' }
    return { type: tool.type, label: tool.label, description: tool.description, params, example: tool.example }
  })
}

/** 生成提示词里的工具白名单文本。小窗口模型使用紧凑形状，避免工具目录吃掉全部输入预算。 */
export function buildToolWhitelistText(compact = false): string {
  return AGENT_TOOL_CATALOG
    .map(tool => compact
      ? `${tool.type}${toolApprovalRequired(tool.type) ? '*' : ''}=${tool.label}`
      : `${tool.example}${toolApprovalRequired(tool.type) ? '（需确认）' : ''} // ${tool.label}：${tool.description}`)
    .join(compact ? '；' : '\n')
}
