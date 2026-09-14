/** 临时：导出微信 builder 的真实步骤 JSON（供真机执行用），跑完即可删 */
import { describe, it } from 'vitest'
import fs from 'node:fs'
import { inviteProfileFor } from '../../packages/shared/src/constants/invite'
import { buildInviteSteps } from '../../packages/shared/src/invite-steps'

describe('导出微信邀约步骤（临时）', () => {
  it('dump', () => {
    const p = inviteProfileFor('微信小店')!
    const steps = buildInviteSteps(p, {
      assist: {
        contact: '测试联系人',
        wechat: 'test_wx_001',
        phone: '13800000000',
        script: '您好，我们是店铺方，想邀请您合作带货：专属高佣 + 免费寄样，提供现成素材，发货售后我们全包。',
        scriptMode: 'manual',
        productCount: 1,
        productIds: ['10000687986563'],
        finderType: '直播带货者',
        finderCategories: ['母婴'],
        finderOtherFilters: ['有联系方式']
      }
    }, 'https://store.weixin.qq.com/shop/findersquare/find')
    fs.writeFileSync('wx-invite-test/wx-steps.json', JSON.stringify(steps, null, 1))
    console.log('dumped steps:', steps.length, 'top-level; nested:', (steps[0] as any).input.steps.length, 'label len:', String((steps[0] as any).input.label).length)
  })
})
