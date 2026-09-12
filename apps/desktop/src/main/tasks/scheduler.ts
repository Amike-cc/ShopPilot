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
    if (!nextFireAt.has(t.id)) nextFireAt.set(t.id, now + t.schedule.everyMs)
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
