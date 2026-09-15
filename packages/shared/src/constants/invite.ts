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

/** 主推类目树的一个一级类目（children = 平台级联里的二级子类，空数组 = 无子类） */
export interface CategoryNode {
  name: string
  children: readonly string[]
}

/**
 * 批量勾选流档案（抖店 / 快手小店）。
 * 字段说明沿用实测注释；选择器只依赖 tbody/checkbox 这类稳定结构，
 * 文案点击靠 clickByText（页面无稳定 data-test）。
 */
export interface BatchInviteProfile extends InviteProfileBase {
  flow: 'batch-list'
  /** 平台单次批量上限 */
  maxBatch: number
  /**
   * 平台要求的最少勾选数（实测快手：只勾 1 位点「批量邀约」**静默无反应**，
   * 勾 2 位才打开抽屉——不留够就会白跑一轮、还看不出原因）。
   * 默认 1（抖店无此限制）。
   */
  minSelect?: number
  /** 推荐商品上限 */
  maxProducts: number
  /**
   * 类目筛选区的**文案名**（面板标题用）。抖店叫「主推类目」，快手叫「带货类目」。
   * 留空用界面默认文案。
   */
  categoryLabelText?: string
  /**
   * 额外的多选筛选行（快手特有：页面把筛选分成「内容标签 / 带货类目 / 带货数据 / 合作信息」四行）。
   * 每行是一个容器，行内有 label + 一排可点项；`scope` 决定点击限定在哪个容器里
   * （平台的行容器类名相同、无法用选择器区分，所以用 `{ text: 行标签, climb }` 从标签上溯——见 invite-steps）。
   * 抖店没有这些行 → 不定义。
   */
  extraFilterRows?: readonly {
    /** 行标签文案（既用于界面显示，也用于运行时定位该行） */
    label: string
    options: readonly string[]
    /** 从行标签元素上溯几层到行容器（实测快手：LABEL → DIV.col → DIV.row，climb=2） */
    climb: number
  }[]
  /**
   * 抽屉内那组复选标签的**叫法**（面板标题用）。抖店叫「专属权益」，快手叫「合作标签」。
   */
  benefitsLabelText?: string
  /**
   * 类目（实测可点击项）。抖店叫「主推类目」，快手叫「带货类目」；
   * 平台自己的叫法由 categoryLabelText 提供，界面据此显示。
   */
  categories: readonly string[]
  /**
   * 类目 chip 的**限定范围**（只在这行里点类目名）。
   * 实测：类目名在达人卡片的类目文案里也会出现（自身文本同样是"个护家清"），
   * 不限定范围就可能点到达人卡片上，筛选自然不生效。
   * 写法二选一：CSS 选择器字符串（抖店 `.quick-filter-button-enums`），
   * 或 `{ text:'行标签', climb:N }`（快手那几行类名相同，只能从标签上溯定位）。
   */
  categoryChipScope: string | { text: string; climb: number }
  /**
   * 类目级联弹层的限定范围。实测：点类目 chip 只是展开子类级联，
   * **必须再点一个叶子项**（"不限/全部"= 不限子类）筛选才真正生效。
   * 叶子项点击必须限定在这个弹层内——别处也有同名的"不限/全部"，不限范围会点错。
   */
  categoryPopoverSelector: string
  /**
   * 类目树（一级 → 二级子类）。二级取自平台级联弹层的逐个实测
   * （抖店 2026-09-14 见 wx-invite-test/category-tree.json；快手 2026-09-15 见 ks-category-tree.json）。
   * 平台对二级的交互：点一级 chip 展开子类级联，**点二级项即生效**。
   * 子类名可能被平台截断（如抖店"摩托车/电动车/自行..."），流程按"包含匹配"点击，不做全等假设。
   */
  categoryTree: readonly CategoryNode[]
  /** 达人等级可选项（快手没有这一维 → 空数组，面板与步骤都跳过） */
  levels: readonly string[]
  /** 实测有邀约额度的等级（仅作提示：额度按"店铺类型 × 等级"下发，会随经营情况变化） */
  levelsWithQuotaHint: readonly string[]
  /** 抽屉里那组复选标签的可选项（抖店=专属权益；快手=合作标签） */
  benefits: readonly string[]
  /** 表格行复选框（thead 里的是"全选"，必须排除） */
  rowCheckboxSelector: string
  /** 邀约抽屉里的话术输入框 */
  scriptSelector: string
  /**
   * 抽屉里的必填联系方式输入框（实测快手要求联系人/手机号/微信号三项必填，
   * 且平台会记住上次填的）。抖店无此字段 → 不定义。
   */
  contactSelectors?: { contact: string; phone?: string; wechat?: string }
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
    /**
     * 发送后平台用来**告知失败**的文案（留空 = 该平台没实测到这种提示，不插入断言步骤）。
     * 出现它就说明这一批没发出去——发送流程会在等抽屉收起之前断言它**缺席**。
     * 为什么必须读它：有的平台在发送失败时会**故意留着抽屉**让你调整后重试（实测快手），
     * 于是"抽屉没关"既可能是失败、也可能只是平台还在处理，光看抽屉区分不出来。
     */
    sendRejectedMarker?: string
  }
  /**
   * 类目生效标记的**定位方式**（默认 `{ text: texts.filteredMarker, climb: 1 }`）。
   *
   * 为什么需要它：抖店的「已筛选」是一个元素的**自有文本**，按文案上溯就能定位；
   * 而快手那条标记（`.pro-tagForm-result`，文本形如「已选1个 个护家清: 清空」）**整段都是子元素**、
   * 自身没有文本节点——按文案找不到它（真机彩排实测：waitForText 直接超时）。
   * 给了 selector 就按选择器定位。
   */
  filteredScope?: string
  /** 额度预检提示（抖店不在页面展示剩余额度数字，额度用尽表现为按钮禁用） */
  quotaNote: string
  /**
   * 额度预检方式（默认 'requireEnabled' = 校验抽屉确认按钮是否禁用，抖店用）：
   *  - 'requireEnabled'：平台不在页面展示剩余额度数字，只能看按钮禁用与否；
   *  - 'requireQuota'  ：页面**明示**剩余额度（实测快手抽屉底部「今日剩余100条发送邀请机会」）
   *                      → 取其中数字判断，比"按钮禁用"更早、更明确。
   */
  quotaCheck?: 'requireEnabled' | 'requireQuota'
  /** quotaCheck='requireQuota' 时的锚点：文案片段与最低通过值 */
  quota?: { textIncludes: string; min: number; optional?: boolean }
  /**
   * 抽屉里的「选择商品」是**弹窗**（实测快手：点「选择商品」开 modal，
   * 里面左侧有商品列表、底部「取 消 / 确 认」）——勾选在 modal 内完成，确认后才回到抽屉。
   */
  goodsModal?: {
    /** 弹窗根容器（在它范围内找商品行复选框与确认按钮，避免点到抽屉里别的"确认"） */
    rootSelector: string
    /** 打开弹窗的按钮文案（抽屉里的那个按钮；实测「选择商品」） */
    addText: string
    /**
     * 弹窗内商品行复选框的选择器。
     * **不能写 `… tbody input[...]`**：实测这个弹窗的商品列表是自绘表格、**没有 <tbody>**
     * （截图确认：有表头 + 若干行，但结构里无 tbody），写 tbody 会一个都匹配不到
     * → clickAll 报"只勾中 0 位"（真机踩到）。
     */
    rowCheckboxSelector: string
    /** 商品搜索框（按商品ID精确搜索时用；placeholder 锚点） */
    searchSelector: string
    /** 搜索按钮（实测文案是「查 询」，按去空格匹配） */
    searchText: string
    /** 确认按钮（实测「确 认」） */
    confirmText: string
    /** 抽屉里"已选商品数"的文案锚点（选完商品后校验商品真的挂上去了） */
    selectedMarker: string
  }
  /**
   * 发送后可能出现的二次确认框文案（平台行为未定时的兜底）。给几条就逐个条件点击：
   * 出现就点、没出现就跳过，并如实记录。
   *
   * 实测（2026-09-15 快手真机）：点「发送邀请」后弹**「邀约提示」**弹窗，逐条列出
   * 不满足项（佣金率低于达人下限 / 商家体验分低于达人设置下限），底部按钮
   * 「返回调整 / **继续发送邀约**」——不点它，邀约抽屉永远不关、一条都发不出去。
   * 该弹窗**只在商品与该达人要求不匹配时出现**（同批换一位达人可能就不弹），故必须条件点击。
   * 未实测到该确认框的平台留空即可（不会插入任何步骤，也不会白等）。
   */
  postSendConfirmTexts?: readonly string[]
  /**
   * 发送后「邀约抽屉关闭」的等待上限（ms，默认 180000）。
   * 实测快手真实发送后抽屉要**一分多钟**才关（平台侧在处理；30s/90s 都太短，
   * 会把一次成功的发送误报成失败），所以别按别的平台的经验往下压。
   */
  postSendGoneTimeoutMs?: number
}

