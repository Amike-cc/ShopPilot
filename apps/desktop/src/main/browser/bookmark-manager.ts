/**
 * 书签管理器
 * §5.8 bookmarks 表
 */

import { getDatabase } from '../db/database'
import { randomBytes } from 'crypto'
import { platformEntryRoutes } from '@shared/constants/platforms'

export interface Bookmark {
  id: string
  storeId: string | null
  title: string
  url: string
  orderIndex: number
  source: string
  createdAt: number
}

/**
 * 生成书签 ID
 */
function generateBookmarkId(): string {
  return `bookmark_${randomBytes(16).toString('hex')}`
}

function mapBookmarkRow(r: any): Bookmark {
  return {
    id: r.id,
    storeId: r.store_id ?? null,
    title: r.title,
    url: r.url,
    orderIndex: r.order_index,
    source: r.source,
    createdAt: r.created_at
  }
}

/**
 * 列出书签 - §6.2
 */
export function listBookmarks(storeId?: string): Bookmark[] {
  const db = getDatabase()
  
  if (storeId) {
    return (db.prepare(`
      SELECT * FROM bookmarks 
      WHERE store_id = ? OR store_id IS NULL
      ORDER BY order_index ASC
    `).all(storeId) as any[]).map(mapBookmarkRow)
  } else {
    return (db.prepare(`
      SELECT * FROM bookmarks 
      WHERE store_id IS NULL
      ORDER BY order_index ASC
    `).all() as any[]).map(mapBookmarkRow)
  }
}

/**
 * 创建书签 - §6.2
 */
export function createBookmark(input: {
  storeId?: string
  url: string
  title: string
}): Bookmark {
  const db = getDatabase()
  const now = Date.now()
  const bookmarkId = generateBookmarkId()
  
  // 获取下一个 order_index
  const maxOrder = db.prepare(`
    SELECT MAX(order_index) as max_order 
    FROM bookmarks 
    WHERE store_id IS ? OR (store_id IS NULL AND ? IS NULL)
  `).get(input.storeId || null, input.storeId || null)
  
  const orderIndex = (maxOrder?.max_order ?? -1) + 1
  
  const bookmark = {
    id: bookmarkId,
    storeId: input.storeId || null,
    title: input.title,
    url: input.url,
    orderIndex,
    source: 'manual',
    createdAt: now
  }
  
  db.prepare(`
    INSERT INTO bookmarks (id, store_id, title, url, order_index, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    bookmark.id,
    bookmark.storeId,
    bookmark.title,
    bookmark.url,
    bookmark.orderIndex,
    bookmark.source,
    bookmark.createdAt
  )
  
  return bookmark
}

/**
 * 删除书签 - §6.2
 */
export function deleteBookmark(bookmarkId: string): boolean {
  const db = getDatabase()
  const info = db.prepare('DELETE FROM bookmarks WHERE id = ?').run(bookmarkId)
  return info.changes > 0
}

/**
 * 获取平台入口路由（来自适配器）
 * §16 平台适配层 + §5.8 source=entry_route
 *
 * 入口清单集中定义在 shared/constants/platforms.ts（国内四家：拼多多/微信小店/快手小店/抖店），
 * 这里的返回值为只读展示缓存，不写入 bookmarks 表（避免与用户自建收藏重复）。
 */
export function getEntryRoutes(platform: string): Bookmark[] {
  const routes = platformEntryRoutes(platform)

  return routes.map((route, index) => ({
    id: `entry_${platform}_${index}`,
    storeId: null,
    title: route.title,
    url: route.url,
    orderIndex: index,
    source: 'entry_route',
    createdAt: Date.now()
  }))
}
