import type { CategoryNode } from './constants/invite'

/**
 * 抖创广场类目树的解析 - 动态 JSON
 *
 * 2026-09-26 审计 P2（`packages/shared` 里的 any 收紧）：这个模块解析的是**第三方接口返回的
 * 动态结构**，以前满是 `any`——等于放弃了"哪些字段被信任"的记录。现在统一收成 `unknown` +
 * 显式收窄（`asRecord` / `Array.isArray` / `typeof`），只有确认是字符串/数组后才当数据用。
 */

/** 收窄成可索引的对象；数组/原始值/null 都不是"对象字段容器" */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function optionLabel(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const record = asRecord(value)
  if (!record) return ''
  for (const key of ['label', 'name', 'text', 'title', 'show_name', 'value_name', 'option_name', 'cate_name', 'category_name']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function optionChildren(value: unknown): unknown[] {
  const record = asRecord(value)
  if (!record) return []
  for (const key of ['children', 'header', 'enums', 'options', 'values', 'sub', 'sub_items', 'child', 'list', 'items']) {
    const candidate = record[key]
    if (Array.isArray(candidate) && candidate.length > 0) return candidate
    const nested = asRecord(candidate)
    if (nested) {
      for (const nestedKey of ['options', 'children', 'header', 'enums', 'values', 'list', 'items']) {
        const nestedValue = nested[nestedKey]
        if (Array.isArray(nestedValue) && nestedValue.length > 0) return nestedValue
      }
    }
  }
  return []
}

function findFirstOptionArray(value: unknown, depth = 0): unknown[] {
  if (depth > 4 || value == null) return []
  if (Array.isArray(value)) {
    if (value.some(item => optionLabel(item))) return value
    for (const item of value) {
      const found = findFirstOptionArray(item, depth + 1)
      if (found.length) return found
    }
    return []
  }
  const record = asRecord(value)
  if (!record) return []
  for (const key of ['options', 'children', 'header', 'enums', 'values', 'items', 'list', 'cascader', 'data']) {
    const found = findFirstOptionArray(record[key], depth + 1)
    if (found.length) return found
  }
  return []
}

/**
 * Normalize the dynamic category filter returned by the Douyin creator-square API.
 * The API has used both `header` and common option-list field names over time.
 */
export function normalizeDouyinCategoryTree(payload: unknown): CategoryNode[] {
  const data = asRecord(asRecord(payload)?.data)
  const rawHeaders = data?.headers ?? data?.header ?? data?.filter_headers ?? []
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0) return []
  const headers: unknown[] = rawHeaders
  const identify = (header: unknown): string => {
    const record = asRecord(header)
    if (!record) return ''
    return [record.key, record.name, record.title, record.label, record.type].filter(Boolean).join(' ')
  }
  const categoryHeader = headers.find(header => /main_cate|主推类目/i.test(identify(header)))
    || headers.find(header => /main_cate|主推类目/i.test(JSON.stringify(header).slice(0, 2000)))
  if (!categoryHeader) return []

  const roots = findFirstOptionArray(categoryHeader)
  const cleanNames = (values: unknown[]): string[] => values
    .map(optionLabel)
    .filter(name => name && !['不限', '全部', '暂无数据'].includes(name))

  return roots
    .map((first): CategoryNode | null => {
      const firstName = optionLabel(first)
      if (!firstName) return null
      const secondItems = optionChildren(first)
      const grandchildren = secondItems
        .map(second => ({
          name: optionLabel(second),
          children: cleanNames(optionChildren(second))
        }))
        .filter(second => second.name && second.children.length > 0)
      return {
        name: firstName,
        children: cleanNames(secondItems),
        ...(grandchildren.length ? { grandchildren } : {})
      }
    })
    .filter((node): node is CategoryNode => !!node && node.children.length > 0)
}
