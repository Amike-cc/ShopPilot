import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyInviteBlockNotice, matchSessionStall } from '@shared/invite-notices'

/**
 * 「点不动时平台说了什么」的分类（2026-10-04）。
 *
 * 真机事故：10:31 / 10:34 两次点「邀请带货」4 次都没跳到表单页，日志里只有一句 TASK_TIMEOUT，
 * **平台原话一个字都没留下**，只能猜是"已邀约 / 额度用完 / 限流"。这三种处置完全相反：
 * 换人 / 干净收工 / 退避重试，所以必须有确定的口径。
 */
describe('邀约被拦时的提示分类', () => {
  it('已邀约 → already-invited（该换下一位）', () => {
    expect(classifyInviteBlockNotice('你已经邀请过该达人，7天内不可再次发送带货邀约')).toBe('already-invited')
    expect(classifyInviteBlockNotice('该达人已邀约')).toBe('already-invited')
    expect(classifyInviteBlockNotice('已经邀约，请勿重复发送')).toBe('already-invited')
  })

  it('邀请机会用完 → quota-exhausted（该干净收工，别继续白跑）', () => {
    expect(classifyInviteBlockNotice('今日邀请机会已用完')).toBe('quota-exhausted')
    expect(classifyInviteBlockNotice('今日邀请次数已达上限')).toBe('quota-exhausted')
    expect(classifyInviteBlockNotice('邀请机会不足')).toBe('quota-exhausted')
    expect(classifyInviteBlockNotice('额度不足，请充值')).toBe('quota-exhausted')
  })

  it('限流 → throttled（该退避后重试同一位，换人反而漏人）', () => {
    expect(classifyInviteBlockNotice('操作过于频繁，请稍后重试')).toBe('throttled')
    expect(classifyInviteBlockNotice('请求过快')).toBe('throttled')
    expect(classifyInviteBlockNotice('系统繁忙，请等待')).toBe('throttled')
  })

  it('认不出来/没读到 → unknown（如实失败，并把原话带进错误信息）', () => {
    expect(classifyInviteBlockNotice(null)).toBe('unknown')
    expect(classifyInviteBlockNotice('')).toBe('unknown')
    expect(classifyInviteBlockNotice('加载中…')).toBe('unknown')
    expect(classifyInviteBlockNotice('暂未到达合作门槛')).toBe('unknown')
  })

  it('分类口径只有一份（引擎侧 re-export，不重复实现正则）', () => {
    const runner = readFileSync(resolve('apps/desktop/src/main/tasks/task-runner.ts'), 'utf8')
    // 引擎必须从 shared 引入，而不是自己再写一遍正则
    expect(runner).toMatch(/import \{ classifyInviteBlockNotice, matchSessionStall \} from '@shared\/invite-notices'/)
    // 分类用到的关键词不许在引擎里再出现一份（否则两边会漂移）
    expect(runner).not.toMatch(/已邀请过该达人\|已经邀请过该达人/)
  })
})

/**
 * 「登录态没拿到」的判据（2026-10-04 快手分销后台真机）。
 * 页面地址正确、标题也对，但正文停在「正在获取用户信息，请稍后…」，筛选区永远不渲染——
 * 旧写法只报"等待文本超时"，用户看不出该重新登录。
 */
describe('登录态停滞（壳页面）的正文判据', () => {
  it('认平台自己的措辞', () => {
    expect(matchSessionStall('正在获取用户信息，请稍后…')).toBe('正在获取用户信息')
    expect(matchSessionStall('请先登录后再访问')).toBe('请先登录')
    expect(matchSessionStall('登录已过期，请重新登录')).toBe('登录已过期')
    expect(matchSessionStall('暂无权限')).toBe('暂无权限')
  })

  it('正常业务页面不误判（判错会把"页面慢"说成"登录失效"）', () => {
    expect(matchSessionStall('带货类目 内容标签 合作信息 已选0条 批量邀约')).toBeNull()
    expect(matchSessionStall('')).toBeNull()
    expect(matchSessionStall(null)).toBeNull()
    expect(matchSessionStall('我的达人 邀约中 已接受 已拒绝')).toBeNull()
  })

  it('极短的"壳页面"正文也算（正文只有一句获取/登录/权限时）', () => {
    expect(matchSessionStall('正在获取用户信息')).toBe('正在获取用户信息')
    expect(matchSessionStall('加载中')).toBeNull() // 太泛，不判
  })
})
