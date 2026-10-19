/**
 * TaskRunner - §4.4 / §9.2
 * 只执行预定义步骤（不接受网页或渲染层的任意代码）；
 * 状态迁移全部在 Main 执行并在 task_runs.status_reason 保留迁移原因。
 *
 * 并发策略：全局同时最多 1 个 active run（暂停/恢复/确认门禁语义确定）；
 * 店铺浏览器未打开的 run 保持 queued，不静默拉起（§4.4）。
 * 审计引用（runId 等）序列化进 audit_logs.request_id（§5.7 七列 schema 不动）。
 *
 * 2026-10-19 P1 重构：本文件只保留**对外入口的薄 facade**，实现按职责拆到：
 *   ./task-runner-registry.ts  运行句柄与进程内状态
 *   ./task-runner-lifecycle.ts 状态迁移、进度事件、借页归还
 *   ./task-runner-control.ts   入队/恢复/重试/暂停/取消/确认、队列泵、定时触发
 *   ./task-runner-execute.ts   单次 run 的执行循环
 *   ./task-step-dom.ts         注入脚本常量与页面交互原语
 *   ./task-step-executor.ts    步骤执行器（execStep）
 * 对外导出名与 `./tasks/task-runner` 这个 import 路径保持不变，调用方无需改动。
 */
export {
  enqueueRun, resumeRun, retryRunFromFailed, pauseRun, cancelRun, confirmRun,
  listLiveRuns, startEngine, RECONCILE_QUEUED_SQL, RECONCILE_ACTIVE_SQL, fireScheduled
} from './task-runner-control'
export { findActiveRunForTask } from './task-runner-lifecycle'
export { classifyInviteBlockNotice } from './task-step-dom'
export { ENUM_DEEP_FN, VISIBLE_JS, PICK_SORT_FN, SCOPE_FN, ABSENT_FN } from './task-step-dom'
