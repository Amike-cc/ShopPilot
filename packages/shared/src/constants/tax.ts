/**
 * 「涉税信息报送」平台档案（抓取平台按《互联网平台企业涉税信息报送规定》报送的经营数据）。
 *
 * 数据从哪来：平台在后台提供**涉税信息报送**页，逐期列出它报送给税务机关的收入数据。
 * 走既有的「任务 readTable + 快照」机制，界面按店铺汇总展示。
 *
 * 红线（与其他适配层一致）：**锚点必须实测**。未实测的平台不要登记假锚点——
 * 界面会如实说明"该平台尚未实测到可读取的涉税信息报送页"，而不是拿猜的选择器去试。
 *
 * 实测记录（2026-10-14，真机登录态 + CDP 读到真实 DOM）：
 *  - 快手小店：`/zone/fund/accounting/tax-information-submission`（资金 → 账务 → 涉税信息报送）
 *    表格是**表头与数据分属两张 `<table>`**（与拼多多发票页同样的情况，要 mergeHeaderTable）；
 *    表头 10 列：
 *      店铺唯一识别码 | 角色 | 涉税数据所属期 | 主体名称 | 纳税人识别号 |
 *      销售货物取得的收入 | 销售服务取得的收入 | 支付给平台的佣金、服务费金额（元） | 交易订单笔数 | 操作
 *    其中「销售货物/服务取得的收入」这两列**不是单个数字**，单元格里是三段式文本：
 *      `销售货物收入金额 (元): 10183.56 销售货物退款金额 (元): 0.00 销售货物收入净额 (元): 10183.56`
 *    → 用 `parseTaxIncomeCell()`（见 ../tax-income.ts，有单测）拆成 金额/退款/净额 三个数。
 *    页面筛选：涉税年份 / 主体名称 / 角色；另有「导出汇总数据」「导出记录明细」两个**动作按钮**
 *    （点了会在平台侧生成导出任务）——采集**不点**它们。
 *  - 拼多多 / 微信小店：**未实测**到该页，按红线不登记锚点（见 TAX_UNSUPPORTED_NOTE）。
 *  - 抖店：`/ffa/fxg-bill/tax-bill`「涉税信息报送数据」（2026-10-14 实测）。
 *    地址**不是猜的**——左侧导航 10 个分组里没有这个入口，是从抖店自己的接口流量里读出来的
 *    （见 DOUDIAN 上面那段留档）。表头是合并单元格、tbody 里还有重复表头行，两点都与快手不同。
 */

/**
 * 统一展示列。
 *
 * 收入拆成 金额/退款/净额 六列：申报要看的是**净额**，而"收入总额"和"退款"是核对依据——
 * 只有净额一列就没法回答"这个数怎么来的"（平台页面上本身就是三段式给的）。
 */
export const TAX_COLUMNS = [
  { key: 'period', label: '涉税数据所属期' },
  // 平台直接给的「收入净额合计」（实测抖店有这一列；快手没有，界面用货物+服务净额算）
  { key: 'netTotal', label: '收入净额合计' },
  { key: 'subject', label: '主体名称' },
  { key: 'taxNo', label: '纳税人识别号' },
  { key: 'goodsAmount', label: '销售货物收入金额' },
  { key: 'goodsRefund', label: '销售货物退款金额' },
  { key: 'goodsNet', label: '销售货物收入净额' },
  { key: 'serviceAmount', label: '销售服务收入金额' },
  { key: 'serviceRefund', label: '销售服务退款金额' },
  { key: 'serviceNet', label: '销售服务收入净额' },
  { key: 'commission', label: '支付给平台的佣金、服务费' },
  { key: 'orders', label: '交易订单笔数' },
  // 微信小店的口径：接口只给一个「结算金额」和一个「退款金额」，**不分货物/服务**。
  // 不并进「收入净额合计」——那是"货物净额+服务净额"的口径，而 settleAmount 是否等价无从确认
  // （那一页在本环境里渲染不出来，看不到平台自己的中文标签）。宁可分开列，也不硬套。
  { key: 'settleTotal', label: '结算金额' },
  { key: 'refundTotal', label: '退款金额' },
  { key: 'shopCode', label: '店铺唯一识别码' },
  { key: 'role', label: '角色' }
] as const

export type TaxColumnKey = (typeof TAX_COLUMNS)[number]['key']

