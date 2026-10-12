import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_SERVICE_PLATFORMS,
  customerServiceSessionPartition,
  isAllowedCustomerServiceUrl
} from '../../packages/shared/src/contracts/customer-service'
import { storeSessionPartition } from '../../packages/shared/src/contracts/shop-session'
import { resolveCustomerServiceNavigationUrl } from '../../apps/desktop/src/renderer/src/features/customer-service/customer-service-navigation'

describe('店铺客服浏览器会话共享与隔离', () => {
  it('同店客服与工作台共享持久分区，不同店铺仍保持隔离', () => {
    const storeA = customerServiceSessionPartition('store-a')
    const storeB = customerServiceSessionPartition('store-b')

    expect(storeA).toBe('persist:store_store-a')
    expect(storeB).toBe('persist:store_store-b')
    expect(storeA).toBe(storeSessionPartition('store-a'))
    expect(storeB).toBe(storeSessionPartition('store-b'))
    expect(storeA).not.toBe(storeB)
    expect(storeA.startsWith('persist:')).toBe(true)
    expect(storeB.startsWith('persist:')).toBe(true)
  })

  it('重建店铺页面时恢复该店铺平台允许范围内的最近地址', () => {
    const entry = CUSTOMER_SERVICE_PLATFORMS['拼多多'].url
    const remembered = 'https://mms.pinduoduo.com/chat-merchant/session/42'
    expect(resolveCustomerServiceNavigationUrl('拼多多', entry, remembered, true)).toBe(remembered)
    expect(resolveCustomerServiceNavigationUrl('拼多多', entry, remembered, false)).toBe(entry)
  })

  it('不恢复非 HTTPS、未授权平台域名或伪装主机名', () => {
    const prepared = CUSTOMER_SERVICE_PLATFORMS['拼多多'].url
    for (const remembered of ['file:///secret', 'javascript:alert(1)', 'http://mms.pinduoduo.com/chat', 'https://mms.pinduoduo.com.evil.test/chat']) {
      expect(resolveCustomerServiceNavigationUrl('拼多多', prepared, remembered, true)).toBe(prepared)
    }
    expect(resolveCustomerServiceNavigationUrl('拼多多', 'https://evil.test/', 'https://mms.pinduoduo.com/chat', true)).toBe('')
  })

  it('客服平台、后台监控和可见工作区共用精确的 HTTPS 主机白名单', () => {
    expect(isAllowedCustomerServiceUrl('抖店', 'https://fxg.jinritemai.com/login')).toBe(true)
    expect(isAllowedCustomerServiceUrl('微信小店', 'https://open.weixin.qq.com/connect/qrconnect')).toBe(true)
    expect(isAllowedCustomerServiceUrl('拼多多', 'http://mms.pinduoduo.com/chat')).toBe(false)
    expect(isAllowedCustomerServiceUrl('拼多多', 'https://mms.pinduoduo.com.attacker.test/chat')).toBe(false)
    expect(isAllowedCustomerServiceUrl('拼多多', 'https://unlisted.pinduoduo.com/chat')).toBe(false)
  })
})
