import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion } from '@shared/version-compare'

describe('插件版本比较', () => {
  it('按数字段比较，而不是字符串排序', () => {
    expect(compareVersions('2.7.10', '2.7.9')).toBe(1)
    expect(compareVersions('2.7.3', '2.7.3')).toBe(0)
    expect(compareVersions('2.7.2', '2.7.3')).toBe(-1)
    expect(compareVersions('v2.8.0', '2.7.9')).toBe(1)
  })

  it('缺省段按 0 处理', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.1', '1.0')).toBe(1)
  })

  it('只在新版本更大时提示更新', () => {
    expect(isNewerVersion('2.7.3', '2.7.2')).toBe(true)
    expect(isNewerVersion('2.7.3', '2.7.3')).toBe(false)
    expect(isNewerVersion('2.7.2', '2.7.3')).toBe(false)
  })
})
