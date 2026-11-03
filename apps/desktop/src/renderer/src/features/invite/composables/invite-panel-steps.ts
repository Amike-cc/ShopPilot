/**
 * 侧栏步骤导航的纯逻辑（不依赖 Vue / IPC，可直接单测）。
 *
 * 为什么单独抽出来：2026-10-25 下线独立页时把模板里的 `activeStep` 删掉了，
 * 步骤高亮与「下一步」按钮因此全部失效（模板读到 undefined，生产构建不报错）。
 * 这段逻辑现在有明确的输入输出，测试能直接钉住，不再靠模板里的隐式变量。
 */
export interface InvitePanelStep {
  /** 对应模板里的 showStep(n)；不是数组下标 */
  n: 1 | 2 | 3 | 4
  label: string
}

export const INVITE_PANEL_STEPS: readonly InvitePanelStep[] = [
  { n: 1, label: '目标' },
  { n: 2, label: '受众' },
  { n: 3, label: '话术' },
  { n: 4, label: '启动' }
]

/**
 * 逐人沟通平台（抖店）：没有受众/话术表单，跳两步只是空页。
 * 只保留「目标 → 启动」，让侧栏的每一步都有真实内容。
 */
export function invitePanelSteps(contactOnly: boolean): InvitePanelStep[] {
  return contactOnly
    ? [{ n: 1, label: '目标' }, { n: 4, label: '启动' }]
    : [...INVITE_PANEL_STEPS]
}

/** 把任意步号落到当前平台真实存在的步骤上；非法值回到第一步。 */
export function normalizeInvitePanelStep(current: number, contactOnly: boolean): number {
  const steps = invitePanelSteps(contactOnly)
  return steps.some(step => step.n === current) ? current : steps[0].n
}

/** 下一步的步号；已经是最后一步返回 null。 */
export function nextInvitePanelStep(current: number, contactOnly: boolean): number | null {
  const steps = invitePanelSteps(contactOnly)
  const index = steps.findIndex(step => step.n === current)
  return index >= 0 && index < steps.length - 1 ? steps[index + 1].n : null
}
