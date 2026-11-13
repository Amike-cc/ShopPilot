/**
 * 店铺「最近活动」文案（侧栏、店铺卡片、浏览器地址栏共用）。
 *
 * last_active_at 由主进程在真正打开/导航时写入；渲染层打开成功后也会本地更新。
 * 注意它也会被后台登录检测/采集刷新，所以文案用「最近活动」而不是「最近使用」，
 * 不把系统动作说成用户操作。
 */
export function storeLastActiveLabel(ts: number | null | undefined, now = Date.now()): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '从未打开'
  const diff = Math.max(0, now - ts)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
