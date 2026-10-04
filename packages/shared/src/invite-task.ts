/**
 * 达人邀约任务构造（单一事实来源）。
 *
 * 面板与智能体共用同一个构造器：配置快照 → 校验 → `buildInviteSteps`。
 * 为什么必须共用：配置里装的是**店铺自己的**联系人/手机号/微信号，两处各写一遍
 * 必然漂移（真机口径的同类事故：把 A 店的手机号发给 B 店的达人）。
 */
import { ASSIST_DEFAULT_MAX_INVITES, ASSIST_LOOP_MAX_ROUNDS, buildInviteSteps, hasRequiredBatchContacts, normalizeMaxInvites, type AssistInviteOptions, type BatchInviteOptions, type StepDraft } from './invite-steps'
import type { InviteProfile } from './constants/invite'

/** 邀约配置快照（面板按店铺存进 app_settings 的那份；字段按流程可选） */
export interface InviteTaskConfigSnapshot {
  category?: string
  subcategory?: string
  category3?: string
  levels?: string[]
  count?: number
  script?: string
  scriptMode?: 'manual' | 'ai'
  benefits?: string[]
  strengths?: string[]
  mainCategory?: string
  extraFilters?: Record<string, string[]>
  batchContact?: string
  batchPhone?: string
  batchWechat?: string
  batchProductCount?: number
  contact?: string
  wechat?: string
  phone?: string
  productIds?: string | string[]
  finderType?: string
  finderCategories?: string[]
  /** 「近30日带货数据 → 带货销售总额」的区间档位（真实文案） */
  finderSalesTiers?: string[]
  finderOtherFilters?: string[]
  /** 本次最多邀约几位（额度护栏，见 AssistInviteOptions.maxInvites） */
  maxInvites?: number
  /** 近 7 天已邀过的达人昵称（台账）：点「详情」时跳过这些行，不重复邀约 */
  recentlyInvited?: string[]
}

export interface InviteTaskPayload {
  name: string
  storeScope: string
  steps: StepDraft[]
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
const list = (value: unknown, max: number): string[] => Array.isArray(value)
  ? value.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => String(item).slice(0, max)).slice(0, max)
  : []
const boundedPicks = (value: unknown, max?: number): string[] => {
  const values = Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => String(item).trim())
    : []
  return values.slice(0, max == null ? values.length : Math.max(0, max))
}
const mapList = (value: unknown): Record<string, string[]> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 12)) out[String(key).slice(0, 60)] = list(item, 60)
  return out
}

