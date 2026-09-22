/** Match a whole category label in a filter summary, never a substring of another label. */
export function matchesTextToken(text: unknown, needle: string): boolean {
  const token = needle.trim()
  if (!token) return false
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Platform filter summaries use both breadcrumb separators and Chinese punctuation.
  const boundary = '[\\s/／＞>、,，:：;；|·()（）\\[\\]【】]'
  return new RegExp(`(?:^|${boundary})${escaped}(?=$|${boundary})`, 'u').test(String(text ?? ''))
}
