/**
 * 店铺清单 CSV（纯函数，有单测）。
 *
 * 导出的是**店铺元数据**，不含 Cookie、密码、代理凭据或营业执照图片。
 * 标签按 JSON 数组还原为逗号分隔；字段里的逗号/引号/换行按 CSV 规则转义。
 */

import type { Store } from './schemas/store'

export const STORE_CSV_COLUMNS = [
  { key: 'name', label: '店铺名称' },
  { key: 'platform', label: '平台' },
  { key: 'adminUrl', label: '后台地址' },
  { key: 'groupName', label: '分组' },
  { key: 'tags', label: '标签' },
  { key: 'owner', label: '负责人' },
  { key: 'region', label: '地区' },
  { key: 'externalCode', label: '外部编码' },
  { key: 'licenseName', label: '营业执照主体名称' },
  { key: 'licenseNo', label: '统一社会信用代码' },
  { key: 'notes', label: '备注' }
] as const

function parseTags(tagsJson: unknown): string {
  try {
    const parsed = JSON.parse(String(tagsJson ?? '[]'))
    return Array.isArray(parsed) ? parsed.map(String).join(', ') : ''
  } catch {
    return ''
  }
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildStoreCsv(stores: readonly Store[]): { csv: string; rows: number } {
  const lines = [STORE_CSV_COLUMNS.map(column => csvCell(column.label)).join(',')]
  for (const store of stores) {
    const values: Record<string, unknown> = {
      name: store.name,
      platform: store.platform,
      adminUrl: store.adminUrl,
      groupName: store.groupName || '',
      tags: parseTags(store.tagsJson),
      owner: store.owner || '',
      region: store.region || '',
      externalCode: store.externalCode || '',
      licenseName: store.licenseName || '',
      licenseNo: store.licenseNo || '',
      notes: store.notes || ''
    }
    lines.push(STORE_CSV_COLUMNS.map(column => csvCell(values[column.key])).join(','))
  }
  return { csv: lines.join('\r\n'), rows: stores.length }
}

/* ------------------------------------------------------------------------- *
 * 导入（2026-11-10）：CSV → 结构化行。只解析，不落库；重复/非法判断在主进程。
 * ------------------------------------------------------------------------- */

export interface StoreImportRow {
  line: number
  name: string
  platform: string
  adminUrl: string
  groupName: string
  tags: string[]
  owner: string
  region: string
  externalCode: string
  licenseName: string
  licenseNo: string
  notes: string
  errors: string[]
}

export interface StoreImportParseResult {
  rows: StoreImportRow[]
  headerError?: string
}

/** RFC4180 风格解析：支持引号包裹的逗号、换行与双引号转义。 */
export function parseCsvTable(text: string): string[][] {
  const source = String(text || '').replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; continue }
      if (char === '"') { quoted = false; continue }
      cell += char
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ',') { row.push(cell); cell = ''; continue }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(value => value !== '')) rows.push(row)
      row = []
      continue
    }
    cell += char
  }
  row.push(cell)
  if (row.some(value => value !== '')) rows.push(row)
  return rows
}

/**
 * 解析店铺清单 CSV。表头可写中文列名（导出格式）或字段 key；
 * 缺「店铺名称 / 平台」列直接返回 headerError，不猜列位。
 */
export function parseStoreCsv(text: string, maxRows = 500): StoreImportParseResult {
  const table = parseCsvTable(text)
  if (!table.length) return { rows: [], headerError: '文件为空' }
  const header = table[0].map(value => value.trim())
  const labelToKey = new Map<string, string>(STORE_CSV_COLUMNS.map(column => [column.label, column.key]))
  const keyIndex = new Map<string, number>()
  header.forEach((value, index) => {
    const key = labelToKey.get(value) || (STORE_CSV_COLUMNS.some(column => column.key === value) ? value : null)
    if (key && !keyIndex.has(key)) keyIndex.set(key, index)
  })
  if (!keyIndex.has('name') || !keyIndex.has('platform')) {
    return { rows: [], headerError: '表头缺少「店铺名称」或「平台」列' }
  }
  const rows: StoreImportRow[] = []
  for (let index = 1; index < table.length && rows.length < maxRows; index++) {
    const cells = table[index]
    const value = (key: string) => String(cells[keyIndex.get(key) ?? -1] ?? '').trim()
    const name = value('name')
    const platform = value('platform')
    if (!name && !platform) continue
    const errors: string[] = []
    if (!name) errors.push('店铺名称为空')
    if (!platform) errors.push('平台为空')
    const tags = value('tags').split(',').map(tag => tag.trim()).filter(Boolean)
    rows.push({
      line: index + 1,
      name,
      platform,
      adminUrl: value('adminUrl'),
      groupName: value('groupName'),
      tags,
      owner: value('owner'),
      region: value('region'),
      externalCode: value('externalCode'),
      licenseName: value('licenseName'),
      licenseNo: value('licenseNo'),
      notes: value('notes'),
      errors
    })
  }
  return { rows }
}

