/**
 * Shared package index
 * 统一导出所有共享类型和契约
 */

// Contracts
export * from './contracts/ipc'
export * from './contracts/platform-adapter'
export * from './contracts/shop-session'
export * from './contracts/unified-order'
export * from './contracts/pdd-order-observation'
export * from './contracts/sales-metrics'

// Enums
export * from './enums/store-status'

// Constants
export * from './constants/platforms'
export * from './constants/invite'
export * from './constants/business'
export * from './constants/ai'

// 邀约步骤构造（渲染层与单测共用）
export * from './invite-steps'
// 邀约配置的存储键（按店铺独立保存）
export * from './invite-config'
// 经营指标采集步骤构造
export * from './business-steps'
// 经营采集纯规则（状态归类 / 退避 / 新鲜度 / 口径 / 跨平台合计门禁）
// Main 的调度器与渲染层的状态卡读同一份判定，避免两处各算一遍
export * from './sales-metrics-rules'

// Schemas
export * from './schemas/store'
export * from './schemas/task'
export * from './schemas/shop-session'
export * from './schemas/order'
export * from './schemas/sales-metrics'

// Errors
export * from './errors/error-codes'

// 导航 URL 协议白名单（主渲共用，单测可直接锁定）
export * from './navigation'
