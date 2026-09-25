/** Redaction shared by the Main observer, Agent UI persistence, and Agent task results. */
function replaceControlChars(value: string): string {
  let result = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    result += code < 9 || code === 11 || code === 12 || (code >= 14 && code <= 31) ? ' ' : character
  }
  return result
}

export function redactAgentText(value: unknown, maxLength = 2400): string {
  let text = replaceControlChars(String(value ?? ''))
  text = text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱已隐藏]')
    .replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, '[密钥已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{8,})?\b/g, '[令牌已隐藏]')
    .replace(/((?:api[_ -]?key|api密钥|访问密钥)\s*[:：=]\s*)[^\s,，;；]{8,}/gi, '$1[密钥已隐藏]')
    .replace(/((?:cookie|authorization|session(?:[_ -]?id)?|sid|refresh[_ -]?token)\s*[:：=]\s*)[^\s,，;；]{4,}/gi, '$1[凭据已隐藏]')
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]')
    .replace(/(?<!\d)\d{15}(?:\d{2}[0-9Xx])?(?!\d)/g, '[证件号已隐藏]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1[已隐藏]')
    .replace(/((?:token|secret|password|passwd|密码|令牌)\s*[:：=]\s*)[^\s,，;；]{4,}/gi, '$1[已隐藏]')
    .replace(/((?:收货地址|收件地址|详细地址|联系地址|地址)\s*[:：]?\s*)[^\n，,；;。]{4,80}/g, '$1[地址已隐藏]')
    .replace(/((?:收货人|收件人|联系人|姓名)\s*[:：]\s*)[\u4e00-\u9fa5·]{2,8}/g, '$1[姓名已隐藏]')
    .replace(/((?:电话|手机|联系电话)\s*[:：]?\s*)[\d+()（） -]{7,20}/g, '$1[号码已隐藏]')
    .replace(/[ \t]+/g, ' ')
  return text.trim().slice(0, maxLength)
}

/** Hide query/hash credentials and long identifier segments before a URL reaches the model or UI summary. */
export function sanitizeAgentUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? ''))
    if (!['http:', 'https:'].includes(url.protocol)) return url.protocol === 'about:' ? 'about:blank' : ''
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    const path = url.pathname.split('/').map(segment => {
      if (/^[\da-f]{16,}$/i.test(segment) || /^\d{9,}$/.test(segment) || /^[A-Za-z0-9_-]{32,}$/.test(segment)) return '[id]'
      return segment
    }).join('/')
    return `${url.origin}${path}`.slice(0, 500)
  } catch {
    return String(value ?? '').slice(0, 500)
  }
}
