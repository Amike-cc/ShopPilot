import { describe, it, expect } from 'vitest'
import { taskCreateSchema } from '../../apps/desktop/src/main/tasks/task-step-schemas'
import { agentScheduleSchema } from '@shared/schemas/agent'

/**
 * 任务周期（schedule）的字段形状。
 *
 * 2026-09-29 实测踩到的坑：主进程 `task-step-schemas.ts` 里**另写了一份** schedule
 * （`z.object({ everyMs })` 且非 strict），调用方传的 `backgroundOpen` 被静默剥掉——
 * 于是"定时任务到点自动把店铺页面开起来"的开关永远是假：界面显示"已启用 3 小时自动更新"，
 * 实际每次触发都只是把 run 排队等人开页面，无人值守时一次都采不到（有状态没结果）。
 * 这类"两处定义漂移 + zod 静默 strip"只能靠断言钉住。
 */
describe('任务 schedule 字段', () => {
  it('主进程任务 schema 与 agent schedule 是同一份定义（都保留 backgroundOpen）', () => {
    const input = { everyMs: 3 * 60 * 60 * 1000, backgroundOpen: true }
    expect(agentScheduleSchema.parse(input)).toEqual(input)
    expect(taskCreateSchema.shape.schedule.parse(input)).toEqual(input)
  })

  it('backgroundOpen 可省略（默认"不静默拉起"，保持排队等人开页面）', () => {
    expect(taskCreateSchema.shape.schedule.parse({ everyMs: 60000 })).toEqual({ everyMs: 60000 })
    expect(taskCreateSchema.shape.schedule.parse(null)).toBeNull()
  })

  it('周期下限仍是一分钟（防手滑写成每秒触发）', () => {
    expect(taskCreateSchema.shape.schedule.safeParse({ everyMs: 5_000 }).success).toBe(false)
  })
})
