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

/**
 * 抖店批量邀约的批次上限（安全阀）。
 * 真实停止条件是"额度用完"或"可选达人不足 40 位"（loop 的 stopOn），
 * 这里只是防止平台状态异常时无限循环：20 批 × 40 位 = 最多 800 位/次运行。
 */
export const BATCH_LOOP_MAX_ROUNDS = 20

export interface BatchInviteOptions {
  /** 一级主推类目（'' = 不筛选） */
  category: string
  /** 二级子类（'' = 不限子类，即整个一级）；仅 category 非空时有效 */
  subcategory?: string
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
  /** 指定商品 ID；非空时优先使用 ensureRowsById，不再按列表顺序盲选 */
  productIds?: string[]
  /** 带货者广场筛选：类型/类目/其他筛选只用于打开广场时，不能混入邀约表单步骤 */
  finderType?: string
  finderCategory?: string
  finderOtherFilters?: string[]
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
 * - 行复选框用 tbody 限定，避免点到表头的"全选"；勾选是**逐个点**（clickAll 不碰表头全选）；
 * - 主推类目是「chip + 级联叶子」两步（实测只点 chip 筛选不生效，详见 constants/invite.ts 注释），
 *   点完还要校验「已筛选」里真的出现该类目——平台改版时宁可在勾人前失败；
 * - 一轮 = 筛选 → 逐个勾 count 位 → 批量邀约带货 → 额度预检 → 填话术 → 确认发送 → 抽屉关闭校验；
 * - 一轮外面套 loop：**循环到额度用完或可选达人不足 40 位为止**（stopOn 命中=干净停止，不算失败）；
 * - 平台侧无"发送前人工确认"步骤（用户明确要求抖店不再二次确认）：额度预检 + 发送后抽屉关闭校验
 *   两道判据替代它——额度不足不发，抽屉没关就如实失败，绝不把"点了"当"发出去了"。
 */
export function buildBatchSteps(p: BatchInviteProfile, opts: BatchInviteOptions, squareUrl: string): StepDraft[] {
  const round: StepDraft[] = [
    { type: 'navigate', input: { url: squareUrl }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: urlPathHint(squareUrl) }, timeoutMs: 45000 }
  ]
  if (opts.category) {
    // ① 点类目 chip：限定在"类目快捷选项行"里——类目名在达人卡片的类目文案里也有，
    //    不限范围可能点到卡片上（实测就是筛选静默失效的原因之一）；
    // ② 点级联弹层里的二级项：限定在弹层内——等级下拉里也有同名"不限"。
    //    选了二级 → 点该二级项（实测点二级即生效，「已筛选」显示 一级/二级/…）；
    //    只选一级 → 点「不限」（不限子类 = 整个一级）。二级名可能被平台截断，按包含匹配。
    const sub = (opts.subcategory || '').trim()
    round.push({ type: 'clickByText', input: { text: opts.category, within: { selector: p.categoryChipScope } }, timeoutMs: 20000 })
    // 级联项必须用受信任鼠标点击（mode:'real'）：有下级的二级项吃合成 click 时只展开下一列、
    // 不选中（真机实测「休闲食品」点了没反应、「已筛选」里 主推类目： 后面是空的）；
    // 真实鼠标点在文字上=用户操作，二级直接生效（实测 家清纸品 → 主推类目：个护家清/家清纸品/…）
    round.push({ type: 'clickByText', input: { text: sub || p.texts.categoryAnyLeaf, within: { selector: p.categoryPopoverSelector }, mode: 'real' }, timeoutMs: 25000 })
  }
  round.push({ type: 'clickByText', input: { text: p.texts.levelTrigger } })
  for (const lv of opts.levels) round.push({ type: 'clickByText', input: { text: lv } })
  round.push({ type: 'clickByText', input: { text: p.texts.search } })
  round.push({ type: 'waitForSelector', input: { selector: p.rowCheckboxSelector }, timeoutMs: 30000 })
  // 类目生效校验：在「已筛选」标签行里必须能看到所选类目（选了二级时连同二级名一起校验，
  // 实测标签形如 `主推类目：个护家清/家清纸品/…`）——否则宁可现在失败，也别把错类目的人邀了
  if (opts.category) {
    round.push({ type: 'waitForText', input: { text: opts.category, within: { text: p.texts.filteredMarker, climb: 1 } }, timeoutMs: 25000 })
    const sub = (opts.subcategory || '').trim()
    if (sub) round.push({ type: 'waitForText', input: { text: sub, within: { text: p.texts.filteredMarker, climb: 1 } }, timeoutMs: 25000 })
  }
  // scroll=true：抖店广场列表在固定容器里滚动加载（无分页），一屏放不下 40 位——
  // 点完当前可点的行后向下滚动、等新行渲染再继续（实测修掉"要勾 40 位却只勾中 1 位"）。
  round.push({ type: 'clickAll', input: { selector: p.rowCheckboxSelector, max: opts.count, scroll: true, maxRounds: 40 }, timeoutMs: 240000 })
  round.push({ type: 'clickByText', input: { text: p.texts.batchInvite } })
  round.push({ type: 'waitForSelector', input: { selector: p.scriptSelector }, timeoutMs: 30000 })
  // 额度先行：抖店不展示剩余额度数字，额度用尽/平台限制表现为抽屉「确认发送」禁用——
  // 填话术之前先校验可用性，额度不足立即如实失败（TASK_QUOTA_EXCEEDED），
  // 在 loop 里这个错误码 = "额度用完"，会被当成**正常收尾**
  round.push({ type: 'requireEnabled', input: { text: p.texts.drawerConfirm, hint: p.quotaNote }, timeoutMs: 30000 })
  if (opts.scriptMode === 'ai') {
    round.push({
      type: 'aiGenerate',
      input: {
        selector: p.scriptSelector,
        sourceSelector: p.goodsSourceSelector || '',
        maxLen: p.scriptMaxLen
      },
      timeoutMs: 90000
    })
    // aiGenerate 的 payload 只有摘要（模型/长度/预览），完整话术靠 readText 落库——事后能查出"到底发了什么"
    round.push({ type: 'readText', input: { selector: p.scriptSelector, metric: 'invite.script' }, timeoutMs: 15000 })
  } else {
    round.push({ type: 'setInput', input: { selector: p.scriptSelector, text: opts.script.trim() } })
  }
  for (const b of opts.benefits) round.push({ type: 'clickByText', input: { text: b } })
  round.push({ type: 'clickByText', input: { text: p.texts.confirmSend } })
  // 发送后的结果校验：邀约抽屉应关闭；没关说明平台没接受这次提交，如实失败
  // （避免"点了确认发送"被当成"已经发出去了"）
  round.push({ type: 'waitForGone', input: { selector: p.scriptSelector }, timeoutMs: 30000 })
  // 截图留档：每轮发送后的达人侧状态（最后一轮的工件会挂在本步骤上）
  round.push({ type: 'screenshot', input: {}, timeoutMs: 20000 })

