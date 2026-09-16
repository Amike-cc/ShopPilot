import { describe, expect, it } from 'vitest'
import { moveStoreId } from '../../apps/desktop/src/renderer/src/stores/store-order'

describe('store drag order', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves a store up before the target', () => {
    expect(moveStoreId(ids, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves a store down after the target', () => {
    expect(moveStoreId(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
  })

  it('keeps the original order when dropping on itself', () => {
    expect(moveStoreId(ids, 'b', 'b', 'after')).toBe(ids)
  })

  it('keeps the original order when a store id is missing', () => {
    expect(moveStoreId(ids, 'missing', 'b', 'before')).toBe(ids)
    expect(moveStoreId(ids, 'a', 'missing', 'after')).toBe(ids)
  })
})
