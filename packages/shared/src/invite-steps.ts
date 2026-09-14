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
  /** 带货者广场筛选：每轮进广场后重新应用（类型/类目/其他） */
  finderType?: string
  finderCategories?: string[]
  finderOtherFilters?: string[]
}

/** 微信逐个邀约的批次上限（安全阀）：真实停止条件是"额度用完/没有更多达人" */
export const ASSIST_LOOP_MAX_ROUNDS = 50

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
 * 逐个邀约流（微信小店）。一轮 = 一个达人：
 * - **广场页只开一次、一直留着**：平台的翻页是内部状态（URL 不变），而且每次加载列表都会
 *   重新洗牌——所以不能每轮重载（重载=分页与筛选全丢、候选顺序重新排）。改为一开始导航
 *   一次、应用一次筛选，之后每轮用 useTab 切回这个活着的广场页；
 * - 选人用 `nth:'unvisited'`（第一条本次运行还没点过的），而不是"第 N 条"——列表会洗牌，
 *   "第几条"无法保证换人，"还没点过的"才能保证不重复邀约同一位达人；
 * - 本页候选都点过 → clickByText 报 TASK_PAGE_EXHAUSTED（missingCode），loop 的 onCode
 *   先点「下一页」再重试；翻到最后一页仍取不出 → onCode 里也修不好 → 由 stopOn 收工；
 * - 点「详情」是 window.open 开新标签页 → followTab 跟过去；一轮结束用 useTab 回到广场并
 *   关掉详情/表单页（否则每轮留一个标签页）；
 * - 表单写入用 typeText（受信任键鼠输入）：微信表单不吃合成 input 事件，setInput 无效；
 * - 额度先行：页面明示「今日剩余N次邀请机会」，为 0 时 requireQuota 如实失败 → 循环**正常收尾**；
 * - 商品：填了商品ID走 ensureRowsById（按 ID 指定），否则 ensureRows 按数量自适应；
 * - **没有人工确认门禁**（用户明确要求）：点「发送邀约」→ 等平台「确认发送邀约」弹窗 → 点「确认」即真实发出；
 * - 结果校验：发送成功后平台会清空表单里的商品行 → waitForGone 复核，没清空就如实失败。
 */
