import { describe, it, expect } from 'vitest'
import { assertNavigableUrl } from '@shared/navigation'

/**
 * 导航 URL 协议白名单的回归单测（§10.1）。
 *
 * 为什么单独钉住：渲染层传进来的 URL、页面 window.open 的目标、DB 里存的老 URL
 * 都会流到 loadURL。漏掉一处白名单，`javascript:` 就能在店铺页面里执行——
 * 这是本轮审查发现的唯一安全缺口（主进程入口已收敛到此函数，改动此处必须同步改调用点）。
 */
describe('assertNavigableUrl · 协议白名单', () => {
  it('放行 http/https/about', () => {
    expect(assertNavigableUrl('https://store.weixin.qq.com/')).toContain('https://')
    expect(assertNavigableUrl('http://localhost:3000/')).toContain('http://')
    expect(assertNavigableUrl('about:blank')).toBe('about:blank')
  })

  it('拦截 javascript:/file:/data:/blob:', () => {
    for (const evil of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'file:///C:/secret.txt',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/uuid',
    ]) {
      expect(() => assertNavigableUrl(evil), evil).toThrow(/Navigation blocked/)
    }
  })

  it('非法字符串也拦截（不是合法 URL 就别进 loadURL）', () => {
    expect(() => assertNavigableUrl('')).toThrow(/Navigation blocked/)
    expect(() => assertNavigableUrl('not a url')).toThrow(/Navigation blocked/)
  })
})
