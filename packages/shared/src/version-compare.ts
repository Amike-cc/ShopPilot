/**
 * 插件版本比较（2026-11-10）。
 *
 * 应用商城只能对比**随包内置目录**声明的版本与已安装清单的版本；
 * 不做联网检查，也不假装有远端仓库。版本段按数字比较，非数字段按字符串比较。
 */
export function compareVersions(left: string, right: string): number {
  const normalize = (value: string) => String(value || '').trim().replace(/^v/i, '').split(/[.+-]/)
  const a = normalize(left)
  const b = normalize(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const x = a[index] ?? '0'
    const y = b[index] ?? '0'
    const xNumber = /^\d+$/.test(x) ? Number(x) : null
    const yNumber = /^\d+$/.test(y) ? Number(y) : null
    if (xNumber !== null && yNumber !== null) {
      if (xNumber !== yNumber) return xNumber > yNumber ? 1 : -1
      continue
    }
    const result = x.localeCompare(y, 'en')
    if (result !== 0) return result > 0 ? 1 : -1
  }
  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}
