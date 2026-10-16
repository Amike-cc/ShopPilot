/**
 * 店铺分区磁盘占用统计（2026-10-16 浏览器审查 S-1）。
 *
 * `persist:store_<id>` 的数据落在 `userData/Partitions/store_<id>/`（HTTP 缓存、
 * localStorage、IndexedDB 等），随使用增长且此前无任何可视化。这里只做**只读统计**
 * ——清理动作走 Electron 官方 `clearStorageData`/`clearCache`（不能手删文件：
 * session 活着时文件被锁，且手删会让 Chromium 的元数据与磁盘脱同步）。
 *
 * 统计是纯 fs 遍历，不碰 Electron——目录存在性与大小可以被单测钉死。
 */
import { lstatSync, readdirSync } from 'fs'
import { join } from 'path'

/** 递归求目录字节数（符号链接不跟随，统计失败的单项跳过并计数——如实不猜）。 */
export function sumDirectorySize(dir: string): { bytes: number; skipped: number } {
  let bytes = 0
  let skipped = 0
  const walk = (current: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(current)
    } catch {
      skipped += 1
      return
    }
    for (const entry of entries) {
      const child = join(current, entry)
      // 用 lstat 判定符号链接：statSync 会跟随链接（CI Linux 实测 2026-10-16，
      // 链接指向的字节被计入统计——统计语义是"本分区磁盘占用"，链接不跟随）
      const stat = lstatSync(child, { throwIfNoEntry: false })
      if (!stat) {
        skipped += 1
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(child)
      else if (stat.isFile()) bytes += stat.size
    }
  }
  walk(dir)
  return { bytes, skipped }
}

/** `persist:store_<id>` → 磁盘上的分区目录（Electron 约定：userData/Partitions/<去掉 persist: 前缀>）。 */
export function partitionDirName(partition: string): string | null {
  if (!partition.startsWith('persist:')) return null
  const name = partition.slice('persist:'.length).trim()
  return name ? name : null
}
