/**
 * 店铺「主体信息（营业执照）」的平台档案——让软件自己去后台把**本店自己的主体**读回来，
 * 不用一家家手填。
 *
 * 为什么值得单独做一套：发票要按开票主体分账（同一个执照下常挂多家店），
 * 而"哪家店属于哪个主体"这件事**只有平台后台最权威**——用户手填容易填错、填漏，
 * 而发票页上出现的"主体"大多是**对方**（平台自己或买家），拿来做本店执照就是张冠李戴。
 *
 * 红线与其他平台适配层一致：**锚点必须实测，不猜**。因此这里只登记已实测过锚点的平台，
 * 未登记的（或实测时登录态已过期的）平台由 `ENTITY_UNSUPPORTED_NOTE` 如实说明原因，
 * 界面直接照实展示，绝不拿猜的选择器去试。
 *
 * 读取方式沿用引擎既有的 `readLabelValue`（按页面标签文案锚定 → 取该行"多出来的那段文本"），
 * 因为类名普遍带构建哈希（快手实测 section-item/item-title 是少数例外），写死类名会随改版失效。
 */

/** 主体名称的快照指标名（落 store_snapshots） */
export const ENTITY_METRIC_NAME = 'entity.name'
/** 统一社会信用代码的快照指标名 */
export const ENTITY_METRIC_NO = 'entity.no'

export interface EntityProfile {
  /** 平台名，与 stores.platform 一致 */
  platform: string
  /** 存放主体信息的页面 */
  pageUrl: string
  /** navigate 后 waitForPage 的就绪判据（URL 片段） */
  urlMarker: string
  /** 页面渲染/取数的静默毫秒数（SPA 拉接口，元素早就在，只能显式等） */
  settleMs: number
  /** 实测日期（YYYY-MM-DD），界面如实展示"哪天测的" */
  measuredAt: string
  /** 统一社会信用代码的标签文案（实测稳定；主体类型变化也用它） */
  noAnchor: string
  /**
   * 代码标签的**候选**（与 nameAnchors 同一思路）：同一平台不同执照形态下这一行的文案会变
   * （实测拼多多个人店铺是「营业执照注册号」，三证合一的店多为「统一社会信用代码」）。
   * 谁在页面上取谁，都不在就按"该行不存在"处理——不编造、也不因为少一行就判失败。
   */
  noAnchors?: string[]
  /**
   * 主体名称的标签文案**候选**：不同主体类型的行文案不同（实测个体工商户是「个体工商户名称」，
   * 企业主体应为「企业名称」但未实测）→ 两个都读，谁在就取谁，另一个按"该行不存在"处理。
   */
  nameAnchors: string[]
  /** 该页实测到的内容（写清证据，便于改版时对照） */
  note?: string
  /** 实测确认的局限（如实展示给用户，不藏） */
  limits?: string[]
  /** 值的最大长度（超过视为爬到容器层级 → 如实失败），默认 40 */
  maxValueLen?: number
  /**
   * 页面上**读不到**主体（隐藏浮层 / 打码），但**接口响应里有完整值**时走这条：
   * 用 readApi 读接口，再用 `scalars` 把值写成 `entity.name` / `entity.no` 标量快照。
   *
   * 实测微信小店（2026-10-14）：页面上「证件注册号/统一社会信用代码」显示的是
   * `9233**********D310`（打码）且整张卡是隐藏浮层，而它自己请求的
   * `getShopProfile` 返回的是**完整 18 位** `92330783MA8G7BD310` 与主体名称
   * `东阳市花小朵电子商务商行`。给了 api 就不再走 readLabelValue。
   *
   * 注意：`noAnchor` / `nameAnchors` 在给了 api 时**不生效**（保持空数组即可）。
   */
  api?: {
    /** 响应 URL 必须包含它 */
    urlMarker: string
    /** 主体名称在响应里的取值路径 */
    namePath: string
    /** 统一社会信用代码在响应里的取值路径 */
    noPath: string
    timeoutMs?: number
  }
}

