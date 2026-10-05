/**
 * 定时任务调度器必须受"自动采集总开关"约束（2026-10-04 用户要求改为手动）。
 *
 * 为什么用源码级守卫：任务调度器的节拍依赖 TaskStore + 任务执行器（会拉浏览器），
 * 单测里跑一整套得等 3 小时周期或伪造一大堆依赖。这里钉住的是"开关判断一定在点火之前"
 * 这个结构事实——删掉/挪到点火之后就红。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(__dirname, '../../apps/desktop/src/main/tasks/scheduler.ts'), 'utf8')

describe('定时任务调度的自动采集门禁', () => {
  it('tick 里在触发任务之前先判断总开关', () => {
    const gate = source.indexOf('isAutoCollectionEnabled()')
    const fire = source.indexOf('fire(t.id)')
    expect(gate, 'scheduler.ts 里必须有 isAutoCollectionEnabled() 门禁').toBeGreaterThan(-1)
    expect(fire, 'scheduler.ts 里应当有触发点 fire(t.id)').toBeGreaterThan(-1)
    expect(gate, '门禁必须出现在触发点之前（在触发之后判断等于没拦）').toBeLessThan(fire)
  })

  it('关闭时清空内存排期，避免重新打开时把停机期间的积压一次性补发', () => {
    expect(source).toMatch(/nextFireAt\.clear\(\)/)
    expect(source).toMatch(/fireEveryMs\.clear\(\)/)
  })

  it('销售采集调度器同样受约束：syncPlans 与周期扫描都走同一个判断点', () => {
    const sales = readFileSync(resolve(__dirname, '../../apps/desktop/src/main/sales-metrics/sales-metrics-scheduler.ts'), 'utf8')
    expect(sales).toMatch(/function autoCollectionOn\(\)/)
    // 周期扫描：关着时 listDuePlans 不该被调用
    expect(sales).toMatch(/autoEnabled \? runtime\(\)\.ledger\.listDuePlans\(now, capacity\) : \[\]/)
    // 计划同步与按需补建都传同一个开关值
    const uses = sales.match(/autoEnabled: autoCollectionOn\(\)/g) || []
    expect(uses.length).toBeGreaterThanOrEqual(2)
  })
})
