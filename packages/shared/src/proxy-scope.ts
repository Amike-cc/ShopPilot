/**
 * 代理凭据作用域（2026-11-09 审查）。
 *
 * 已保存代理的账号密码只能用于**同一 type/host/port** 的探测；
 * 只凭一个 proxyId 就把凭据解密并发往任意 host，是凭据外发通道。
 */
export interface ProxyEndpointLike {
  type: string
  host: string
  port: number
}

export function sameProxyEndpoint(stored: ProxyEndpointLike | null | undefined, draft: ProxyEndpointLike): boolean {
  return !!stored && stored.type === draft.type && stored.host === draft.host && stored.port === draft.port
}
