import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (file: string) => readFileSync(resolve(file), 'utf8')

describe('纯渲染预览的原生桥接边界', () => {
  it('设置页挂载时先判断 preload，再注册更新事件', () => {
    const source = read('apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue')
    expect(source).toMatch(/onMounted\(\(\) => \{[\s\S]{0,180}if \(!window\.shopilot\) return[\s\S]{0,180}window\.shopilot\.on/)
    expect(source).toContain('window.shopilot?.off?.(EVENT_CHANNELS.UPDATE_STATUS_CHANGED')
  })

  it('店铺页和任务页在没有 preload 时禁用会触发 IPC 的入口', () => {
    const stores = read('apps/desktop/src/renderer/src/features/workbench/UnifiedStorePage.vue')
    const tasks = read('apps/desktop/src/renderer/src/features/workbench/UnifiedTaskPage.vue')
    expect(stores).toContain('const bridgeAvailable = typeof window !== \'undefined\' && !!window.shopilot')
    expect(stores).toContain(':disabled="!bridgeAvailable"')
    expect(tasks).toContain('function requireBridge(): boolean')
    expect(tasks).toContain('if (bridgeAvailable) void ws.refreshTasks()')
  })

  it('数据页卸载时移除事件并使主体采集轮询失效', () => {
    const source = [
  'apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue',
  'apps/desktop/src/renderer/src/features/workbench/use-invoice-detail.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-tax-license.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-data-collection.ts',
    ].map(p => readFileSync(resolve(p), 'utf8')).join('\n')
    expect(source).toContain('let entityCollectGeneration = 0')
    expect(source).toContain('entityCollectGeneration++')
    expect(source).toContain('window.shopilot?.off?.(EVENT_CHANNELS.TASK_PROGRESS')
  })
})