/**
 * 辅助填单流档案（微信小店）。
 * 选择器按实测的稳定锚点：placeholder 文案（weui-desktop-form 输入控件类名共享，
 * 只能靠 placeholder 区分）与按钮文案；全部在 ShadowRoot 内，执行时需要 deep 穿透。
 */
export interface AssistInviteProfile extends InviteProfileBase {
  flow: 'assist-form'
  /** 带货者广场的类型页签（应用于用户打开广场时） */
  finderTypes: readonly string[]
  /** 带货类目筛选项（真实页面文案） */
  finderCategories: readonly string[]
  /** 其他筛选项（真实页面文案） */
  finderOtherFilters: readonly string[]
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
    /** 广场列表里的「详情」（逐个邀约时按它进入达人详情页） */
    detail: string
    /** 详情页里的「邀请带货」入口 */
    inviteEntry: string
    /**
     * 详情页在**不可邀约**时显示的**替代文案**（实测微信：「暂未到达合作门槛」）。
     * 与 inviteEntry 互斥：页面出现它就说明这位达人自身不满足平台合作条件
     * （实测该文案的悬浮说明是「成为热招品牌 / 店铺需满足店铺评分行业前30%」）。
     * 引擎据此**跳过换下一位**——与"页面没渲染出来"（重试同一位）是相反的处理，
     * 不区分的话就会一直重试同一个不能邀约的人，白跑整轮。
     */
    notInvitable: string
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
  // 二级子类为平台级联逐个实测（2026-09-14）；「不限」由流程隐式提供（子类留空 = 整个一级）
  categoryTree: [
    { name: '玩具乐器', children: ['玩具', '乐器及配件'] },
    { name: '服饰内衣', children: ['服装'] },
    { name: '个护家清', children: ['个人护理', '家清纸品'] },
    { name: '智能家居', children: ['五金/工具', '电子/电工', '家具', '家装灯饰光源', '家装建材', '居家日用', '汽车用品', '整车及配件', '摩托车/电动车/自行...', '餐饮厨具'] },
    { name: '生鲜', children: ['水果蔬菜', '海鲜水产', '肉禽蛋品', '冷冻/冷藏制品'] },
    { name: '美妆', children: ['彩妆香水'] },
    { name: '母婴宠物', children: ['宠物生活', '母婴用品'] },
    { name: '鲜花园艺', children: ['农资园艺'] },
    { name: '本地生活', children: ['文娱', '通讯充值', '本地生活服务', '教育培训'] },
    { name: '食品饮料', children: ['休闲食品', '水饮冲调', '粮油干货/方便速食'] },
    { name: '3C数码家电', children: ['元器件', '办公设备及耗材', '电器', '3C数码及配件'] },
    { name: '图书教育', children: ['文教文化用品', '书籍/杂志/报纸'] },
    { name: '鞋靴箱包', children: ['鞋靴', '箱包'] },
    { name: '虚拟充值', children: ['有价券'] },
    { name: '运动户外', children: ['运动休闲用品', '户外装备'] },
    { name: '钟表配饰', children: ['钟表眼镜', '时尚饰品'] },
    { name: '珠宝文玩', children: ['文玩收藏', '民俗工艺/非遗', '黄金珠宝玉石', '工艺品'] },
    { name: '医疗健康', children: ['医疗器械及保健用品', '药品'] },
    { name: '酒类', children: ['酒类'] },
    { name: '滋补保健', children: ['传统滋补', '营养保健/特医食品'] },
    { name: '原料包装', children: ['工业品'] },
    { name: '餐饮外卖', children: [] }
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
  finderTypes: ['全部带货者', '直播带货者', '短视频带货者', '公众号带货者'],
  finderCategories: [
    '文玩文创', '珠宝首饰', '家纺', '运动户外', '母婴', '家用电器', '数码', '鞋靴',
    '家庭清洁/纸品', '箱包皮具', '个人护理', '食品饮料', '生鲜', '家居日用', '家具',
    '酒类', '钟表', '图书', '保健食品/膳食营养补充食品', '服饰内衣', '家装建材', '美妆护肤',
    '汽车电动', '玩具乐器', '教育培训', '农资园艺', '宠物生活', '成人用品', '酒旅', '餐饮',
    '电脑、办公', '手机通讯', '厨具', '其他'
  ],
  finderOtherFilters: ['可开发票', '有联系方式'],
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
    dialogMarker: '确认发送邀约',
    detail: '详情',
    inviteEntry: '邀请带货',
    // 实测（2026-09-15 真机）：同一详情页上，可邀约的显示「邀请带货」，
    // 不可邀约的显示「暂未到达合作门槛」（悬浮说明「成为热招品牌 / 店铺需满足店铺评分行业前30%」）。
    // 广场列表里约 1/4 是这种——不区分会一直重试同一位，整单空转。
    notInvitable: '暂未到达合作门槛'
  },
  dailyQuotaHint: '每日 200 次邀请额度',
  quota: { textIncludes: '今日剩余', min: 1 }
}

