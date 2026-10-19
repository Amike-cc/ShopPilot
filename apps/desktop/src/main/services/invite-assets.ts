/**
 * 达人邀约资产：话术库 + 商品集（2026-10-19，v2 P4）。
 *
 * 只做**本店本平台**的复用，不跨店共享：话术里常带店铺名/权益，商品 ID 也属于具体店铺。
 * 删除是硬删（资产不是台账，不需要回收站）；被批次引用过的快照仍在 invite_campaigns / records 里。
 */
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/database'
import { logMain } from './logger'

export interface InviteScriptView {
  id: string
  storeId: string
  platform: string
  name: string
  mode: 'manual' | 'ai'
  template: string
  maxLen: number | null
  status: string
  createdAt: number
  updatedAt: number
}

export interface InviteProductSetView {
  id: string
  storeId: string
  platform: string
  name: string
  productIds: string[]
  createdAt: number
  updatedAt: number
}

function parseProducts(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'))
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(0, 30) : []
  } catch { return [] }
}

function mapScript(row: any): InviteScriptView {
  return {
    id: row.id,
    storeId: row.store_id,
    platform: row.platform,
    name: row.name,
    mode: row.mode === 'ai' ? 'ai' : 'manual',
    template: row.template,
    maxLen: row.max_len == null ? null : Number(row.max_len),
    status: row.status,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  }
}

function mapProductSet(row: any): InviteProductSetView {
  return {
    id: row.id,
    storeId: row.store_id,
    platform: row.platform,
    name: row.name,
    productIds: parseProducts(row.product_ids_json),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  }
}

export function listInviteScripts(input: { storeId: string; platform?: string }): InviteScriptView[] {
  if (!input.storeId) return []
  try {
    const rows = getDatabase().prepare(`
      SELECT * FROM invite_scripts
      WHERE store_id = ? ${input.platform ? 'AND platform = ?' : ''}
      ORDER BY updated_at DESC LIMIT 100
    `).all(...(input.platform ? [input.storeId, input.platform] : [input.storeId])) as any[]
    return rows.map(mapScript)
  } catch { return [] }
}

export function saveInviteScript(input: {
  id?: string
  storeId: string
  platform: string
  name: string
  mode?: 'manual' | 'ai'
  template: string
  maxLen?: number | null
}): InviteScriptView | null {
  const name = String(input.name || '').trim().slice(0, 60)
  const template = String(input.template || '').trim().slice(0, 2000)
  if (!input.storeId || !input.platform || !name || !template) return null
  const maxLen = input.maxLen == null || !Number.isFinite(Number(input.maxLen))
    ? null
    : Math.max(20, Math.min(2000, Math.round(Number(input.maxLen))))
  const now = Date.now()
  const id = input.id ? String(input.id) : `scr_${randomUUID().replace(/-/g, '').slice(0, 20)}`
  try {
    const db = getDatabase()
    const exists = input.id ? db.prepare('SELECT id FROM invite_scripts WHERE id = ? AND store_id = ?').get(id, input.storeId) : null
    if (exists) {
      db.prepare(`
        UPDATE invite_scripts SET name = ?, mode = ?, template = ?, max_len = ?, updated_at = ?
        WHERE id = ? AND store_id = ?
      `).run(name, input.mode === 'ai' ? 'ai' : 'manual', template, maxLen, now, id, input.storeId)
    } else {
      db.prepare(`
        INSERT INTO invite_scripts (id, store_id, platform, name, mode, template, variables_json, max_len, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,NULL,?, 'active', ?,?)
      `).run(id, input.storeId, input.platform, name,
        input.mode === 'ai' ? 'ai' : 'manual', template, maxLen, now, now)
    }
    const row = db.prepare('SELECT * FROM invite_scripts WHERE id = ?').get(id) as any
    return row ? mapScript(row) : null
  } catch (error) {
    logMain('error', `[invite] 保存话术失败: ${String((error as Error)?.message || error)}`)
    return null
  }
}

export function deleteInviteScript(id: string, storeId: string): boolean {
  try {
    const result = getDatabase().prepare('DELETE FROM invite_scripts WHERE id = ? AND store_id = ?').run(id, storeId)
    return Number(result.changes) > 0
  } catch { return false }
}

export function listInviteProductSets(input: { storeId: string; platform?: string }): InviteProductSetView[] {
  if (!input.storeId) return []
  try {
    const rows = getDatabase().prepare(`
      SELECT * FROM invite_product_sets
      WHERE store_id = ? ${input.platform ? 'AND platform = ?' : ''}
      ORDER BY updated_at DESC LIMIT 100
    `).all(...(input.platform ? [input.storeId, input.platform] : [input.storeId])) as any[]
    return rows.map(mapProductSet)
  } catch { return [] }
}

export function saveInviteProductSet(input: {
  id?: string
  storeId: string
  platform: string
  name: string
  productIds: string[]
}): InviteProductSetView | null {
  const name = String(input.name || '').trim().slice(0, 60)
  const ids = [...new Set((input.productIds || []).map(id => String(id).trim()).filter(Boolean).map(id => id.slice(0, 40)))].slice(0, 30)
  if (!input.storeId || !input.platform || !name || !ids.length) return null
  const now = Date.now()
  const id = input.id ? String(input.id) : `pset_${randomUUID().replace(/-/g, '').slice(0, 20)}`
  try {
    const db = getDatabase()
    const exists = input.id ? db.prepare('SELECT id FROM invite_product_sets WHERE id = ? AND store_id = ?').get(id, input.storeId) : null
    if (exists) {
      db.prepare('UPDATE invite_product_sets SET name = ?, product_ids_json = ?, updated_at = ? WHERE id = ? AND store_id = ?')
        .run(name, JSON.stringify(ids), now, id, input.storeId)
    } else {
      db.prepare(`
        INSERT INTO invite_product_sets (id, store_id, platform, name, product_ids_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(id, input.storeId, input.platform, name, JSON.stringify(ids), now, now)
    }
    const row = db.prepare('SELECT * FROM invite_product_sets WHERE id = ?').get(id) as any
    return row ? mapProductSet(row) : null
  } catch (error) {
    logMain('error', `[invite] 保存商品集失败: ${String((error as Error)?.message || error)}`)
    return null
  }
}

export function deleteInviteProductSet(id: string, storeId: string): boolean {
  try {
    const result = getDatabase().prepare('DELETE FROM invite_product_sets WHERE id = ? AND store_id = ?').run(id, storeId)
    return Number(result.changes) > 0
  } catch { return false }
}
