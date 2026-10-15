import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * B2（2026-10-15 全库审查）回归：删除"运行中"任务的竞态。
 *
 * 背景：cancelRun 是**协作式**的（running/waiting_confirmation 只置标志，由执行循环在
 * 下一个检查点感知），而 TASK_DELETE 以前 cancel 后立即级联删行——在途 run 的下一次写库
 * （insertStepResult）会撞 run_id 外键，把"已执行成功的步骤"误判为失败。
 *
 * 修复三处：
 *   1) TASK_DELETE：删除前**有界等待**运行真正到终态（最多 8 秒），等不到如实拒绝；
 *   2) insertStepResult：run 已被删（外键失败）时不再抛，如实记日志返回 ''；
 *   3) 任务中心：删除确认把"先停止运行"说清楚。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const HANDLERS = read('apps/desktop/src/main/ipc/task-handlers.ts')
const TASK_STORE = read('apps/desktop/src/main/tasks/task-store.ts')
const PAGE = read('apps/desktop/src/renderer/src/features/workbench/UnifiedTaskPage.vue')

describe('B2 删除运行中任务：有界等待 + 外键兜底', () => {
  it('TASK_DELETE：先协作取消，再有界等待（8s）到终态后才删；删除动作在等待之后', () => {
    expect(HANDLERS).toContain("Runner.cancelRun(activeRunId, '任务被删除')")
    expect(HANDLERS).toContain('const deadline = Date.now() + 8000')
    expect(HANDLERS).toContain('Runner.listLiveRuns().some(r => r.runId === activeRunId)')
    expect(HANDLERS).toContain('运行仍在停止中（可能正停在长等待步骤），请稍等几秒后重试删除')
    const waitIdx = HANDLERS.indexOf('const deadline = Date.now() + 8000')
    const delIdx = HANDLERS.indexOf('TaskStore.deleteTask(input.taskId)')
    expect(waitIdx).toBeGreaterThan(-1)
    expect(delIdx).toBeGreaterThan(waitIdx)
  })

  it('insertStepResult：外键失败（运行记录已被删）不再抛——不再把"已执行的步骤"误判为失败', () => {
    expect(TASK_STORE).toContain('步骤结果未落库：运行记录已不存在')
    expect(TASK_STORE).toMatch(/步骤结果未落库[\s\S]{0,200}return ''/)
  })

  it('任务中心的删除确认把"会先停止运行"说清楚（运行中任务）', () => {
    expect(PAGE).toContain('删除会先停止运行（最多等几秒）')
    expect(PAGE).toContain('isActive(task)')
  })
})