/** 把存档/表单的松散对象规范成有界快照（缺省为空值，绝不猜内容）。 */
export function normalizeInviteTaskConfig(flow: 'batch-list' | 'assist-form', saved: unknown): InviteTaskConfigSnapshot {
  const record = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {}
  const scriptMode = record.scriptMode === 'ai' ? 'ai' as const : 'manual' as const
  if (flow === 'batch-list') {
    const count = Number(record.count)
    return {
      category: text(record.category, 40),
      subcategory: text(record.subcategory, 40),
      category3: text(record.category3, 40),
      levels: list(record.levels, 40),
      count: Number.isFinite(count) ? Math.round(count) : undefined,
      script: text(record.script, 2000),
      scriptMode,
      benefits: list(record.benefits, 120),
      strengths: list(record.strengths, 120),
      mainCategory: text(record.mainCategory, 120),
      extraFilters: mapList(record.extraFilters),
      batchContact: text(record.batchContact, 120),
      batchPhone: text(record.batchPhone, 40),
      batchWechat: text(record.batchWechat, 80),
      batchProductCount: Number.isFinite(Number(record.batchProductCount)) ? Math.max(0, Math.round(Number(record.batchProductCount))) : 1,
      /**
       * 近 7 天已邀过的达人昵称 → 勾选阶段跳过（批量流也要，2026-10-04 补）。
       *
       * ⚠️ 之前这一支**漏了它**：面板照常查台账并传进来，归一化时被丢掉 →
       * 快手的 skipTexts 恒为空，等于这条防线在批量流上根本没生效（微信流才有）。
       * 与微信支同一套收口（去空、限长 120、最多 500 条）。
       */
      recentlyInvited: (Array.isArray(record.recentlyInvited) ? record.recentlyInvited : [])
        .filter(item => typeof item === 'string' && item.trim().length > 0)
        .map(item => String(item).trim().slice(0, 120))
        .slice(0, 500)
    }
  }
  return {
    script: text(record.script, 2000),
    scriptMode,
    contact: text(record.contact, 120),
    wechat: text(record.wechat, 80),
    phone: text(record.phone, 40),
    productIds: parseInviteProductIds(typeof record.productIds === 'string' || Array.isArray(record.productIds) ? record.productIds as string | string[] : undefined),
    finderType: text(record.finderType, 60) || '全部带货者',
    finderCategories: list(record.finderCategories, 60),
    finderSalesTiers: list(record.finderSalesTiers, 60),
    finderOtherFilters: list(record.finderOtherFilters, 60),
    // 额度护栏：老配置没有这个字段 → 用默认值（10），而不是"不限"。
    // 这里刻意用 normalizeMaxInvites 而不是原样透传：坏值（0/负数/超大）一律收敛到合法区间。
    maxInvites: record.maxInvites == null ? ASSIST_DEFAULT_MAX_INVITES : normalizeMaxInvites(record.maxInvites),
    /**
     * 近 7 天已邀过的达人昵称（台账，由面板/调用方查好传进来）。
     * 这里只做**边界收口**（去空、限长 120、最多 500 条）：值本身是"列表里显示过的昵称"，
     * 不做任何模糊匹配——匹配不上的那些由平台的"7 天内不可再次邀请"兜底。
     * （不能用 list()：它的第二个参数同时是"条数上限"，会把清单截成 120 条。）
     */
    recentlyInvited: (Array.isArray(record.recentlyInvited) ? record.recentlyInvited : [])
      .filter(item => typeof item === 'string' && item.trim().length > 0)
      .map(item => String(item).trim().slice(0, 120))
      .slice(0, 500)
  }
}

/** 商品 ID：字符串按逗号/空格/换行分隔，数组直接用；去重、限长、上限 30。 */
export function parseInviteProductIds(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,，、]+/)
  return [...new Set(raw.map(item => String(item).trim()).filter(Boolean).map(item => item.slice(0, 40)))].slice(0, 30)
}

/**
 * 开跑前的完整性检查（与面板 `inviteReady` 同一口径，错误逐条可读）。
 * 话术：抽屉里真有话术框（profile.scriptSelector）或辅助流程才要求；AI 模式视为已就绪
 * （运行时由 aiGenerate 步骤生成，未配置 AI 时引擎如实报 AI_NOT_CONFIGURED）。
 */
