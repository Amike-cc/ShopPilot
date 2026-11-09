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