  return [{
    type: 'loop',
    input: {
      label: `${opts.category ? opts.category + (opts.subcategory ? '/' + opts.subcategory : '') : '全部'} · ${opts.levels.join('/')} · 每批 ${opts.count} 位`,
      maxRounds: BATCH_LOOP_MAX_ROUNDS,
      stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'],
      steps: round
    }
  }]
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

  const productIds = (opts.productIds || []).map(x => x.trim()).filter(Boolean)
  if (productIds.length) {
    steps.push({
      type: 'ensureRowsById',
      input: {
        rowsSelector: p.selectors.goodsRows,
        checkboxSelector: p.selectors.goodsCheckbox,
        addText: p.texts.addGoods,
        confirmText: p.texts.confirmAdd,
        productIds,
        deep: true
      },
      timeoutMs: 120000
    })
  } else {
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
  }

  const contactDesc = [
    `联系人 ${opts.contact.trim()}`,
    opts.wechat?.trim() ? `微信 ${opts.wechat.trim()}` : null,
    opts.phone?.trim() ? `手机 ${opts.phone.trim()}` : null
  ].filter(Boolean).join('｜')

  steps.push({
    type: 'waitForUserConfirmation',
    input: {
      message: `【达人邀约·${p.platform}】${contactDesc}｜商品：${productIds.length ? `指定 ID：${productIds.join('、')}` : `页面已有则不动，否则自动添加 ${Math.max(1, opts.productCount)} 个`}｜话术：` +
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
