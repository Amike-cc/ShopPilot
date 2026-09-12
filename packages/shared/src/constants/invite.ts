/**
 * 达人邀约「平台档案」（§16 平台适配层扩展）
 *
 * 当前只实现了抖店（精选联盟）。后续按平台扩展的方式：
 *   1) 在 INVITE_PROFILES 里加一份该平台的档案（页面地址、筛选文案、选择器、上限）；
 *   2) 面板按「当前店铺的平台」自动匹配档案——匹配不到就明确说"暂不支持"，不做猜测。
 * 抖店档案的每一项都是 2026-09-13 在真实登录态店铺上的实测结果，不是猜测：
 * - 达人广场与抖店共用登录态（同一 .jinritemai.com 域，无需单独登录）
 * - 主推类目 22 项实测均可点击（折叠区里的项也能点中，无需先"展开"）
 * - 达人等级 LV0–LV6 为下拉多选；单次勾选上限 40；邀约信息 ≤150 字；推荐商品 ≤5 个
 * - 已发过消息的达人：行复选框为 disabled，平台不允许重复邀约（任务侧跳过并如实回报）
 *
 * 平台页面会改版：文案或结构失配时任务引擎报 TASK_SELECTOR_CHANGED，绝不静默重试或假装成功。
 */

export interface InviteProfile {
  /** 平台名，与 stores.platform 一致 */
  platform: string
  /** 达人广场（邀约入口页） */
  pageUrl: string
  /** 平台硬限制 */
  maxBatch: number
  scriptMaxLen: number
  maxProducts: number
  /** 主推类目（实测可点击项） */
  categories: readonly string[]
  /** 达人等级可选项 */
  levels: readonly string[]
  /** 实测有邀约额度的等级（仅作提示：额度按"店铺类型 × 等级"下发，会随经营情况变化） */
  levelsWithQuotaHint: readonly string[]
  /** 专属权益可选项 */
  benefits: readonly string[]
  /** 表格行复选框（thead 里的是"全选"，必须排除） */
  rowCheckboxSelector: string
  /** 邀约抽屉里的话术输入框 */
  scriptSelector: string
  /**
   * 邀约抽屉里「推荐商品」区域的读取源（用于 AI 生成话术时参考商品）。
   * 留空 = 运行时从话术框向上找最近的「固定定位浮层」（抽屉本体）再读其可见文本；
   * 找不到浮层就如实报 AI_EMPTY_SOURCE 失败——绝不把整页噪音当商品信息喂给模型。
   * 之所以不写死选择器：实测抽屉用哈希类名、结构随版本变，写死等于猜测（平台适配层红线）。
   */
  goodsSourceSelector: string
  /** 需按文案点击的入口/按钮 */
  texts: {
    levelTrigger: string
    search: string
    batchInvite: string
    confirmSend: string
  }
}

const DOUDIAN: InviteProfile = {
  platform: '抖店',
  pageUrl: 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square',
  maxBatch: 40,
  scriptMaxLen: 150,
  maxProducts: 5,
  categories: [
    '玩具乐器', '服饰内衣', '个护家清', '智能家居', '生鲜', '美妆',
    '母婴宠物', '鲜花园艺', '本地生活', '食品饮料', '3C数码家电', '图书教育',
    '鞋靴箱包', '虚拟充值', '运动户外', '钟表配饰', '珠宝文玩', '医疗健康',
    '酒类', '滋补保健', '原料包装', '餐饮外卖'
  ],
  levels: ['LV0', 'LV1', 'LV2', 'LV3', 'LV4', 'LV5', 'LV6'],
  levelsWithQuotaHint: ['LV0', 'LV1', 'LV2', 'LV3'],
  benefits: ['专属高佣', '免费申样', '视频素材支持', '优质视频投放'],
  rowCheckboxSelector: 'tbody input[type=checkbox]',
  scriptSelector: 'textarea',
  // 留空 = 运行时用「话术框最近的固定定位浮层」当商品来源（见接口注释：不写死哈希类名）
  goodsSourceSelector: '',
  texts: {
    levelTrigger: '达人等级',
    search: '搜索',
    batchInvite: '批量邀约带货',
    confirmSend: '确认发送'
  }
}

/** 已实现的平台档案（后续按平台扩展只需在此追加） */
export const INVITE_PROFILES: Readonly<Record<string, InviteProfile>> = {
  [DOUDIAN.platform]: DOUDIAN
}

/** 已支持达人邀约的平台名（供界面如实展示） */
export const INVITE_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(INVITE_PROFILES)

/** 取某店铺平台的档案；未实现的平台返回 null（界面据此明确拒绝，不猜测） */
export function inviteProfileFor(platformName: string | null | undefined): InviteProfile | null {
  if (!platformName) return null
  return INVITE_PROFILES[platformName] || null
}
