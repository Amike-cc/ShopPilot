import { describe, it, expect, vi } from 'vitest'

/**
 * 日志值级脱敏（§22）单测。
 *
 * 这里**不起 Electron**：logger 只在真正写日志时才用 app.getPath（日志目录），
 * 本文件只测纯函数 redactSecretValues，所以用一个最小 electron mock 让模块能在 node 下加载。
 */
vi.mock('electron', async () => {
  const os = await import('node:os')
  return { app: { getPath: () => os.tmpdir() } }
})

const { redactSecretValues } = await import('../../apps/desktop/src/main/services/logger')

const MASK = '[已隐藏]'

describe('日志值级脱敏', () => {
  it('URL 查询参数：参数名保留、值一律掩码（覆盖不在关键词表里的 sessionid/code）', () => {
    const out = redactSecretValues('url=https://proxy.example.com/auth?token=abc123&sessionid=deadbeef&next=/home')
    expect(out).toContain('token=' + MASK)
    expect(out).toContain('sessionid=' + MASK)
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('deadbeef')
    // 参数名与路径要留着，否则日志失去排查价值
    expect(out).toContain('https://proxy.example.com/auth?token=')
  })

  it('账号口令：user/password 的值就地掩码', () => {
    const out = redactSecretValues('[login] username=alice password=m4-pass-12345')
    expect(out).not.toContain('alice')
    expect(out).not.toContain('m4-pass-12345')
    expect(out).toContain('username=' + MASK)
  })

  it('认证头与 Cookie：值掩码到行尾（Cookie 含多个 name=value 也不漏）', () => {
    const auth = redactSecretValues('Proxy-Authorization: Basic dXNlcjpwYXNz')
    expect(auth).not.toContain('dXNlcjpwYXNz')
    expect(auth).toContain(MASK)

    const cookie = redactSecretValues('Cookie: sid=abcdef; uid=42')
    expect(cookie).not.toContain('abcdef')
    expect(cookie).not.toContain('uid=42')
  })

  it('裸令牌：Bearer 之后的一段凭据掩码', () => {
    const out = redactSecretValues('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(out).toContain(MASK)
  })

  it('普通文本原样保留（不误伤可排查信息）', () => {
    const text = 'store tab renderer gone store=store_1 tab=tab_2 reason=oom exitCode=5'
    expect(redactSecretValues(text)).toBe(text)
  })
})
