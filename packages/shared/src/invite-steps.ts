/**
 * 达人邀约步骤构造（§16 平台适配层）
 *
 * 由面板配置生成任务步骤序列。放在 shared：渲染层调用、单测覆盖，两端不漂移。
 * 每个平台流程相互独立（见 constants/invite.ts 顶部说明）：
 *   - batch-list（抖店）：广场筛选 → 批量勾选 → 抽屉话术 → 门禁 → 确认发送；
 *   - assist-form（微信小店）：镜像人工打开的邀约表单页 → 代填联系方式/话术 →
 *     确保邀约商品 → 门禁 → 发送 → 等平台确认框 → 确认 → 截图留档。
 *
 * 红线：文案/选择器失配时任务引擎报 TASK_SELECTOR_CHANGED，绝不静默重试或假装成功；
 * 「确认发送」前必须有一道 waitForUserConfirmation 门禁，拒绝即整单取消。
 */

import type { AssistInviteProfile, BatchInviteProfile, InviteProfile } from './constants/invite'

export interface StepDraft {
  type: string
  input: Record<string, unknown>
  timeoutMs?: number
}

export interface BatchInviteOptions {
  category: string
  levels: string[]
  count: number
  script: string
  scriptMode: 'manual' | 'ai'
  benefits: string[]
}

export interface AssistInviteOptions {
  contact: string
  wechat?: string
  phone?: string
  script: string
  scriptMode: 'manual' | 'ai'
  /** 本次要确保存在的邀约商品数量（1 起） */
  productCount: number
}

/** 从达人广场地址取末段路径作为 waitForPage 的就绪判据（换成自定义地址也要能用） */
export function urlPathHint(url: string): string {
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean)
    return seg[seg.length - 1] || u.hostname
  } catch {
    return url
  }
}

/**
 * 批量勾选流（抖店）。要点：
 * - 平台无稳定 data-test，筛选与提交靠文案点击（clickByText）；
 * - 行复选框用 tbody 限定，避免点到表头的"全选"；
 * - clickAll 会跳过平台禁用（已邀约过）的行，上限取用户设定值（≤平台上限）；
 * - 话术两种来源：手填 → setInput；AI → aiGenerate（读抽屉商品区）+ readText 留档；
 * - 「确认发送」前必须放 waitForUserConfirmation：拒绝则整单取消，绝不继续。
 */
export function buildBatchSteps(p: BatchInviteProfile, opts: BatchInviteOptions, squareUrl: string): StepDraft[] {
  const steps: StepDraft[] = [
    { type: 'navigate', input: { url: squareUrl }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: urlPathHint(squareUrl) }, timeoutMs: 45000 }
  ]
  if (opts.category) steps.push({ type: 'clickByText', input: { text: opts.category } })
  steps.push({ type: 'clickByText', input: { text: p.texts.levelTrigger } })
  for (const lv of opts.levels) steps.push({ type: 'clickByText', input: { text: lv } })
  steps.push({ type: 'clickByText', input: { text: p.texts.search } })
  steps.push({ type: 'waitForSelector', input: { selector: p.rowCheckboxSelector }, timeoutMs: 30000 })
  // scroll=true：抖店广场列表在固定容器里滚动加载（无分页），一屏放不下上限 40 行——
  // 点完当前可点的行后向下滚动、等新行渲染再继续（实测修掉"要勾 40 位却只勾中 1 位"）。
  // maxRounds 给到 40：实测整表约 60 行、容器每次滚 ~95% 视口，够把 46 个可选行扫完；
  // 池子提前扫空时 clickAll 自己会停（不空转）。
  steps.push({ type: 'clickAll', input: { selector: p.rowCheckboxSelector, max: opts.count, scroll: true, maxRounds: 40 }, timeoutMs: 240000 })
  steps.push({ type: 'clickByText', input: { text: p.texts.batchInvite } })
  steps.push({ type: 'waitForSelector', input: { selector: p.scriptSelector }, timeoutMs: 30000 })
  // 额度先行：抖店不展示剩余额度数字，额度用尽/平台限制表现为抽屉「确认发送」禁用——
  // 填话术与人工确认之前先校验可用性，额度不足快速如实失败（TASK_QUOTA_EXCEEDED），
  // 不浪费一轮人工确认，更不会把无效邀约送去发送
  steps.push({ type: 'requireEnabled', input: { text: p.texts.drawerConfirm, hint: p.quotaNote }, timeoutMs: 30000 })
  if (opts.scriptMode === 'ai') {
    steps.push({
      type: 'aiGenerate',
      input: {
        selector: p.scriptSelector,
        sourceSelector: p.goodsSourceSelector || '',
        maxLen: p.scriptMaxLen
      },
      timeoutMs: 90000
    })
    // aiGenerate 的 payload 只有摘要（模型/长度/预览），完整话术靠 readText 落库——事后能查出"到底发了什么"
    steps.push({ type: 'readText', input: { selector: p.scriptSelector, metric: 'invite.script' }, timeoutMs: 15000 })
  } else {
    steps.push({ type: 'setInput', input: { selector: p.scriptSelector, text: opts.script.trim() } })
  }
  for (const b of opts.benefits) steps.push({ type: 'clickByText', input: { text: b } })
  steps.push({
    type: 'waitForUserConfirmation',
    input: {
      message: `【达人邀约·${p.platform}】类目 ${opts.category || '全部'}｜等级 ${opts.levels.join('/')}｜最多 ${opts.count} 位｜权益 ${opts.benefits.join('、') || '无'}｜话术：` +
        (opts.scriptMode === 'ai'
          ? '由 AI 按平台推荐商品生成，请在页面「邀约话术」框里核对后再放行'
          : opts.script.trim())
    },
    timeoutMs: 1800000
  })
  steps.push({ type: 'clickByText', input: { text: p.texts.confirmSend } })
  // 发送后的结果校验：邀约抽屉应关闭；没关说明平台没接受这次提交，如实失败
  // （避免"点了确认发送"被当成"已经发出去了"）
  steps.push({ type: 'waitForGone', input: { selector: p.scriptSelector }, timeoutMs: 30000 })
  // 截图留档：发送结果（达人侧邀约记录/行状态）事后可查
  steps.push({ type: 'screenshot', input: {}, timeoutMs: 20000 })
  return steps
}

