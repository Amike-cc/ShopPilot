import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { invitePanelSteps, nextInvitePanelStep, normalizeInvitePanelStep } from '../../apps/desktop/src/renderer/src/features/invite/composables/invite-panel-steps'
import {
  inviteCampaignCountsText,
  inviteCampaignOptionText,
  inviteCampaignStatusLabel,
  inviteRecordLineText,
  inviteRecordStatusLabel,
  inviteRecordToneClass
} from '../../apps/desktop/src/renderer/src/features/invite/composables/invite-run-labels'

const PANEL = readFileSync(resolve('apps/desktop/src/renderer/src/features/invite/InvitePanelView.vue'), 'utf8')
const INVITE_STATE = readFileSync(resolve('apps/desktop/src/renderer/src/features/invite/composables/invite-state.ts'), 'utf8')
const INVITE_NAV = readFileSync(resolve('apps/desktop/src/renderer/src/features/invite/composables/use-invite-navigation.ts'), 'utf8')
const INVITE_CONFIG = readFileSync(resolve('apps/desktop/src/renderer/src/features/invite/composables/use-invite-config.ts'), 'utf8')
const BROWSER_HANDLERS = readFileSync(resolve('apps/desktop/src/main/ipc/browser-handlers.ts'), 'utf8')

describe('侧栏步骤导航（2026-11-01 修复 activeStep 丢失）', () => {
  it('抖店逐人沟通只保留目标 → 启动两步', () => {
    expect(invitePanelSteps(true).map(step => step.label)).toEqual(['目标', '启动'])
    expect(nextInvitePanelStep(1, true)).toBe(4)
    expect(nextInvitePanelStep(4, true)).toBeNull()
  })

  it('其他平台仍是四步，下一步按顺序走', () => {
    expect(invitePanelSteps(false).map(step => step.n)).toEqual([1, 2, 3, 4])
    expect(nextInvitePanelStep(1, false)).toBe(2)
    expect(nextInvitePanelStep(3, false)).toBe(4)
    expect(nextInvitePanelStep(4, false)).toBeNull()
  })

  it('切到两步平台后，停留在失效步骤会回到第一步', () => {
    expect(normalizeInvitePanelStep(3, true)).toBe(1)
    expect(normalizeInvitePanelStep(4, true)).toBe(4)
    expect(normalizeInvitePanelStep(2, false)).toBe(2)
  })

  it('面板必须用显式的 activeStep alias，而不是模板里的未定义变量', () => {
    expect(PANEL).toContain('const activeStep = localStep')
    expect(PANEL).toContain('nextStepN')
    expect(PANEL).not.toContain('activeStep < 4')
    expect(PANEL).toContain('data-test="invite-panel-next"')
    expect(PANEL).toContain(':class="{ on: activeStep === tab.n }"')
  })

  it('启动前有筛选摘要，预览明确标注"仅预览/首屏数量"', () => {
    expect(PANEL).toContain('data-test="invite-scope-summary"')
    expect(PANEL).toContain('打开广场 · 仅预览')
    expect(PANEL).toContain('data-test="invite-preview-count-note"')
    expect(PANEL).toContain('data-test="invite-preview-scope-note"')
    // 切店后不能把上一家店的候选预览留在新店面板里
    expect(INVITE_STATE).toContain('squareCandidates.value = []')
  })

  it('打开广场前先落盘当前表单：reloadConfig 不能把刚改的筛选回滚成旧值', () => {
    expect(INVITE_NAV).toContain('await ports.flushConfig()')
    expect(INVITE_CONFIG).toContain('async function flushInviteConfig')
    expect(INVITE_CONFIG).toContain('flushInviteConfig')
  })

  it('逐人记录最新在前，自动滚动位置与记录/日志排序一致', () => {
    expect(PANEL).toContain('inviteCampaignRecords.value.length ? 0 : el.scrollHeight')
  })

  it('批次读取失败不能被伪装成"本店铺还没有运行"', () => {
    expect(PANEL).toContain('!inviteCampaign && !inviteLatest && !inviteCampaignError')
    expect(PANEL).toContain("inviteCampaignError ? '读取失败' : '等待运行'")
  })

  it('候选预览排除禁用态「在线沟通」，并如实说明另有多少位不可沟通', () => {
    expect(BROWSER_HANDLERS).toContain("closest('[class*=\"disabled\"]')")
    expect(BROWSER_HANDLERS).toContain('disabledCandidates')
    expect(INVITE_NAV).toContain('位当前不可沟通（已排除）')
  })

  it('抖店未接入的筛选维度在面板上如实说明，不伪装成已生效', () => {
    expect(PANEL).toContain('达人等级、销售额等快筛尚未接入')
  })
})

describe('邀约运行记录文案', () => {
  it('批次状态与逐人状态都有中文（不再直接显示内部状态码）', () => {
    expect(inviteCampaignStatusLabel('exhausted')).toBe('已结束（候选用尽）')
    expect(inviteCampaignStatusLabel('waiting')).toBe('等待确认')
    expect(inviteRecordStatusLabel('inviting')).toBe('邀请中')
    expect(inviteRecordStatusLabel('skipped_already_invited')).toContain('近 7 天已邀')
  })

  it('记录行包含昵称、状态与原因', () => {
    const line = inviteRecordLineText({
      nickname: '小美', status: 'inviting', statusReason: '已发起在线沟通，平台未回读结果',
      invitedAt: Date.parse('2026-11-01T12:00:00Z'), createdAt: 0
    })
    expect(line).toContain('小美 · 邀请中 · 已发起在线沟通，平台未回读结果')
  })

  it('记录着色：失败红、跳过黄、已发绿、未知红', () => {
    expect(inviteRecordToneClass('failed_send')).toBe('log-fail')
    expect(inviteRecordToneClass('unknown')).toBe('log-skip')
    expect(inviteRecordToneClass('skipped_not_invitable')).toBe('log-skip')
    expect(inviteRecordToneClass('sent')).toBe('log-ok')
    expect(inviteRecordToneClass('queued')).toBe('')
  })

  it('批次摘要只展示非零的跳过/失败/未知计数', () => {
    expect(inviteCampaignCountsText({ targetCount: 40, sentCount: 3, skippedCount: 0, failedCount: 0, unknownCount: 0 }))
      .toBe('目标 40 · 已发 3')
    expect(inviteCampaignCountsText({ targetCount: 20, sentCount: 3, skippedCount: 1, failedCount: 2, unknownCount: 4 }))
      .toBe('目标 20 · 已发 3 · 跳过 1 · 失败 2 · 未知 4')
  })

  it('最近批次下拉显示状态与进度，历史结果可回看', () => {
    const text = inviteCampaignOptionText({
      createdAt: Date.parse('2026-11-01T12:00:00Z'), status: 'running', sentCount: 3, targetCount: 40
    })
    expect(text).toContain('运行中 · 3/40')
    expect(PANEL).toContain('data-test="invite-campaign-picker"')
    expect(PANEL).toContain('selectInviteCampaign')
  })
})