/**
 * **原始来源键**（不是展示列）。
 *
 * 平台把「销售货物/服务取得的收入」做成三段式文本塞在**一个单元格**里，
 * 采集时整格原样存下来（`goodsIncome` / `serviceIncome`），界面再用
 * `parseTaxIncomeCell()`（../tax-income.ts，有单测）拆成金额/退款/净额三列展示。
 *
 * 为什么单列一份而不是混进 TAX_COLUMNS：
 *  - TAX_COLUMNS 是"屏上会出现的列"，把原始大段文本混进去会多出一列没人看的文本；
 *  - 但 headerMap **必须**映射到这两个键——不映射的话整格内容在采集阶段就被丢了，
 *    净额也就永远拆不出来（静默丢数据，比报错危险）。
 * 单测同时钉住两点：映射的键必须落在「展示列 ∪ 原始键」里，且原始键在界面上真的被解析使用。
 */
export const TAX_RAW_KEYS = ['goodsIncome', 'serviceIncome'] as const

/** 一个采集方向（目前每个平台只有一个：报送汇总表） */
/** 读接口响应时，一个字段怎么取、怎么变成界面文本（与 main/tasks/api-reader.ts 的 ApiFieldSpec 对应） */
export interface TaxApiField {
  key: string
  path: string
  as?: 'text' | 'cents' | 'epochQuarter'
}

/** 该方向没有可读表格，改读页面自己发的接口响应（见 main/tasks/api-reader.ts 的说明） */
export interface TaxApiSource {
  /** 响应 URL 必须包含它 */
  urlMarker: string
  /** 行数组在响应 JSON 里的路径（如 dataList） */
  rowsPath: string
  fields: readonly TaxApiField[]
  /** 抓之前 reload（默认 true）：让页面**自己**重发一次请求 */
  reload?: boolean
  timeoutMs?: number
  maxBytes?: number
}

export interface TaxSection {
  /** 方向名（平台自己的叫法，界面直接显示） */
  name: string
  /** 数据表的表头特征（表内须含该文案），用于多张表中挑对一张 */
  pickByHeader?: string
  /** 表头与数据分属两个 `<table>`（实测快手：table[0] 只有表头行）→ 读表时把下一张一并合并 */
  mergeHeaderTable?: boolean
  /** 表头文案 → 统一列 key（实测的表头文案） */
  headerMap: Record<string, TaxColumnKey | string>
  /** 该方向的快照指标名（落库为 `tax.report`，界面按它取数） */
  metricKey: string
  /**
   * 该表**本来就可能没有数据**（新店还没到报送期）→ 允许空表，落 0 条而不是判失败。
   * 注意：它只放行"表头对得上但没有数据行"的情况；页面改版导致表都找不到时仍会如实报错。
   */
  emptyOk?: boolean
  /**
   * **按列序映射**（可选）。给**表头是合并单元格（colspan）**的表用：这种表的表头行格数与
   * 数据行格数对不上（实测抖店涉税报送页：表头行 7 个 `<th>` 但实际占 11 列、数据行 11 个 `<td>`），
   * 按表头文案对齐会整体错位。
   *
   * 给了它就按 `columns[i]` 映射第 i 个数据格；空串 = 该列忽略（如「操作」按钮列）。
   * ⚠ 列序必须**实测**（打开页面逐格数出来），位置映射比文案映射脆——平台插一列就会整体错位，
   * 所以用它的方向**必须同时给 `headerMap`**，让运行器继续用表头文案校验"读到的还是不是这张表"，
   * 改版时如实失败而不是把错位的数据当上报。
   */
  columns?: readonly string[]
  /**
   * **必填列**：这些列有一格为空，这一行就不算记录（映射后过滤）。
   *
   * 为什么需要：抖店那一页的季度行下面还挂着一行**展开的明细**（「结算明细（实物） 去核对
   * 用户实付 ￥… 政府补贴平台垫资 ￥…」），它的「报送数据时间」是空的——既不是全空行、
   * 也不是表头行，通用清洗规则拦不住它，会被当成一个"金额未解析"的报送期混进统计。
   * 报送期的存在本身就是这条记录的身份，所以按 `period` 必填来挡。
   */
  requireFields?: readonly string[]
  /**
   * 该方向**没有可读的表格**，数据只在页面自己发的接口响应里 → 改读响应（见 main/tasks/api-reader.ts）。
   *
   * 只在读表做不到时才用：接口没有表头文案兜底，平台改字段名就是取不到值，
   * 所以必须靠 `requireFields` 把"读到了但关键列全空"挡成失败，而不是当成"这家没数据"。
   */
  api?: TaxApiSource
  /**
   * ⚠ 刻意**不设** `measuredRows`（发票中心那边的"比实测少"阈值）。
   * 原因：这张表的行数 = 该店已经过了几个报送期，随经营时长增长（实测某店 11 行）。
   * 拿一个固定条数当阈值，会让"经营 3 个月的店"永远显示"比实测少"，把正常情况报成抓漏。
   */
}