/**
 * 快手小店（快手快分销「达人广场」，2026-09-15 真机实测）。
 *
 * 与抖店同属"批量勾选流"，但锚点与交互差异较大，逐条都是从真实登录态页面上量出来的：
 *  - 入口在**另一个站点**：cps.kwaixiaodian.com（分销后台），不是 s.kwaixiaodian.com（商家后台）；
 *  - 筛选区分 4 行（内容标签 / 带货类目 / 带货数据 / 合作信息），每行是一个 .row 容器，
 *    行内首列是 label。**行之间文案会重名**（"达人信息"既是行标签也是表格表头），
 *    所以类目/合作的点击必须限定在对应 .row 里（同抖店思路）；
 *  - 带货类目是**下拉级联**：点 chip 开下拉（实测「个护家清」→ 全部/个护仪器/假发/…），
 *    必须再点一个叶子项（「全部」= 不限子类）才真正生效；生效判据是行内出现
 *    「已选N个 个护家清: 清空」（实测锚点，比抖店的「已筛选」好认）；
 *  - **勾选数是硬门槛**：只勾 1 位点「批量邀约」静默无反应，勾 2 位才开抽屉（实测）；
 *  - 行复选框：input.kwaishop-...-checkbox-input，label 是 .checkbox-wrapper；
 *    JS 点 label 即可生效（与微信不同，快手吃合成 click）；
 *  - 抽屉「带货邀约」：底部有**明示额度**「今日剩余100条发送邀请机会」；
 *    带货描述 textarea（占位「请输入带货描述，最多可输入500个汉字。」）；
 *    联系人/手机号/微信号三个必填输入（平台会**记住上次填的**，面板预填只作覆盖用）；
 *    合作标签是 6 个复选框（免费申样/可聊高佣/素材支持/支持投流/24h发货/可破价）；
 *  - 商品：需点「选择商品」开**弹窗**，在里面勾商品行 → 点「确 认」（实测文案带空格
 *    「确 认」，引擎已支持去空格匹配）→ 回到抽屉，商品计数变「已选择商品数：1/10」；
 *  - 平台把按钮文案拆进子 span 并拉字距（「确 认」「重 置」「查 询」），元素的自有文本为空——
 *    引擎为此加了"规范化 innerText"兜底匹配（见 task-runner 的 PICK_SORT_FN 注释）。
 */
