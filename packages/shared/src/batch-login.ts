/**
 * 批量登录检测的展示口径（纯函数，主进程/渲染层/单测共用）。
 *
 * 只做"把主进程给的结论翻译成人话"，不参与判定：检测结论来自平台适配器，
 * 这里把 UNKNOWN/ERROR/SKIPPED 与"未登录"分开展示——把"没拿到证据"说成"没登录"
 * 会让用户白跑一次重新登录。
 */

export type BatchLoginStatus = 'ONLINE' | 'LOGIN_REQUIRED' | 'VERIFY_REQUIRED' | 'UNKNOWN' | 'ERROR' | 'SKIPPED'

export interface BatchLoginSummary {
  online: number
  needsLogin: number
  verify: number
  unknown: number
  error: number
  skipped: number
  total: number
}

export function batchLoginStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ONLINE: '已登录',
    LOGIN_REQUIRED: '未登录',
    VERIFY_REQUIRED: '需安全验证',
    UNKNOWN: '未识别',
    ERROR: '检测失败',
    SKIPPED: '未检测'
  }
  return labels[String(status)] || String(status || '未知')
}

export function summarizeBatchLogin(items: Array<{ status?: string }> | null | undefined): BatchLoginSummary {
  const summary: BatchLoginSummary = { online: 0, needsLogin: 0, verify: 0, unknown: 0, error: 0, skipped: 0, total: 0 }
  for (const item of Array.isArray(items) ? items : []) {
    summary.total++
    switch (String(item?.status || '')) {
      case 'ONLINE': summary.online++; break
      case 'LOGIN_REQUIRED': summary.needsLogin++; break
      case 'VERIFY_REQUIRED': summary.verify++; break
      case 'UNKNOWN': summary.unknown++; break
      case 'ERROR': summary.error++; break
      case 'SKIPPED': summary.skipped++; break
      default: summary.unknown++; break
    }
  }
  return summary
}

/** `已登录 2 · 未登录 1`；非零的异常类别才追加，全零时给出"没有可检测的店铺" */
export function batchLoginSummaryText(summary: BatchLoginSummary): string {
  if (!summary.total) return '没有可检测的店铺'
  const parts = [`已登录 ${summary.online}`, `未登录 ${summary.needsLogin}`]
  if (summary.verify > 0) parts.push(`需验证 ${summary.verify}`)
  if (summary.unknown > 0) parts.push(`未识别 ${summary.unknown}`)
  if (summary.error > 0) parts.push(`失败 ${summary.error}`)
  if (summary.skipped > 0) parts.push(`未检测 ${summary.skipped}`)
  return parts.join(' · ')
}
