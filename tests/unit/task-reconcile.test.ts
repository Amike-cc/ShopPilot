import { describe, it, expect } from 'vitest'
import { RECONCILE_QUEUED_SQL, RECONCILE_ACTIVE_SQL } from '../../apps/desktop/src/main/tasks/task-runner'

/**
 * 进程重启对账的单测。
 *
 * 防的是"合并或漏掉任一条"：queued 的 run 还没执行过任何步骤（内存队列随进程
 * 一起没了，不可能有副作用），running/waiting_confirmation/paused 可能停在
 * 任意步骤中间。两类必须分开说，混成一句会让用户去对账一个不存在的部分执行。
 */
describe('启动对账 · 两条语句分工', () => {
  it('queued 与 running 系分开归档（两条语句都存在）', () => {
    expect(RECONCILE_QUEUED_SQL).toContain(`WHERE status = 'queued'`)
    expect(RECONCILE_ACTIVE_SQL).toContain(`'running'`)
    expect(RECONCILE_ACTIVE_SQL).toContain(`'waiting_confirmation'`)
    expect(RECONCILE_ACTIVE_SQL).toContain(`'paused'`)
  })

  it('queued 那条不碰 running 系（不许互相覆盖）', () => {
    expect(RECONCILE_QUEUED_SQL).not.toContain('running')
    expect(RECONCILE_QUEUED_SQL).not.toContain('paused')
  })

  it('running 系那条不碰 queued（分开说的意义就在这里）', () => {
    expect(RECONCILE_ACTIVE_SQL).not.toContain(`'queued'`)
  })

  it('两条都标记失败并回填 finished_at（遗留 run 不能永远卡在非终态）', () => {
    for (const sql of [RECONCILE_QUEUED_SQL, RECONCILE_ACTIVE_SQL]) {
      expect(sql).toContain(`status = 'failed'`)
      expect(sql).toContain('finished_at')
      expect(sql).toContain('status_reason')
    }
  })

  it('queued 的文案说清"无任何步骤已执行"（与 running 的"运行中断"区分）', () => {
    expect(RECONCILE_QUEUED_SQL).toContain('排队未开始')
    expect(RECONCILE_ACTIVE_SQL).toContain('运行中断')
  })
})