export function inviteTaskIssues(input: { profile: InviteProfile; config: InviteTaskConfigSnapshot }): string[] {
  const { profile, config } = input
  const issues: string[] = []
  const scriptRequired = profile.flow !== 'batch-list' || !!profile.scriptSelector
  const scriptOk = config.scriptMode === 'ai' ? true : String(config.script || '').trim().length > 0
  if (scriptRequired && !scriptOk) issues.push('邀约话术未填写')
  if (profile.flow === 'assist-form') {
    if (!String(config.contact || '').trim()) issues.push('联系人未填写')
    if (!String(config.wechat || '').trim()) issues.push('微信号未填写')
    if (!String(config.phone || '').trim()) issues.push('手机号未填写')
    if (parseInviteProductIds(config.productIds).length > 30) issues.push('邀约商品超过 30 个')
    /**
     * 广场筛选的**实测清单校验**（2026-10-02 加）。
     *
     * 为什么要拦"清单外的值"：档案里的选项是逐个真机实测出来的，平台改版后文案会变
     * ——实测微信把「汽车电动」改成了「汽摩电动」，按旧文案点只会得到"页面上找不到"，
     * 用户看到的是"点了没反应"。存的是旧值（旧配置/旧版本遗留）时，在这里明确说是哪一项过期了，
     * 比在运行时抛 TASK_SELECTOR_CHANGED 好排查得多。
     */
    const unknownValues = (label: string, values: string[], allowed: readonly string[]): void => {
      const bad = values.filter(v => !allowed.includes(v))
      if (bad.length) issues.push(`${label}「${bad.join('、')}」不在平台实测清单里（平台可能已改名），请重新选择`)
    }
    unknownValues('带货类目', config.finderCategories || [], profile.finderCategories)
    unknownValues('带货销售总额档位', config.finderSalesTiers || [], profile.finderSalesTiers || [])
    unknownValues('其他筛选', config.finderOtherFilters || [], profile.finderOtherFilters)
    const finderType = String(config.finderType || '').trim() || '全部带货者'
    if (!profile.finderTypes.includes(finderType)) issues.push(`带货者类型「${finderType}」不在平台实测清单里，请重新选择`)
    /**
     * 「带货销售总额」只在某些类型页签下存在（实测微信：只有「全部带货者」有这一维，
     * 直播/短视频/公众号各只有本类型的指标）。不拦的话运行时会停在"找不到这个指标"，
     * 而用户从面板上看不出是类型选错了。
     */
    const salesTiers = config.finderSalesTiers || []
    const salesTypes = profile.finderSalesTypes || []
    if (salesTiers.length && salesTypes.length && !salesTypes.includes(finderType)) {
      issues.push(`「${profile.finderSalesMetric || '带货销售总额'}」只在「${salesTypes.join('、')}」下提供，当前类型是「${finderType}」——请改回该类型，或清空这项筛选`)
    }
    /**
     * 额度护栏也要校验：平台不显示剩余次数（实测两版页面都没有），所以"本次最多邀约几位"
     * 是我们唯一的硬上限。允许 1..50；超范围直接拦下，绝不放行成"不设上限"。
     */
    const maxInvites = Number(config.maxInvites)
    if (!Number.isInteger(maxInvites) || maxInvites < 1 || maxInvites > ASSIST_LOOP_MAX_ROUNDS) {
      issues.push(`「本次最多邀约」需为 1～${ASSIST_LOOP_MAX_ROUNDS} 的整数（当前 ${config.maxInvites === undefined ? '未设置' : String(config.maxInvites)}）`)
    }
    return issues
  }
  if (profile.levels.length > 0 && !(config.levels || []).length) issues.push('达人等级未选择')
  const benefitCount = boundedPicks(config.benefits).length
  if (profile.benefitsMax != null && benefitCount > profile.benefitsMax) {
    issues.push(`${profile.benefitsLabelText || '权益'}最多选择 ${profile.benefitsMax} 项`)
  }
  const strengthMax = profile.strengths?.maxSelect
  if (strengthMax != null && boundedPicks(config.strengths).length > strengthMax) {
    issues.push('核心优势最多选择 ' + strengthMax + ' 项')
  }
  const contactsOk = hasRequiredBatchContacts(profile, { contact: config.batchContact, phone: config.batchPhone, wechat: config.batchWechat })
  if (!contactsOk) issues.push('抽屉必填的联系方式未填写（联系人/手机号/微信号）')
  const count = Number(config.count)
  const minCount = Math.max(1, Math.min(profile.maxBatch, profile.minSelect || 1))
  if (!Number.isInteger(count) || count < minCount || count > profile.maxBatch) issues.push(`邀约数量需为 ${minCount}～${profile.maxBatch} 的整数`)
  return issues
}

