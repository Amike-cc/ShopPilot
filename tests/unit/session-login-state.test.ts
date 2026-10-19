/**
 * 「主动检测登录状态」纯逻辑的回归测试。
 *
 * 最要命的一条：**拿不到证据时不许说"已登录"**。主进程的 UNKNOWN 表示"这次没拿到
 * 证据"（页面没开 / 当前标签页不是档案页 / 检测超时），结构不认识更是连字段都对不上；
 * 这两种都必须如实说「未识别」、`expired: false`，绝不能顺着某个默认值放行。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  canCheckLogin,
  describeLoginCheckResult,
  loginCheckBlockedReason,
  loginCheckButtonText
} from '../../apps/desktop/src/renderer/src/features/workbench/session-login-state'

const MODULE_PATH = 'apps/desktop/src/renderer/src/features/workbench/session-login-state.ts'

/** session.checkLoginStatus 成功返回的形状（会话摘要 + platformLogin）。 */
const payload = (login: Record<string, unknown> | null, summary: Record<string, unknown> = {}) => ({
  storeId: 'store-1',
  status: 'READY',
  sessionPresent: true,
  sessionReady: true,
  loginStatus: 'UNKNOWN',
  ...summary,
  platformLogin: login
})

const platformLogin = (status: string, reasonCode = 'TEST_CODE', safeMessage = '测试安全文案') =>
  ({ platform: 'douyin', storeId: 'store-1', status, checkedAt: 1, reasonCode, safeMessage, evidenceType: 'DOM' })

