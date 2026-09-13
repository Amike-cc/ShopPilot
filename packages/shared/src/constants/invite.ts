/**
 * 达人邀约「平台档案」（§16 平台适配层扩展）
 *
 * 【设计约定】每个平台的达人邀约功能相互独立：各平台一份档案 + 一种流程（flow），
 * 不做跨平台抽象猜配。当前实现两种流程：
 *   - batch-list  批量勾选流（抖店）：广场列表筛选 → 勾选 N 行 → 批量邀约抽屉 → 一道确认门禁；
 *   - assist-form 辅助填单流（微信小店）：达人必须逐个邀约——人工在浏览器里进到某达人的
 *     「邀请带货」表单页，引擎自建标签页镜像该页 URL，代填联系方式/话术并添加商品，
 *     停下一道确认门禁后才点「发送邀约」。
 *
 * 档案里的每一项都来自真实登录态店铺的实测（2026-09-13），不是猜测：
 * - 抖店：与达人广场共用登录态；主推类目 22 项均可点击；等级 LV0–LV6 下拉多选、单次上限 40、
 *   话术 ≤150 字、推荐商品 ≤5 个；已邀约行复选框 disabled。
 * - 微信小店（带货者广场）：
 *   · 页面整体在 <micro-app shadowdom> 的 ShadowRoot 里，普通 querySelector 不可见（引擎步骤需 deep）；
 *   · 列表行只有「详情」，进详情页后点「邀请带货」→ 同页跳转 /shop/findersquare/initiate-invite 表单页；
 *   · 表单：邀约联系人 / 微信号 / 手机号码 / 合作说明（≤200 字，计数器 n/200）/ 邀约商品（必选，上限 30 个）；
 *   · 「发送邀约」在必填与商品齐备前是类名禁用态；齐备后弹「确认发送邀约」确认框；
 *   · 每日 200 次邀请额度（页面文案「今日剩余200次邀请机会」）；
 *   · 列表 DOM 拿不到 finderUsername（token 只在详情页出现）→ 引擎无法自动拼详情页 URL，
 *     选人必须人工完成，这正是 assist-form 流程的由来。
 *
 * 平台页面会改版：文案或结构失配时任务引擎报 TASK_SELECTOR_CHANGED，绝不静默重试或假装成功。
 */

export interface InviteProfileBase {
  /** 平台名，与 stores.platform 一致 */
  platform: string
  /** 达人广场（邀约入口页） */
  pageUrl: string
  /** 流程标识：平台邀约功能相互独立，渲染层与步骤构造按 flow 分派 */
  flow: 'batch-list' | 'assist-form'
  /** 邀约话术长度上限（平台限制） */
  scriptMaxLen: number
}

/**
 * 批量勾选流档案（抖店）。
 * 字段说明沿用实测注释；选择器只依赖 tbody/checkbox 这类稳定结构，
 * 文案点击靠 clickByText（页面无稳定 data-test）。
 */
export interface BatchInviteProfile extends InviteProfileBase {
  flow: 'batch-list'
  /** 平台单次批量上限 */
  maxBatch: number
  /** 推荐商品上限 */
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
   * 主推类目的「快捷选项行」容器（只在这行里点类目名）。
   * 实测：类目名在达人卡片的类目文案里也会出现（自身文本同样是"个护家清"），
   * 不限定范围就可能点到达人卡片上，筛选自然不生效。
   */
  categoryChipScope: string
  /**
   * 主推类目的级联弹层。实测：点类目 chip 只是展开子类级联（不限/个人护理/家清纸品…），
   * **必须再点一个叶子项**（"不限"= 不限子类）筛选才真正生效；只点 chip 的话
   * 「已筛选」里不会出现主推类目、列表也不会按类目过滤。
   * 叶子项点击必须限定在这个弹层内——等级下拉里也有"不限"，不限范围会点错。
   */
  categoryPopoverSelector: string
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
    /** 抽屉内确认按钮（打开抽屉后先校验它可用=额度/平台未拦截，再填话术） */
    drawerConfirm: string
    /** 主推类目标签文案（用于把类目点击限定在类目那一行） */
    categoryLabel: string
    /** 类目级联里的"不限子类"叶子项（选中则覆盖整个主推类目） */
    categoryAnyLeaf: string
    /** 「已筛选」标签行锚点（校验筛选真的生效：该行里应出现所选类目名） */
    filteredMarker: string
  }
  /** 额度预检提示（抖店不在页面展示剩余额度数字，额度用尽表现为按钮禁用） */
  quotaNote: string
}

/**
 * 辅助填单流档案（微信小店）。
 * 选择器按实测的稳定锚点：placeholder 文案（weui-desktop-form 输入控件类名共享，
 * 只能靠 placeholder 区分）与按钮文案；全部在 ShadowRoot 内，执行时需要 deep 穿透。
 */
