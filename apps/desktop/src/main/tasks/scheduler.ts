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
/** 每个任务"上次排期用的周期"：用于发现周期被改过并重新排期（见 tick 里的注释） */
const fireEveryMs = new Map<string, number>()

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
  let tasks: TaskStore.ScheduleCandidate[]
  try {
    // 轻量查询：每秒一拍，不能用 listTasks()（那是 1+3N 次查询，见 task-store 注释）
    tasks = TaskStore.listScheduleCandidates()
  } catch {
    return // 数据库正在恢复等瞬态
  }
  const now = Date.now()
  // 已删除任务的节拍必须清理，否则常驻内存越积越多
  if (nextFireAt.size > tasks.length) {
    const alive = new Set(tasks.map(t => t.id))
    for (const id of nextFireAt.keys()) {
      if (!alive.has(id)) { nextFireAt.delete(id); fireEveryMs.delete(id) }
    }
  }
  for (const t of tasks) {
    if (t.status !== 'active' || !t.schedule?.everyMs) continue
    if (!t.storeScope) continue // 未绑定店铺的任务不自动触发
    if (t.latestRunStatus && ['queued', 'running', 'waiting_confirmation', 'paused'].includes(t.latestRunStatus)) {
      nextFireAt.set(t.id, now + t.schedule.everyMs)
      fireEveryMs.set(t.id, t.schedule.everyMs)
      continue
    }
    /**
     * 周期被改过 → 重新排期。
     *
     * 2026-09-29 实测踩到：nextFireAt 是**内存里**的值，改任务上的 everyMs 并不会动它。
     * 把发票采集的周期从 3 小时改成 1 分钟做验证时，调度器仍按老锚点等满 3 小时——
     * 界面上周期已经显示"每 1 分钟"，实际一次也不会触发（"改了没生效"这类错觉）。
     * 这里记住每个任务上次排期用的 everyMs，不等就重新锚一次：
     * 取"新锚点"与"已排的点"里较早的那个——改短立即生效，改长则下一次仍按旧点跑一次。
     */
    const everyMs = t.schedule.everyMs
    if (!fireEveryMs.has(t.id) || fireEveryMs.get(t.id) !== everyMs) {
      const anchored = anchorNextFire(t.lastFiredAt, everyMs, now)
      const planned = nextFireAt.get(t.id)
      nextFireAt.set(t.id, planned == null ? anchored : Math.min(planned, anchored))
      fireEveryMs.set(t.id, everyMs)
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
