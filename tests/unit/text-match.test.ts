import { expect, it } from 'vitest'
import { matchesTextToken } from '../../packages/shared/src/text-match'

it('does not accept a parent category as the selected child', () => {
  expect(matchesTextToken('个护家清 家清纸品', '纸品')).toBe(false)
  expect(matchesTextToken('个护家清 家清纸品 纸品', '纸品')).toBe(true)
  expect(matchesTextToken('个护家清/家清纸品/纸品', '纸品')).toBe(true)
  expect(matchesTextToken('纸品用品', '纸品')).toBe(false)
})

it('accepts a whole label wrapped by common Chinese filter-summary punctuation', () => {
  expect(matchesTextToken('已筛选：个护家清 / 家清纸品（纸品）', '纸品')).toBe(true)
  expect(matchesTextToken('个护家清·家清纸品·纸品', '纸品')).toBe(true)
  expect(matchesTextToken('家清纸品（纸品用品）', '纸品')).toBe(false)
})
