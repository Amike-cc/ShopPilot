/**
 * 达人邀约任务构造（单一事实来源）。
 *
 * 面板与智能体共用同一个构造器：配置快照 → 校验 → `buildInviteSteps`。
 * 为什么必须共用：配置里装的是**店铺自己的**联系人/手机号/微信号，两处各写一遍
 * 必然漂移（真机口径的同类事故：把 A 店的手机号发给 B 店的达人）。
 */
import { buildInviteSteps, hasRequiredBatchContacts, type AssistInviteOptions, type BatchInviteOptions, type StepDraft } from './invite-steps'
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
  finderOtherFilters?: string[]
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
      batchProductCount: Number.isFinite(Number(record.batchProductCount)) ? Math.max(0, Math.round(Number(record.batchProductCount))) : 1
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
    finderOtherFilters: list(record.finderOtherFilters, 60)
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
    return issues
  }
  if (profile.levels.length > 0 && !(config.levels || []).length) issues.push('达人等级未选择')
  const contactsOk = hasRequiredBatchContacts(profile, { contact: config.batchContact, phone: config.batchPhone, wechat: config.batchWechat })
  if (!contactsOk) issues.push('抽屉必填的联系方式未填写（联系人/手机号/微信号）')
  const count = Number(config.count)
  if (!Number.isInteger(count) || count < 1 || count > profile.maxBatch) issues.push(`邀约数量需为 1～${profile.maxBatch} 的整数`)
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
      benefits: config.benefits || [],
      strengths: config.strengths || [],
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
      productCount: Math.max(0, Math.min(profile.maxProducts, Number(config.batchProductCount) || 0))
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
    finderCategories: config.finderCategories || [],
    finderOtherFilters: config.finderOtherFilters || []
  }
  const name = `达人邀约 · ${profile.platform} · 辅助填单 · ${assist.contact || '未命名'}`
  return { name, storeScope: storeId, steps: buildInviteSteps(profile, { assist }, squareUrl) }
}
