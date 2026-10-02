/**
 * 发布预检纯规则（方案 §7.2 / §7.6 / §7.7）
 *
 * 这是**发布的门禁**：把"能不能发、发之前要让人看什么、会不会重复发"全部算清楚，
 * 且**不碰浏览器、不写库**——纯函数，界面、服务、任务引擎共用同一份判定（各写一套必然分叉）。
 *
 * 三条不可动摇的纪律（都来自方案 §7.9）：
 *   ① 这里**只产出计划与清单**，不产生任何"提交"动作；
 *   ② 未实测的平台一律 L3（只打开页面、引导人工），**不假装能自动填**；
 *   ③ 重复发布一律**默认拒绝**并说明理由（与上次完全一致 / 在途任务 / 平台已有链接）。
 */

import { hasBlockingIssue, productDraftIssues, type LocalProductDraft, type ProductDraftIssue } from './product-draft'
import { publishTierFor, PRODUCT_PUBLISH_PROFILES, type PublishTier } from './constants/product'

/** 单店发布状态机的状态（方案 §7.4）。 */
export type PublishItemState =
  | 'prechecking'
  | 'precheck_failed'
  | 'filling'
  | 'fill_partial'
  | 'awaiting_human'
  | 'verifying'
  | 'confirmed'
  | 'needs_review'
  | 'discarded'

/** 逐字段的"本次动作"。`fill*` 会写页面；其余都只提示。 */
export type PublishFieldAction =
  | 'fill'              // 本地有、平台空 → 填入
  | 'fill_suggest'      // 建议填入，**待用户确认**（类目这类有平台规则的字段）
  | 'keep_platform'     // 平台已有值且与本地不同 → 不动平台，摆给用户看
  | 'reuse_last'        // 用上次发布时的选择（如运费模板）
  | 'skip_unsupported'  // 该平台不支持这个字段 → 跳过（warning）
  | 'leave_empty'       // 本地也没有 → 不填，记入"待补清单"

export interface PublishPrecheckField {
  field: string
  label: string
  localValue: string | null
  platformValue: string | null
  lastValue: string | null
  action: PublishFieldAction
  level: 'info' | 'warning' | 'blocker'
  note?: string
}

export interface PublishPrecheckInput {
  product: { id: string; title: string; draft: LocalProductDraft; draftHash: string }
  target: { storeId: string; storeName: string; platform: string; storeStatus: string }
  /** 该商品在该店已有的平台链接（判断"是不是已经发过"） */
  existingLinks: Array<{
    storeId: string; platform: string; platformProductId: string; platformStatus: string
    /** 上次发布成功时的草稿指纹（迁移 v29 加的列）。null/缺失 = 老数据，无法比较 → 按"放行"处理。 */
    draftHash?: string | null
  }>
  /** 上次发布时用的字段值（product_platform_defaults），用于"用上次选择" */
  lastValues?: Record<string, string | null>
  /** 同店同商品是否已有在途发布任务 */
  inFlight?: boolean
}

export interface PublishPrecheckResult {
  verdict: 'ready' | 'ready_with_warnings' | 'blocked'
  /** 预检通过后应进入的状态 */
  nextState: PublishItemState
  tier: PublishTier
  /** 幂等键（方案 §7.7）：同键在途直接复用既有 item，不新建 */
  idempotencyKey: string
  draftHash: string
  blockers: ProductDraftIssue[]
  warnings: ProductDraftIssue[]
  /** 字段级 diff（方案 §7.6）：界面上的那张核对清单就是它 */
  fields: PublishPrecheckField[]
  /** 该平台必填但本地没有的字段（记入"本地补全清单"） */
  missingRequired: string[]
  /** 一句人能看懂的话（界面直接显示） */
  summary: string
}

/** 幂等键：同一商品 + 同一店铺 + 同一草稿指纹 = 同一次发布。 */
export function publishIdempotencyKey(productId: string, storeId: string, draftHash: string): string {
  return `publish:${productId}:${storeId}:${draftHash}`
}

function money(minor: number | null): string | null {
  return minor == null ? null : `¥${(minor / 100).toFixed(2)}`
}

