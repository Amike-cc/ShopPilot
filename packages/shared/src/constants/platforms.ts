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
  /**
   * 该地址是否经**真机实测**确认（打开后确实是对应页面）。
   * 未标 true 的属于推断或"平台未提供独立入口"，界面上会如实标注「未实测」，
   * 避免把猜测的深链当成可用入口（宁缺毋滥）。
   */
  verified?: boolean
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
  /** 发票入口（「发票中心」用；实测到的排前面，未实测的如实标注） */
  invoiceRoutes: PlatformEntryRoute[]
}

export const PLATFORM_CATALOG: readonly PlatformDef[] = [
  {
    name: '拼多多',
    color: '#E22E24',
    adminUrl: 'https://mms.pinduoduo.com',
    entryRoutes: [{ title: '拼多多商家后台', url: 'https://mms.pinduoduo.com' }],
    // 实测（2026-09-14，已登录真店）：左侧「发货管理」下有「订单开票」，
    // 点击后地址为 /invoice/center；「发票管理」在资金中心下，href=/cashier/finance/invoice
    invoiceRoutes: [
      { title: '订单开票', url: 'https://mms.pinduoduo.com/invoice/center', verified: true },
      { title: '发票管理（资金中心）', url: 'https://mms.pinduoduo.com/cashier/finance/invoice', verified: true }
    ]
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
    ],
    // 实测（2026-09-14，已登录真店）：后台导航里有「发票中心」（平台自己的叫法），
    // href=/shop/bill/home
    invoiceRoutes: [
      { title: '发票中心', url: 'https://store.weixin.qq.com/shop/bill/home', verified: true }
    ]
  },
  {
    name: '快手小店',
    color: '#FF6A00',
    adminUrl: 'https://s.kwaixiaodian.com',
    entryRoutes: [{ title: '快手小店商家后台', url: 'https://s.kwaixiaodian.com' }],
    // 实测（2026-09-14，已登录真店）：**整页未找到「发票」入口**；
    // 试过的资金类路径（/zone/fund/invoice 等）都被重定向回后台首页，故不给猜测深链。
    // 这里只放后台入口，提示从「资金 / 账户中心」进。
    invoiceRoutes: [
      { title: '快手小店后台（资金 / 账户中心）', url: 'https://s.kwaixiaodian.com' }
    ]
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
    ],
    // 本店的抖店后台当前未登录，**无法实测**发票入口，因此不写猜测深链；
    // 只给后台入口（登录后从「资金」里进发票）。
    invoiceRoutes: [
      { title: '抖店后台（资金 → 发票）', url: 'https://fxg.jinritemai.com' }
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