/** 构造任务载荷：不完整返回 null（调用方先用 inviteTaskIssues 说明原因）。 */
export function buildInviteTaskPayload(input: { profile: InviteProfile; storeId: string; squareUrl: string; config: InviteTaskConfigSnapshot }): InviteTaskPayload | null {
  const { profile, storeId, squareUrl, config } = input
  if (!profile || !storeId) return null
  if (inviteTaskIssues({ profile, config }).length) return null
  if (profile.flow === 'batch-list') {
    const batch: BatchInviteOptions = {
      category: config.category || '',
      subcategory: config.subcategory || '',
      category3: config.category3 || '',
      levels: (config.levels || []).filter(level => profile.levels.includes(level)),
      count: Math.max(1, Math.min(Number(config.count), profile.maxBatch)),
      script: config.script || '',
      scriptMode: config.scriptMode || 'manual',
      // Shared/Main 也要执行平台上限，不能只依赖 Renderer 的 watch。
      benefits: boundedPicks(config.benefits, profile.benefitsMax),
      strengths: boundedPicks(config.strengths, profile.strengths?.maxSelect),
      mainCategory: config.mainCategory || '',
      extraFilters: config.extraFilters || {},
      contacts: profile.contactSelectors
        ? [
            ...(profile.contactSelectors.contact ? [{ selector: profile.contactSelectors.contact, text: String(config.batchContact || '').trim() }] : []),
            ...(profile.contactSelectors.phone ? [{ selector: profile.contactSelectors.phone, text: String(config.batchPhone || '').trim() }] : []),
            ...(profile.contactSelectors.wechat ? [{ selector: profile.contactSelectors.wechat, text: String(config.batchWechat || '').trim() }] : [])
          ].filter(item => item.text)
        : [],
      // 上限用平台档案自己的 maxProducts（快手 10）：这里再夹一次是兜住绕过面板的调用方，
      // 口径必须与面板/档案一致，写死 20 会让超限配置照样进执行器。
      productCount: Math.max(0, Math.min(profile.maxProducts, Number(config.batchProductCount) || 0)),
      /**
       * 近 7 天已邀过的昵称 → 勾选阶段跳过（用户要求：7 天内不重复邀约）。
       * 批量流与微信流同一个台账；平台侧同样会剔除这些人，但那是**静默**的：
       * 勾中的全被剔除时点「批量邀约」等于没发生（一位都没发出去）。
       */
      recentlyInvited: (config.recentlyInvited || []).slice(0, 500)
    }
    const name = `达人邀约 · ${profile.platform} · ${
      config.category
        ? config.category + (config.subcategory ? '/' + config.subcategory : '') + (config.subcategory && config.category3 ? '/' + config.category3 : '')
        : '全部'
    } · 最多 ${batch.count} 位`
    return { name, storeScope: storeId, steps: buildInviteSteps(profile, { batch }, squareUrl) }
  }
  const assist: AssistInviteOptions = {
    contact: String(config.contact || '').trim(),
    wechat: String(config.wechat || '').trim(),
    phone: String(config.phone || '').trim(),
    script: config.script || '',
    scriptMode: config.scriptMode || 'manual',
    productCount: 1,
    productIds: parseInviteProductIds(config.productIds),
    finderType: config.finderType || '全部带货者',
    /**
     * 三个筛选维度都**按档案的实测清单收口**：清单外的值（旧配置、平台改名后的遗留值）
     * 一律不进入步骤——按不存在的文案点击只会得到"页面上找不到"。
     * 这不是静默丢弃：`inviteTaskIssues` 会把清单外的值逐条报成缺项，用户/智能体先被拦住。
     */
    finderCategories: (config.finderCategories || []).filter(c => profile.finderCategories.includes(c)),
    finderSalesTiers: (config.finderSalesTiers || []).filter(t => (profile.finderSalesTiers || []).includes(t)),
    finderOtherFilters: (config.finderOtherFilters || []).filter(f => profile.finderOtherFilters.includes(f)),
    maxInvites: normalizeMaxInvites(config.maxInvites),
    // 近 7 天已邀过的昵称 → 点「详情」时跳过（用户要求：7 天内不重复邀约）
    recentlyInvited: (config.recentlyInvited || []).slice(0, 500)
  }
  // 任务名带上筛选摘要：实时日志/任务卡片里一眼能看出这一单按什么条件挑人
  // （任务名 schema 上限 80，所以统一截断——联系人本身允许 120 字）
  const assistCats = assist.finderCategories || []
  const assistSales = assist.finderSalesTiers || []
  const assistOthers = assist.finderOtherFilters || []
  const filterDesc = [
    assist.finderType && assist.finderType !== '全部带货者' ? assist.finderType : '',
    assistCats.length ? `类目 ${assistCats.length} 项` : '',
    assistSales.length ? `销售额 ${assistSales.length} 档` : '',
    assistOthers.length ? `其他 ${assistOthers.length} 项` : ''
  ].filter(Boolean).join(' · ')
  // 任务名里带上"最多几位"：任务卡片/实时日志一眼能看到这一单的上限（额度护栏可见）
  const name = `达人邀约 · ${profile.platform} · 辅助填单 · ${assist.contact || '未命名'}${filterDesc ? ' · ' + filterDesc : ''} · 最多 ${assist.maxInvites} 位`.slice(0, 80)
  return { name, storeScope: storeId, steps: buildInviteSteps(profile, { assist }, squareUrl) }
}
