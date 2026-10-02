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
export * from './contracts/platform-product'
export * from './contracts/agent-software'

// Enums
export * from './enums/store-status'

// Constants
export * from './constants/platforms'
export * from './constants/invite'
export * from './constants/business'
export * from './constants/ai'
// 商品平台档案（商品列表页地址/列映射/翻页；只登记真机实测过的平台）
export * from './constants/product'
// 商品纯规则（标题+ID / 价格 / 库存 / 状态 的实测形态解析 + 草稿指纹）
export * from './product-rules'
// 本地商品草稿规则（分级校验 + 草稿指纹 + 从平台商品生成初值）
export * from './product-draft'

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
export * from './schemas/product'

// Errors
export * from './errors/error-codes'

// 导航 URL 协议白名单（主渲共用，单测可直接锁定）
export * from './navigation'

// 发布台账状态词表（三套命名曾互不一致，收敛到一处 + 源码扫描测试兜底）
export * from './product-status'
