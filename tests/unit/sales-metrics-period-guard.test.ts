import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { businessProfileFor, BUSINESS_PROFILES } from '@shared/constants/business'

/**
 * 「周期真的切过去了」的判据（2026-09-28 实测事故后补的护栏）。
 *
 * 事故经过：微信小店的采集点了「近7天」，但那次点击没生效，页面还停在默认的「今天」视图，
 * 于是 `¥0 / 0 单`（今天）被当成 `LAST_7_DAYS` 写进了库——而近7天真实值是 `¥108.90 / 11 单`。
 * 旧实现只验证"点到了控件"（`clickText` 返回 true 仅表示"在元素上派发了点击"），
 * 没验证"周期已生效"。把默认周期的数字标成目标周期，比没有数字更糟。
 *
 * 现在的判据（任一成立即可，都不成立就报 `PERIOD_NOT_APPLIED` 且不写任何字段）：
 *   ① 首个指标的值与点击前不同；
 *   ② 档案声明的 `periodAppliedText` 出现（微信实测：近7天视图显示「较上周期 X%」，
 *      默认「今天」视图显示的是「昨日 X」）。
 */

const ADAPTER_SRC = readFileSync(resolve('apps/desktop/src/main/platform-adapters/sales-metrics-dom-adapter.ts'), 'utf8')

describe('经营数据采集的周期生效判据', () => {
  it('微信小店：档案声明了可区分的切换判据（实测「较上周期」只在近7天视图出现）', () => {
    const weixin = businessProfileFor('微信小店')!
    expect(weixin.periodText).toBe('近7天')
    expect(weixin.periodAppliedText).toBe('较上周期')
  })

  it('快手小店：不声明「较上周期」——它在两个视图里都出现，声明了反而会让判据恒真', () => {
    // 实测（2026-09-28）：快手商品总览在默认视图与近7日视图都显示「较上周期-」，
    // 因此它只能靠判据①（值变化：昨日 ¥0 → 近7日 ¥9.80）。
    const kuaishou = businessProfileFor('快手小店')!
    expect(kuaishou.periodText).toBe('近7日')
    expect(kuaishou.periodAppliedText).toBeUndefined()
  })

  it('判据③：页面本来就停在目标周期时（点击是空操作）也要认，不能被判成 PERIOD_NOT_APPLIED', () => {
    // 实测（2026-09-29）：快手计划连续 9 次 PERIOD_NOT_APPLIED，快照里写着"点了「近7日」但
    // 读数仍是 9.8"——页面已经停在近7日（SPA 记住上次选择），再点同一个页签当然不会变值，
    // 于是判据①②必然都不成立。判据③读控件自身的选中态（选中色与同组页签不同），
    // 点击前也认：那时读到的值**就是**目标周期的值。
    expect(ADAPTER_SRC).toContain('readPeriodControlState')
    expect(ADAPTER_SRC).toContain('periodStateBefore')
    expect(ADAPTER_SRC).toContain('CONTROL_SELECTED')
    expect(ADAPTER_SRC).toContain('BASE_SELECTED')
    // 判据③不能把 2026-09-28 的护栏拆掉：点击失败后页面仍停在默认周期 → 目标页签不呈现选中态 → 仍报错
    expect(ADAPTER_SRC).toContain("reasonCode: 'PERIOD_NOT_APPLIED'")
  })

  it('判据③是"与同组页签比较配色"，不是在页面里找固定的颜色值', () => {
    const reader = readFileSync(resolve('apps/desktop/src/main/platform-adapters/sales-metrics-page-reader.ts'), 'utf8')
    expect(reader).toContain('readPeriodControlState')
    // 与同组页签逐个比较（写死某个 rgb 会在平台换肤/夜间模式时静默失效）
    expect(reader).toContain('SELECTED_BY_STYLE')
    expect(reader).toContain('SAME_AS_SIBLINGS')
    expect(reader).not.toMatch(/selected\s*=\s*.*rgb\(/)
  })

  it('所有声明了周期控件的档案都必须注明"默认口径与目标口径不同"（否则判据①不成立）', () => {
    for (const profile of Object.values(BUSINESS_PROFILES)) {
      if (!profile.periodText) continue
      // 声明 periodText = 页面上有周期控件；采集侧靠"值变化"或"文案标记"确认切换成功。
      // 若某平台的默认周期本来就是目标周期，判据①会恒假 —— 那种情况必须补 periodAppliedText。
      expect(profile.salesPeriodType, `${profile.platform} 需要明确目标口径`).toBeTruthy()
    }
  })

  it('采集侧确实执行了验证，且失败时不写数据（源码级护栏）', () => {
    // 失败路径：周期没生效 → ERROR + PERIOD_NOT_APPLIED（不是静默按目标周期落库）
    expect(ADAPTER_SRC).toContain('PERIOD_NOT_APPLIED')
    // 两个判据都要在：点击前先记值 → 点击后比对
    expect(ADAPTER_SRC).toContain('beforeClick')
    expect(ADAPTER_SRC).toContain('afterClick')
    expect(ADAPTER_SRC).toContain('valueChanged')
    expect(ADAPTER_SRC).toContain('periodAppliedText')
    // 文案判据要穿透 ShadowRoot（微信小店的经营数据区整页在 micro-app 的 ShadowRoot 内）
    expect(ADAPTER_SRC).toContain('shadowRoot')
    // 周期验证失败必须发生在"逐锚点读值"之前：上面的判据失败要 return，不能继续读
    const appliedIndex = ADAPTER_SRC.indexOf('PERIOD_NOT_APPLIED')
    const readLoopIndex = ADAPTER_SRC.indexOf('// 3. 逐锚点读值')
    expect(appliedIndex).toBeGreaterThan(0)
    expect(readLoopIndex).toBeGreaterThan(appliedIndex)
  })
})