export interface TaxProfile {
  platform: string
  /** 涉税信息报送页地址（实测） */
  pageUrl: string
  /** waitForPage 就绪判据（URL 片段） */
  urlMarker: string
  /** 数据表选择器 */
  tableSelector: string
  /** 读表前额外等待（页面异步取数） */
  settleMs?: number
  /** 实测日期 */
  measuredAt: string
  /** 采集方向 */
  sections: TaxSection[]
  /** 界面备注（口径/边界，如实写） */
  note?: string
}

const KUAISHOU: TaxProfile = {
  platform: '快手小店',
  pageUrl: 'https://s.kwaixiaodian.com/zone/fund/accounting/tax-information-submission',
  urlMarker: 'tax-information-submission',
  tableSelector: 'table',
  settleMs: 9000,
  measuredAt: '2026-10-14',
  sections: [
    {
      name: '涉税信息报送汇总',
      pickByHeader: '涉税数据所属期',
      // 实测该页有 2 张 table：#0 只有表头行、#1 才是数据行（第一行还是全空的占位行）
      mergeHeaderTable: true,
      headerMap: {
        '店铺唯一识别码': 'shopCode',
        '角色': 'role',
        '涉税数据所属期': 'period',
        '主体名称': 'subject',
        '纳税人识别号': 'taxNo',
        '销售货物取得的收入': 'goodsIncome',
        '销售服务取得的收入': 'serviceIncome',
        '支付给平台的佣金、服务费金额（元）': 'commission',
        '交易订单笔数': 'orders'
        // 「操作」列刻意不映射：那是「导出明细」按钮，不是数据
      },
      metricKey: 'tax.report',
      // 不要「操作」列，也不收操作按钮行；报送期为空的展开明细行不算记录
      requireFields: ['period'],
      // 新店可能一个报送期都还没过 → 允许空表；表头对不上时仍会如实失败
      emptyOk: true
    }
  ],
  note: '取该页报送汇总表：店铺唯一识别码 / 角色 / 涉税数据所属期 / 主体名称 / 纳税人识别号 / 销售货物取得的收入 / 销售服务取得的收入 / 支付给平台的佣金、服务费金额（元）/ 交易订单笔数。「销售货物/服务取得的收入」在页面上是三段式文本（收入金额 / 退款金额 / 收入净额），采集后拆成三列展示。'
}

/**
 * 抖店「涉税信息报送数据」（**怎么找到这个地址的**，留档免得以后有人以为是猜的）：
 * 2026-10-14 在真机上把这家店的**接口流量**抓下来（`tools/research/find-menu-entry.mjs`），
 * 从抖店自己请求的路径参数里读到 `/ffa/fxg-bill/tax-bill`，以及它的数据接口
 * `bill_center/domestic/shop/query_tax_bill_agg`——**不是靠猜 URL 试出来的**。
 * 左侧导航里没有这个入口（10 个分组全翻过），所以只能这么找。
 *
 * 页面结构（真机实测）与快手**不一样**，两点必须注意：
 *  1. 表头是**合并单元格（colspan）**：第一行 7 个 `<th>`（「销售货物取得的收入」「销售服务取得的收入」
 *     各跨 3 列），第二行才是子列名「收入总额 / 退款总额 / 收入净额」——表头格数与数据行格数对不上
 *     （7 vs 11），所以这个方向用 `columns` **按列序**映射，而不是按表头文案；
 *  2. `tbody` 第一行又是**重复表头**（11 格全是表头文案）。旧清洗规则只拿第一行当词表 → 只命中 5/11（45%）
 *     过不了 60% 阈值、会被当成一条真实数据；为此 TABLE_ROW_CLEAN_FN 改成用 `<thead>` 的**所有**表头行
 *     当词表（见 shared/constants/invoice.ts 的说明）。
 *
 * 页面上还有：选择主体 / 按季度看|按月度看 / 选择时间（默认当前季度）三个筛选器，
 * 以及「每季度首月5号上午10点生成上个季度数据」的口径说明；地址栏会带上
 * `member_id=…&date_type=quarter&tax_time=2026Q3`。采集**不点**「下载明细」。
 */