/**
 * 辅助填单流（微信小店）。要点：
 * - mirrorTabUrl：人工已在店铺浏览器进到某达人的「邀请带货」表单页（URL 含 initiate-invite），
 *   引擎在自建标签页里镜像同一 URL——列表 DOM 拿不到 finderUsername，选人必须人工完成；
 * - 表单写入用 typeText（受信任键鼠输入）：微信表单不吃合成 input 事件，setInput 无效；
 * - 微信号/手机号可选（至少填一个由面板校验），空值不生成对应步骤；
 * - ensureRows 自适应：页面已有商品行则不动，没有才走「添加商品」弹窗勾选；
 * - 门禁后引擎点「发送邀约」，等平台「确认发送邀约」弹窗出现再点「确认」，最后截图留档。
 */
export function buildAssistSteps(p: AssistInviteProfile, opts: AssistInviteOptions): StepDraft[] {
  const steps: StepDraft[] = [
    { type: 'mirrorTabUrl', input: { urlIncludes: p.inviteUrlMarker }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: p.inviteUrlMarker }, timeoutMs: 45000 },
    // 额度先行：微信小店页面明示「今日剩余N次邀请机会」，数字 < min（=0）时如实失败，
    // 不进入填表/发送流程
    { type: 'requireQuota', input: { textIncludes: p.quota.textIncludes, min: p.quota.min, metric: 'invite.quota', deep: true }, timeoutMs: 30000 }
  ]
  const typeIn = (selector: string, text: string) =>
    steps.push({ type: 'typeText', input: { selector, text, deep: true }, timeoutMs: 30000 })

  typeIn(p.selectors.contact, opts.contact.trim())
  if (opts.wechat?.trim()) typeIn(p.selectors.wechat, opts.wechat.trim())
  if (opts.phone?.trim()) typeIn(p.selectors.phone, opts.phone.trim())

  if (opts.scriptMode === 'ai') {
    steps.push({
      type: 'aiGenerate',
      input: { selector: p.selectors.script, sourceSelector: p.selectors.goodsSource, deep: true, maxLen: p.scriptMaxLen },
      timeoutMs: 90000
    })
    steps.push({ type: 'readText', input: { selector: p.selectors.script, metric: 'invite.script', deep: true }, timeoutMs: 15000 })
  } else {
    typeIn(p.selectors.script, opts.script.trim())
  }

  steps.push({
    type: 'ensureRows',
    input: {
      rowsSelector: p.selectors.goodsRows,
      checkboxSelector: p.selectors.goodsCheckbox,
      addText: p.texts.addGoods,
      confirmText: p.texts.confirmAdd,
      min: 1,
      max: Math.max(1, opts.productCount),
      deep: true
    },
    timeoutMs: 120000
  })

  const contactDesc = [
    `联系人 ${opts.contact.trim()}`,
    opts.wechat?.trim() ? `微信 ${opts.wechat.trim()}` : null,
    opts.phone?.trim() ? `手机 ${opts.phone.trim()}` : null
  ].filter(Boolean).join('｜')

  steps.push({
    type: 'waitForUserConfirmation',
    input: {
      message: `【达人邀约·${p.platform}】${contactDesc}｜商品：页面已有则不动，否则自动添加 ${Math.max(1, opts.productCount)} 个｜话术：` +
        (opts.scriptMode === 'ai'
          ? '由 AI 按邀约商品信息生成，请在页面「合作说明」框里核对后再放行'
          : opts.script.trim()) +
        `。放行后软件将点击「${p.texts.sendInvite}」，并在平台「${p.texts.dialogMarker}」弹窗上点「${p.texts.confirmSend}」——这是真实发送，请先在页面上核对全部内容。`
    },
    timeoutMs: 1800000
  })
  steps.push({ type: 'clickByText', input: { text: p.texts.sendInvite, deep: true, mode: 'real' }, timeoutMs: 20000 })
  steps.push({ type: 'waitForText', input: { text: p.texts.dialogMarker, deep: true }, timeoutMs: 20000 })
  steps.push({ type: 'clickByText', input: { text: p.texts.confirmSend, deep: true, mode: 'real' }, timeoutMs: 20000 })
  steps.push({ type: 'screenshot', input: {}, timeoutMs: 20000 })
  return steps
}

/** 按档案流程分派（平台邀约功能相互独立，新增平台在此登记新流程即可） */
export function buildInviteSteps(
  profile: InviteProfile,
  opts: { batch?: BatchInviteOptions; assist?: AssistInviteOptions },
  squareUrl: string
): StepDraft[] {
  if (profile.flow === 'batch-list') {
    if (!opts.batch) throw new Error('batch-list 档案缺少 batch 配置')
    return buildBatchSteps(profile, opts.batch, squareUrl)
  }
  if (!opts.assist) throw new Error('assist-form 档案缺少 assist 配置')
  return buildAssistSteps(profile, opts.assist)
}
