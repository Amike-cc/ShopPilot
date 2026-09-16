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
 * 批量流的「确认发送」前必须有一道 waitForUserConfirmation 门禁，拒绝即整单取消。
 * 辅助填单流的最终确认由平台「确认发送邀约」对话框完成，并按档案步骤校验结果。
 */

import type { AssistInviteProfile, BatchInviteProfile, InviteProfile } from './constants/invite'

export interface StepDraft {
  type: string
  input: Record<string, unknown>
  timeoutMs?: number
  /** 瞬态失败（超时/网络抖动）时的重试次数；只对**可安全重放**的步骤用（写话术是幂等的） */
  retryLimit?: number
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
  /** 三级类目（'' = 不限三级）；仅 category/subcategory 都非空时有效 */
  category3?: string
  levels: string[]
  count: number
  script: string
  scriptMode: 'manual' | 'ai'
  benefits: string[]
  /**
   * 额外的筛选行选择（快手特有）：`{ '内容标签': ['美妆'], '合作信息': ['有联系方式'] }`。
   * 这些是**页面上独立的多选筛选行**，与类目是不同维度，可以同时生效。
   */
  extraFilters?: Record<string, string[]>
  /** 抽屉里的必填联系方式（快手要求必填；抖店无此字段 → 空数组即不填） */
  contacts?: { selector: string; text: string }[]
  /** 邀约商品自动添加的个数（快手商品在弹窗里选；0 = 不添加） */
  productCount?: number
}