/** 草稿里"会被发布用到"的字段及其本地值（供 §7.6 三列对比）。 */
function localFieldValues(draft: LocalProductDraft): Record<string, string | null> {
  const prices = draft.variants.map(variant => variant.priceMinor).filter((value): value is number => value != null)
  const stocks = draft.variants.map(variant => variant.stock).filter((value): value is number => value != null)
  return {
    title: draft.title || null,
    subtitle: draft.subtitle ?? null,
    price: prices.length ? (prices.length === 1 ? money(prices[0]) : `${money(Math.min(...prices))} ~ ${money(Math.max(...prices))}`) : null,
    stock: stocks.length ? String(stocks.reduce((sum, value) => sum + value, 0)) : null,
    category: draft.localCategory ?? null,
    brand: draft.brand ?? null,
    image: draft.media.length ? `${draft.media.length} 张（主图${draft.media.some(item => item.role === 'cover') ? '已设' : '未设'}）` : null,
    spec: draft.variants.length ? `${draft.variants.length} 个规格` : null
  }
}

/**
 * 发布预检。
 *
 * 判定顺序固定：先阻断项（能不能发）→ 再字段动作（怎么发）→ 最后警告（发之前要知道什么）。
 */
export function precheckPublish(input: PublishPrecheckInput): PublishPrecheckResult {
  const { product, target } = input
  const blockers: ProductDraftIssue[] = []
  const warnings: ProductDraftIssue[] = []
  const profile = PRODUCT_PUBLISH_PROFILES[target.platform] ?? null
  const tier = publishTierFor(target.platform)
  const idempotencyKey = publishIdempotencyKey(product.id, target.storeId, product.draftHash)

  // ---------- 阻断项 ----------

  // ① 草稿本身的阻断问题（标题空、无主图、无规格、价格非法）
  const draftIssues = productDraftIssues(product.draft, { platform: target.platform })
  for (const issue of draftIssues) {
    if (issue.level === 'blocker') blockers.push(issue)
    else if (issue.level === 'warning') warnings.push(issue)
  }

  // ② 店铺状态：**只有"确实不能发"的状态才阻断**。
  //
  // ⚠️ 这里曾经写成"只要不是 online 就阻断"，那是**语义理解错误**（2026-09-30 实测踩到）：
  //   · `offline` 的语义是"**浏览器窗口没开 / 还没确认登录**"（代码注释原话：
  //     "打开浏览器只代表 Session 已建立，不能据此推断平台已登录"）；
  //   · "真的没登录"是**另一个**状态 `needs_login`。
  // 把 `offline` 当阻断，结果是**明明登录着的店铺永远发不出去**（实测：微信小店一直卡在
  // "店铺 offline，不能发布"，而它的页面我们一直能正常读）。
  // 正确口径：offline/launching 只是"还没开"，发布时会先打开店铺并确认登录 → 记 warning。
  const blockingStatuses: Record<string, string> = {
    needs_login: '需要登录该店铺',
    proxy_error: '代理异常',
    archived: '店铺已归档',
    incomplete: '店铺配置不完整'
  }
  const blockingReason = blockingStatuses[target.storeStatus]
  if (blockingReason) {
    blockers.push({
      level: 'blocker', field: 'title',
      message: `店铺「${target.storeName}」${blockingReason}（当前状态 ${target.storeStatus}），不能发布`,
      fixHint: target.storeStatus === 'needs_login' ? '先在该店铺完成登录' : '先处理店铺状态问题'
    })
  } else if (target.storeStatus === 'offline' || target.storeStatus === 'launching') {
    warnings.push({
      level: 'warning', field: 'title',
      message: `店铺「${target.storeName}」当前不在线（${target.storeStatus}：窗口没开或还没确认登录）—— 发布时会先打开店铺并确认登录状态`,
      fixHint: '不需要额外操作；如果打开后发现要登录，按提示登录即可'
    })
  }

  // ③ 已发过且草稿**一模一样** → 默认拒绝（方案 §7.7：这是"白跑一趟"而不是"更新"）
  //
  // ⚠️ **这里曾经是个挡住主链路的 bug**（2026-10-02 实测查明，见 §12.11）：
  // 原条件只判断 `sameStore.length > 0`（"这家店有没有这个商品的链接"），**完全没有比较内容**，
  // 但文案却写着"且本地草稿与上次完全一致"、fixHint 写着"本地内容改了之后才会允许再次发布"。
  // 结果：商品在某家店发过一次之后**永远发不出去**（实测：改了标题、draftHash 变了，预检仍 blocked），
  // 而且界面用一个**代码里不存在的条件**骗用户。比较所需的数据当时也没落库（迁移 v29 才补上）。
  //
  // 现在的口径与文案一致：**只有"真的和上次一模一样"才拒绝**（那才是"白跑一趟"）。
  const sameStore = input.existingLinks.filter(link => link.storeId === target.storeId)
  const lastPublished = sameStore[0]
  const draftUnchanged = !!lastPublished?.draftHash && lastPublished.draftHash === input.product.draftHash
  if (lastPublished && draftUnchanged) {
    blockers.push({
      level: 'blocker', field: 'title',
      message: `该店铺已经有这个商品的平台记录（平台商品 ID ${lastPublished.platformProductId}），且本地草稿与上次完全一致`,
      fixHint: '要更新平台商品请用平台的编辑入口；本地内容改了之后才会允许再次发布'
    })
  }

  // ④ 同店同商品已有在途任务 → 直接复用，不新建
  if (input.inFlight) {
    blockers.push({
      level: 'blocker', field: 'title',
      message: '这个商品在这家店已有一次未完成的发布',
      fixHint: '到「发布」列表里继续那一次，不要重复发起'
    })
  }

  // ---------- 字段动作（方案 §7.6 的那张表）----------

  const local = localFieldValues(product.draft)
  const lastValues = input.lastValues ?? {}
  const fields: PublishPrecheckField[] = []
  const missingRequired: string[] = []

  // 每个字段的标签与"该平台是否支持"。
  //
  // ⚠️ **只写实测过的**：这里曾经把微信的 `subtitle` 写成 `false`（"该平台不支持副标题"），
  // 而那是**没实测就下的结论** —— 实测发布页明明有 `请输入商品短标题`。
  // 猜出来的"不支持"比"不知道"更糟：它会让一个能填的字段被静默丢掉。
  // 所以没有实测依据的平台，这里**整个不登记**（走下面 `!profile` 的分支，如实说"未实测"）。
  const SUPPORTED: Record<string, Record<string, boolean>> = {
    微信小店: {
      title: true,
      subtitle: true,   // 实测：请输入商品短标题
      price: true,
      stock: true,
      category: true,
      brand: true,
      image: true,
      spec: true
    }
  }
  const LABELS: Record<string, string> = {
    title: '标题', subtitle: '副标题', price: '价格', stock: '库存',
    category: '类目', brand: '品牌', image: '图片', spec: '规格'
  }
  const REQUIRED: Record<string, string[]> = {
    微信小店: ['title', 'price', 'stock', 'category', 'image']
  }

  const supported = SUPPORTED[target.platform] ?? {}
  const required = REQUIRED[target.platform] ?? []
  for (const field of ['title', 'subtitle', 'price', 'stock', 'category', 'brand', 'image', 'spec']) {
    const localValue = local[field] ?? null
    const lastValue = lastValues[field] ?? null
    // 平台当前值：预检阶段还没读页面，一律为 null（读页面属于"填写阶段"的事）
    const platformValue: string | null = null

    // 未实测发布档案的平台：**不判断支持性**（不知道的事不猜），全部按"留给人工"
    if (!profile) {
      fields.push({
        field, label: LABELS[field], localValue, platformValue, lastValue,
        action: 'leave_empty', level: 'info',
        note: `${target.platform}尚未实测发布页，这一项由你在页面上处理`
      })
      continue
    }
    if (supported[field] === false) {
      fields.push({
        field, label: LABELS[field], localValue, platformValue, lastValue,
        action: 'skip_unsupported', level: localValue ? 'warning' : 'info',
        note: `${target.platform}发布页没有这个入口 → 跳过${localValue ? '（本地有值，会被忽略）' : ''}`
      })
      continue
    }
    if (!localValue) {
      if (required.includes(field)) missingRequired.push(LABELS[field])
      fields.push({
        field, label: LABELS[field], localValue: null, platformValue, lastValue,
        action: lastValue ? 'reuse_last' : 'leave_empty',
        level: required.includes(field) ? 'warning' : 'info',
        note: lastValue ? `本地没填，用上次的选择「${lastValue}」` : '本地也没填'
      })
      continue
    }
    // ⚠️ **锚点适用范围**（2026-09-30 实测）：新增商品页与编辑既有商品页共用一个 URL，
    // 但渲染出来的字段不一样（实测新增页只有标题；短标题/品牌/类目/价格/库存只在编辑页出现）。
    // 所以"在编辑页测到的字段"不能在新增页上承诺代填 —— 那会得到"页面上还没有这个字段"。
    // 这里如实降级成"留人工"，而不是嘴上说能填、实际填不上。
    //
    // **必须排在下面"类目建议填入"之前**：页面范围是硬约束，任何"建议填"都不能越过它
    // （顺序反了会让类目绕过范围检查、又变回 fill_suggest —— 单测抓到过）。
    const anchor = profile.fields.find(item => item.field === field)
    // **档案里没登记这个字段 = 没实测过它** → 一律不代填。
    // 否则会出现"预检说会填、代填里却没有这个锚点"的不一致（实测抓到：规格被标成 fill，
    // 而档案里根本没登记 spec 的锚点，结果说了要填却不会填）。
    const registered = !!anchor
    const fillableOnNewPage = registered && (anchor!.pageScope === undefined || anchor!.pageScope === 'new' || anchor!.pageScope === 'new+edit')
    if (!fillableOnNewPage) {
      fields.push({
        field, label: LABELS[field], localValue, platformValue, lastValue,
        action: 'leave_empty',
        // 本地**有值**却填不了 → warning（用户必须知道这一项得自己动手）；
        // 本地也没有 → info（本来就没什么可丢的）
        level: localValue ? 'warning' : 'info',
        note: registered
          ? '该字段的锚点是在**编辑既有商品**页实测的，新增商品页上没有这个字段 → 本次不代填，请在页面上处理'
          : `尚未实测到该字段在${target.platform}发布页上的锚点 → 本次不代填，请在页面上处理`
      })
      continue
    }
    // 类目这类"平台有规则"的字段：建议填入但**待用户确认**（方案 §7.6）。
    // 注意这里是在**页面范围检查通过之后**才走到的 —— 类目在新增页上实测没有锚点，
    // 所以实际上会先被上面的范围检查拦下来（这正是我们要的：硬约束优先）。
    if (field === 'category') {
      fields.push({
        field, label: LABELS[field], localValue, platformValue, lastValue,
        action: 'fill_suggest', level: 'info',
        note: '建议填入，待你确认（平台的类目规则可能不接受这个路径）'
      })
      continue
    }
    fields.push({
      field, label: LABELS[field], localValue, platformValue, lastValue,
      action: lastValue && lastValue === localValue ? 'reuse_last' : 'fill',
      level: 'info',
      note: lastValue && lastValue === localValue ? '与上次一致' : undefined
    })
  }

  // ---------- 警告 ----------

  if (!profile) {
    warnings.push({
      level: 'warning', field: 'title',
      message: `${target.platform}尚未实测发布页，本次是**接力模式（L3）**：只打开页面并给你核对清单，不代填`,
      fixHint: '按核对清单在页面上自己填，填完回到应用点「我已提交」'
    })
  } else if (tier === 'L2') {
    warnings.push({
      level: 'warning', field: 'title',
      message: `${target.platform}的发布档案只实测了部分字段（${tier} 引导模式）：已实测的会填，其余给你清单`,
      fixHint: '按清单核对没填上的字段'
    })
  }

  const verdict: PublishPrecheckResult['verdict'] = blockers.length
    ? 'blocked'
    : warnings.length ? 'ready_with_warnings' : 'ready'

  return {
    verdict,
    nextState: verdict === 'blocked' ? 'precheck_failed' : 'filling',
    tier,
    idempotencyKey,
    draftHash: product.draftHash,
    blockers,
    warnings,
    fields,
    missingRequired,
    summary: verdict === 'blocked'
      ? `预检未通过：${blockers.length} 项阻断（${blockers.map(item => item.message).slice(0, 2).join('；')}）`
      : `预检通过（${tier}${warnings.length ? `，${warnings.length} 项提醒` : ''}）：${fields.filter(item => item.action.startsWith('fill')).length} 个字段会填，${missingRequired.length} 个必填项本地没有`
  }
}