export interface AssistInviteProfile extends InviteProfileBase {
  flow: 'assist-form'
  /** 邀约表单页 URL 判据（mirrorTabUrl 据此找到人工打开的邀约页） */
  inviteUrlMarker: string
  /** 单次邀约可添加商品上限（平台弹窗上限 30；引擎单次默认只加少量，宁少勿错） */
  maxProducts: number
  /** 邀约表单各输入控件（placeholder 锚点） */
  selectors: {
    contact: string
    wechat: string
    phone: string
    script: string
    /** 邀约商品表格行（配合可见性过滤统计） */
    goodsRows: string
    /** 添加商品弹窗里的行复选框 label（thead 全选被排除） */
    goodsCheckbox: string
    /** AI 生成话术时的商品信息读取源（邀约商品表格） */
    goodsSource: string
  }
  /** 需按文案点击的入口/按钮 */
  texts: {
    addGoods: string
    confirmAdd: string
    sendInvite: string
    /** 「确认发送邀约」弹窗里的确认按钮文案（弹窗标题用 dialogMarker 等待出现） */
    confirmSend: string
    dialogMarker: string
  }
  /** 每日额度提示（实测页面文案，供界面展示；额度随经营情况变化） */
  dailyQuotaHint: string
  /** 额度预检锚点：页面明示「今日剩余N次邀请机会」，取其中数字 ≥ min 才进行邀约 */
  quota: { textIncludes: string; min: number }
}

export type InviteProfile = BatchInviteProfile | AssistInviteProfile

export function isBatchProfile(p: InviteProfile): p is BatchInviteProfile {
  return p.flow === 'batch-list'
}

export function isAssistProfile(p: InviteProfile): p is AssistInviteProfile {
  return p.flow === 'assist-form'
}

const DOUDIAN: BatchInviteProfile = {
  platform: '抖店',
  pageUrl: 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square',
  flow: 'batch-list',
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
  categoryChipScope: '.quick-filter-button-enums',
  categoryPopoverSelector: '.quick-filter-cascader-popover',
  // 留空 = 运行时用「话术框最近的固定定位浮层」当商品来源（见接口注释：不写死哈希类名）
  goodsSourceSelector: '',
  texts: {
    levelTrigger: '达人等级',
    search: '搜索',
    batchInvite: '批量邀约带货',
    confirmSend: '确认发送',
    drawerConfirm: '确认发送',
    categoryLabel: '主推类目',
    categoryAnyLeaf: '不限',
    filteredMarker: '已筛选'
  },
  quotaNote: '抖店不在页面展示剩余邀约额度；流程会在打开邀约抽屉后先校验「确认发送」是否可用，额度用尽/平台限制时如实失败'
}

/**
 * 微信小店（带货者广场，2026-09-13 实测）。
 * - 输入控件锚点用 placeholder 文案；平台改版文案变了会如实报 TASK_SELECTOR_CHANGED。
 * - 商品策略由 ensureRows 步骤内自适应：页面已有商品行 → 不动；没有 → 点「添加商品」
 *   弹窗勾前 N 个未勾选项 → 点「确认」→ 复核行数。
 */
const WEIXIN: AssistInviteProfile = {
  platform: '微信小店',
  pageUrl: 'https://store.weixin.qq.com/shop/findersquare/find',
  flow: 'assist-form',
  scriptMaxLen: 200,
  inviteUrlMarker: 'initiate-invite',
  maxProducts: 10,
  selectors: {
    contact: 'input[placeholder*="邀约联系人"]',
    wechat: 'input[placeholder*="微信号"]',
    phone: 'input[placeholder*="手机号码"]',
    script: 'textarea[placeholder*="合作说明"]',
    goodsRows: 'tbody tr',
    goodsCheckbox: 'tbody label.weui-desktop-form__check-label',
    goodsSource: 'table'
  },
  texts: {
    addGoods: '添加商品',
    confirmAdd: '确认',
    sendInvite: '发送邀约',
    confirmSend: '确认',
    dialogMarker: '确认发送邀约'
  },
  dailyQuotaHint: '每日 200 次邀请额度',
  quota: { textIncludes: '今日剩余', min: 1 }
}

/** 已实现的平台档案（每个平台流程独立；后续按平台扩展只需在此追加） */
export const INVITE_PROFILES: Readonly<Record<string, InviteProfile>> = {
  [DOUDIAN.platform]: DOUDIAN,
  [WEIXIN.platform]: WEIXIN
}

/** 已支持达人邀约的平台名（供界面如实展示） */
export const INVITE_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(INVITE_PROFILES)

/** 取某店铺平台的档案；未实现的平台返回 null（界面据此明确拒绝，不猜测） */
export function inviteProfileFor(platformName: string | null | undefined): InviteProfile | null {
  if (!platformName) return null
  return INVITE_PROFILES[platformName] || null
}
