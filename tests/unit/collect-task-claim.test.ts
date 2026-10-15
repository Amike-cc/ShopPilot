import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pickLatestCollectTask } from '@shared/constants/collection'

/**
 * 采集任务"认领口径"的回归（2026-10-15 审查 C2/C3）。
 *
 * 背景：认领任务（点「采集」复用哪个任务）与改周期（自动更新开关、状态条看哪个任务）
 * 曾经是两套口径——认领按 `updatedAt` 最新，开关按列表序（created_at DESC）拿第一个。
 * 库里只要存在历史重复的同名任务（真实出现过：46 个「发票采集 ·」里 41 个是积压），
 * 两套口径就可能命中不同任务：开关把周期挂到 A，采集却复用 B 跑——用户看到
 * "开了自动更新但数据不动"。现在全部统一到 `pickLatestCollectTask`，这里同时钉住：
 *   1) 纯函数本身的行为；2) 渲染层四处用点确实都在用它（不再有旧的"列表序"写法）；
 *   3) C2：任务有未结束运行时含 steps 的更新会被拒，代码必须去掉 steps 重试并如实留痕，
 *      不能一边宣称"每 3 小时自动更新"、一边什么都没写上。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const PAGE = read('apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue')

describe('pickLatestCollectTask：认领"这家店的采集任务"的唯一口径', () => {
  const task = (id: string, storeScope: string, name: string, updatedAt: number) => ({ id, storeScope, name, updatedAt })

  it('取 updatedAt 最新的，而不是列表里先出现的（列表序是 created_at DESC，两者可以不同）', () => {
    const picked = pickLatestCollectTask([
      task('newest-created', 's1', '发票采集 ·微信小店', 100),
      task('newest-updated', 's1', '发票采集 ·微信小店', 900)
    ], 's1', '发票采集 ·')
    expect(picked?.id).toBe('newest-updated')
  })

  it('只认同一家店、同一前缀：别的店 / 别的前缀 / 用户自建任务都不碰', () => {
    const list = [
      task('a', 's1', '发票采集 ·微信小店', 100),
      task('b', 's2', '发票采集 ·抖店', 500),          // 别的店
      task('c', 's1', '订单明细采集 ·微信小店', 600),   // 别的前缀
      task('d', 's1', '自定义任务 · 九月对账', 700)      // 用户自建（名字里没有采集前缀）
    ]
    expect(pickLatestCollectTask(list, 's1', '发票采集 ·')?.id).toBe('a')
  })

  it('updatedAt 缺失按 0 处理（平手保留先遇到的）；名字为空不崩；空列表给 null', () => {
    const list = [
      { id: 'no-updated', storeScope: 's1', name: '发票采集 ·云店' } as any,
      task('zero', 's1', '发票采集 ·云店', 0)
    ]
    expect(pickLatestCollectTask(list, 's1', '发票采集 ·')?.id).toBe('no-updated')
    expect(pickLatestCollectTask([{ id: 'x', storeScope: 's1', updatedAt: 5 } as any], 's1', '发票采集 ·')).toBeNull()
    expect(pickLatestCollectTask([], 's1', '发票采集 ·')).toBeNull()
  })
})

describe('渲染层：认领、开关、状态条、主体认领四处共用一个口径（C3）', () => {
  it('pickLatestCollectTask 至少四处在用（ensureCollectTask / invoiceSchedule / toggleInvoiceSchedule / ensureEntityCollectTask）', () => {
    const uses = PAGE.match(/pickLatestCollectTask\(/g) || []
    expect(uses.length, '四处用点都要走统一口径').toBeGreaterThanOrEqual(4)
  })

  it('不再有"按列表序拿第一个"的旧写法（ws.tasks.find 直取 + updatedAt 排序取 [0]）', () => {
    expect(PAGE).not.toContain('ws.tasks.find(')
    expect(PAGE).not.toMatch(/\.sort\(\(a, b\) => Number\(b\.updatedAt/)
  })
})

describe('更新被拒时如实留痕（C2）', () => {
  it('含 steps 的更新被拒 → 去掉 steps 重试（name/schedule 运行中允许改），不静默丢弃返回值', () => {
    expect(PAGE).toMatch(/const updated = await window\.shopilot\.task\.update\(\{ taskId: existing\.id, name, steps, schedule \}\)/)
    expect(PAGE).toMatch(/const retried = await window\.shopilot\.task\.update\(\{ taskId: existing\.id, name, schedule \}\)/)
    expect(PAGE).toMatch(/updateWarning: retried\.ok \? null :/)
  })

  it('toast 在同一条里点名"配置未能更新"的店（不能只说"已启动 N 个采集任务"）', () => {
    expect(PAGE).toContain('stuckNote')
    expect(PAGE).toMatch(/的任务配置未能更新/)
    expect(PAGE).toMatch(/ws\.toast\(created \? `已启动 \$\{created\} 个采集任务\$\{suffix\}\$\{stuckNote\}`/)
  })
})