export interface AssistInviteOptions {
  contact: string
  wechat?: string
  phone?: string
  script: string
  scriptMode: 'manual' | 'ai'
  /** 留空 productIds 时按数量自动添加的商品数（面板已无此项，固定传 1） */
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
 * 批量勾选流（抖店 / 快手小店）。要点：
 * - 平台无稳定 data-test，筛选与提交靠文案点击（clickByText）；
 * - 行复选框用 tbody 限定，避免点到表头的"全选"；勾选是**逐个点**（clickAll 不碰表头全选）；
 * - 类目是「chip + 级联叶子」两步（实测只点 chip 筛选不生效，详见 constants/invite.ts 注释），
 *   点完还要校验生效标记里真的出现该类目——平台改版时宁可在勾人前失败；
 * - 一轮 = 筛选 → 逐个勾 count 位 → 批量邀约 → 额度预检 → 填话术（+必填联系方式/商品）→ 发送 → 抽屉关闭校验；
 * - 一轮外面套 loop：**循环到额度用完或可选达人不足为止**（stopOn 命中=干净停止，不算失败）；
 * - 发送类动作前保留人工确认门禁：额度预检 + 人工确认 + 发送后抽屉关闭校验，
 *   三道判据共同保证不会把一次误触当成真实邀约。
 *
 * 两个平台的差异全部走**档案字段**驱动，不在这里写 `if (platform === ...)`：
 *   minSelect / quotaCheck / goodsModal / benefits / contacts / postSendConfirmTexts。
 */
export function buildBatchSteps(p: BatchInviteProfile, opts: BatchInviteOptions, squareUrl: string): StepDraft[] {
  const round: StepDraft[] = [
    { type: 'navigate', input: { url: squareUrl }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: urlPathHint(squareUrl) }, timeoutMs: 45000 }
  ]
  if (opts.category) {
    // ① 点类目 chip：限定在"类目快捷选项行"里——类目名在达人卡片的类目文案里也有，
    //    不限范围可能点到卡片上（实测就是筛选静默失效的原因之一）；
    // ② 点级联弹层里的叶子项：限定在弹层内——别处也有同名"不限/全部"。
    //    抖店选二级 → 点该二级项并继续展开三级；快手点「全部」= 不限子类。
    //    叶子名可能被平台截断，按包含匹配。
    const sub = (opts.subcategory || '').trim()
    const third = sub ? (opts.category3 || '').trim() : ''
    // 范围写法两种都支持：字符串=CSS 选择器（抖店）；{text,climb}=从行标签上溯（快手，
    // 因为那几行的行容器类名完全相同，选择器区分不了）
    const chipWithin = typeof p.categoryChipScope === 'string'
      ? { selector: p.categoryChipScope }
      : { text: p.categoryChipScope.text, climb: p.categoryChipScope.climb }
    round.push({ type: 'clickByText', input: { text: opts.category, within: chipWithin }, timeoutMs: 20000 })
    // 级联项必须用受信任鼠标点击（mode:'real'）：有下级的二级项吃合成 click 时只展开下一列、
    // 不选中（真机实测抖店「休闲食品」点了没反应）；真实鼠标点在文字上=用户操作，直接生效。
    //
    // 这里**不要**开 jsClickWhenOffscreen（试过，已回退）：快手把这个级联弹层定位在屏幕外
    // （`.…select-dropdown` 停在 -9999,-9999），JS 点击虽然"点得到"，但平台只记下了一级类目
    // （实测标记只有「已选1个 个护家清: 清空」，**没有**子类），会被后面的 waitForText 校验拦下——
    // 于是"点不到"变成"校验超时"，诊断反而更难。离屏时如实报 TASK_TARGET_OUT_OF_VIEWPORT
    // （提示把店铺窗口放到前台）才是对用户最有用的信息。
    round.push({ type: 'clickByText', input: { text: sub || p.texts.categoryAnyLeaf, within: { selector: p.categoryPopoverSelector }, mode: 'real' }, timeoutMs: 25000 })
    // 有三级类目时，二级项真实点击后展开第三列；再点三级叶子才真正选中。
    if (third) {
      round.push({ type: 'clickByText', input: { text: third, within: { selector: p.categoryPopoverSelector }, mode: 'real' }, timeoutMs: 25000 })
    }
    // 选完类目后**把下拉收起来**：实测这个级联下拉会一直展开着，盖住后面要点的按钮
    // （快手：商品弹窗的「确 认」就被它压住，点了没反应）。Escape 是页面级的收起手势。
    round.push({ type: 'pressKey', input: { key: 'Escape' }, timeoutMs: 10000 })
  }
  // 达人等级：快手没有这一维（等级是达人属性、不是筛选项）→ 档案里 levelTrigger 留空则整段跳过
  if (p.texts.levelTrigger) {
    round.push({ type: 'clickByText', input: { text: p.texts.levelTrigger } })
    for (const lv of opts.levels) round.push({ type: 'clickByText', input: { text: lv } })
  }
  // 额外的筛选行（快手：内容标签 / 合作信息…）。每行的行容器类名相同，用行标签上溯定位，
  // 只在该行范围内点选项——否则"美妆"这类词在别处（达人卡片的标签、类目名）也会命中。
  for (const row of (p.extraFilterRows || [])) {
    const picks = opts.extraFilters?.[row.label] || []
    for (const opt of picks) {
      round.push({
        type: 'clickByText',
        input: { text: opt, within: { text: row.label, climb: row.climb } },
        timeoutMs: 20000
      })
    }
  }
  // 搜索按钮：抖店有独立的「搜索」按钮；快手是**关键词输入框**（没有搜索按钮，
  // 筛选靠点 chip 即时生效）→ 档案里 texts.search 留空则整段跳过。
  if (p.texts.search) round.push({ type: 'clickByText', input: { text: p.texts.search } })
  round.push({ type: 'waitForSelector', input: { selector: p.rowCheckboxSelector }, timeoutMs: 30000 })
  // 类目生效校验：生效标记里必须能看到所选类目（抖店「已筛选」、快手「已选N个 …」）——
  // 否则宁可现在失败，也别把错类目的人邀了。
  // 定位方式按档案：有 filteredScope 用选择器（快手那条标记整段是子元素、无自有文本），
  // 否则按锚点文案上溯（抖店）。
  if (opts.category) {
    const scope = p.filteredScope
      ? { selector: p.filteredScope }
      : { text: p.texts.filteredMarker, climb: 1 }
    round.push({ type: 'waitForText', input: { text: opts.category, within: scope }, timeoutMs: 25000 })
    const sub = (opts.subcategory || '').trim()
    if (sub) round.push({ type: 'waitForText', input: { text: sub, within: scope }, timeoutMs: 25000 })
    const third = sub ? (opts.category3 || '').trim() : ''
    if (third) round.push({ type: 'waitForText', input: { text: third, within: scope }, timeoutMs: 25000 })
  }
  // 勾选数下限（实测快手：只勾 1 位点「批量邀约」静默无反应）→ 不足就把本批要的人数抬到下限，
  // 否则每轮都会白跑一次"点了没反应"。count 本身已由面板按 maxBatch 收过口。
  const need = Math.max(opts.count, p.minSelect || 1)
  // scroll=true：广场列表在固定容器里滚动加载（无分页），一屏放不下 40 位——
  // 点完当前可点的行后向下滚动、等新行渲染再继续（实测修掉"要勾 40 位却只勾中 1 位"）。
  round.push({
    type: 'clickAll',
    input: {
      selector: p.rowCheckboxSelector,
      max: need,
      scroll: true,
      maxRounds: 40,
      // 计数消歧义：快手达人选人区的计数写作「已选N条」（不是抖店的「已选择N位达人」）。
      // 不给这一段只认抖店写法；给了才启用宽松写法（见 clickAll 的 counterIncludes 说明）。
      counterIncludes: '已选'
    },
    timeoutMs: 240000
  })
  // 勾不满时 clickAll 自己会报 TASK_SELECTION_SHORTFALL（loop 的 stopOn 把它当正常收尾），
  // 所以这里**不需要**再加一道"按钮可用性预检"——那道预检看着更保险，实际会因页面上的
  // 类目下拉挡住按钮而误报"找不到「批量邀约」"（真机踩到）。
  round.push({ type: 'clickByText', input: { text: p.texts.batchInvite } })
  round.push({ type: 'waitForSelector', input: { selector: p.scriptSelector }, timeoutMs: 30000 })
  // 额度先行（按档案选择方式）：
  //  - requireEnabled：平台不展示剩余额度，额度用尽表现为抽屉确认按钮禁用（抖店）；
  //  - requireQuota  ：页面**明示**剩余额度（快手「今日剩余N条发送邀请机会」），取数字判断。
  // 两者不足时都如实报 TASK_QUOTA_EXCEEDED → loop 里视为"额度用完"正常收尾。
  if (p.quotaCheck === 'requireQuota' && p.quota) {
    round.push({
      type: 'requireQuota',
      input: { textIncludes: p.quota.textIncludes, min: p.quota.min, optional: !!p.quota.optional, hint: p.quotaNote },
      timeoutMs: 30000
    })
  } else if (p.texts.drawerConfirm) {
    round.push({ type: 'requireEnabled', input: { text: p.texts.drawerConfirm, hint: p.quotaNote }, timeoutMs: 30000 })
  }
  // 必填联系方式（快手要求联系人/手机号/微信号；抖店无此字段 → contacts 为空则整段跳过）。
  // 用 setInput（合成 input 事件）：实测快手这三个框吃合成事件；微信那种不吃的是 typeText 流程。
  for (const c of (opts.contacts || [])) {
    if (!c.text) continue
    round.push({ type: 'setInput', input: { selector: c.selector, text: c.text }, timeoutMs: 20000 })
  }
  if (opts.scriptMode === 'ai') {
    round.push({
      type: 'aiGenerate',
      input: {
        selector: p.scriptSelector,
        sourceSelector: p.goodsSourceSelector || '',
        maxLen: p.scriptMaxLen
      },
      timeoutMs: 90000,
      // 生成话术幂等（重跑=重新生成覆盖同一输入框）→ 允许瞬态重试，
      // 免得一次模型抖动把整批（可能已真实发出几十位）打掉。理由同 assist 流程那条注释。
      retryLimit: 2
    })
    // aiGenerate 的 payload 只有摘要（模型/长度/预览），完整话术靠 readText 落库——事后能查出"到底发了什么"
    round.push({ type: 'readText', input: { selector: p.scriptSelector, metric: 'invite.script' }, timeoutMs: 15000 })
  } else {
    round.push({ type: 'setInput', input: { selector: p.scriptSelector, text: opts.script.trim() } })
  }
  // 商品：快手**必须选商品**才能发送（实测点「发送邀请」会提示「请选择商品」），
  // 而抽屉里那份商品表永远是空的 → 必须点「选择商品」进**弹窗**选，再点弹窗「确 认」回到抽屉。
  //
  // 这里**不用 ensureRows**，而是拆成显式步骤，原因：ensureRows 内部是**受信任鼠标**点击
  // （找坐标 → sendInputEvent），而实测快手选完带货类目后级联下拉常残留展开、盖住这些按钮，
  // 受信任鼠标会点在浮层上（引擎如实报 COVERED 或点了没反应）。改用 clickByText 的默认
  // **JS 点击**（不依赖坐标、不受遮挡影响）＋ clickAll（内部也是 label.click()）即可稳定走通。
  if (p.goodsModal) {
    const g = p.goodsModal
    round.push({ type: 'clickByText', input: { text: g.addText }, timeoutMs: 20000 })
    round.push({ type: 'waitForSelector', input: { selector: g.rowCheckboxSelector }, timeoutMs: 30000 })
    round.push({
      type: 'clickAll',
      input: {
        selector: g.rowCheckboxSelector,
        max: Math.max(1, opts.productCount ?? 1),
        // 排除表头的"全选"：它在 modal-body 内、也是 input[type=checkbox]，
        // 会被当成一个候选（点它会全选，不是我们要的"勾 N 个"）。
        skipSelector: '.kwaishop-cps-daren-match-pc-modal-body thead input[type=checkbox]'
      },
      timeoutMs: 60000
    })
    round.push({ type: 'clickByText', input: { text: g.confirmText }, timeoutMs: 20000 })
    // 选完商品点「确 认」后，平台**可能**再弹一个确认框：
    // 「您所选择的商品不符合达人带货要求，确认是否仍要发送邀请？」（取消 / 确认）。
    // 只在商品与该达人的品类要求不匹配时出现（实测同一个商品换一位达人就不弹），
    // 所以用 clickIfPresent：出现就点掉、没出现就跳过，并把"到底弹没弹"如实记进步骤结果。
    // nearText 必须给：那个确认框的按钮也叫「确认」，与商品弹窗的「确 认」同名——
    // 不限范围会点到下层弹窗的按钮（点了白点，确认框一直留着，商品计数还是 0/100）。
    //
    // 锚点用「确认是否仍要发送邀请」而不是更具体的那半句：**这个提示框的文案是动态的**，
    // 实测同一个流程见过两种：
    //   「您所选择的商品不符合达人带货要求，确认是否仍要发送邀请？」
    //   「您所设置的商品佣金率低于达人带货要求，确认是否仍要发送邀请？」
    // 只有"确认是否仍要发送邀请"是共有的（按具体那半句当锚点，第二种就点不掉了）。
    round.push({
      type: 'clickIfPresent',
      input: { text: '确认', nearText: '确认是否仍要发送邀请', waitMs: 8000 },
      timeoutMs: 22000
    })
    // 结果校验：**商品数真的 ≥ 1**（实测抽屉里「已选择商品数：1/100」）。
    // 用 requireQuota 这枚通用"数字 ≥ min"断言，但**必须换错误码**：
    // 默认的 TASK_QUOTA_EXCEEDED 在 loop 的 stopOn 里（= 正常收尾），
    // 用它会把"商品没选上"当成"按预期收工"→ 一位都没邀约却报成功（最危险的静默失败）。
    round.push({
      type: 'requireQuota',
      input: {
        textIncludes: g.selectedMarker,
        min: 1,
        code: 'TASK_PRODUCT_NOT_SELECTED',
        hint: '邀约商品没选上——平台要求必选商品才能发送，已在发送前中止'
      },
      timeoutMs: 30000
    })
  }
  for (const b of opts.benefits) round.push({ type: 'clickByText', input: { text: b } })
  round.push({
    type: 'waitForUserConfirmation',
    input: { message: `确认向 ${need} 位达人发送邀约？` },
    timeoutMs: 3600000
  })
  round.push({ type: 'clickByText', input: { text: p.texts.confirmSend } })
  // 发送后**可能**弹二次确认框（平台行为未定时的兜底）：出现就点、没出现就跳过，如实记录。
  // 不硬等（白等超时会把成功报成失败），也不假设没有（真弹了没人点其实没发出去）。
  //
  // 实测（2026-09-15 快手真机）：点「发送邀请」后平台弹**「邀约提示」**弹窗，列出
  // "商品佣金率低于达人下限 / 商家体验分低于达人设置下限"等**逐条不满足项**，
  // 底部两个按钮是「返回调整 / **继续发送邀约**」——不点它，邀约抽屉永远不关，
  // waitForGone 白等到超时，一次真实的发送被记成失败（且平台侧确实一条都没发出去）。
  // 这类弹窗**只在商品与该达人的要求不匹配时出现**（同一批里换一位达人可能就不弹），
  // 所以必须用 clickIfPresent（出现就点、没出现就跳过）。
  // 它可能同时有「确认」这一种措辞（旧版实测），所以逐个候选试一遍。
  for (const t of p.postSendConfirmTexts || []) {
    round.push({ type: 'clickIfPresent', input: { text: t, waitMs: 8000 }, timeoutMs: 25000 })
  }
  // 发送后的结果校验（顺序很重要）：
  //  ① 先断言**平台没说失败**：实测快手点「发送邀请」后可能弹「部分邀约发送失败」
  //     （近7天有未处理/被拒绝的邀约单），并且**故意把抽屉留着**让你调整重试。
  //     这时"抽屉没关"根本区分不出"发送失败"与"平台还在处理"——只有读这段失败文案才能
  //     如实报出"这一批其实没发出去"。放在 waitForGone 之前：失败文案通常立刻出现，
  //     先读它就不用白等三分钟才知道没发成功。
  //     没登记该文案的平台（如抖店）不插入这一步。
  //  ② 再校验邀约抽屉应关闭；没关说明平台没接受这次提交，如实失败。
  //     超时按平台给：实测快手真实发送后抽屉要**一分多钟**才关（平台侧在处理；
  //     实测 30s / 90s 都太短，会把一次成功的发送误报成失败）。
  //     注意不能再用"有没有配确认框"去推这个超时——独立字段，各平台自己说。
  if (p.texts.sendRejectedMarker) {
    // 先记下平台给的失败原文（它是"平台已拒绝"的**证据**，点掉前先读一次）。
    //
    // 措辞必须是"部分"：实测快手这条弹窗叫「**部分**邀约发送失败」，列出的是**逐条**被拒的人
    // （如「近7天有未处理/被拒绝的邀约单，暂不能发送新的邀约单(达人ID:…)]」），
    // 同一批里**其余人可能已经发出去了**（实测同一批 2 位：1 位进「邀约中」、1 位被拒）。
    // 所以错误码用 TASK_SEND_PARTIAL、提示语**不能**说"未产生有效邀约"——那是把部分成功
    // 说成全失败，会误导用户以为要重发，反而造成重复邀约。
    round.push({
      type: 'requireTextAbsent',
      input: {
        text: p.texts.sendRejectedMarker,
        code: 'TASK_SEND_PARTIAL',
        hint: '平台列出的是**这些**达人没发出去（多为"近7天有未处理/被拒绝的邀约单"）——本批其余人可能已发出，请以「我的达人 → 邀约中」为准，别急着重发',
        waitMs: 8000
      },
      timeoutMs: 20000
    })
  }
  round.push({ type: 'waitForGone', input: { selector: p.scriptSelector }, timeoutMs: p.postSendGoneTimeoutMs ?? 180000 })
  // 截图留档：每轮发送后的达人侧状态（最后一轮的工件会挂在本步骤上）
  round.push({ type: 'screenshot', input: {}, timeoutMs: 20000 })

