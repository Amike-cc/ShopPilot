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

export const ENTITY_PROFILES: Readonly<Record<string, EntityProfile>> = {
  [KUAISHOU.platform]: KUAISHOU
}

/** 已实测可自动获取主体的平台（界面据此决定按钮里包含哪些店） */
export const ENTITY_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(ENTITY_PROFILES)

export function entityProfileFor(platformName: string | null | undefined): EntityProfile | null {
  if (!platformName) return null
  return ENTITY_PROFILES[platformName] || null
}

/**
 * 没有档案的平台为什么抓不了——**逐平台实测状态**，界面照实说，不含糊其辞。
 * 这些限制会随实测进展更新（比如某店重新登录后就能登记）。
 */
export const ENTITY_UNSUPPORTED_NOTE: Readonly<Record<string, string>> = {
  微信小店: '主体信息在「店铺信息」页的悬浮卡里：实测它平时是 display:none，点击与合成悬停都不展开（页面另一处「资质管理」本店没有记录）。当前读取方式只认可见元素，读不到；且该页给的信用代码是掩码（只显示头尾）。要支持得先给引擎加"悬停"步骤——未做，故不做猜测性实现。',
  抖店: '未实测到可读的主体信息页：2026-09-17 实测时该店铺未登录（后台首页直接落到登录页）。登录后再实测登记。',
  拼多多: '未实测到可读的主体信息页：2026-09-17 实测时该店铺商家后台登录态已过期（mms 落到登录页）。重新登录后再实测登记。'
}

export function entityUnsupportedNote(platformName: string | null | undefined): string {
  if (!platformName) return '未知平台，未实测过主体信息页'
  return ENTITY_UNSUPPORTED_NOTE[platformName] || '该平台尚未实测到可读的主体信息页'
}