/** 预检结果能不能进入填写阶段（服务/任务引擎的门禁调用）。 */
export function canStartFilling(result: PublishPrecheckResult): boolean {
  return result.verdict !== 'blocked' && !hasBlockingIssue([...result.blockers])
}

// ---------------------------------------------------------------- 回读校验（§7.5）

export interface ReadbackInput {
  /** **发布前**该店已知的平台商品 ID（基线）。空数组是合法的（首次发布） */
  baselinePlatformProductIds: readonly string[]
  /** 回读时刻该店的平台商品（标题用于匹配"是不是刚发的那个"） */
  current: ReadonlyArray<{ platformProductId: string; title: string }>
  /** 期望出现的标题（本地商品标题） */
  expectedTitle: string
}

export interface ReadbackResult {
  state: 'confirmed' | 'needs_review'
  reasonCode: string
  safeMessage: string
  /** 基线之后**新增**的平台商品 ID */
  newPlatformProductIds: string[]
  /** 其中标题匹配上的那些 */
  matchedPlatformProductIds: string[]
}

/**
 * 提交后回读的判定（方案 §7.5）。
 *
 * ⚠️ **必须对基线比对，不能"存在即确认"**（2026-09-30 实测踩到）：
 * 第一版回读只查"这个标题在不在本地台账里"，结果对一个**本来就同步过**的商品直接报 `confirmed`
 * —— 用户根本没提交成功也会显示"已确认"。那是假阳性，比不校验更糟。
 *
 * 正确口径：拿**发布前记下的平台商品 ID 集合**当基线，只认**基线之后新增**的记录：
 *   · 新增里标题恰好匹配 1 条 → `confirmed`；
 *   · 新增里 0 条匹配       → `needs_review`（可能还没同步过来，或提交其实没成功）；
 *   · 新增里 ≥2 条匹配      → `needs_review` + 明确提示**疑似重复提交**（方案 §7.7）。
 */