describe('session-login-state：模块边界', () => {
  it('纯模块，不 import vue / electron / DOM（保持可单测）', () => {
    const source = readFileSync(resolve(MODULE_PATH), 'utf8')
    expect(source).not.toMatch(/from\s+['"]vue['"]/)
    expect(source).not.toMatch(/from\s+['"]electron['"]/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
  })
})

describe('session-login-state：已登录 / 需验证 / 失败', () => {
  it('确认已登录 → success「已登录」，不是过期', () => {
    const view = describeLoginCheckResult(payload(platformLogin('LOGGED_IN', 'EVIDENCE_OK', '平台登录状态已确认')))
    expect(view.tone).toBe('success')
    expect(view.label).toBe('已登录')
    expect(view.expired).toBe(false)
    expect(view.detail).toBe('平台登录状态已确认（EVIDENCE_OK）')
  })

  it('需要安全验证 → warning「需要安全验证」，不属于过期', () => {
    const view = describeLoginCheckResult(payload(platformLogin('VERIFY_REQUIRED', 'EXPLICIT_VERIFY_PAGE', '需要在店铺浏览器中完成安全验证')))
    expect(view.tone).toBe('warning')
    expect(view.label).toBe('需要安全验证')
    expect(view.expired).toBe(false)
    expect(view.detail).toContain('安全验证')
  })

  it('检测失败（ERROR）→ error「检测失败」，不报过期', () => {
    const view = describeLoginCheckResult(payload(platformLogin('ERROR', 'ADAPTER_ERROR', '平台登录状态检测失败')))
    expect(view.tone).toBe('error')
    expect(view.label).toBe('检测失败')
    expect(view.expired).toBe(false)
    expect(view.detail).toBe('平台登录状态检测失败（ADAPTER_ERROR）')
  })

  it('UNKNOWN（这次没拿到证据）→ info「未识别」，绝不判过期', () => {
    const view = describeLoginCheckResult(payload(platformLogin('UNKNOWN', 'PAGE_NOT_READY', '无法确认平台登录状态')))
    expect(view.tone).toBe('info')
    expect(view.label).toBe('未识别')
    expect(view.expired).toBe(false)
    expect(view.detail).toBe('主进程未能确认平台登录状态：无法确认平台登录状态（PAGE_NOT_READY）')
  })
})

describe('session-login-state：未登录 vs 登录态过期', () => {
  it('有会话但平台要求重新登录 → 「登录态已过期」且 expired=true', () => {
    const view = describeLoginCheckResult(payload(platformLogin('LOGIN_REQUIRED', 'EXPLICIT_LOGIN_PAGE'), { sessionPresent: true }))
    expect(view.tone).toBe('warning')
    expect(view.label).toBe('登录态已过期')
    expect(view.expired).toBe(true)
    expect(view.detail).toBe('该店铺原有会话已被平台判为失效，请重新登录：测试安全文案（EXPLICIT_LOGIN_PAGE）')
  })

  it('从来没有会话 → 「未登录」且 expired=true（同样需要用户去登录）', () => {
    const view = describeLoginCheckResult(payload(platformLogin('LOGIN_REQUIRED'), { sessionPresent: false }))
    expect(view.label).toBe('未登录')
    expect(view.expired).toBe(true)
    expect(view.detail).toBe('该店铺还没有可用登录态，请登录后再操作：测试安全文案（TEST_CODE）')
  })

  it('摘要里没有 sessionPresent 时不猜"过期"，按未登录说', () => {
    const summary = { storeId: 'store-1', status: 'READY' }
    const view = describeLoginCheckResult({ ...summary, platformLogin: platformLogin('LOGIN_REQUIRED') })
    expect(view.label).toBe('未登录')
    expect(view.expired).toBe(true)
  })
})

describe('session-login-state：只拿到会话摘要也能读', () => {
  it('退化为会话摘要时读 loginStatus（不是 Session 就绪轴的 status）', () => {
    const view = describeLoginCheckResult({ storeId: 'store-1', status: 'READY', loginStatus: 'LOGGED_IN', loginReasonCode: 'EVIDENCE_OK', loginSafeMessage: '平台登录状态已确认' })
    expect(view.tone).toBe('success')
    expect(view.label).toBe('已登录')
    expect(view.detail).toBe('平台登录状态已确认（EVIDENCE_OK）')
  })

  it('摘要说 LOGIN_REQUIRED 且本来有会话 → 过期', () => {
    const view = describeLoginCheckResult({ storeId: 'store-1', status: 'READY', sessionPresent: true, loginStatus: 'LOGIN_REQUIRED', loginReasonCode: 'EXPLICIT_LOGIN_PAGE', loginSafeMessage: '需要在店铺浏览器中登录' })
    expect(view.label).toBe('登录态已过期')
    expect(view.expired).toBe(true)
  })

  it('只有 Session 就绪轴的 status（READY/CHECKING）不算登录状态 → 未识别', () => {
    for (const status of ['READY', 'CHECKING']) {
      const view = describeLoginCheckResult({ storeId: 'store-1', status })
      expect(view.label).toBe('未识别')
      expect(view.expired).toBe(false)
    }
  })

  it('会话就绪轴的 status 即使取值与登录轴同名（LOGIN_REQUIRED/ERROR/…）也不当登录结论（复验 F4）', () => {
    // 两条轴共享 UNKNOWN/LOGIN_REQUIRED/VERIFY_REQUIRED/ERROR 四个取值：
    // 拿就绪轴推登录结论会把「会话要求重新登录」误报成「登录态已过期」。
    for (const status of ['LOGIN_REQUIRED', 'ERROR', 'VERIFY_REQUIRED', 'UNKNOWN']) {
      const view = describeLoginCheckResult({ storeId: 'store-1', status, sessionPresent: true })
      expect(view.label, status).toBe('未识别')
      expect(view.expired, status).toBe(false)
    }
  })

  it('platformLogin 的 status 不认识时，退回到摘要的 loginStatus', () => {
    const view = describeLoginCheckResult({
      storeId: 'store-1',
      loginStatus: 'LOGGED_IN',
      platformLogin: { status: 'WHATEVER' }
    })
    expect(view.label).toBe('已登录')
  })
})

describe('session-login-state：结构不认识时如实说未识别', () => {
  const UNRECOGNIZED: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'LOGGED_IN'],
    ['数字', 42],
    ['空对象', {}],
    ['无关字段', { foo: 'bar', nested: { status: 'LOGGED_IN' } }],
    ['platformLogin 为 null', { storeId: 'store-1', platformLogin: null }],
    ['platformLogin 不是对象', { storeId: 'store-1', platformLogin: 'LOGGED_IN' }],
    ['platformLogin 状态拼错', { storeId: 'store-1', platformLogin: { status: 'LOGGEDIN' } }],
    ['小写状态', { storeId: 'store-1', status: 'logged_in' }],
    ['数组', [{ status: 'LOGGED_IN' }]]
  ]

  it('一律 info「未识别」、expired=false，且绝不显示"已登录"', () => {
    for (const [name, input] of UNRECOGNIZED) {
      const view = describeLoginCheckResult(input)
      expect(view.tone, name).toBe('info')
      expect(view.label, name).toBe('未识别')
      expect(view.expired, name).toBe(false)
      expect(view.detail.length, name).toBeGreaterThan(0)
      expect(view.label, name).not.toBe('已登录')
    }
  })

  it('缺 safeMessage / reasonCode 时用主进程口径的兜底文案，不留空行', () => {
    expect(describeLoginCheckResult({ platformLogin: { status: 'LOGIN_REQUIRED' } }).detail).toContain('需要在店铺浏览器中登录')
    expect(describeLoginCheckResult({ platformLogin: { status: 'VERIFY_REQUIRED', safeMessage: '   ' } }).detail).toContain('需要在店铺浏览器中完成安全验证')
    expect(describeLoginCheckResult({ platformLogin: { status: 'ERROR' } }).detail).toBe('平台登录状态检测失败')
  })

  it('不改动入参（pure）', () => {
    const input = payload(platformLogin('LOGGED_IN'))
    const snapshot = JSON.stringify(input)
    describeLoginCheckResult(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('session-login-state：按钮文案', () => {
  it('空闲 / 检测中两种文案', () => {
    expect(loginCheckButtonText(false)).toBe('检测登录状态')
    expect(loginCheckButtonText(true)).toBe('检测中…')
  })
})

describe('session-login-state：按钮门控', () => {
  const OK = { storeId: 'store-1', pageAttached: true, appLocked: false }

  it('三项都满足才允许检测', () => {
    expect(canCheckLogin(OK)).toBe(true)
    expect(loginCheckBlockedReason(OK)).toBe('')
  })

  it('没选店 → 不允许，原因是选店铺', () => {
    for (const storeId of [undefined, null, '']) {
      expect(canCheckLogin({ ...OK, storeId })).toBe(false)
      expect(loginCheckBlockedReason({ ...OK, storeId })).toContain('选择一个店铺')
    }
  })

  it('应用锁定 → 不允许，原因是锁定', () => {
    expect(canCheckLogin({ ...OK, appLocked: true })).toBe(false)
    expect(loginCheckBlockedReason({ ...OK, appLocked: true })).toContain('锁定')
  })

  it('页面未挂载 → 不允许，原因是先打开页面', () => {
    expect(canCheckLogin({ ...OK, pageAttached: false })).toBe(false)
    expect(loginCheckBlockedReason({ ...OK, pageAttached: false })).toContain('页面还没打开')
    expect(canCheckLogin({ ...OK, pageAttached: undefined })).toBe(false)
  })

  it('多个条件同时不满足时，按"没选店 → 锁定 → 未挂载"取第一个原因', () => {
    expect(loginCheckBlockedReason({ storeId: null, pageAttached: false, appLocked: true })).toContain('选择一个店铺')
    expect(loginCheckBlockedReason({ storeId: 'store-1', pageAttached: false, appLocked: true })).toContain('锁定')
  })
})
