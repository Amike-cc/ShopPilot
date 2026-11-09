import { describe, expect, it } from 'vitest'
import { isProxyLoadFailure } from '@shared/view-state'

describe('代理类加载失败判定', () => {
  it('proxy / tunnel / auth 才算店铺级代理异常', () => {
    expect(isProxyLoadFailure('net::ERR_PROXY_CONNECTION_FAILED')).toBe(true)
    expect(isProxyLoadFailure('net::ERR_TUNNEL_CONNECTION_FAILED')).toBe(true)
    expect(isProxyLoadFailure('Proxy Authentication Required')).toBe(true)
  })

  it('普通 DNS/连接拒绝/证书错误不算代理异常', () => {
    expect(isProxyLoadFailure('net::ERR_NAME_NOT_RESOLVED')).toBe(false)
    expect(isProxyLoadFailure('net::ERR_CONNECTION_REFUSED')).toBe(false)
    expect(isProxyLoadFailure('net::ERR_CERT_AUTHORITY_INVALID')).toBe(false)
    expect(isProxyLoadFailure(null)).toBe(false)
  })
})
