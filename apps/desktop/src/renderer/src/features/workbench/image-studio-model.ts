/**
 * 「AI 生成商品图」的模型解析：把供应商真实返回的模型列表、界面上的快捷卡片、
 * 以及设置里**明确配置的模型**对上。
 *
 * 为什么要单独抽一个纯模块：这段匹配原先直接写在组件里，踩过一个静默错误——
 * 设置里写的是 `gpt-image-2.5`，界面却因为 `includes('gpt-image')` 命中了列表里
 * 先出现的 `gpt-image-2`，于是**用旧模型生成**，确认框还照着显示 `gpt-image-2`。
 * 用户看到的模型名和真正调用的模型不一致，这类错误只能靠纯函数 + 单测钉住。
 */

export interface ModelCardLike {
  key: string
  /** 卡片对应的候选模型名（不区分大小写，按"包含"匹配供应商返回的 id）。 */
  modelNames: string[]
}

/** 两个字符串的公共前缀长度（不区分大小写）。 */
function commonPrefixLength(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  const max = Math.min(x.length, y.length)
  let i = 0
  while (i < max && x[i] === y[i]) i++
  return i
}

/** 卡片在供应商列表里的全部候选（按"包含卡片名"匹配，与界面上的「已发现」口径一致）。 */
export function candidateModelsForCard(card: ModelCardLike, availableModels: string[]): string[] {
  const names = card.modelNames.map(name => name.toLowerCase())
  return availableModels.filter(item => names.some(name => item.toLowerCase().includes(name)))
}

/**
 * 选定这张卡片最终要提交的模型名。
 *
 * 优先级：
 *   ① 设置里配置的模型（`configuredModel`）——它才是用户真正写下、也最可能被供应商接受的模型，
 *      只要供应商列表里确实有它就直接用；
 *   ② 与卡片候选名**完全同名**的那个；
 *   ③ 与卡片候选名**公共前缀最长**的那个（版本号越贴近越优先；同前缀时取更长的名字，
 *      因为 `gpt-image-2.5` 比 `gpt-image-2` 新——旧实现取的是列表顺序，等于随机）。
 *
 * 返回空串表示"这张卡片在供应商列表里没有对应模型"，界面据此提示改选"自定义 API"。
 */
export function matchModelForCard(card: ModelCardLike, availableModels: string[], configuredModel = ''): string {
  const candidates = candidateModelsForCard(card, availableModels)
  if (!candidates.length) return ''
  const configured = String(configuredModel || '').trim()
  if (configured && candidates.includes(configured)) return configured
  const names = card.modelNames.map(name => name.toLowerCase())
  const exact = candidates.find(item => names.includes(item.toLowerCase()))
  if (exact) return exact
  return candidates
    .slice()
    .sort((a, b) => {
      const pa = Math.max(...names.map(name => commonPrefixLength(name, a)))
      const pb = Math.max(...names.map(name => commonPrefixLength(name, b)))
      if (pa !== pb) return pb - pa
      return b.length - a.length
    })[0]
}

/**
 * 默认选中哪张卡片：跟着**设置里配置的模型**走。
 * 配置的是 `gpt-image-2.5` 就默认选 GPT-Image 卡片、配置的是 `flux-1.1-pro` 就默认选 FLUX，
 * 而不是永远默认第一张（旧行为：无论配了什么，打开都是 GPT-Image 选中）。
 */
export function pickDefaultCardKey<T extends ModelCardLike>(cards: T[], configuredModel: string, fallbackKey: string): string {
  const configured = String(configuredModel || '').trim().toLowerCase()
  if (!configured) return fallbackKey
  const hit = cards.find(card => card.modelNames.some(name => configured.includes(name.toLowerCase()) || name.toLowerCase().includes(configured)))
  return hit ? hit.key : fallbackKey
}