/** 已实测的平台档案 */
const KUAISHOU: EntityProfile = {
  platform: '快手小店',
  // 实测路径：后台左侧「店铺」→「资质管理」→ 落地 /zone/shop/info/qualification，
  // 页面默认就是「主体信息」页签（另有 达人主体信息 / 品牌资质 / 行业资质）
  pageUrl: 'https://s.kwaixiaodian.com/zone/shop/info/qualification',
  urlMarker: 'shop/info/qualification',
  settleMs: 9000,
  measuredAt: '2026-09-17',
  noAnchor: '统一社会信用代码',
  nameAnchors: ['个体工商户名称', '企业名称'],
  maxValueLen: 60,
  note: '实测（2026-09-17，已登录真店）：主体信息页的「个体工商户信息」块给出 主体名称 / 统一社会信用代码（完整 18 位、未掩码）/ 类型 / 经营地址 / 营业期限，逐项都读到了真值；按 readLabelValue 的算法预演也确认两个锚点各自命中「标签 值」同一个 DIV。',
  limits: [
    '企业主体的名称行文案应为「企业名称」，本店是个体工商户、未实测——因此两个候选都读，谁在取谁；两个都不在时如实报"没读到名称"，不编造。',
    '个人店铺（没有营业执照）本来就没有这两行 → 会如实报"页面上没有这两行"，不是采集失败。',
    '经营者姓名/证件号码等个人信息不采集（发票只需主体名称与信用代码）。'
  ]
}

/**
 * 拼多多 —— 实测（2026-10-14，已登录真店）。
 *
 * 路径：商家后台 →「店铺信息」页的「主体信息」标签（页面另有 品牌资质/类目资质/商品资质 三个标签）；
 * 直接打开 `https://mms.pinduoduo.com/mallcenter/info/main/index` 就落在「主体信息」，
 * 页面上「营业执照信息」区块逐行给出：**营业执照 / 个体工商户名称 / 营业执照注册号 / 营业执照有效期**。
 *
 * 实测这台店是**个人店铺**：四行都写「无」（不是空行）——占位符会在写回判定里被拒绝
 * （见 shared/store-license.ts 的 PLACEHOLDER_RE），不会把「无」当成主体名称写进店铺。
 */
const PINDUODUO: EntityProfile = {
  platform: '拼多多',
  pageUrl: 'https://mms.pinduoduo.com/mallcenter/info/main/index',
  urlMarker: 'mallcenter/info/main',
  settleMs: 9000,
  measuredAt: '2026-10-14',
  // 实测这一行就叫「营业执照注册号」（三证合一的店这一行是 18 位统一社会信用代码，同为可校验形态）
  noAnchor: '营业执照注册号',
  // 未实测、但同族的候选：三证合一的店常见文案。谁在取谁，都不在就记"没读到"。
  noAnchors: ['统一社会信用代码'],
  nameAnchors: ['个体工商户名称', '企业名称', '公司名称'],
  maxValueLen: 60,
  note: '实测（2026-10-14，已登录真店）：店铺信息 →「主体信息」标签的「营业执照信息」区块逐行给出 营业执照 / 个体工商户名称 / 营业执照注册号 / 营业执照有效期；本店是个人店铺，四行都是「无」。',
  limits: [
    '本店是**个人店铺**（页面「店铺认证」写的就是"个人店铺"），四行值均为「无」→ 如实按"没有可用的主体信息"处理，绝不把「无」写进店铺营业执照。',
    '企业/个体工商户店铺的取值与「统一社会信用代码」这一行文案**未实测**（本店没有执照），故代码与名称都按候选读，缺行不算失败。',
    '只取主体名称与注册号；页面上另有法人/经营者身份信息，不采集。'
  ]
}

/**
 * 微信小店：**页面上读不到，改读接口响应**。
 *
 * 为什么不能读页面（2026-10-14 实测，两家店的教训）：
 *  1. 主体卡在 `/shop/setting/profile` 是**隐藏浮层**（读取只认可见元素）；
 *  2. 卡里「证件注册号/统一社会信用代码」显示的是**打码**值 `9233**********D310`；
 *  3. 整站是 `<micro-app>` 微前端，内容在 shadow DOM 里。
 *
 * 但**接口给的是完整值**：`/shop-faas/mmchannelstradebase/cgi/shop/getShopProfile` 的
 * `licenseInfo.ocrBusiLicenceInfo` 里 `Name` = 主体名称、`RegNum` = 完整 18 位信用代码
 * （同一响应里 `getMerchantInfo` 的 `registrationNum` 才是打码的那个，别读错接口）。
 */
