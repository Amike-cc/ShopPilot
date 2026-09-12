/**
 * 店铺相关的 Zod Schema
 * §6.1 店铺 IPC 接口
 */

export interface StoreCreateInput {
  name: string
  platform: string
  adminUrl: string
  tags?: string[]
  notes?: string
  externalCode?: string
  owner?: string
  region?: string
}

export interface StoreUpdateInput {
  storeId: string
  patch: {
    name?: string
    platform?: string
    adminUrl?: string
    tags?: string[]
    notes?: string
    externalCode?: string
    owner?: string
    region?: string
    groupName?: string
  }
}

export interface StoreReorderInput {
  orderedStoreIds: string[]
}

export interface Store {
  id: string
  name: string
  platform: string
  adminUrl: string
  status: string
  avatarColor: string
  sortOrder: number
  groupName: string | null
  externalCode: string | null
  owner: string | null
  region: string | null
  tagsJson: string
  notes: string | null
  lastActiveAt: number | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}
