/**
 * 回读闭环的纯规则（方案 §7.5 第 2、3 类只读回查）
 *
 * §7.5 的三类回读里，第 1 类（平台商品标识 → 写 `product_platform_links`/`product_sku_links`）
 * 已经在 M3 的回读里做了；这里做另外两类：
 *   · **用户实际填的值**：读回页面上的值，与本地对比 → 产出**建议**；
 *   · **平台必填清单**：把"平台要填但本地没有"的字段记下来，下次预检提示。
 *
 * ⚠️ 一条不可动摇的纪律：**本模块只产出建议，绝不落库**。
 * 落库必须由用户逐条确认（`source: 'human_readback'`）——方案 §7.5 的原话是
 * "不自动改，避免'这次特批'变成默认值"。所以这里连一个写库的函数都没有。
 */

/** 三类建议（外加"一致"与"只有本地有"两种无需处理的观察）。 */
export type ReadbackSuggestionKind =
  | 'suggest_default'    // 本地没有、平台上用户填了 → 建议存为默认值（下次自动填）
  | 'suggest_writeback'  // 本地有、用户在平台上改了 → 摆两边让用户选是否回写本地
  | 'same'               // 两边一致 → 无需处理
  | 'only_local'         // 只有本地有 → 用户在平台上没填这一项

export interface ReadbackSuggestion {
  field: string
  label: string
  kind: ReadbackSuggestionKind
  localValue: string | null
  platformValue: string | null
  /** 落库用的键（写 `product_platform_defaults.field_key`） */
  defaultKey: string
  note: string
}

export interface ReadbackComparison {
  suggestions: ReadbackSuggestion[]
  /** 只需用户处理的那部分（`same` 之外的） */
  actionable: ReadbackSuggestion[]
  counts: { suggestDefault: number; suggestWriteback: number; same: number; onlyLocal: number }
}

const DEFAULT_LABELS: Record<string, string> = {
  title: '标题', subtitle: '短标题', price: '价格', stock: '库存',
  category: '类目', brand: '品牌', image: '图片', spec: '规格'
}

/** 归一化：去首尾空白 + 把连续空白压成一个（平台常对空白做归一化）。 */
function norm(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 对比"本地值"与"平台上的值"，产出建议。
 *
 * 顺序固定（先需要用户决定的、后无需处理的），界面按顺序显示即可。
 */
export function compareReadbackFields(input: {
  local: Record<string, string | null | undefined>
  platformValues: Record<string, string | null | undefined>
  labels?: Record<string, string>
  /** 只对比这些字段（默认两边出现过的所有键） */
  fields?: string[]
}): ReadbackComparison {
  const labels = { ...DEFAULT_LABELS, ...(input.labels ?? {}) }
  const fields = input.fields ?? Array.from(new Set([...Object.keys(input.local), ...Object.keys(input.platformValues)]))
  const suggestions: ReadbackSuggestion[] = []

  for (const field of fields) {
    const localValue = norm(input.local[field]) || null
    const platformValue = norm(input.platformValues[field]) || null
    const label = labels[field] ?? field

    if (platformValue && !localValue) {
      suggestions.push({
        field, label, kind: 'suggest_default', localValue: null, platformValue,
        defaultKey: field,
        note: `本地没有、你在平台上填了「${platformValue.slice(0, 30)}」→ 存为默认值后，下次发布自动填`
      })
      continue
    }
    if (localValue && platformValue && localValue !== platformValue) {
      suggestions.push({
        field, label, kind: 'suggest_writeback', localValue, platformValue,
        defaultKey: field,
        note: `本地是「${localValue.slice(0, 30)}」、平台上你填的是「${platformValue.slice(0, 30)}」→ 要不要把本地改成平台那一版？`
      })
      continue
    }
    if (localValue && !platformValue) {
      suggestions.push({
        field, label, kind: 'only_local', localValue, platformValue: null,
        defaultKey: field,
        note: `本地有值但平台上这一项是空的 → 已记入「平台必填但本地/页面缺失」清单`
      })
      continue
    }
    suggestions.push({
      field, label, kind: 'same', localValue, platformValue,
      defaultKey: field,
      note: '两边一致，无需处理'
    })
  }

  const actionable = suggestions.filter(item => item.kind !== 'same')
  return {
    suggestions,
    actionable,
    counts: {
      suggestDefault: suggestions.filter(item => item.kind === 'suggest_default').length,
      suggestWriteback: suggestions.filter(item => item.kind === 'suggest_writeback').length,
      same: suggestions.filter(item => item.kind === 'same').length,
      onlyLocal: suggestions.filter(item => item.kind === 'only_local').length
    }
  }
}

/** 一条平台必填项的记忆（方案 §7.5 第 3 类）。 */
export interface PlatformRequirement {
  platform: string
  field: string
  label: string
  /** 观察到它的时刻 */
  observedAt: number
}

/**
 * 合并"这次观察到的必填项"与"以前记下的"。
 *
 * 规则：同一个 (platform, field) 只留一条，`observedAt` 取**最新**；
 * 以前记下、这次没观察到的**不删**（平台必填项不会因为一次没看到就消失，
 * 删掉会让提示悄悄失效——这正是"必填清单"最容易坏的地方）。
 */
export function mergeRequirements(existing: readonly PlatformRequirement[], observed: readonly PlatformRequirement[]): PlatformRequirement[] {
  const byKey = new Map<string, PlatformRequirement>()
  for (const item of existing) byKey.set(`${item.platform}::${item.field}`, item)
  for (const item of observed) {
    const key = `${item.platform}::${item.field}`
    const previous = byKey.get(key)
    byKey.set(key, previous && previous.observedAt > item.observedAt ? previous : item)
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.platform === b.platform ? a.field.localeCompare(b.field) : a.platform.localeCompare(b.platform))
}

/**
 * 下次发布前的"本地补全清单"：平台必填 + 本地没有 → 提示用户补。
 *
 * 与预检里的 `missingRequired` 不同：那个只看**这一次**的草稿，
 * 这个看的是**跨次记住的平台必填项**（方案 §7.5 的原话："下次发布前在本地补全清单里提示"）。
 */
export function completionChecklist(input: {
  requirements: readonly PlatformRequirement[]
  platform: string
  local: Record<string, string | null | undefined>
}): Array<{ field: string; label: string; reason: string }> {
  return input.requirements
    .filter(item => item.platform === input.platform)
    .filter(item => !norm(input.local[item.field]))
    .map(item => ({ field: item.field, label: item.label, reason: '平台必填，本地还没有' }))
}
