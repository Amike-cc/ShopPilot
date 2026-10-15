/** Match a whole category label in a filter summary, never a substring of another label. */
export function matchesTextToken(text: unknown, needle: string): boolean {
  const token = needle.trim()
  if (!token) return false
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Platform filter summaries use both breadcrumb separators and Chinese punctuation.
  const boundary = '[\\s/／＞>、,，:：;；|·()（）\\[\\]【】]'
  return new RegExp(`(?:^|${boundary})${escaped}(?=$|${boundary})`, 'u').test(String(text ?? ''))
}

/**
 * 单元格文本清洗（唯一实现，2026-10-15 审查 P2-1 收敛）
 *
 * 背景：shared 里曾有两份同名 `normalizeCellText` 且语义不同——发票/涉税域做
 * "整串重复两遍"去重但不剥零宽字符；商品域剥零宽字符但不做去重。同一批平台文本
 * 按域走两套清洗，发票侧可能残留 `\u200b` 导致列比对/去重失败。
 *
 * 合并后：**剥零宽（\u200b-\u200f\ufeff）+ 连续空白压缩**是共同基座；
 * "整串重复两遍"折叠由 `dedupe` 显式开关（发票「处理记录」月份这类单元格需要，
 * 商品标题里的重复词有真语义、不需要）。各域入口只做参数选择，不再各写一份实现：
 *   · 发票域 → `@shared/constants/invoice` 的 normalizeCellText（dedupe: true）
 *   · 商品域 → `@shared/product-rules` 的 normalizeCellText（默认）
 */
export function normalizeCellText(value: unknown, options: { dedupe?: boolean } = {}): string {
  const s = String(value ?? '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s || !options.dedupe) return s
  // 整串正好由同一段重复两遍构成 → 只留一遍
  const compact = s.replace(/ /g, '')
  if (compact.length >= 4 && compact.length % 2 === 0) {
    const half = compact.slice(0, compact.length / 2)
    if (half === compact.slice(compact.length / 2)) {
      // 从**带空格的原文**回填那前半段，而不是返回 compact——
      // 直接返回 compact 会把「订单号 2000000038930468 订单号 2000000038930468」压成
      // 「订单号2000000038930468」（空格没了），与页面上看到的文案不一致，导出的单元格也跟着变样。
      let seen = 0
      let cut = 0
      for (let i = 0; i < s.length && seen < half.length; i++) {
        if (s[i] !== ' ') seen++
        cut = i + 1
      }
      return s.slice(0, cut).trim()
    }
  }
  return s
}