  const labelParts = [
    opts.category
      ? opts.category +
        (opts.subcategory ? '/' + opts.subcategory : '') +
        (opts.subcategory && opts.category3 ? '/' + opts.category3 : '')
      : '全部',
    ...(opts.levels.length ? [opts.levels.join('/')] : []),
    `每批 ${need} 位`
  ]
  return [{
    type: 'loop',
    input: {
      label: labelParts.join(' · '),
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
      // 详情页渲染正常、但平台明说这一位**不满足合作条件**时，页面上没有「邀请带货」，
      // 而是写着「暂未到达合作门槛」（实测：同一页可邀约的显示「邀请带货」）。
      // 这两件事的处置**相反**，必须在这里分开：
      //   - 按钮不在、也没有这句话 → 页面（微应用）没渲染出来 → 退避后重试同一位；
      //   - 按钮不在、但有这句话 → 这位达人天生不能邀约 → 立刻换下一位，重试毫无意义。
      // 不给 absentCode 的话两者会共用 missingCode，表现成"一直重试同一个不能邀约的人"。
      absentText: p.texts.notInvitable,
      absentCode: 'TASK_DAREN_NOT_INVITABLE',
      // 按钮存在但**禁用**：微信在这里表达的是"这一位现在不能邀约"，实测原因是
      // 「你已经邀请过该达人，7天内不可再次发送带货邀约」（悬浮说明）。
      // 与上面的缺席判据一样，必须**跳过换下一位**而不是中止整单——
      // 一批刚发完就再跑时，广场排在前面的往往正是刚邀过的人。
      // 报出的文案由引擎带上平台给的禁用原因，日志里能看出到底是"已邀约"还是别的原因。
      disabledCode: 'TASK_DAREN_ALREADY_INVITED',
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
      timeoutMs: 90000,
      // 生成话术是**幂等**的（重跑只是重新生成并覆盖同一个输入框），所以允许瞬态重试：
      // 真机实测第 25 轮 aiGenerate 超时 30s 直接把整单打掉，而前 24 位已真实发出——
      // 一次模型抖动不该让整批作废。aiGenerate 内部超时由 AI 客户端控制，重试由 loop 做。
      retryLimit: 2
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
          },
          {
            // 页面正常、但平台明说这一位不满足合作条件（「暂未到达合作门槛」）：
            // **跳过换下一位**（advance = 重开本轮但保留"已访问"记录，所以会取到下一条候选），
            // 不做退避——它不是限流，等多久都一样。
            // limit=20：一屏里不可邀约的占比实测约 1/4，给足余量；连续 20 位都不行
            // （多半是这组筛选下确实没几个可邀约的）就如实收尾，不做无意义空转。
            code: 'TASK_DAREN_NOT_INVITABLE',
            limit: 20,
            advance: true,
            steps: [{ type: 'waitMs', input: { ms: 300 }, timeoutMs: 5000 }]
          },
          {
            // 这一位已经邀约过（按钮禁用 + 平台提示「你已经邀请过该达人，7天内不可再次发送带货邀约」）：
            // 同样是**跳过换下一位**。一批刚发完就再跑时，广场排在前面的往往正是刚邀过的人；
            // 不跳过就会在第一轮当场 TASK_TARGET_DISABLED 中止，整单跑不起来。
            code: 'TASK_DAREN_ALREADY_INVITED',
            limit: 20,
            advance: true,
            steps: [{ type: 'waitMs', input: { ms: 300 }, timeoutMs: 5000 }]
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
