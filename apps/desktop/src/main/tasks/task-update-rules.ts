/**
 * 任务定义更新（task:update）里与数据库无关的判定。
 *
 * 独立成文件的原因与 task-step-schemas.ts 相同：task-store.ts 依赖 SQLite/Electron，
 * 纯 Node 单测加载不了它；把"运行中能不能改步骤"与"这次 UPDATE 到底写哪几列"放这里，
 * 单测就能直接钉住这两条规则（运行中拒绝改步骤 / 部分更新不动其它列）。
 */

/**
 * 未结束的运行状态：任务在这些状态下，定义里的**步骤序列**正被消费、或还能被恢复重放
 * （与 task-runner.findActiveRunForTask、scheduler、task-handlers 的 TASK_DELETE 同一组）。
 */
export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_confirmation', 'paused'] as const

export function isActiveRunStatus(status: unknown): boolean {
  return typeof status === 'string' && (ACTIVE_RUN_STATUSES as readonly string[]).includes(status)
}

/**
 * 运行中改 steps 的拒因。当前状态与原因都写在里面：
 * task-handlers 的 taskError 会剥掉 `TASK_BAD_STATE:` 前缀后原样展示这条文案。
 */
export function stepsEditBlockReason(status: string): string {
  return `运行状态为 ${status}，不允许修改任务步骤（该任务有未结束的运行：步骤下标与已执行记录一一对应，`
    + '中途替换会让恢复/跳过对不上，副作用步骤可能被跳过或重复执行；请先取消或等本次运行结束后再改）'
}

/**
 * 存在未结束运行时拒绝修改 steps（抛 TASK_BAD_STATE，沿用 task-store 里直接抛 Error 的风格）。
 * 只约束 steps：名称 / 店铺范围 / 计划都不参与当前这一轮的执行（见 updateTask 的注释）。
 */
export function assertStepsEditable(status: string | null | undefined): void {
  if (isActiveRunStatus(status)) throw new Error(`TASK_BAD_STATE: ${stepsEditBlockReason(String(status))}`)
}

export interface TaskUpdateSetInput {
  name?: string
  storeScope?: string | null
  /** undefined = 不改计划；null = 清空计划；字符串 = 新的计划 JSON */
  scheduleJson?: string | null
  updatedAt: number
}

/**
 * 只把**这次真正要改的列**放进 SET：未传的字段不进语句，原值自然保留（部分更新的语义所在）。
 * 显式传 null（清空店铺范围/计划）会进语句并写入 NULL。
 * updated_at 一定写：tasks 表有这一列，定义一改动就要落时间。
 */
export function buildTaskUpdateSet(patch: TaskUpdateSetInput): { sets: string[]; values: unknown[] } {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name) }
  if (patch.storeScope !== undefined) { sets.push('store_scope = ?'); values.push(patch.storeScope) }
  if (patch.scheduleJson !== undefined) { sets.push('schedule_json = ?'); values.push(patch.scheduleJson) }
  sets.push('updated_at = ?'); values.push(patch.updatedAt)
  return { sets, values }
}
