/**
 * 平台商品「归并状态」判定与解除归并文案（纯逻辑）。
 *
 * 为什么单独一层：`products:library:unmerge` 早已在主进程可用，但渲染层从来没有调用方——
 * 「归并能挂不能摘」。判定与文案放在这里（零 vue/electron/DOM 依赖）是为了能被单测直接覆盖：
 * 三态判定错一格，界面上就会出现"点了没反应"或"对未归并的行也能摘"的假入口。
 *
 * 数据来源：`products.list` 每行就是 `ProductLinkRow`（product-repository.ts:46）：
 *   · `linkId`            —— 这条平台商品记录的 id（解除归并的入参，必需）
 *   · `productId` 有值    —— 已归并到某个本地商品
 *   · `productId` 为空    —— 平台上发现、本地还没有归属（未归并）
 */

/** 平台商品行里判定归并状态所需的最小字段集合（`ProductLinkRow` 的结构子集） */
export interface ProductLinkRowLike {
  linkId?: string | null
  platformProductId?: string | null
  platformTitle?: string | null
  productId?: string | null
  productTitle?: string | null
}

/**
 * 三态：
 *   · `merged`  —— 已归并（`productId` 有值）
 *   · `orphan`  —— 未归并（`productId` 为空，但 `linkId` 合法）
 *   · `invalid` —— 这行缺 `linkId`（拿不到要摘的那条记录），任何写操作都不该放行
 */
export type ProductLinkMergeState = 'merged' | 'orphan' | 'invalid'

/** 只认非空字符串：`null` / `undefined` / `''` / `'   '` 一律当"没有" */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function productLinkMergeState(row: ProductLinkRowLike | null | undefined): ProductLinkMergeState {
  if (!row || typeof row !== 'object') return 'invalid'
  if (!text(row.linkId)) return 'invalid'
  return text(row.productId) ? 'merged' : 'orphan'
}

/**
 * 是否允许「解除归并」：**只有已归并且 `linkId` 合法**的行才允许。
 * 未归并的行没有可摘的东西，缺 linkId 的行摘不动——两种情况都返回 false，界面就不渲染入口。
 */
export function canUnmerge(row: ProductLinkRowLike | null | undefined): boolean {
  return productLinkMergeState(row) === 'merged'
}

/** 平台商品在文案里的自称：优先标题，其次平台商品 ID */
function platformLabel(row: ProductLinkRowLike | null | undefined): string {
  return text(row?.platformTitle) || text(row?.platformProductId) || '该平台商品'
}

/** 本地商品在文案里的自称：优先标题，其次本地商品 ID（已归并的行两者至少有一个） */
function localLabel(row: ProductLinkRowLike | null | undefined): string {
  return text(row?.productTitle) || text(row?.productId)
}

/**
 * 二次确认文案。如实说明"解除后平台商品回到未归并、本地商品与发布台账不动"——
 * 不夸大也不隐瞒：用户点之前应该知道哪些东西不会被删。
 */
export function unmergeConfirmText(row: ProductLinkRowLike | null | undefined): string {
  const platform = platformLabel(row)
  const local = localLabel(row)
  const subject = local
    ? `解除「${platform}」与本地商品「${local}」的归并？`
    : `解除「${platform}」的归并？`
  return `${subject}\n解除后这条平台商品会回到「未归并」，本地商品与发布台账不受影响。`
}

/** 兜底中文提示：内部异常的形状（英文栈、错误码、空串）一律不直接甩给用户 */
export const UNMERGE_FALLBACK_TEXT = '解除归并失败，请刷新列表后重试。'

/** 已知错误码 → 中文说明（主进程已给中文时以主进程的为准） */
const UNMERGE_ERROR_BY_CODE: Record<string, string> = {
  APP_LOCKED: '应用已锁定，请先解锁后再解除归并。',
  INVALID_ARGUMENT: '这条平台商品记录不完整，请刷新列表后重试。',
  STORE_NOT_FOUND: '店铺不存在或已删除，请刷新列表后重试。',
  INTERNAL_ERROR: UNMERGE_FALLBACK_TEXT
}

/** 最长可转达的文案长度：超过这个长度的一律当内部细节处理 */
const READABLE_MAX_LENGTH = 120

/**
 * 只接受"像给人看的中文短句"：
 *   · 必须是含中日韩统一表意文字的短文本（纯英文错误码/栈帧一律拒收）；
 *   · 不许多行、不许出现 `at fn (path:line:col)` 这种栈帧形状。
 * 拒收时返回空串，由调用方回落到兜底文案。
 */
function readableChineseMessage(value: unknown): string {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (!candidate || candidate.length > READABLE_MAX_LENGTH) return ''
  if (!/[\u4e00-\u9fff]/.test(candidate)) return ''
  if (candidate.includes('\n') || candidate.includes('\r')) return ''
  if (/(?:^|\s)at\s+\S+\s*\([^)]*:\d+:\d+\)/.test(candidate)) return ''
  if (/^(?:Error|TypeError|RangeError|SyntaxError)\b/.test(candidate)) return ''
  return candidate
}

/**
 * 解除归并失败时的用户可读文案。接受三种入参：
 *   · IPC 失败信封的 `error`（`{ code, message }`）——渲染层的正常路径；
 *   · 抛出的 `Error`（含 `code` 字段）；
 *   · 字符串或 `null` / `undefined`（异常兜底）。
 */
export function unmergeErrorText(error: unknown): string {
  if (error == null) return UNMERGE_FALLBACK_TEXT
  if (typeof error === 'string') return readableChineseMessage(error) || UNMERGE_FALLBACK_TEXT
  if (typeof error !== 'object') return UNMERGE_FALLBACK_TEXT
  const record = error as { code?: unknown; message?: unknown }
  const message = readableChineseMessage(record.message)
  if (message) return message
  const code = text(record.code)
  if (code && UNMERGE_ERROR_BY_CODE[code]) return UNMERGE_ERROR_BY_CODE[code]
  return UNMERGE_FALLBACK_TEXT
}