const DOUDIAN: TaxProfile = {
  platform: '抖店',
  pageUrl: 'https://fxg.jinritemai.com/ffa/fxg-bill/tax-bill',
  urlMarker: 'fxg-bill/tax-bill',
  tableSelector: 'table',
  settleMs: 9000,
  measuredAt: '2026-10-14',
  sections: [
    {
      name: '涉税信息报送数据',
      // 表头校验用（合并表头下按文案对齐会错位，所以只拿它校验"还是不是这张表"，不用它取列）
      pickByHeader: '报送数据时间',
      headerMap: {
        '报送数据时间': 'period',
        '收入净额合计': 'netTotal',
        '销售货物取得的收入': 'goodsAmount',
        '销售服务取得的收入': 'serviceAmount',
        '支付给平台的佣金/服务费总额': 'commission',
        '交易订单笔数(笔)': 'orders'
      },
      // ↓ 真机逐格数出来的列序（11 列）；最后一个是「下载明细」按钮列 → 空串忽略
      columns: [
        'period', 'netTotal',
        'goodsAmount', 'goodsRefund', 'goodsNet',
        'serviceAmount', 'serviceRefund', 'serviceNet',
        'commission', 'orders', ''
      ],
      metricKey: 'tax.report',
      // 报送期为空的展开明细行不算记录（该页季度行下面挂着「结算明细…」那行）
      requireFields: ['period'],
      emptyOk: true
    }
  ],
  note: '取该页报送汇总表：报送数据时间（按季度，形如 2026年第三季度(7-9月)）/ 收入净额合计 / 销售货物取得的收入（收入总额·退款总额·收入净额）/ 销售服务取得的收入（同三段）/ 支付给平台的佣金/服务费总额 / 交易订单笔数。平台口径：每季度首月 5 号上午 10 点生成上个季度数据；第一季度 4 月底前报送、第二季度 7 月底前、第三季度 10 月底前、第四季度次年 1 月底前。'
}

/**
 * 微信小店「涉税账单」——**唯一一个不读表格、改读接口响应的方向**。
 *
 * 怎么找到的：2026-10-14 用户直接给了地址 `/shop/funds/moneyManage?section=5`。
 * 页面**确实在请求数据**（`/shop-faas/mmchannelstradefunds/cgi/listQuarterTax` 返回 200，
 * 带两个季度的结算额/退款额），但它是 `<micro-app>` 微前端，子应用在当前环境里只渲染出外壳
 * （shadow 树 435 个元素、正文 0 字、0 个 `<table>`），**没有表头/列结构可实测**。
 * 数据只在响应体里 → 走 `readApi`（见 main/tasks/api-reader.ts）。
 *
 * 字段映射取自**接口自己的字段名**（页面没渲染，看不到平台的中文标签）：
 *   taxTime → 报送季度（值是**季度末**的秒级时间戳，实测 2026-06-30 / 2026-09-30）
 *   settleAmount → 结算金额   refundAmount → 退款金额   （两者单位都是**分**）
 * 所以列名用的是「结算金额 / 退款金额」，**没有**套成「收入净额合计」——是不是同一个口径无从确认。
 */
const WEIXIN: TaxProfile = {
  platform: '微信小店',
  pageUrl: 'https://store.weixin.qq.com/shop/funds/moneyManage?section=5',
  urlMarker: 'funds/moneyManage',
  // 这个方向不用表格，但档案结构要求给一个选择器；保持一个不会命中的值，避免误读别的表
  tableSelector: 'table.__tax_not_used__',
  settleMs: 6000,
  measuredAt: '2026-10-14',
  sections: [
    {
      name: '涉税账单',
      // 接口没有表头文案，这里只作为"这是什么表"的说明与统一列的口径
      headerMap: { '报送数据时间': 'period', '结算金额': 'settleTotal', '退款金额': 'refundTotal' },
      columns: ['period', 'settleTotal', 'refundTotal'],
      // 报送期为空的记录不算数（`{low:0}` 这种占位行会被这条挡掉）
      requireFields: ['period'],
      metricKey: 'tax.report',
      // 该季度还没生成数据是正常的（平台每季度首月 5 号上午 10 点生成上个季度）
      emptyOk: true,
      api: {
        urlMarker: 'listQuarterTax',
        rowsPath: 'dataList',
        fields: [
          { key: 'period', path: 'taxTime', as: 'epochQuarter' },
          { key: 'settleTotal', path: 'settleAmount', as: 'cents' },
          { key: 'refundTotal', path: 'refundAmount', as: 'cents' }
        ],
        reload: true,
        timeoutMs: 25000
      }
    }
  ],
  note: '微信小店「流水与账单 → 涉税账单」。该页在本环境里渲染不出表格（micro-app 微前端），因此按接口响应读取：listQuarterTax 返回按季度的 taxTime / settleAmount / refundAmount（金额单位：分）。'
}

