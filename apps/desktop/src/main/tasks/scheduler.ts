/**
 * Scheduler - §4.4
 * 只负责"到点创建 run 并入队"，本身不接触页面；
 * 调度触发与手动触发共享同一确认门禁；店铺未打开时保持 queued 并提示（不静默拉起）。
 */

import * as TaskStore from './task-store'
import { fireScheduled } from './task-runner'

let timer: NodeJS.Timeout | null = null
/** 内存中的下次触发时间；首次见到任务 = now + everyMs（不做停机补偿突发触发） */
const nextFireAt = new Map<string, number>()

export function startScheduler(): void {
  if (timer) return
  timer = setInterval(tick, 1000)
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null }
}

/**
 * 重启后首次节拍的锚定计算（纯函数，单测锁定）。
 *
 * 锚到上次真实触发（tasks.last_fired_at）而不是"重启时刻 + 周期"，
 * 否则每次重启都把节拍重置一次，触发时刻越漂越远。
 * 停机期间错过的周期不补偿（立即连发一堆积压 run 比晚一次危险得多），直接开新周期。
 */
export function anchorNextFire(lastFiredAt: unknown, everyMs: number, now: number): number {
  const anchored = typeof lastFiredAt === 'number' && lastFiredAt > 0
    ? lastFiredAt + everyMs
    : now + everyMs
  return anchored > now ? anchored : now + everyMs
}

function tick(): void {
  let tasks
  try {
    tasks = TaskStore.listTasks()
  } catch {
    return // 数据库正在恢复等瞬态
  }
  const now = Date.now()
  for (const t of tasks) {
    if (t.status !== 'active' || !t.schedule?.everyMs) continue
    if (!t.storeScope) continue // 未绑定店铺的任务不自动触发
    if (t.latestRun && ['queued', 'running', 'waiting_confirmation', 'paused'].includes(t.latestRun.status)) {
      nextFireAt.set(t.id, now + t.schedule.everyMs)
      continue
    }
    if (!nextFireAt.has(t.id)) {
      nextFireAt.set(t.id, anchorNextFire(t.lastFiredAt, t.schedule.everyMs, now))
    }
    if (now >= nextFireAt.get(t.id)!) {
      nextFireAt.set(t.id, now + t.schedule.everyMs)
      fire(t.id)
    }
  }
}

function fire(taskId: string): void {
  try {
    fireScheduled(taskId)
    TaskStore.setLastFired(taskId, Date.now())
  } catch (e) {
    console.error('[scheduler] 触发失败', taskId, e)
  }
}

/** 测试/诊断用：立即触发某任务（与到点触发同一路径，语义一致） */
export function fireNow(taskId: string): ReturnType<typeof fireScheduled> {
  const ev = fireScheduled(taskId)
  TaskStore.setLastFired(taskId, Date.now())
  return ev
}
