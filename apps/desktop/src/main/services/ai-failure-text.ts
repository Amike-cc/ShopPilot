/**
 * AI 调用失败 → 用户可读文案（纯函数，可单测）。
 *
 * 背景（2026-10-18 实测）：接口地址不可达时，界面把底层英文串原样透给用户
 * （`AI 商品分析失败：fetch failed`）——既没告诉用户能做什么，也不像本地产品该有的文案。
 * 这里做**一次**映射：把已知的底层原因翻成中文可执行提示，兜底保留截断后的原始摘要便于报障。
 *
 * 三条纪律：
 *   ① 未配置类错误（`AI_*_NOT_CONFIGURED`）**原样透传**——那是可执行的中文提示，
 *      重映射反而会把它说成"凭据被拒绝"（用户会去改一个本来就没填的 Key）；
 *   ② 不吞原始信息：兜底与各分支都带上截断摘要，报障时还能定位；
 *   ③ 不抛异常、不依赖 Electron，任意输入（含 null/字符串/符号）都要有稳定输出。
 */

export interface AiFailureText {
  code: string
  message: string
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/

/** 摘要最长这么多字符，超出截断：避免把整段 HTML / 堆栈甩到界面。 */
const DETAIL_LIMIT = 80

/**
 * 5xx **必须有 HTTP 上下文**才算状态码。
 * 裸三位数会把 `bytes=500`、`retry after 500 ms` 误判成服务端错误，也会命中 URL 端口
 * （`http://127.0.0.1:500/v1/…`）——2026-10-18 独立复验两轮都盯过这一条。
 */
const HTTP_5XX = /(?:https?(?:\/[\d.]+)?[^\d\n]{0,12}|status[\s:=]{0,3}|code[\s:=]{0,3}|\breturned\s+)(5\d\d)(?!\d)/i

function readCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return ''
  const value = String((error as { code?: unknown }).code ?? '')
  return CODE_PATTERN.test(value) ? value : ''
}

function readDetail(error: unknown): string {
  const value = typeof error === 'object' && error !== null
    ? ('message' in error ? (error as { message?: unknown }).message : '')
    : error
  // message 本身可能是对象（或压根没有 message）：那种情况下没有可用摘要，
  // 绝不能 String() 成 "[object Object]" 甩给用户
  if (value !== null && typeof value === 'object') return ''
  return String(value ?? '').replace(/^[A-Z][A-Z0-9_]*:\s*/, '').trim()
}

function truncate(detail: string): string {
  return detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}…` : detail
}

function withDetail(detail: string): string {
  const short = truncate(detail)
  return short ? `（原始错误：${short}）` : ''
}

export function describeAiFailure(error: unknown): AiFailureText {
  const rawCode = readCode(error)
  const code = rawCode || 'AI_REQUEST_FAILED'
  const detail = readDetail(error)

  // ① 未配置：原样透传（见文件头纪律 ①）
  if (/NOT_CONFIGURED/.test(code)) {
    return { code, message: detail || 'AI 接口尚未配置，请到设置中心填写接口地址、模型与 API Key' }
  }

  // ② Agent 预算/用量被拦：这是 **AI 域**的失败（`model-governance` 抛码 → `ai-client` 包成 AiError），
  //    要给指向日预算的中文，而不是中性「操作失败」，否则用户不知道去哪儿改
  if (/^AGENT_BUDGET_/.test(rawCode)) {
    return {
      code,
      message: detail
        ? `Agent 日预算挡住了这次模型调用：${truncate(detail)}`
        : 'Agent 日预算挡住了这次模型调用：请到设置中心调整日预算，或等次日额度重置'
    }
  }

  // ③ 显式的**非 AI 域**错误码：不冠 AI 语义（这类错误从 AI try 块里冒出来说明有意料之外的问题，
  //    说成「AI 请求失败」会把人引到 AI 配置上去查）。AI_ / AGENT_ 前缀都属于本域，不在此列。
  if (rawCode && !/^(AI|AGENT)_/.test(rawCode)) {
    return { code, message: detail ? `操作失败：${truncate(detail)}` : '操作失败，请稍后重试' }
  }

  // ④ 已经是中文可读文案（配置/入参校验等）：原样透传，但**仍要截断**——
  //    "不让整段堆栈上屏"这条纪律对中文同样成立（上游错误体可能是几百字中文）。
  if (/[\u4e00-\u9fa5]/.test(detail)) return { code, message: truncate(detail) }

  // ④ 已知的底层原因 → 中文可执行提示（顺序有意义：先具体后笼统）。
  //    状态码必须有 HTTP 上下文：裸三位数会把 "bytes=500"、"retry after 500 ms" 误判成 5xx，
  //    也会命中 URL 端口（`http://127.0.0.1:500/v1/…`）。
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error|ERR_NETWORK|ERR_CONNECTION/i.test(detail)) {
    return { code, message: `连不上 AI 接口：请到设置中心核对接口地址与网络${withDetail(detail)}` }
  }
  if (/timeout|timed out|ETIMEDOUT|aborted|超时/i.test(detail)) {
    return { code, message: `AI 接口响应超时：可稍后重试或调大设置里的超时时间${withDetail(detail)}` }
  }
  if (/(?<![\d:])(401|403)(?!\d)|unauthorized|invalid api key|incorrect api key|invalid_api_key/i.test(detail)) {
    return { code, message: `AI 接口拒绝了凭据：请到设置中心检查 API Key 是否有效${withDetail(detail)}` }
  }
  if (/(?<![\d:])429(?!\d)|rate limit|too many requests/i.test(detail)) {
    return { code, message: `AI 接口限流（429）：请稍后重试${withDetail(detail)}` }
  }
  if (HTTP_5XX.test(detail) || /internal server error|bad gateway|service unavailable/i.test(detail)) {
    return { code, message: `AI 接口返回服务端错误：请稍后重试${withDetail(detail)}` }
  }

  // ⑤ 兜底：保留摘要，但**同样截断**（500 字符的底层堆栈不能整段上屏）
  if (!detail) return { code, message: 'AI 请求失败：接口没有返回可用结果，请稍后重试' }
  return { code, message: `AI 请求失败：${truncate(detail)}` }
}