export const TAX_PROFILES: Readonly<Record<string, TaxProfile>> = {
  [KUAISHOU.platform]: KUAISHOU,
  [DOUDIAN.platform]: DOUDIAN,
  [WEIXIN.platform]: WEIXIN
}

export function taxProfileFor(platformName: string | null | undefined): TaxProfile | null {
  if (!platformName) return null
  return TAX_PROFILES[platformName] || null
}

/** 已实测可抓取涉税信息报送的平台（供界面如实展示） */
export const TAX_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(TAX_PROFILES)

/**
 * 已知但**未实测**该页的平台 → 界面如实说明为什么取不到，而不是显示成"没有数据"。
 *
 * 写法要求（2026-10-14 自纠）：说明里**只写真的查过什么**。
 * 没查过的平台不许写"未找到该入口"——那是把"没找过"说成"找过了没有"，
 * 与假锚点一样是编数据。查过的把日期与查了哪些位置写清楚，别人才能复核。
 */
export const TAX_UNSUPPORTED_NOTE: Readonly<Record<string, string>> = {
  拼多多: '2026-10-14 真机查过（四项都查了）：（1）后台 DOM 全文一个「税」字都没有，资金区只有 账户资金 / 资金中心 / 资金限制 / 发票管理；（2）资金微应用 cashier.pinduoduo.com/main/finance 的接口流量（20 条 JSON）无一处「税」；（3）前端包全文——cashier 11 个 + 主站 34 个——搜「涉税 / 税务申报」零命中；（4）pddFinance:// 深链表里也没有税务相关项。唯一线索是 cashier 包里那张平台应用表里的 DuoduoJinbaoTaxReport（appId duoduo-jinbao-tax-report-pc，entryType: 3），而 entryType 3 对应的是 **DuoduoJinbao（多多金宝）**——它是与 批发 / 咖啡 / 物流平台 / 开放平台 并列的**另一个平台入口**，不是本店所在的拼多多主站。→ 本店在拼多多主站，主站没有面向商家的涉税信息报送页；不登记锚点'
}

/**
 * **平台自己写的用途提示**（原文照录，不转述、不打折）。
 *
 * 为什么必须原样出现在界面上：快手该页明确写了"数据仅可作为您开展业务合作参考依据，
 * **不得作为税务申报、财务审计、监管备案等任何用途使用**"。把这份数据摆到"涉税申报"旁边
 * 却不说这句话，等于引导用户拿它去申报——那是错的，而且错在应用这边。
 * 界面上这条提示与数据同屏显示，用户看到的才是平台的原意。
 */
export const TAX_DATA_DISCLAIMER = '数据仅可作为您开展业务合作参考依据，不得作为税务申报、财务审计、监管备案等任何用途使用。'

/** 平台报送依据（同页原文，界面用来交代这份数据是什么） */
export const TAX_REPORT_BASIS = '《互联网平台企业涉税信息报送规定》（国务院令第810号）：互联网平台企业应当向其主管税务机关报送平台内经营者的身份信息、收入信息等涉税信息，按季度报送。'

/**
 * 自动创建的「涉税报送采集」任务名前缀（单一事实来源：认领任务与"不计入任务"都用它）。
 *
 * 与 INVOICE_TASK_PREFIX 同样的道理：这是**后台刷新**，不是用户要管理的活儿；
 * 且点多次不该堆一串同名任务——按前缀认领同一个。注意这里**不带尾随空格**，
 * 与「发票采集 ·」的历史写法保持一致（带空格会让库里已有的任务认不出来）。
 */
export const TAX_TASK_PREFIX = '涉税报送采集 ·'

/** 这个任务是不是「涉税报送采集」任务（只按名称前缀判定） */
export function isTaxCollectTask(task: { name?: unknown } | string | null | undefined): boolean {
  const name = typeof task === 'string' ? task : String((task as { name?: unknown } | null | undefined)?.name ?? '')
  return name.startsWith(TAX_TASK_PREFIX)
}
