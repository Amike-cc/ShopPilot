/**
 * 计算跨店上传的目标店铺。
 *
 * 一个目标店铺可能已经挂载了所选商品中的一部分，但仍然可以接收其余商品。
 * 旧实现只要发现任意一条归并记录就把整家店排除，导致多选商品时误伤可上传的商品。
 */
export interface UploadTargetStoreLike {
  id: string
  status: string
}

export interface UploadSourceProductLike {
  sourceStoreIds?: readonly string[]
}

export type UploadTargetOption<T extends UploadTargetStoreLike> = T & {
  existingCount: number
  selectedCount: number
  canReceive: boolean
}

export function buildUploadTargetOptions<T extends UploadTargetStoreLike>(
  stores: readonly T[],
  products: readonly UploadSourceProductLike[]
): Array<UploadTargetOption<T>> {
  const selectedCount = products.length
  return stores
    .filter(store => store.status === 'online')
    .map(store => {
      const existingCount = products.reduce((count, product) =>
        count + (product.sourceStoreIds?.includes(store.id) ? 1 : 0), 0)
      return {
        ...store,
        existingCount,
        selectedCount,
        canReceive: selectedCount === 0 || existingCount < selectedCount
      }
    })
}
