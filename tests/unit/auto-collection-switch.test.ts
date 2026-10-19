/**
 * 「取消自动采集、改为手动」的回归测试。
 *
 * 背景（2026-10-04 用户要求）：之前应用会**自己**给店铺建 enabled=1 的计划（每 10 分钟一采），
 * 还有每 3 小时的定时任务（发票采集）——用户在不知情的情况下一直被自动采集。
 * 现在默认关闭：缺省、乱填、读不到都按"手动"算，只有界面明确打开才自动跑。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AUTO_COLLECTION_DEFAULT, AUTO_COLLECTION_SETTING, parseAutoCollectionEnabled } from '@shared/constants/collection'

describe('自动采集总开关的解析（fail-closed）', () => {
  it('默认是关的', () => {
    expect(AUTO_COLLECTION_DEFAULT).toBe(false)
    expect(parseAutoCollectionEnabled(undefined)).toBe(false)
    expect(parseAutoCollectionEnabled(null)).toBe(false)
  })

  it('只有明确表示"开"的值才算开', () => {
    for (const value of [true, 1, 'true', 'TRUE', ' true ', '1']) {
      expect(parseAutoCollectionEnabled(value)).toBe(true)
    }
  })

  it('乱填/其它类型一律按关处理（宁可少采，不可偷偷采）', () => {
    for (const value of [false, 0, 'false', 'no', 'yes', '', '  ', '2', {}, [], { enabled: true }]) {
      expect(parseAutoCollectionEnabled(value)).toBe(false)
    }
  })

  it('设置键名固定为 collection.autoEnabled（渲染层与主进程共用）', () => {
    expect(AUTO_COLLECTION_SETTING).toBe('collection.autoEnabled')
  })

  it('发票中心读总开关用 shared 常量与解析（不许手抄 key，不许 === true 自造口径）', () => {
    // 2026-10-15 审查 M3：以前手抄 'collection.autoEnabled' 且 === true 判定——
    // 存量值为 1/"true" 时主进程按"开"跑、界面却显示"总开关是关的"（假状态）
    const page = [
  'apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue',
  'apps/desktop/src/renderer/src/features/workbench/use-invoice-detail.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-tax-license.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-data-collection.ts',
    ].map(p => readFileSync(resolve(p), 'utf8')).join('\n')
    expect(page).toContain('parseAutoCollectionEnabled')
    expect(page).toContain('settings.get(AUTO_COLLECTION_SETTING)')
    expect(page, '不许再手抄设置键字面量').not.toContain("= 'collection.autoEnabled'")
  })
})