const KUAISHOU_BATCH: BatchInviteProfile = {
  platform: '快手小店',
  pageUrl: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro',
  flow: 'batch-list',
  // 平台没在页面标出单批上限；抽屉底部明示「今日剩余100条发送邀请机会」。
  // 取 100 = 一天的额度，避免一轮就把额度打满（真要跑满就多轮）。
  maxBatch: 100,
  // 实测：只勾 1 位点「批量邀约」没有任何反应，2 位才打开抽屉
  minSelect: 2,
  scriptMaxLen: 500,
  maxProducts: 10,
  categoryLabelText: '带货类目',
  // 实测「带货类目」18 项 + 各自子类（2026-09-15 逐个点开量取，见 wx-invite-test/ks-category-tree.json）
  categories: [
    '零食饮料', '家居百货', '女装女鞋', '美妆护肤', '个护家清', '营养健康', '母婴玩具', '生鲜食品',
    '男装男鞋', '运动户外', '数码家电', '珠宝文玩', '茶叶酒水', '箱包配饰', '图书学习', '花宠园艺',
    '童装童鞋', '内衣裤袜'
  ],
  categoryTree: [
    { name: '零食饮料', children: ['乳品饮料', '冲调饮品', '南北干货', '卤味肉干', '坚果炒货', '方便速食', '果干蜜饯', '糖巧克力', '面包糕点', '饼干膨化'] },
    { name: '家居百货', children: ['五金机电', '家具', '家居家纺', '家装软饰', '床上用品', '收纳整理', '汽车用品', '生活日用', '餐厨用具', '驱虫用品'] },
    { name: '女装女鞋', children: ['上衣', '中老年', '外套', '大码女装', '套装', '女鞋', '裙子', '裤子'] },
    { name: '美妆护肤', children: ['唇彩口红', '男士用品', '眼部护理', '美发用品', '美妆工具', '美妆香水', '美甲美睫', '防晒必备', '面部护肤', '面部色彩'] },
    { name: '个护家清', children: ['个护仪器', '假发', '口腔护理', '女性护理', '家用清洁', '洗发护发', '纸品湿巾', '衣物清洁', '身体护理', '身体清洁'] },
    { name: '营养健康', children: ['传统滋补', '保健品', '养生用品', '参类滋补', '燕窝阿胶', '膳食补充', '蜂蜜', '隐形眼镜', '食疗滋补', '鹿茸灵芝'] },
    { name: '母婴玩具', children: ['奶粉', '婴儿服饰', '婴儿用品', '孕妇专用', '早教学习', '益智玩具', '纸尿裤', '辅食营养'] },
    { name: '生鲜食品', children: ['冷冻食品', '月饼', '水果', '海鲜水产', '烘焙原料', '米面杂粮', '肉蛋制品', '蔬菜', '调味品', '食用油'] },
    { name: '男装男鞋', children: ['上衣', '中老年', '外套', '大码男装', '男士套装', '男士毛衣', '男鞋', '裤装'] },
    { name: '运动户外', children: ['体育用品', '健身训练', '垂钓装备', '户外服装', '户外照明', '户外装备', '户外鞋靴', '旅行出游', '运动服', '运动鞋'] },
    { name: '数码家电', children: ['二手数码', '厨房电器', '家用电器', '影音摄像', '手机/配件', '数码配件', '智能设备', '生活电器', '电子教育', '电脑办公'] },
    { name: '珠宝文玩', children: ['书画收藏', '古董文玩', '水晶宝石', '珍珠', '翡翠玉石', '黄金'] },
    { name: '茶叶酒水', children: ['养生茶', '啤酒', '国产白酒', '果酒', '洋酒', '粮食酒', '花果茶', '茶具', '茶叶', '葡萄酒'] },
    { name: '箱包配饰', children: ['功能箱包', '发饰', '女士包袋', '帽子围巾', '打火机', '流行首饰', '男士包袋', '眼镜'] },
    { name: '图书学习', children: ['书包', '作业辅导', '图书', '学习用品', '画具画材'] },
    { name: '花宠园艺', children: ['主粮饲料', '农林牧渔', '园艺用品', '宠物用品', '生活鲜花', '绿植盆栽', '美容清洁', '花草种子', '观赏宠物', '零食营养'] },
    { name: '童装童鞋', children: ['亲子装', '休闲服饰', '儿童服配', '儿童裤子', '儿童配饰', '内衣裤袜', '家居服', '户外运动', '礼服制服', '童鞋'] },
    { name: '内衣裤袜', children: ['保暖内衣', '内裤', '女士内衣', '家居服', '袜子'] }
  ],
  /**
   * 内容标签行（快手特有）。与「带货类目」是两回事：
   * 内容标签描述达人的**内容方向**（三农/美妆/美食…），带货类目是他的**货品方向**。
   * 两者可以同时筛（平台就是这么设计的四行筛选）。
   */
  extraFilterRows: [
    {
      label: '内容标签',
      climb: 2,
      options: [
        '三农', '二次元', '亲子', '随手拍', '生活', '穿搭', '美妆', '美食', '旅游', '健康',
        '游戏', '情感', '资讯', '颜值', '运动', '高新数码', '动物', '汽车', '音乐', '影视和短剧',
        '法律', '才艺', '明星娱乐', '军事', '教育', '宗教', '读书', '房产家居', '摄影', '舞蹈',
        '搞笑', '财经', '星座命理', '奇人异象', '科学', '历史', '其他'
      ]
    },
    {
      label: '合作信息',
      climb: 2,
      options: ['有联系方式', '无坑位费', '招商中达人', '专属推荐']
    }
  ],
  benefitsLabelText: '合作标签',
  // 快手**没有「达人等级」筛选**（LV0 是达人自身属性，不是可筛条件）→ 置空，
  // 面板/步骤据此不渲染也不点击等级区（见 invite-steps.ts 的 levelTrigger 判断）。
  levels: [],
  levelsWithQuotaHint: [],
  // 抽屉里的合作标签（6 个复选框，实测；页面提示最多 5 个）
  benefits: ['免费申样', '可聊高佣', '素材支持', '支持投流', '24h发货', '可破价'],
  rowCheckboxSelector: 'tbody input[type=checkbox]',
  scriptSelector: 'textarea',
  // 四行的行容器类名**完全相同**（.kwaishop-cps-daren-match-pc-row），选择器区分不了，
  // 所以用「行标签 + 上溯层数」定位（LABEL → DIV.col → DIV.row，climb=2）
  categoryChipScope: { text: '带货类目', climb: 2 },
  // 类目下拉（点开后才存在）
  categoryPopoverSelector: '.kwaishop-cps-daren-match-pc-select-dropdown',
  // 抽屉里的必填联系方式（实测三项都是必填，label 带 required 类）
  contactSelectors: {
    contact: 'input[placeholder*="常用联系人称呼"]',
    phone: 'input[placeholder*="常用11位手机号"]',
    wechat: 'input[placeholder*="常用微信号"]'
  },
  goodsSourceSelector: '',
  texts: {
    // 快手没有"达人等级"下拉；留空表示面板不渲染该行
    levelTrigger: '',
    // 快手**没有独立的「搜索」按钮**：关键词是输入框（回车生效），而筛选靠点 chip 即时生效。
    // 留空 = 不生成"点搜索"的步骤（真机彩排实测：按文案找「搜索」必然失败）。
    search: '',
    batchInvite: '批量邀约',
    confirmSend: '发送邀请',
    // 抽屉里没有"确认发送"这类禁用态按钮可预检（页面明示额度代替）
    drawerConfirm: '',
    categoryLabel: '带货类目',
    categoryAnyLeaf: '全部',
    // 生效判据（实测）：行内出现「已选1个 个护家清: 清空」
    filteredMarker: '已选',
    /**
     * 发送后平台用来**告知失败**的文案（实测「部分邀约发送失败」）。
     * 出现它就说明这一批没发出去——发送流程会在 waitForGone 之前断言它缺席。
     * 为什么必须读它：快手在发送失败时会**故意留着抽屉**（让你调整后重试），
     * 于是"抽屉没关"既可能是失败、也可能只是平台还在处理，区分不出来。
     */
    sendRejectedMarker: '部分邀约发送失败'
  },
  // 那条标记整段都是子元素（自身无文本节点）→ 必须按选择器定位（见 filteredScope 说明）
  filteredScope: '.kwaishop-cps-daren-match-pc-pro-tagForm-result',
  quotaNote: '快手抽屉底部明示「今日剩余N条发送邀请机会」，额度为 0 时如实停止（不会硬发）',
  quotaCheck: 'requireQuota',
  quota: { textIncludes: '今日剩余', min: 1, optional: false },
  goodsModal: {
    rootSelector: '.kwaishop-cps-daren-match-pc-modal-body',
    /**
     * 抽屉里打开商品弹窗的**按钮**文案：实测「选择商品」（蓝底，紧挨「已选择商品数：0/100」）。
     * 注意页面里另有一个「添加商品」——那是**空态里的提示按钮**，点它同样能开弹窗，
     * 但「选择商品」是常驻的入口，更稳（商品列表非空时「添加商品」就不在了）。
     */
    addText: '选择商品',
    /**
     * 弹窗内商品行复选框的选择器。实测弹窗里确实有 `<tbody>`（7 行、6 个复选框），
     * 所以按 tbody 限定即可，表头的"全选"天然被排除在外。仍额外给 skipSelector（见步骤构造）
     * 作为第二道保险——表头复选框列若被平台改到 tbody 里也不至于被当成商品。
     */
    rowCheckboxSelector: '.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]',
    searchSelector: '.kwaishop-cps-daren-match-pc-modal-body input[placeholder="请输入"]',
    searchText: '查 询',
    confirmText: '确 认',
    /**
     * 抽屉里"已选商品数"的文案锚点（实测「已选择商品数：0/100」）。
     * 选完商品后用它**校验商品真的挂上去了**——比"等弹窗消失"可靠：
     * 弹窗的隐藏方式平台会改，而"选了几个商品"才是我们真正关心的结果。
     */
    selectedMarker: '已选择商品数'
  },
  /**
   * 点「发送邀请」后平台弹出的**「邀约提示」**复核弹窗（2026-09-15 真机实测）。
   *
   * 它逐条列出"这个商品与该达人的要求不匹配"的项目（实测见过两类）：
   *   · 佣金率低于达人下限30%
   *   · 商家体验分低于达人设置下限
   * 底部按钮是「返回调整 / **继续发送邀约**」。**不点它，抽屉永远不关**——
   * 实测整轮卡在 waitForGone 直到 180s 超时，一次真实发送被记成失败，平台侧一条都没发出去。
   *
   * 该弹窗只在"商品与这位达人的要求不匹配"时出现（同一批里换一位达人可能就不弹），
   * 所以用 clickIfPresent：出现就点、没出现就跳过。旧版实测文案是「确认」，一并保留。
   */
  postSendConfirmTexts: ['继续发送邀约', '确认'],
  // 实测该弹窗可能较晚才渲染出来（商品校验是异步的），等久一点再判定"没弹"
  postSendGoneTimeoutMs: 180000
}

/** 已实现的平台档案（每个平台流程独立；后续按平台扩展只需在此追加） */
export const INVITE_PROFILES: Readonly<Record<string, InviteProfile>> = {
  [DOUDIAN.platform]: DOUDIAN,
  [WEIXIN.platform]: WEIXIN,
  [KUAISHOU_BATCH.platform]: KUAISHOU_BATCH
}

/** 已支持达人邀约的平台名（供界面如实展示） */
export const INVITE_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(INVITE_PROFILES)

/** 取某店铺平台的档案；未实现的平台返回 null（界面据此明确拒绝，不猜测） */
export function inviteProfileFor(platformName: string | null | undefined): InviteProfile | null {
  if (!platformName) return null
  return INVITE_PROFILES[platformName] || null
}
