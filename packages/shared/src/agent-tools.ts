/**
 * AI 工具目录（Tool Catalog）。
 *
 * AI 只能调用这里登记的工具：每个工具对应一个闭合的软件动作，参数是固定 JSON 形状，
 * 没有脚本、Shell、文件或任意代码。技能（Skill）只能由“自动执行类”工具组成，
 * 涉及资金或不可逆操作（审批清单）的工具不允许写进技能。
 */
import { APPROVAL_REQUIRED_SOFTWARE_ACTIONS, MONEY_ACTION_RE } from './agent-domain-rules'

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
  { type: 'searchMemory', label: '检索记忆', description: '检索已审核长期记忆', example: '{"type":"searchMemory","query":"库存规则"}' },
  { type: 'writeMemory', label: '写入记忆', description: '写入待人工审核的记忆', example: '{"type":"writeMemory","title":"...","content":"..."}' },
  { type: 'openStore', label: '打开店铺', description: '打开目标店铺浏览器', example: '{"type":"openStore","storeId":"..."}' },
  { type: 'displayStore', label: '切换店铺', description: '切换当前显示的店铺', example: '{"type":"displayStore","storeId":"..."}' },
  { type: 'activateTab', label: '切换标签页', description: '切换店铺内的标签页', example: '{"type":"activateTab","storeId":"...","tabId":"..."}' },
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
  { type: 'deleteSkill', label: '删除技能', description: '删除技能', example: '{"type":"deleteSkill","skillId":"skill_..."}' },
  { type: 'createPlugin', label: '制作插件', description: '把多个技能打包成插件', example: '{"type":"createPlugin","name":"店铺日报","description":"...","skillIds":["skill_..."]}' },
  { type: 'listPlugins', label: '查看插件', description: '列出插件及其技能', example: '{"type":"listPlugins"}' },
  { type: 'runInvite', label: '发送达人邀约', description: '按店铺已保存的邀约配置构造任务并派给子 Agent（提交类，额度用尽自动停止）', example: '{"type":"runInvite","storeId":"...","count":5}' }
] as const

/** 技能步骤禁止嵌套技能/插件管理，也禁止提交类动作（邀约发送必须每次由用户明确要求）。 */
export const AGENT_SKILL_FORBIDDEN_STEPS: readonly string[] = ['createSkill', 'runSkill', 'deleteSkill', 'createPlugin', 'listPlugins', 'listSkills', 'listTools', 'runInvite']

export function isSkillStepAllowed(type: string): boolean {
  return !AGENT_SKILL_FORBIDDEN_STEPS.includes(type)
}

export function toolApprovalRequired(type: string): boolean {
  return APPROVAL_REQUIRED_SOFTWARE_ACTIONS.includes(type) || MONEY_ACTION_RE.test(type)
}

/** 生成提示词里的工具白名单文本。 */
export function buildToolWhitelistText(): string {
  return AGENT_TOOL_CATALOG
    .map(tool => `${tool.example}${toolApprovalRequired(tool.type) ? '（需确认）' : ''} // ${tool.label}：${tool.description}`)
    .join('\n')
}
