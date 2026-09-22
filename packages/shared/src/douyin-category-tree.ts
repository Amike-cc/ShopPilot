import type { CategoryNode } from './constants/invite'

type JsonRecord = Record<string, any>

function optionLabel(value: any): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  for (const key of ['label', 'name', 'text', 'title', 'show_name', 'value_name', 'option_name', 'cate_name', 'category_name']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function optionChildren(value: any): any[] {
  if (!value || typeof value !== 'object') return []
  for (const key of ['children', 'header', 'enums', 'options', 'values', 'sub', 'sub_items', 'child', 'list', 'items']) {
    if (Array.isArray(value[key]) && value[key].length > 0) return value[key]
    const nested = value[key]
    if (nested && typeof nested === 'object') {
      for (const nestedKey of ['options', 'children', 'header', 'enums', 'values', 'list', 'items']) {
        if (Array.isArray(nested[nestedKey]) && nested[nestedKey].length > 0) return nested[nestedKey]
      }
    }
  }
  return []
}

function findFirstOptionArray(value: any, depth = 0): any[] {
  if (depth > 4 || value == null) return []
  if (Array.isArray(value)) {
    if (value.some(item => optionLabel(item))) return value
    for (const item of value) {
      const found = findFirstOptionArray(item, depth + 1)
      if (found.length) return found
    }
    return []
  }
  if (typeof value !== 'object') return []
  for (const key of ['options', 'children', 'header', 'enums', 'values', 'items', 'list', 'cascader', 'data']) {
    const found = findFirstOptionArray((value as JsonRecord)[key], depth + 1)
    if (found.length) return found
  }
  return []
}

/**
 * Normalize the dynamic category filter returned by the Douyin creator-square API.
 * The API has used both `header` and common option-list field names over time.
 */
export function normalizeDouyinCategoryTree(payload: any): CategoryNode[] {
  const headers = payload?.data?.headers || payload?.data?.header || payload?.data?.filter_headers || []
  if (!Array.isArray(headers) || headers.length === 0) return []
  const categoryHeader = headers.find((header: any) => {
    const identity = [header?.key, header?.name, header?.title, header?.label, header?.type].filter(Boolean).join(' ')
    return /main_cate|主推类目/i.test(identity)
  }) || headers.find((header: any) => /main_cate|主推类目/i.test(JSON.stringify(header).slice(0, 2000)))
  if (!categoryHeader) return []

  const roots = findFirstOptionArray(categoryHeader)
  const cleanNames = (values: any[]) => values
    .map(optionLabel)
    .filter(name => name && !['不限', '全部', '暂无数据'].includes(name))

  return roots
    .map((first: any): CategoryNode | null => {
      const firstName = optionLabel(first)
      if (!firstName) return null
      const secondItems = optionChildren(first)
      const grandchildren = secondItems
        .map((second: any) => ({
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
