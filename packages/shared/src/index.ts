/**
 * Shared package index
 * 统一导出所有共享类型和契约
 */

// Contracts
export * from './contracts/ipc'

// Enums
export * from './enums/store-status'

// Constants
export * from './constants/platforms'
export * from './constants/invite'
export * from './constants/business'
export * from './constants/ai'

// 邀约步骤构造（渲染层与单测共用）
export * from './invite-steps'
// 经营指标采集步骤构造
export * from './business-steps'

// Schemas
export * from './schemas/store'
export * from './schemas/task'

// Errors
export * from './errors/error-codes'
