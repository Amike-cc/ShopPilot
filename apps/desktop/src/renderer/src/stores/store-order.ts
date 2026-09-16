export type StoreDropPosition = 'before' | 'after'

/**
 * Move a store relative to another store without changing any other items.
 * Returns the original array when the move is a no-op or either id is missing.
 */
export function moveStoreId(
  orderedIds: string[],
  draggingId: string,
  targetId: string,
  position: StoreDropPosition
): string[] {
  if (draggingId === targetId) return orderedIds
  if (!orderedIds.includes(draggingId) || !orderedIds.includes(targetId)) return orderedIds

  const next = orderedIds.filter(id => id !== draggingId)
  const targetIndex = next.indexOf(targetId)
  if (targetIndex < 0) return orderedIds

  next.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, draggingId)
  return next
}
