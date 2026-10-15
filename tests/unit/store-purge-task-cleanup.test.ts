import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * B1（2026-10-15 全库审查）回归：彻底删除店铺必须连带清理该店任务。
 *
 * 背景：`tasks.store_scope` 是无外键软引用，而 `task_runs.store_id` 有
 * `REFERENCES stores(id) ON DELETE CASCADE`——店铺被"彻底删除"后它的任务成孤儿，
 * 之后每次调度触发/手动运行都会在 createRun 撞 `FOREIGN KEY constraint failed`
 *（调度器只把它当"触发失败"刷 console.error、手动运行把库报错原样丢给用户）。
 *
 * 三处防线（与仓库既有白盒测试同一风格，逐条钉住）：
 *   1) `store:purge` 处理器：回收站校验 → 取消在跑运行 → 删该店任务 → 才删店铺；
 *   2) `createRun`：外键失败换成可处置的 `STORE_NOT_FOUND`（兜底）；
 *   3) 调度器：店铺不可运行（已彻底删除 / 在回收站）的任务不触发。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const HANDLERS = read('apps/desktop/src/main/ipc/store-handlers.ts')
const STORE_MANAGER = read('apps/desktop/src/main/stores/store-manager.ts')
const TASK_STORE = read('apps/desktop/src/main/tasks/task-store.ts')
const SCHEDULER = read('apps/desktop/src/main/tasks/scheduler.ts')

describe('B1 彻底删除店铺：任务级联清理', () => {
  it('purge 处理器的顺序：先校验在回收站 → 取消运行 → 删任务 → 才调用 purgeStore', () => {
    const guardIdx = HANDLERS.indexOf('StoreManager.isStoreInTrash(storeId)')
    const cancelIdx = HANDLERS.indexOf("Runner.cancelRun(run.runId, '店铺被彻底删除')")
    const listTasksIdx = HANDLERS.indexOf('TaskStore.listTasks().filter(t => t.storeScope === storeId)')
    const purgeCallIdx = HANDLERS.indexOf('const ok = await StoreManager.purgeStore(storeId)')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(cancelIdx).toBeGreaterThan(guardIdx)
    expect(listTasksIdx).toBeGreaterThan(cancelIdx)
    expect(purgeCallIdx).toBeGreaterThan(listTasksIdx)
  })

  it('store-manager 提供 isStoreInTrash（只看 deleted_at，不猜状态文案）', () => {
    expect(STORE_MANAGER).toMatch(/export function isStoreInTrash\(storeId: string\): boolean \{[\s\S]*?deleted_at IS NOT NULL/)
  })

  it('createRun 把外键失败换成可处置的 STORE_NOT_FOUND（把库报错变成人话）', () => {
    expect(TASK_STORE).toContain("String(error?.message || '').includes('FOREIGN KEY')")
    expect(TASK_STORE).toContain('STORE_NOT_FOUND: 店铺不存在或已被彻底删除')
  })

  it('调度候选带 store_alive（未删店铺才算），tick 跳过不可运行店铺并清内存锚点', () => {
    expect(TASK_STORE).toContain('s.deleted_at IS NULL')
    expect(TASK_STORE).toContain('storeAlive: r.store_alive === 1 || r.store_scope == null')
    expect(SCHEDULER).toContain('if (!t.storeAlive)')
    const skipIdx = SCHEDULER.indexOf('if (!t.storeAlive)')
    expect(SCHEDULER.indexOf('nextFireAt.delete(t.id)', skipIdx)).toBeGreaterThan(skipIdx)
  })
})
