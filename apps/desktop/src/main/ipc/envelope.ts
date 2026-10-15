/**
 * IPC 信封与错误文案脱敏（2026-10-15 审查：P1-2 + P2-3）
 *
 * 背景：
 *   · 此前 9 个 ipc/*.ts 文件各自复制了一份 `ok / err / fail` 三件套——信封契约改一处要改九处，
 *     且各文件对 message 的截断长度（300/500/不截断）都不一致；
 *   · 各文件把 `error.message` 原样回渲染层：Node fs 错误的字符串会带绝对路径
 *     （`EACCES: permission denied, open 'C:\Users\…'`），SQLite 错误会带库内细节，
 *     异常栈帧会把 node_modules 路径整个吐给 UI。
 *
 * 规则（保持"业务文案原样、内部细节替换"的取舍）：
 *   · 干净的文案（业务错误、`CODE: 描述` 形态）原样透出（按 maxLen 截断）；
 *   · 命中"泄露形状"（盘符绝对路径 / UNC / fs 错误码 / SQLITE_* / 栈帧 / node_modules 路径）
 *     的文案替换为通用文案，原文只进日志（logMain），便于事后排查；
 *   · requestId 始终随信封返回，界面与日志可按它对齐一次调用。
 */

import type { IPCResult } from '@shared/contracts/ipc'
import { logMain } from '../services/logger'

/** 默认的通用文案：不暴露内部细节，但告诉用户下一步能做什么 */
export const IPC_SAFE_FALLBACK = '操作失败，请重试；若反复出现，可在「设置 → 关于软件」导出诊断包反馈'

/**
 * "泄露形状"清单。全部按**具体特征**匹配，避免误伤正常业务文案
 * （例如"店铺不存在""参数不合法"这类干净消息不会命中）。
 */
const INTERNAL_DETAIL_PATTERNS: RegExp[] = [
  // Windows 盘符绝对路径（用 lookbehind 排除 https:// 这类 URL 里的 "s:"）
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"]+/,
  // UNC 路径 \\server\share
  /\\\\[^\s'"]+\\[^\s'"]+/,
  // node_modules（依赖内部结构，出现在文案里一定是内部细节）
  /node_modules[\\/]/,
  // 常见 fs / Node 错误码
  /\b(?:ENOENT|EACCES|EPERM|EBUSY|EISDIR|ENOTDIR|EMFILE|ENFILE|ENOSPC|EROFS|EEXIST|ERR_DLOPEN_FAILED|ERR_INVALID_ARG_TYPE|ERR_INVALID_ARG_VALUE|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b/,
  // SQLite 错误
  /\bSQLITE_[A-Z_]+\b/,
  // 异常栈帧：at fn (path:line:col)
  /(?:^|\s)at\s+\S+\s+\([^)]*:\d+:\d+\)/,
  // POSIX 绝对路径（依赖或某些库的错误串会带）
  /(?:^|\s)\/(?:home|Users|var|tmp|opt|root|etc)\/[^\s'"]+/
]

/** 文案是否携带内部细节（路径 / 错误码 / 栈帧） */
export function looksLikeInternalDetail(text: string): boolean {
  return INTERNAL_DETAIL_PATTERNS.some((re) => re.test(text))
}

/** 成功信封 */
export function ipcOk<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

/** 失败信封（调用方已明确 code 与文案时使用；文案按 500 截断并做内部细节脱敏） */
export function ipcFail(code: string, message: string, requestId: string, details?: unknown): IPCResult<never> {
  const safeMessage = String(message).slice(0, 500)
  if (looksLikeInternalDetail(safeMessage)) {
    logMain('warn', `[ipc] 错误文案已脱敏 code=${code}: ${safeMessage.slice(0, 300)}`)
    return { ok: false, error: { code, message: IPC_SAFE_FALLBACK }, requestId }
  }
  return {
    ok: false,
    error: details === undefined ? { code, message: safeMessage } : { code, message: safeMessage, details },
    requestId
  }
}

/**
 * 从 unknown 异常构造失败信封（各 ipc 家族的 `taskError` / `sessionError` 等统一走这里）。
 * 命中内部细节时替换为安全文案并记日志，其余文案原样透出（按 maxLen 截断）。
 */
export function ipcErrFromUnknown(
  error: unknown,
  requestId: string,
  options: { fallback?: string; maxLen?: number } = {}
): IPCResult<never> {
  const raw = (error instanceof Error ? error.message : String((error as any)?.message ?? error ?? '')).trim()
  const code = String((error as any)?.code || 'INTERNAL_ERROR')
  const fallback = options.fallback ?? IPC_SAFE_FALLBACK
  const maxLen = options.maxLen ?? 300
  if (!raw) {
    return { ok: false, error: { code, message: fallback }, requestId }
  }
  if (looksLikeInternalDetail(raw)) {
    logMain('warn', `[ipc] 错误文案已脱敏 code=${code}: ${raw.slice(0, 300)}`)
    return { ok: false, error: { code, message: fallback }, requestId }
  }
  return { ok: false, error: { code, message: raw.slice(0, maxLen) }, requestId }
}
