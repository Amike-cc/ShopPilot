/**
 * 软件自检与缓存清理的共享口径（2026-10-16 新增）。
 *
 * 设置中心「数据与维护」新增三件事：**清除软件缓存 / 清除浏览器缓存 / 诊断软件**。
 * 三者都要"如实回显自己做了什么"，所以把口径放在 shared：
 *   · 检查项状态与汇总：主进程产出、渲染层显示，避免两处各自翻译一套词；
 *   · 字节格式化：主进程的 detail 与渲染层的提示读同一份格式（过去渲染层有一份本地实现）；
 *   · 缓存清理结果：清了哪些项、释放多少、有没有失败的项，全部结构化，界面不猜。
 *
 * 纯函数、零依赖：主进程与渲染层都能 import，单测可直接锁定
 * （`tests/unit/software-diagnostics.test.ts`）。
 */

/** 单项自检的状态。`warn` = 还能用但值得处理；`error` = 已经影响功能。 */
export type SoftwareCheckStatus = 'ok' | 'warn' | 'error'

export const SOFTWARE_CHECK_STATUS_LABEL: Record<SoftwareCheckStatus, string> = {
  ok: '正常',
  warn: '注意',
  error: '异常'
}

export interface SoftwareCheckItem {
  /** 稳定标识（界面 key、测试断言用；不随文案变） */
  key: string
  /** 人话标题，例如「数据库」「磁盘剩余空间」 */
  label: string
  status: SoftwareCheckStatus
  /** 事实本身（版本号、字节数、条数、错误原文摘要），不写"建议" */
  detail: string
  /** 可执行的下一步（只在需要时给） */
  hint?: string
}

export interface SoftwareDiagnosticsReport {
  capturedAt: number
  appVersion: string
  items: SoftwareCheckItem[]
}

export interface SoftwareCheckSummary {
  ok: number
  warn: number
  error: number
  /** 总体判定：有异常→error，有注意→warn，否则 ok */
  status: SoftwareCheckStatus
  /** 一句话结论（界面标题栏用） */
  headline: string
}

/** 汇总检查项：**最差的一项决定总体**（不拿"大部分正常"糊弄）。 */
export function summarizeSoftwareChecks(items: readonly SoftwareCheckItem[]): SoftwareCheckSummary {
  let ok = 0
  let warn = 0
  let error = 0
  const list = items || []
  for (const item of list) {
    if (item?.status === 'error') error += 1
    else if (item?.status === 'warn') warn += 1
    else ok += 1
  }
  const status: SoftwareCheckStatus = error > 0 ? 'error' : warn > 0 ? 'warn' : 'ok'
  const extra = [error > 0 ? `${error} 项异常` : '', warn > 0 ? `${warn} 项注意` : ''].filter(Boolean)
  const headline = list.length === 0
    ? '没有可执行的检查项'
    : extra.length > 0
      ? `发现 ${extra.join('、')}（共 ${list.length} 项）`
      : `全部 ${ok} 项正常`
  return { ok, warn, error, status, headline }
}

/** 字节 → 人话。界面与主进程 detail 共用一份，避免 1.0 GB / 1 GB 两种写法混在一屏。 */
export function formatBytesShort(bytes: unknown): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = value
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit += 1
  }
  const shown = unit === 0 || n >= 100 ? Math.round(n) : Math.round(n * 10) / 10
  return `${shown} ${units[unit]}`
}

/** 缓存清理的结果：清了什么、释放多少、哪里没清成——全部如实带回界面。 */
export interface CacheClearResult {
  /** app = 应用界面自己的缓存；browser = 所有店铺的网页缓存 */
  scope: 'app' | 'browser'
  /**
   * 实际释放的磁盘字节（缓存目录清理前后的差值；只算量到的，不估算、不四舍五入成"已清空"）。
   * 注意：Chromium 会保留部分内存映射文件，差值可能小于清理前的占用，这是事实，不修饰。
   */
  freedBytes: number
  /** 实际执行成功的清理项（界面逐条回显） */
  items: string[]
  /** 执行失败的清理项（不为零时界面要显红，不能说"清理完成"） */
  failures: string[]
  /** 逐店结果（browser scope；app scope 为空数组） */
  stores: Array<{ storeId: string; storeName: string; freedBytes: number }>
  /** 尚未创建浏览器数据、被跳过的店铺（如实计数，不假装清过） */
  skippedStores: number
}

/**
 * 把清理结果变成一句如实的话：**失败要说失败，没释放就说没有，什么都没做就别报成功**。
 * 放在 shared 是为了能被单测直接钉住——"清理完成"这四个字是用户判断要不要重新登录的唯一依据。
 */
export function describeCacheClearResult(result: CacheClearResult): { text: string; ok: boolean; performed: boolean } {
  const scope = result.scope === 'app' ? '软件缓存' : '浏览器缓存'
  // performed=false：一项都没执行（例如所有店铺都还没产生浏览器数据）。
  // 这时不能弹"已清理成功"——用户会以为自己清掉了什么。
  const performed = result.items.length > 0 || result.failures.length > 0
  if (result.failures.length > 0) {
    return { text: `${scope}部分清理失败：${result.failures.slice(0, 2).join('；')}`, ok: false, performed: true }
  }
  if (!performed) {
    return { text: `没有需要清理的${scope}（没有找到可清理的缓存目录）`, ok: true, performed: false }
  }
  const freed = result.freedBytes > 0
    ? `释放 ${formatBytesShort(result.freedBytes)}`
    : '没有可释放的缓存（可能已是最新）'
  const executed = `（${result.items.join('、')}）`
  const parts = [`已清理${scope}${executed}，${freed}`]
  if (result.scope === 'browser') {
    parts.push(result.stores.length > 0
      ? `涉及 ${result.stores.length} 家店铺${result.skippedStores > 0 ? `，另有 ${result.skippedStores} 家尚未产生浏览器数据已跳过` : ''}`
      : '没有需要清理的店铺')
  }
  return { text: parts.join('；'), ok: true, performed: true }
}
