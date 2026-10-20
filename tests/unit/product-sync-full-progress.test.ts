import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 全量同步「详情阶段进度 + 取消」的接线守卫（2026-10-21 审查 P2-5）。
 *
 * 与 image-studio-parity / graphic-sell-page 同模式：源码扫描式守卫。
 * 钉的不是实现细节，是四层契约的接缝——任何一层把接线拆了（比如事件频道改名、
 * 订阅没退、preload 声明丢了），这里先红，而不是等用户在真机上发现进度不动/取消失灵。
 */
const readSource = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

const shared = readSource('packages/shared/src/contracts/ipc.ts')
const service = readSource('apps/desktop/src/main/products/product-sync-service.ts')
const handlers = readSource('apps/desktop/src/main/ipc/product-handlers.ts')
const preload = readSource('apps/desktop/src/preload/index.ts')
const env = readSource('apps/desktop/src/renderer/src/env.d.ts')
const page = readSource('apps/desktop/src/renderer/src/features/products/ProductManagementPage.vue')

describe('全量同步进度与取消：四层接线守卫（shared → service → preload → 页面）', () => {
  it('shared 契约：取消通道与进度事件频道存在，且事件 payload 只承诺计数不承诺商品正文', () => {
    expect(shared).toContain("PRODUCT_SYNC_FULL_CANCEL: 'products:syncFullCancel'")
    expect(shared).toContain("PRODUCT_SYNC_FULL_PROGRESS: 'products:syncFullProgress'")
  })

  it('主进程 service：取消标志在下一条前消费、循环让出事件循环、每条后推送进度', () => {
    // 取消标志的消费点必须在 collectDetail 之前——否则"取消"要等当前这条跑完才生效
    expect(service).toContain('this.fullSyncCancelFlags.has(storeKey)')
    expect(service.indexOf('this.fullSyncCancelFlags.has(storeKey)'))
      .toBeLessThan(service.indexOf('await collectDetail('))
    // 每条之间让出事件循环：详情单条最长几十秒，不让出会饿死其它 IPC
    expect(service).toContain('setImmediate(resolve)')
    expect(service).toContain('emitToRenderer(EVENT_CHANNELS.PRODUCT_SYNC_FULL_PROGRESS')
    // 中断轮次必须如实告知剩余未采集，不允许把中断轮宣称为完整
    expect(service).toContain('已按用户要求中断')
    // 无在跑的同步时取消请求如实返回 false
    expect(service).toContain('requestFullSyncCancel')
  })

  it('主进程 handler：取消 IPC 已注册且校验 storeId', () => {
    expect(handlers).toContain('IPC_CHANNELS.PRODUCT_SYNC_FULL_CANCEL')
  })

  it('preload 与 env.d.ts：syncFullCancel 暴露与声明成对存在', () => {
    expect(preload).toContain('syncFullCancel')
    expect(env).toContain('syncFullCancel')
  })

  it('页面：进度显示与取消按钮只在抓取中渲染，事件订阅随组件卸载成对退订', () => {
    expect(page).toContain('product-sync-full-progress')
    expect(page).toContain('product-sync-full-cancel-')
    // 取消按钮只在当前店抓取中时出现
    expect(page).toContain('v-if="fullSyncingStoreId === store.id"')
    // 订阅/退订成对（组件卸载不残留监听器）
    expect(page).toContain('window.shopilot.on(EVENT_CHANNELS.PRODUCT_SYNC_FULL_PROGRESS')
    expect(page).toContain('window.shopilot.off(EVENT_CHANNELS.PRODUCT_SYNC_FULL_PROGRESS')
    expect(page).toContain('onUnmounted(')
  })
})