export function buildAssistSteps(p: AssistInviteProfile, opts: AssistInviteOptions, squareUrl: string): StepDraft[] {
  const squarePath = (() => { try { return new URL(squareUrl).pathname } catch { return squareUrl } })()
  const typeIn = (selector: string, text: string) =>
    round.push({ type: 'typeText', input: { selector, text, deep: true }, timeoutMs: 30000 })
  // 一轮 = 从广场取一个"还没邀约过的"达人 → 详情 → 邀请带货 → 表单 → 发送 → 回广场
  const round: StepDraft[] = [
    { type: 'useTab', input: { path: squarePath }, timeoutMs: 30000 }
  ]
  // 进达人详情：平台是 window.open 开**新标签页**（页面自身不跳转），所以点完要跟随新标签页。
  // nth:'unvisited'：取第一条还没点过的（列表每次加载都洗牌，"第几条"不可靠）；
  // 本页都点过了 → TASK_PAGE_EXHAUSTED → loop 的 onCode 点「下一页」后重试。
  round.push({ type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 30000 })
  round.push({
    type: 'clickByText',
    input: {
      text: '详情', deep: true, mode: 'real', nth: 'unvisited',
      missingCode: 'TASK_PAGE_EXHAUSTED',
      // closeOld:false —— 详情页是新标签页，但**广场必须留着**（分页/筛选是页面内部状态，
      // 关了就得重新加载：分页丢、名单重新洗牌）。广场由轮末的 useTab 负责切回。
      followTab: { urlIncludes: 'finder-detail', closeOld: false }
    },
    timeoutMs: 40000
  })
  round.push({ type: 'waitForPage', input: { urlIncludes: 'finder-detail' }, timeoutMs: 45000 })
  // 「邀请带货」实测是普通 BUTTON、点击后**同标签页 pushState** 到 initiate-invite（不是 window.open），
  // 所以**不能**配 followTab（那会白等 40s 新标签页，实测踩过）。
  // 另一个实测坑：详情页刚到时按钮已在 DOM 里（waitForText 立刻通过），但 SPA 还没挂上事件——
  // 此时点击会被丢弃。固定 sleep 不可靠（实测 3s 失败 / 4s 成功），所以用 waitUrl：
  // 点击后轮询地址，没跳到表单页就重新定位再点一次，最多 4 次。
  // missingCode：这一位达人的详情页微应用没渲染出来（按钮压根不存在）→ 交给 onCode 跳过换人，
  // 不要与"列表到头"（TASK_SELECTION_SHORTFALL，应收工）混为一谈。
  round.push({
    type: 'clickByText',
    input: {
      text: '邀请带货', deep: true, mode: 'real',
      missingCode: 'TASK_DAREN_PAGE_UNOPENABLE',
      waitUrl: { includes: p.inviteUrlMarker, attempts: 4 }
    },
    timeoutMs: 60000
  })
  round.push({ type: 'waitForPage', input: { urlIncludes: p.inviteUrlMarker }, timeoutMs: 45000 })
  // 额度预检：为 0 时如实失败（TASK_QUOTA_EXCEEDED）→ 循环干净收尾
  round.push({ type: 'requireQuota', input: { textIncludes: p.quota.textIncludes, min: p.quota.min, metric: 'invite.quota', deep: true }, timeoutMs: 30000 })

  typeIn(p.selectors.contact, opts.contact.trim())
  if (opts.wechat?.trim()) typeIn(p.selectors.wechat, opts.wechat.trim())
  if (opts.phone?.trim()) typeIn(p.selectors.phone, opts.phone.trim())

  if (opts.scriptMode === 'ai') {
    round.push({
      type: 'aiGenerate',
      input: { selector: p.selectors.script, sourceSelector: p.selectors.goodsSource, deep: true, maxLen: p.scriptMaxLen },
      timeoutMs: 90000
    })
    round.push({ type: 'readText', input: { selector: p.selectors.script, metric: 'invite.script', deep: true }, timeoutMs: 15000 })
  } else {
    typeIn(p.selectors.script, opts.script.trim())
  }

  const productIds = (opts.productIds || []).map(x => x.trim()).filter(Boolean)
  if (productIds.length) {
    round.push({
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
    round.push({
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

  // 发送（无门禁，真实发出）→ 等平台确认弹窗 → 确认 → 校验表单被清空
  round.push({ type: 'clickByText', input: { text: p.texts.sendInvite, deep: true, mode: 'real' }, timeoutMs: 20000 })
  round.push({ type: 'waitForText', input: { text: p.texts.dialogMarker, deep: true }, timeoutMs: 25000 })
  round.push({ type: 'clickByText', input: { text: p.texts.confirmSend, deep: true, mode: 'real' }, timeoutMs: 20000 })
  // 发送成功后平台会清空「邀约商品」行；没清空说明这次提交没被接受，如实失败
  round.push({ type: 'waitForGone', input: { selector: p.selectors.goodsRows, deep: true }, timeoutMs: 30000 })
  round.push({ type: 'screenshot', input: {}, timeoutMs: 20000 })
  // 收尾：回广场（下一轮开头那次 useTab 会再切一次，这里先回来是为了让"本轮已发出"的
  // 现场留在广场页上，同时把详情/表单页关掉）
  round.push({ type: 'useTab', input: { path: squarePath }, timeoutMs: 30000 })

  const contactDesc = [
    `联系人 ${opts.contact.trim()}`,
    opts.wechat?.trim() ? `微信 ${opts.wechat.trim()}` : null,
    opts.phone?.trim() ? `手机 ${opts.phone.trim()}` : null
  ].filter(Boolean).join('｜')

  // 广场页只开一次：先导航过去、应用一次筛选（每轮重载会丢分页/筛选，且列表会重新洗牌）
  const opening: StepDraft[] = [
    { type: 'navigate', input: { url: squareUrl }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: urlPathHint(squareUrl) }, timeoutMs: 45000 }
  ]
  if (opts.finderType) opening.push({ type: 'clickByText', input: { text: opts.finderType, deep: true, mode: 'real' }, timeoutMs: 25000 })
  for (const c of (opts.finderCategories || [])) opening.push({ type: 'clickByText', input: { text: c, deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL' }, timeoutMs: 25000 })
  for (const f of (opts.finderOtherFilters || [])) opening.push({ type: 'clickByText', input: { text: f, deep: true, mode: 'real' }, timeoutMs: 25000 })

  return [
    ...opening,
    {
      type: 'loop',
      input: {
        // label 上限 60 字（Zod）：联系人/微信/手机都可能很长，这里必须截断——
        // 实测超限会让任务创建整单被拒，而失败提示不易察觉，表现成"点开始邀约没反应"
        label: (`${contactDesc} · 逐个邀约${productIds.length ? ` · 商品ID ${productIds.join('/')}` : ''}`).slice(0, 60),
        maxRounds: ASSIST_LOOP_MAX_ROUNDS,
        // 收工条件：额度用完 / 翻到最后一页也没有新候选（onCode 里点不动「下一页」时会报它）
        stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'],
        // 本页候选都点过了 → 点「下一页」再重试；「下一页」点不动（最后一页）→ 交给 stopOn 收工
        onCode: [
          {
            code: 'TASK_PAGE_EXHAUSTED',
            limit: 10,
            steps: [
              {
                type: 'clickByText',
                input: {
                  text: '下一页', deep: true, mode: 'real',
                  // 找不到「下一页」（页面还没渲染完）→ 也当作"没有更多候选"收工，而不是报选择器改版
                  missingCode: 'TASK_SELECTION_SHORTFALL',
                  // 最后一页按钮会置灰：那个"禁用"就是"没有更多了"，同样干净收工
                  disabledCode: 'TASK_SELECTION_SHORTFALL'
                },
                timeoutMs: 20000
              },
              { type: 'waitMs', input: { ms: 2500 }, timeoutMs: 15000 }
            ]
          },
          {
            // 这一位达人打不开：实测详情页微应用的子应用 HTML 被平台拒绝（控制台
            // `[micro-app] app findersquare: html is empty` + HTTP 403），<micro-app> 压根不挂载。
            // 连续快速逐位邀约会触发平台限流；实测等约 1–2 分钟后同一地址又能正常打开。
            // 所以这里**退避后重试同一位**（不消耗候选、也不会漏人），而不是跳过：
            // limit=6 次退避仍打不开才放弃这一位（连续打不开同样会耗尽上限而停下）。
            code: 'TASK_DAREN_PAGE_UNOPENABLE',
            limit: 6,
            restart: true,
            steps: [
              { type: 'useTab', input: { path: squarePath }, timeoutMs: 30000 },
              { type: 'waitMs', input: { ms: 20000 }, timeoutMs: 30000 }
            ]
          }
        ],
        steps: round
      }
    }
  ]
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
  return buildAssistSteps(profile, opts.assist, squareUrl)
}