const WEIXIN: EntityProfile = {
  platform: '微信小店',
  pageUrl: 'https://store.weixin.qq.com/shop/setting/profile',
  urlMarker: 'setting/profile',
  settleMs: 6000,
  measuredAt: '2026-10-14',
  // 给了 api 后这两个锚点不生效，留空即可
  noAnchor: '',
  nameAnchors: [],
  api: {
    urlMarker: 'shop/getShopProfile',
    /**
     * 真实结构（2026-10-14 抓包逐层核对，**别再看走眼**）：
     *   licenseInfo
     *     ├─ ocrBusiLicenceInfo    ← 大写的 RegNum / Name 在这里（少一层就取空）
     *     │    ├─ RegNum / Name / Type / Person / Address / Period …
     *     └─ ocrBusiLicenceInfoV2  ← 另一份，字段名是**小写** regNum / name
     * 踩过的坑：`licenseInfo.Name`（少一层）与 `ocrBusiLicenceInfoV2.Name`
     * （V2 那层是小写 name，且它嵌在 licenseInfo 里）都会**静默取到空值**——
     * 靠 requireFields 才会如实报"字段映射可能已失效"，而不是写成"这家没主体"。
     */
    namePath: 'licenseInfo.ocrBusiLicenceInfo.Name',
    noPath: 'licenseInfo.ocrBusiLicenceInfo.RegNum',
    timeoutMs: 25000
  },
  note: '实测（2026-10-14，已登录真店）：getShopProfile 的 licenseInfo.ocrBusiLicenceInfo 返回 Name / RegNum（完整未打码；V2 那层是小写字段名，本档案不读它）。',
  limits: [
    '读的是**接口**不是页面：平台改字段名时 requireFields 会如实失败（不会显示成"这家没主体"）。',
    'getMerchantInfo 里的 registrationNum 是**打码**值，绝不能拿它当信用代码——只认 getShopProfile。',
    '主体名称与信用代码必须**同时**取到才写；只取到一个时如实报缺。'
  ]
}

/**
 * 抖店：页面上有这两行，但**读接口更稳**（那页是「修改主体资质」表单，值多在输入框里，
 * readLabelValue 取的是"标签后多出来的那段文本"，对表单控件不可靠）。
 *
 * 怎么找到的（2026-10-14，留档免得以后有人以为是猜的）：
 *  1. 抓「常用工具」页 `/ffa/grs-new/qualification/common-tools` 的接口，从平台自己下发的工具表里
 *     读到 `/ffa/grs-new/qualification/entity-edit`（「修改公司信息」「修改法人信息」都指向它）；
 *  2. 导航到那一页再抓接口流量，命中 `/center/qualification/subject/info`——
 *     响应里 `data.subject_qual_info.company_info` 就是主体名称与统一社会信用代码。
 *  3. 左侧导航里没有「主体信息」入口，所以之前一直没找到；**不是平台没有，是入口藏起来了**。
 */
const DOUDIAN: EntityProfile = {
  platform: '抖店',
  pageUrl: 'https://fxg.jinritemai.com/ffa/grs-new/qualification/entity-edit',
  urlMarker: 'qualification/entity-edit',
  settleMs: 7000,
  measuredAt: '2026-10-14',
  noAnchor: '',
  nameAnchors: [],
  api: {
    urlMarker: 'qualification/subject/info',
    namePath: 'data.subject_qual_info.company_info.company_name',
    noPath: 'data.subject_qual_info.company_info.license_code',
    timeoutMs: 25000
  },
  note: '实测（2026-10-14，已登录真店）：/center/qualification/subject/info 返回 company_name 与 license_code（完整未打码），另有 enterprise_type_str 等。',
  limits: [
    '采集**只导航 + 读接口**，不点该页任何提交/保存按钮（那是「修改主体资质」表单页）。',
    '读的是**接口**不是页面：平台改字段名时 requireFields 会如实失败，不会显示成"这家没主体"。',
    '营业执照照片等图片资质不采集，只取主体名称与统一社会信用代码两项。'
  ]
}

export const ENTITY_PROFILES: Readonly<Record<string, EntityProfile>> = {
  [KUAISHOU.platform]: KUAISHOU,
  [PINDUODUO.platform]: PINDUODUO,
  [WEIXIN.platform]: WEIXIN,
  [DOUDIAN.platform]: DOUDIAN
}

/** 已实测可自动获取主体的平台（界面据此决定按钮里包含哪些店） */
export const ENTITY_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(ENTITY_PROFILES)

export function entityProfileFor(platformName: string | null | undefined): EntityProfile | null {
  if (!platformName) return null
  return ENTITY_PROFILES[platformName] || null
}

/**
 * 没有档案的平台为什么抓不了——**逐平台实测状态**，界面照实说，不含糊其辞。
 *
 * 2026-10-14 更新：**四家平台全部实测通过，这里已经空了**。
 * 曾经写在这儿的「微信小店主体卡打码」「抖店找不到主体信息页」两条，都是**当时**的实测结论，
 * 后来分别用「读接口响应」和「抓平台自己的接口流量找路由」两条路解决了——
 * 说明"页面上看不到"不等于"平台没有"，别把它当成永久结论。
 */
export const ENTITY_UNSUPPORTED_NOTE: Readonly<Record<string, string>> = {}

export function entityUnsupportedNote(platformName: string | null | undefined): string {
  if (!platformName) return '未知平台，未实测过主体信息页'
  return ENTITY_UNSUPPORTED_NOTE[platformName] || '该平台尚未实测到可读的主体信息页'
}