export function evaluateReadback(input: ReadbackInput): ReadbackResult {
  const baseline = new Set(input.baselinePlatformProductIds)
  const added = input.current.filter(row => !baseline.has(row.platformProductId))
  const newIds = added.map(row => row.platformProductId)
  const matched = added.filter(row => sameTitle(row.title, input.expectedTitle)).map(row => row.platformProductId)

  if (matched.length === 1) {
    return {
      state: 'confirmed',
      reasonCode: 'READBACK_CONFIRMED',
      safeMessage: `回读确认：平台上**新增**了「${input.expectedTitle.slice(0, 20)}」（平台商品 ID ${matched[0]}）`,
      newPlatformProductIds: newIds,
      matchedPlatformProductIds: matched
    }
  }
  if (matched.length === 0) {
    return {
      state: 'needs_review',
      reasonCode: 'READBACK_NO_NEW_RECORD',
      safeMessage: newIds.length
        ? `回读**没有**找到这个标题的新增记录（平台侧新增了 ${newIds.length} 条，但标题都对不上）—— 可能提交没成功，或平台改了标题`
        : '回读**没有**找到任何新增记录 —— 可能还没同步过来（先跑一次商品同步再看），或提交其实没成功',
      newPlatformProductIds: newIds,
      matchedPlatformProductIds: []
    }
  }
  return {
    state: 'needs_review',
    reasonCode: 'READBACK_DUPLICATE',
    safeMessage: `回读发现 ${matched.length} 条新增的同标题记录（ID ${matched.join('、')}）—— **疑似重复提交**，请在平台上核对后处理`,
    newPlatformProductIds: newIds,
    matchedPlatformProductIds: matched
  }
}

/** 标题比较：去空白 + 忽略大小写（平台可能对空白做归一化）。 */
function sameTitle(a: string, b: string): boolean {
  const norm = (value: string): string => String(value ?? '').replace(/\s+/g, '').toLowerCase()
  return norm(a) === norm(b) && norm(a) !== ''
}
