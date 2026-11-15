import { ref } from 'vue'

/**
 * 素材库 → 对话生图 的一次性交接（2026-11-15）。
 *
 * 素材库详情里点「用于对话生图」时写入，页面切到对话生图后由对方消费并清空；
 * 不放全局持久状态，避免下次进入对话生图时莫名其妙带着一张旧参考图。
 */
export interface PendingAssetReference {
  name: string
  dataUrl: string
}

export const pendingAssetReference = ref<PendingAssetReference | null>(null)

export function setPendingAssetReference(reference: PendingAssetReference): void {
  pendingAssetReference.value = reference
}

export function takePendingAssetReference(): PendingAssetReference | null {
  const value = pendingAssetReference.value
  pendingAssetReference.value = null
  return value
}
