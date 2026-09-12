/**
 * 国内电商平台目录（§16 平台适配层）
 *
 * 产品范围：本工具的适配平台为国内四家 —— 拼多多 / 微信小店 / 快手小店 / 抖店。
 *
 * 后台地址与深链的校验方式（2026-09-11，未登录态 HTTP 实测）：
 * - 微信小店、抖店：不存在的路径返回 404，实测 200 的深链才收录（可信）；
 * - 拼多多、快手小店：任意路径都 200（统一重定向到登录页），无法区分深链真伪，
 *   因此只收录后台首页，不猜测"订单/商品"等二级地址（宁缺毋滥，避免给出 404 死链）。
 * 深链会随平台改版调整：若某条失效，用户可直接删除该收藏，或用收藏面板自行添加。
 */

export interface PlatformEntryRoute {
  /** 收藏面板展示名 */
  title: string
  url: string
}

export interface PlatformDef {
  /** 平台名，原样存入 stores.platform */
  name: string
  /** 店铺卡圆点/标签色 */
  color: string
  /** 商家后台默认地址（新建店铺时自动填入，可改） */
  adminUrl: string
  /** 平台入口（只读，不重复入库，见 §5.8 source=entry_route） */
  entryRoutes: PlatformEntryRoute[]
}

export const PLATFORM_CATALOG: readonly PlatformDef[] = [
  {
    name: '拼多多',
    color: '#E22E24',
    adminUrl: 'https://mms.pinduoduo.com',
    entryRoutes: [{ title: '拼多多商家后台', url: 'https://mms.pinduoduo.com' }]
  },
  {
    name: '微信小店',
    color: '#07C160',
    adminUrl: 'https://store.weixin.qq.com',
    entryRoutes: [
      { title: '小店后台首页', url: 'https://store.weixin.qq.com/shop/dashboard' },
      { title: '订单管理', url: 'https://store.weixin.qq.com/shop/order/list' },
      { title: '商品管理', url: 'https://store.weixin.qq.com/shop/product/list' },
      { title: '售后管理', url: 'https://store.weixin.qq.com/shop/aftersale/list' }
    ]
  },
  {
    name: '快手小店',
    color: '#FF6A00',
    adminUrl: 'https://s.kwaixiaodian.com',
    entryRoutes: [{ title: '快手小店商家后台', url: 'https://s.kwaixiaodian.com' }]
  },
  {
    name: '抖店',
    color: '#FE2C55',
    adminUrl: 'https://fxg.jinritemai.com',
    entryRoutes: [
      { title: '抖店后台首页', url: 'https://fxg.jinritemai.com/ffa/mshop/trade/dashboard' },
      { title: '订单管理', url: 'https://fxg.jinritemai.com/ffa/mshop/order/list' },
      { title: '商品管理', url: 'https://fxg.jinritemai.com/ffa/g/list' },
      { title: '售后管理', url: 'https://fxg.jinritemai.com/ffa/mshop/aftersale/list' }
    ]
  }
]

/** 自定义平台（用户可自行填写后台地址） */
export const CUSTOM_PLATFORM_NAME = '其他'

export function findPlatform(name: string): PlatformDef | undefined {
  return PLATFORM_CATALOG.find(p => p.name === name)
}

export function platformAdminUrl(name: string): string {
  return findPlatform(name)?.adminUrl || ''
}

export function platformEntryRoutes(name: string): PlatformEntryRoute[] {
  return findPlatform(name)?.entryRoutes || []
}
