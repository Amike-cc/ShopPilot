import { describe, expect, it } from 'vitest'
import { sameProxyEndpoint } from '@shared/proxy-scope'

describe('代理凭据作用域', () => {
  const stored = { type: 'socks5', host: 'proxy.example.com', port: 1080 }

  it('同一 type/host/port 才允许复用已存凭据', () => {
    expect(sameProxyEndpoint(stored, { ...stored })).toBe(true)
  })

  it('只改 host / port / type 任一字段都视为另一个端点', () => {
    expect(sameProxyEndpoint(stored, { ...stored, host: 'evil.example.com' })).toBe(false)
    expect(sameProxyEndpoint(stored, { ...stored, port: 1081 })).toBe(false)
    expect(sameProxyEndpoint(stored, { ...stored, type: 'http' })).toBe(false)
  })

  it('没有已存代理时永不复用', () => {
    expect(sameProxyEndpoint(null, stored)).toBe(false)
    expect(sameProxyEndpoint(undefined, stored)).toBe(false)
  })
})
