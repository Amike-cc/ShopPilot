import { normalizeCellText as normalizeCellTextBase } from '../text-match'

/**
 * 发票中心「平台档案」（抓取各平台**待开票信息**用）
 *
 * 数据从哪来：本应用没有平台官方 API，只能从各平台后台的发票/开票页面读取——
 * 走既有的「任务 readTable + 快照」机制，发票中心按店铺汇总展示。
 *
 * 红线（与其他平台适配层一致）：**锚点必须实测**。这里登记的每条都写清了实测日期与实测到的表结构。
 * 未实测的平台/页面不要登记假锚点——界面会如实说明"该平台暂无可读取的发票页"，而不是拿猜的选择器去试。
 *
 * 实测记录（2026-09-14，真实登录态店铺）：
 *  - 微信小店：/shop/bill/home「发票中心」；页签「可开票 / 已开票 / 开票记录」；
 *    汇总「可开票 ¥41.50 / 已开票 ¥0.00」；数据表表头 = 账单号 | 账单日期 | 账单类型 | 可开金额 | 账单信息
 *  - 拼多多：/invoice/center「订单开票」；表头 = 订单号 | 订单状态 | 售后状态 | 申请时间 | 发票金额 |
 *    开票方式 | 发票种类 | 发票类型 | 抬头类型 | 发票抬头 | 企业税号 | 其他信息 | 发票邮寄地址 | 承诺开票时间 | 操作
 *  - 抖店：/ffa/m-invoice/merchant-invoice「我给平台开票」；表头 = 账单名称 | 账单类型 | 收票方主体 | 账单总额
 *  - 快手小店：**未找到可读取的发票页**（后台整页无「发票」入口，资金类路径均重定向回后台首页）→ 不登记
 */

/** 发票中心统一展示的列（各平台能提供的字段映射到这些列；缺失的显示"—"） */
export const INVOICE_COLUMNS = [
  { key: 'id', label: '单号/账单号' },
  { key: 'period', label: '期间/申请时间' },
  { key: 'type', label: '类型' },
  { key: 'amount', label: '可开金额' },
  { key: 'title', label: '发票抬头/收票方' },
  { key: 'taxNo', label: '税号' },
  { key: 'status', label: '状态' },
  { key: 'deadline', label: '承诺/到期' }
] as const

export type InvoiceColumnKey = (typeof INVOICE_COLUMNS)[number]['key']

/**
 * 一个「开票方向」（页签）= 一套表头映射。
 *
 * 为什么要分方向：实测同一发票页上「给平台开票 / 给买家开票 / 申请平台开票」是**不同的数据**——
 * 微信小店实测：「申请平台开票」5 条（账单号*+技术服务费），而「给平台开票」另有 2 条
 * （账单号 B*、用户补贴、待处理）。只抓默认页签会漏掉另一个方向的全部记录。
 */
export interface InvoiceSection {
  /** 方向名（平台自己的叫法，界面直接显示；如「给平台开票」） */
  name: string
  /**
   * 抓该方向前要点的页签文案。**为空 = 页面默认就停在这个方向**（实测微信默认在「申请平台开票」）。
   * 注意：页面上可能有同名非页签元素（实测微信有个y≈167 的 DIV），所以点击走 JS 逐级 click
   * （见 invoice-steps.ts 的注释），而不是按文案坐标点。
   */
  tabText?: string
  /**
   * 页签点击的**查找范围**限定（`clickByText.within`）。
   * 实测动机：页签文案在页面上常有同名副本（教程文案、标题），限定到页签容器里点才准。
   */
  tabWithin?: { selector: string; climb?: number }
  /**
   * 点完校验页签**真的选中了**（`clickByText.verifyActive`）。
   *
   * 为什么必须有：平台常有一批**表头完全相同**的页签（实测快手发票页「处理中」与
   * 「处理记录」列名一致）。切页签静默失败时读回的是上一个页签的数据，而按表头做的
   * `expectHeaders`/`rejectHeaders` 对这种情况完全看不出来——校验选中态才拦得住。
   */
  tabVerify?: { selector: string; classIncludes: string; deep?: boolean }
  /**
   * 该方向的页**不在**平台的默认发票页上，而在另一个地址（实测拼多多：
   * 「给平台开票」在资金中心 cashier.pinduoduo.com/main/invoice，而「给买家开票」在
   * mms.pinduoduo.com/invoice/center，两者是不同站点）。给了它就先导航过去再读。
   */
  pageUrl?: string
  /**
   * 非表格方向：该方向的信息以"标签 + 邻近文本"成对呈现，而不是一张表（实测拼多多资金中心
   * 「提交发票」页：待开票金额（元） 421.40 / 收票主体 上海寻梦信息技术有限公司 /
   * 账单日期 2026年05/06/07/08月）。给了它就逐个标签读值，拼成该方向的**一行**。
   */
  labels?: { label: string; key: InvoiceColumnKey }[]
  /**
   * **重复卡片列表**方向：一张账单一张卡、页面**没有 `<table>`**（实测拼多多资金中心
   * 「申请发票」：10 张待开票账单卡片，含 5657.37 / 287.81 等金额，开票主体是平台自己的公司）。
   *
   * 与 `labels` 的区别：`labels` 是**单张卡**读成一行（`readLabelValue` 只取最短的那一个匹配）；
   * `cards` 会把**每一张卡**读成一行。类名带构建哈希（`BusItem_topTitle__3bA_R`）→ 以文案为锚。
   */
  cards?: {
    /** 卡片锚点标签：**每张卡各出现一次**的那个标签（实测「账单日期」） */
    anchor: string
    /** 卡内字段：key = 统一列 key，label = 卡上的标签文案（必须原样，含全角括号） */
    fields: { key: InvoiceColumnKey; label: string }[]
    maxValueLen?: number
  }
  /** 该方向数据表的表头特征（表内须含该文案），用于多张表中挑对一张。labels 模式不需要 */
  pickByHeader?: string
  /** 表头与数据分属两个 <table>（实测拼多多：table[0] 只有表头行）→ 读表时把下一张一并合并 */
  mergeHeaderTable?: boolean
  /**
   * 读到含这些列名的表就**不采信**，按"该方向没数据"处理。
   *
   * 为什么需要它：切页签失败时，页面上留着的还是**上一个方向**的表。若该方向恰好没有自己的表
   * （实测微信「给买家开票」整页无表），这一步就会把上一个方向的数据当成它的上报——
   * 界面里出现两份一模一样、却挂着不同方向名的记录，是最危险的静默错误。
   * 而微信「给平台开票」的表头带「处理状态」（其他方向都没有），正好可以当判据。
   * 与 emptyOk 配套用：命中 rejectHeaders 只是"这不是我的表"，不是报错。
   */
  rejectHeaders?: string[]
  /** 表头文案 → 统一列 key（实测的表头文案） */
  headerMap: Record<string, InvoiceColumnKey>
  /** 该方向的快照指标名前缀（实际落库为 `<metricPrefix>.<序号>`，一个方向一条，互不覆盖） */
  metricKey: string
  /** 该方向实测到的条数（写档案里，便于日后对比"是不是抓漏了"） */
  measuredRows: number
  /**
   * 该方向是否还有**商家侧待办**。默认 true。
   *
   * 为什么要这个标记：同一页的某些方向是**已提交/已办完**的流水，商家这边没有待办动作
   * （实测快手发票页：「处理中」= 已提交等平台审核、「处理记录」= 已审核通过）。
   * 把它们算进"待开票条数/可开金额合计"，合计就虚高了——界面必须只对真正待办的求和，
   * 这类方向照常展示、但单独标注且不计入。
   */
  pending?: boolean
  /**
   * `pending: false` 时展示给用户的**原因**（如实写清这一页是什么状态）。
   * 不写就用界面的通用兜底文案。
   */
  notPendingNote?: string
}

/**
 * 一个平台的发票页档案（**可含多个开票方向**）。
 * 抓取做法：navigate → waitForPage → 逐个方向（切页签 → readTable 读整表落快照）。
 * 表头映射用**列名文案**（平台改版时列名通常会保留，比 CSS 哈希稳），映射不到的列进 extras。
 */
export interface InvoiceProfile {
  platform: string
  /** 发票页地址（实测） */
  pageUrl: string
  /** waitForPage 就绪判据（URL 片段） */
  urlMarker: string
  /** 数据表选择器 */
  tableSelector: string
  /** 整页在 ShadowRoot 内需要穿透（微信小店） */
  deep?: boolean
  /** 读表前额外等待（页面异步取数） */
  settleMs?: number
  /**
   * **预热刷新**：该平台的页面第一次加载渲染不出来，reload 一次才正常。
   *
   * 实测抖店发票页（`/ffa/m-invoice/merchant-invoice`，2026-10-14）：首次加载内容区**永久停在
   * 「加载中...」**——等 45 秒仍然 0 个 `<table>`，而它的接口全是 `0000` 成功
   * （`merchant/scenes` 38KB、`subject/list` 拿到主体、`shop/status`、`record/statusMap`）。
   * 刷新一次**立刻出表**（1 张表 / 160 行）。
   *
   * 为什么：那页是独立的发票微前端（`invoice_merchant`），它初始化时要订阅抖店外壳的 userInfo，
   * 首次加载拿不到那个流就不 resolve（实测 `window._yylx_user` / `_yylx_workbench` 都是 undefined）。
   * 不刷新的话采集必然卡在 readTable 超时——实测报 `TASK_SELECTOR_CHANGED: 超时未出现元素 table`，
   * 四个方向全变 0 条。
   */
  warmReload?: boolean
  /**
   * 读表步骤的等待上限（毫秒，默认 30000）。
   *
   * 为什么可配：有的页面**渲染得极慢**。实测抖店发票页（2026-10-14 逐秒采样）：
   * 视口正常（1054×757、visible）、接口全 `0000` 成功，但表格要到**约 45 秒**才出现
   * （40 秒时还是 0 个 table + 「加载中」，45 秒时 1 张表）。默认 30 秒的 readTable
   * 加上前置等待约 41 秒，**刚好差一点**——于是整轮采集报
   * `TASK_SELECTOR_CHANGED: 超时未出现元素 table`，四个方向全变 0 条。
   */
  readTimeoutMs?: number
  /**
   * 读表期间**挂调试器 + 强制焦点模拟**（unthrottle），把渲染从后台节流里拉出来。
   *
   * 实测（2026-10-14 抖店发票页）：该页是独立微前端，采集时渲染被节流饿死——
   * 挂上 CDP 调试器的场景 45 秒就出表（1 张表 / 160 行），不挂的采集任务等满 90 秒
   * 仍然 0 个 `<table>`。应用自己的 `setBackgroundThrottling(false)` 对普通表格够用，
   * 对这个微前端不够。只对确实需要的平台打开（挂调试器期间外部探针连不上该 webview）。
   */
  unthrottle?: boolean
  /** 切方向后额外等待（页内重渲染 + 重新取数） */
  tabSettleMs?: number
  /** 实测日期 */
  measuredAt: string
  /** 该平台有哪些开票方向（实测） */
  sections: InvoiceSection[]
  /** 界面备注（口径/边界，如实写） */
  note?: string
}

const WEIXIN: InvoiceProfile = {
  platform: '微信小店',
  pageUrl: 'https://store.weixin.qq.com/shop/bill/home',
  urlMarker: 'bill/home',
  // 实测该页有多张 table（两张是日历），数据表以表头含「账单号」区分；
  // deep：整页在 micro-app 的 ShadowRoot 内
  tableSelector: 'table',
  deep: true,
  // 实测：页面加载后**默认就停在「申请平台开票」**（该页签选中、数据表已在），故该方向 tabText 留空。
  settleMs: 8000,
  // 切方向后要等页内重渲染 + 重新取数（实测 10s 内稳定）
  tabSettleMs: 10000,
  measuredAt: '2026-09-14',
  sections: [
    {
      name: '申请平台开票',
      // 默认方向，不需要点击
      pickByHeader: '账单号',
      headerMap: { 账单号: 'id', 账单日期: 'period', 账单类型: 'type', 可开金额: 'amount' },
      metricKey: 'invoice.applyPlatform',
      measuredRows: 5
    },
    {
      name: '给平台开票',
      tabText: '给平台开票',
      // 2026-10-14 实测（真机 CDP 读到页签 DOM）：三个页签是同一个父容器里的 span，
      // 父容器 class 含 `h-[56px]` + `mt-[32px]`；**选中态的 span 带 `text-[#0AB8A6]`**（未选中的是 `cursor-pointer ml-[40px]`）。
      // 为什么必须校验选中态：本方向的表头与「申请平台开票」几乎一样，切不动就会张冠李戴地读到上一个方向的数据。
      // deep: true —— 实测切到这个方向后，页签与表格一起进了 micro-app 的 ShadowRoot，
      // document 级选择器一个都看不到（照旧写法会把"切成功了"误报成"没切成功"）。
      // **不加 tabWithin**：实测（2026-10-14 真机）给这个页签加限定范围后点击不再生效
      // （校验如实报「申请平台开票(选中)…」，即真的没切过去），而不限定范围时「给平台开票」在整页
      // 只有 1 个候选、trusted-mouse 点击有效——限定范围在这里只会帮倒忙。
      tabVerify: { selector: '[class*="h-[56px]"][class*="mt-[32px]"] span', classIncludes: 'text-[#0AB8A6]', deep: true },
      pickByHeader: '账单号',
      // 该方向多出「处理状态」「操作」两列（实测），状态映射到 status
      headerMap: { 账单号: 'id', 账单日期: 'period', 账单类型: 'type', 可开金额: 'amount', 处理状态: 'status' },
      metricKey: 'invoice.toPlatform',
      measuredRows: 2
    },
    {
      name: '给买家开票',
      tabText: '给买家开票',
      tabVerify: { selector: '[class*="h-[56px]"][class*="mt-[32px]"] span', classIncludes: 'text-[#0AB8A6]', deep: true },
      pickByHeader: '账单号',
      headerMap: { 账单号: 'id', 账单日期: 'period', 账单类型: 'type', 可开金额: 'amount' },
      metricKey: 'invoice.toBuyer',
      // 实测该方向下没有账单列表（表都没有）→ 0 条；仍保留方向，抓到就展示、抓不到如实标 0
      measuredRows: 0,
      // 「给买家开票」自己没有表，而它的前一个方向「给平台开票」的表头带「处理状态」——
      // 切页签若没生效就会把那张表读成本方向的数据（方向名不同、内容却完全一样）。
      // 用这个列名把那种情况挡掉：识别为"不是本方向的表"，落 0 条。
      rejectHeaders: ['处理状态']
    }
  ],
  note: '三个方向各自独立取数（实测「申请平台开票」与「给平台开票」数据不同）：申请平台开票 / 给平台开票 / 给买家开票。另：2026-10-14 起「给平台开票 / 给买家开票」两个页签带选中态校验（实测选中类名 text-[#0AB8A6]）——以前切页签失败会静默读到上一个方向的数据。**2026-10-14 更正**：该页其实是**四个**方向，不是三个——第四个是「**收佣金发票**」（实测四个页签都带 `cursor-pointer`，选中的那个带 `text-[#0AB8A6]`）。它的内容是**配置表单**（发票抬头 / 开票地址 / 期望发票类型 / 期望发票税率 + 《收佣金发票协议》），**没有账单列表**，所以没有可采集的数据行；本方向的「平台给商家开票」数据在 **「申请平台开票」** 里（已采到）。上一版这里写"该页只有三个方向、没有平台给我开票"是**看漏了第 4 个页签**，已更正。'
}

const PINDUODUO: InvoiceProfile = {
  platform: '拼多多',
  pageUrl: 'https://mms.pinduoduo.com/invoice/center',
  urlMarker: 'invoice/center',
  tableSelector: 'table',
  settleMs: 7000,
  tabSettleMs: 8000,
  measuredAt: '2026-09-14',
  sections: [
    {
      // 拼多多的「订单开票」就是买家向商家申请开票 → 即「给买家开票」
      name: '给买家开票（订单开票）',
      pickByHeader: '订单号',
      mergeHeaderTable: true,
      headerMap: {
        订单号: 'id',
        申请时间: 'period',
        发票类型: 'type',
        发票金额: 'amount',
        发票抬头: 'title',
        企业税号: 'taxNo',
        订单状态: 'status',
        承诺开票时间: 'deadline'
      },
      metricKey: 'invoice.toBuyer',
      measuredRows: 3
    },
    {
      // 「给平台开票」在**资金中心**（另一个站点），不在本页——实测 2026-09-14：
      // https://cashier.pinduoduo.com/main/invoice 的「提交发票」页给出待开票金额与收票主体。
      // 该页是"标签 + 邻近文本"的卡片，不是表格 → 用 labels 模式读。
      name: '给平台开票（资金中心）',
      pageUrl: 'https://mms.pinduoduo.com/cashier/finance/invoice',
      // 该页默认停在「申请发票」（只有说明文字，没有数据），要切到「提交发票」才有待开票金额
      tabText: '提交发票',
      labels: [
        // 实测文案（含全角括号），必须原样写才匹配得上
        { label: '账单日期', key: 'period' },
        { label: '待开票金额（元）', key: 'amount' },
        { label: '收票主体', key: 'title' }
      ],
      headerMap: {},
      metricKey: 'invoice.toPlatform',
      measuredRows: 1
    },
    {
      /**
       * 拼多多的「**平台给商家开票**」待办金额（2026-10-14 实测）。
       *
       * 这是资金中心「发票管理」的**默认页签**，内容是**一串 div 卡片**（不是表格）：
       * 实测 10 张，例如
       *   `账单日期 2026年01/04/05/06月 | 待开票金额（元） 5657.37 | 开票主体 上海寻梦信息技术有限公司`
       *   `账单日期 2026年09月          | 待开票金额（元） 287.81  | 开票主体 上海禹璨信息技术有限公司`
       * 「开票主体」是**平台自己的公司**——所以这就是"平台给商家开票"的待办金额。
       *
       * 用 cards 模式读（类名带构建哈希 `BusItem_topTitle__3bA_R`，不能写死选择器；
       * 而 readLabelValue 只取最短的那一个匹配、读不了列表 —— 见 InvoiceSection.cards）。
       */
      name: '申请发票（平台给商家开票）',
      pageUrl: 'https://mms.pinduoduo.com/cashier/finance/invoice',
      tabText: '申请发票',
      headerMap: {},
      cards: {
        // 锚点：每张卡各出现一次的那个标签
        anchor: '账单日期',
        fields: [
          { key: 'period', label: '账单日期' },
          // 全角括号必须原样写，否则匹配不上
          { key: 'amount', label: '待开票金额（元）' },
          { key: 'title', label: '开票主体' }
        ],
        // 账单日期那一格可能很长（实测有一张横跨 2021–2026 十几个月份）
        maxValueLen: 160
      },
      metricKey: 'invoice.platformToMePending',
      measuredRows: 10
    },
    {
      /**
       * 拼多多的「**平台给商家开票**」这一向（**2026-10-14 更正**：上一版这里写"该店没有这一向"是错的）。
       *
       * 实测同页（资金中心「发票管理」）四个页签：申请发票 / 申请记录 / 提交发票 / 提交记录。
       *  - 「申请记录」是一张**标准表格**（表头实测：发票金额（元）/ 账单日期·订单号 / 申请时间 /
       *    发票抬头 / 发票类型 / 状态 / 操作），就是"商家申请平台给开票"的记录 → 本方向。
       *    实测时 0 条（还没申请过），但表头与结构都在，能采。
       *  - 「申请发票」是**待开票账单卡片**（实测多张：待开票金额 5657.37 / 287.81 / 0.02 / -1045.57…，
       *    开票主体是平台自己的公司「上海寻梦信息技术有限公司」「上海禹璨信息技术有限公司」）——
       *    那才是待办金额，但它是 **div 卡片列表、不是表格**，类名还带构建哈希
       *    （`BusItem_topTitle__3bA_R`），按项目红线不能写死；引擎现有的 readLabelValue 只取
       *    **最短的那一个**匹配（`cands[0]`），读不了这种重复卡片列表。→ 卡片数据**暂未采集**，
       *    要等一个"重复卡片列表"的读取能力。
       */
      name: '申请记录（平台给商家开票）',
      // 与上一个方向同页（资金中心发票管理），只是切页签
      pageUrl: 'https://mms.pinduoduo.com/cashier/finance/invoice',
      tabText: '申请记录',
      pickByHeader: '发票金额（元）',
      headerMap: {
        '发票金额（元）': 'amount',
        '账单日期/订单号': 'id',
        申请时间: 'period',
        发票抬头: 'title',
        发票类型: 'type',
        状态: 'status'
      },
      metricKey: 'invoice.platformToMe',
      // 记录类，不是待办（商家无需再操作）
      pending: false,
      notPendingNote: '已提交的开票申请记录，商家无需再操作；待办金额看同页「申请发票」',
      measuredRows: 0
    }
  ],
  note: '「订单开票」即买家向商家发起的开票申请（给买家开票）：订单号 / 申请时间 / 发票金额 / 发票抬头 / 企业税号 / 订单状态 / 承诺开票时间（含逾期天数）。「给平台开票」在资金中心（另一个站点），页面上是卡片不是表格，取的是账单日期 / 待开票金额 / 收票主体。**2026-10-14 更正**：该店**有**「平台给商家开票」这一向，叫「**申请发票 / 申请记录**」（已登记「申请记录」为表格方向）；上一版写"没有这一向"是看漏了页签语义——资金中心发票管理四个页签里，申请发票（商家申请平台开票，卡片）/ 申请记录（申请记录，表格）就是平台给商家开票，提交发票 / 提交记录才是商家给平台开票。'
}

const DOUDIAN: InvoiceProfile = {
  platform: '抖店',
  pageUrl: 'https://fxg.jinritemai.com/ffa/m-invoice/merchant-invoice',
  urlMarker: 'merchant-invoice',
  tableSelector: 'table',
  // 2026-10-14：该页首次加载渲染不出来（内容区永久「加载中...」，接口却全成功），
  // 必须预热刷新一次才出表 —— 见 InvoiceProfile.warmReload 的实测记录。
  warmReload: true,
  // 逐秒采样实测：刷新后要 **约 45 秒** 表格才出现（40 秒时仍 0 个 table）。
  // 默认 30 秒刚好差一点 → 四个方向全 0 条。给到 90 秒留足余量。
  readTimeoutMs: 90000,
  // 渲染被节流饿死：不挂调试器时等满 90 秒也不出表，挂了 45 秒就出（实测 2026-10-14）
  unthrottle: true,
  settleMs: 8000,
  tabSettleMs: 10000,
  measuredAt: '2026-10-14',
  // 实测（2026-09-14 真机）：该页有**四个**方向，不是两个——
  //   我给平台开票（默认，1 条）/ 给消费者开票 / 平台给我开票（38 行）/ 达人给我开票（无表）
  // 前两个回应"给平台开票 / 给买家开票"的诉求；后两个是页面本来就有的方向，一并如实采集。
  sections: [
    {
      // 页面默认停在「我给平台开票」
      name: '我给平台开票',
      pickByHeader: '账单名称',
      headerMap: { 账单名称: 'id', 账单类型: 'type', 收票方主体: 'title', 账单总额: 'amount' },
      metricKey: 'invoice.toPlatform',
      measuredRows: 1,
      // 同页还有个「平台给我开票」，表头只差一个字（收票方主体 / 开票方主体）——
      // 切页签没生效时用它挡住，避免两个方向显示成同一批数据
      rejectHeaders: ['开票方主体']
    },
    {
      name: '给消费者开票',
      tabText: '给消费者开票',
      pickByHeader: '订单信息',
      // 实测表头（2026-09-14 真机；此前这里登记的是**猜的**拼多多式列名，已按实测改正）：
      // 订单信息 | 发票类型 | 发票抬头/税号 | 开票金额 | 申请时间 | 订单状态 | 开票状态 |
      // 最晚开票时间 | 开票完成时间 | 操作
      headerMap: {
        订单信息: 'id',
        发票类型: 'type',
        开票金额: 'amount',
        申请时间: 'period',
        订单状态: 'status',
        最晚开票时间: 'deadline',
        // 该平台把抬头与税号合成一列，统一列里没有对应项 → 映射到抬头（税号随该列一起展示在抬头里），
        // 宁可在抬头里带出税号，也不要因为"拆不开"把这一列整列丢掉
        '发票抬头/税号': 'title'
      },
      metricKey: 'invoice.toBuyer',
      // 实测该方向当前 0 条（表在、表头在，只是没有申请）
      measuredRows: 0,
      rejectHeaders: ['账单名称']
    },
    {
      // 平台开给商家的票（账单名称/账单类型/开票方主体/账单金额）——实测 38 行，同一页的第三个方向
      name: '平台给我开票',
      tabText: '平台给我开票',
      pickByHeader: '账单名称',
      headerMap: { 账单名称: 'id', 账单类型: 'type', 开票方主体: 'title', 账单金额: 'amount' },
      metricKey: 'invoice.fromPlatform',
      // 实测 37 条数据行（表内 tr 共 38，含表头）
      measuredRows: 37,
      rejectHeaders: ['收票方主体']
    },
    {
      // 达人开给商家的票——实测该方向整页没有表（页面只有标题，无数据表）
      name: '达人给我开票',
      tabText: '达人给我开票',
      pickByHeader: '账单名称',
      headerMap: { 账单名称: 'id', 账单类型: 'type', 达人主体: 'title', 账单金额: 'amount' },
      metricKey: 'invoice.fromDaren',
      measuredRows: 0,
      // 该方向没表；若切页签没生效，读到的一定是邻居（含「账单名称」+「收票方主体」或「开票方主体」）
      rejectHeaders: ['收票方主体', '开票方主体', '订单信息']
    }
  ],
  note: '四个方向各自独立取数：我给平台开票（默认，待开票账单）/ 给消费者开票（给买家开票）/ 平台给我开票 / 达人给我开票。「给消费者开票」的抬头与税号在平台上是同一列，统一列里放在「发票抬头/收票方」并带出税号。'
}

const KUAISHOU: InvoiceProfile = {
  platform: '快手小店',
  // 实测路径：后台「资金」→「给平台开票」→「未开票账单」（菜单需先滚进视口才点得到）
  pageUrl: 'https://s.kwaixiaodian.com/zone/fund/tax-bill/subsidy',
  urlMarker: 'tax-bill/subsidy',
  tableSelector: 'table',
  settleMs: 9000,
  tabSettleMs: 8000,
  measuredAt: '2026-09-14',
  // 实测（2026-09-14 真机，ant-tabs 三个页签）：
  //   未开票账单（默认，5 条）/ 处理中（0 条）/ 处理记录（3 条）
  // 「处理中」与「处理记录」**表头完全相同**（流水单号/账单编号/…/状态/操作）——
  // 切页签静默失败时表头校验完全看不出来，必须靠 tabVerify 校验选中态（见该字段说明）。
  sections: [
    {
      name: '给平台开票（未开票账单）',
      pickByHeader: '账单编号',
      headerMap: {
        '账单编号': 'id',
        '账单月份': 'period',
        '账单类型': 'type',
        '账单金额（元）': 'amount',
        '开票主体名称': 'title'
        // **不要把「阈值生效时间」映射成 deadline**（2026-10-15 审查 BUG 修复）。
        // 实测它的值是 `2026-06-10(预计)` / `2026-05-10(预计)` —— 那是**账单/阈值的预计生效日期**，
        // 不是"承诺开票时间"。以前映射成 deadline，界面按"过去的日期 = 已逾期"判，
        // 于是一批正常账单被算成**假的已逾期**（实测 5 条），KPI 上写着「5 条已逾期」，
        // 会把商家推去催一批根本没到期的单子。现在它落进「其他信息」照常展示，不参与逾期判定。
      },
      metricKey: 'invoice.toPlatform',
      measuredRows: 5
    },
    {
      name: '开票处理中',
      tabText: '处理中',
      // 页签容器限定：页面上有同名文案的标题/教程，限定到 .ant-tabs-tab-btn 里点才准
      tabWithin: { selector: '.ant-tabs-tab-btn' },
      tabVerify: { selector: '.ant-tabs-tab', classIncludes: 'ant-tabs-tab-active' },
      pickByHeader: '流水单号',
      headerMap: {
        '流水单号': 'id',
        '账单月份': 'period',
        '账单金额（元）': 'amount',
        '发票类型': 'type',
        '状态': 'status'
      },
      metricKey: 'invoice.processing',
      measuredRows: 0,
      // 已提交、等平台审核——商家这边没有待办动作，不计入"待开票"
      pending: false,
      notPendingNote: '已提交、等平台审核的流水，商家无需再操作'
    },
    {
      name: '开票处理记录',
      tabText: '处理记录',
      tabWithin: { selector: '.ant-tabs-tab-btn' },
      tabVerify: { selector: '.ant-tabs-tab', classIncludes: 'ant-tabs-tab-active' },
      pickByHeader: '流水单号',
      headerMap: {
        '流水单号': 'id',
        '账单月份': 'period',
        '账单金额（元）': 'amount',
        '发票类型': 'type',
        '状态': 'status'
      },
      metricKey: 'invoice.records',
      measuredRows: 3,
      // 实测里面是「审核通过」的流水（已办完）→ 展示但不计入待开票
      pending: false,
      notPendingNote: '已提交并通过审核的记录，商家无需再操作'
    },
    {
      /**
       * **达人给我开票**（2026-10-14 实测）。
       *
       * 为什么会有这一条：查「快手有没有平台给我开票」时，从前端包的路由表里挖出
       * `kwaishop-seller-fund-tax-bill-pc` 的全部子路由，发现**整个包里只有一条**
       * 含「给我开票」的路由 —— 就是这条（`/seller-issue-invoice`，菜单文案
       * 「达人/MCN给我开票」）；**没有**「平台给我开票」。既然这条是真实存在的收票方向，
       * 就如实登记（与抖店的「达人给我开票」同类）。
       *
       * 表头实测：账单ID / 账单月份 / 账单类型 / 收票方主体 / 收票方二级商户号 /
       * 开票方 / 开票方主体 / 账单金额（元）/ 冻结金额（元）/ 操作 —— 前三列之外都是"其他信息"。
       */
      name: '达人给我开票（未开票账单）',
      // 这是**另一个页面**，不在 /subsidy 上
      pageUrl: 'https://s.kwaixiaodian.com/zone/fund/tax-bill/seller-issue-invoice',
      pickByHeader: '账单ID',
      headerMap: {
        账单ID: 'id',
        账单月份: 'period',
        账单类型: 'type',
        收票方主体: 'title',
        '账单金额（元）': 'amount'
      },
      metricKey: 'invoice.talentToMe',
      // 实测当前这家店 0 条（表格在、暂无数据）
      measuredRows: 0
    }
  ],
  note: '取「给平台开票」三个页签：未开票账单（账单编号 / 账单月份 / 账单类型 / 账单金额（元）/ 开票主体名称 / 阈值生效时间，阈值金额与收票主体名称进「其他信息」）/ 处理中 / 处理记录（后两者是提交后的核销流水：流水单号 / 账单编号 / 账单月份 / 账单金额 / 发票类型 / 提交时间 / 状态，违约金三项与核销方式进「其他信息」）。**另有一个独立页面「达人给我开票」**（/zone/fund/tax-bill/seller-issue-invoice，已登记为第 4 个方向）。**快手没有「平台给我开票」**：把该模块前端包（`kwaishop-seller-fund-tax-bill-pc`）的路由表全量挖出来后，含「给我开票」的路由**只有** `/seller-issue-invoice`（达人/MCN给我开票）这一条，其余是 `/subsidy` 平台补贴开票页、`/talent-subsidy` 达人补贴开票页、`/self-operated-subsidy` 给自营店开票、`/self-consumer-subsidy` 向消费者开票、`/distributor/invoice-manage` 快手快分销-发票管理、`/pay-later-subsidy` 国补明细管理 —— 全是"商家开出去"，没有平台开给商家的那一向。'
}

export const INVOICE_PROFILES: Readonly<Record<string, InvoiceProfile>> = {
  [WEIXIN.platform]: WEIXIN,
  [PINDUODUO.platform]: PINDUODUO,
  [DOUDIAN.platform]: DOUDIAN,
  [KUAISHOU.platform]: KUAISHOU
}

export function invoiceProfileFor(platformName: string | null | undefined): InvoiceProfile | null {
  if (!platformName) return null
  return INVOICE_PROFILES[platformName] || null
}

/**
 * 自动创建的「发票采集」任务名前缀（**单一事实来源**：认领任务与"不计入任务"都用它）。
 *
 * 两处用途：
 *  ① 认领同一个任务——点一次「采集发票数据」不该新建一个，按这个前缀找到已有的那个，
 *     只把步骤与周期更新上去（否则任务中心会堆一串同名任务，定时更新也只会挂在其中一个上）；
 *  ② **不计入任务**（用户口径）：这是每 3 小时一次的后台刷新，不是用户要管理的活儿。
 *     任务中心的列表与统计、概览「待办任务」卡、任务总数与工具栏任务红点都不把它算成一项任务。
 *
 * 注意：这里**故意不带尾随空格**。历史上生成的任务名是「发票采集 ·微信小店」（中间没有空格，
 * 与「经营指标采集 · 店铺」那种写法并不一致）。改成带空格会让库里已有的任务认不出来：
 * 于是又新建一个同名任务，而旧任务会重新冒到任务中心里。
 */
export const INVOICE_TASK_PREFIX = '发票采集 ·'

/**
 * 这个任务是不是「发票自动采集」任务（只按名称前缀判定）。
 *
 * 传任务对象或只传名字都可以：渲染层手上是 task 对象，主进程 SQL 侧用 `INVOICE_TASK_PREFIX + '%'`。
 * 只认前缀，所以用户自己建的任务只要不占用这个前缀就不受影响。
 */
export function isInvoiceCollectTask(task: { name?: unknown } | string | null | undefined): boolean {
  const name = typeof task === 'string' ? task : String((task as { name?: unknown } | null | undefined)?.name ?? '')
  return name.startsWith(INVOICE_TASK_PREFIX)
}

/**
 * 单元格文本规范化（主进程映射时统一走这里，界面与 CSV 导出共用同一份结果）。
 *
 * 实测踩到的两种脏文本：
 *  ① 同一段文案重复两遍——平台为了响应式/自定义 tooltip 会把同内容渲染两次，
 *     cell.innerText 于是变成 "2026年01月\n\n2026年01月"（快手「处理记录」的账单月份）；
 *  ② 内部换行/多空格——拼多多的订单号带 "\n逾期未开票"，直接展示会把表格撑破。
 *
 * 规则保守：只把**连续空白**压成一个空格，并且只在"整串正好是同一段重复两遍"时才去重，
 * 绝不做模糊的相似度合并（那会把真有重复含义的内容吃掉）。
 * 每半段至少要 2 个字符才判重复——否则「人人」这种叠字内容会被误削成「人」。
 */
export function normalizeCellText(v: unknown): string {
  // P2-1 收敛（2026-10-15 审查）：实现唯一在 @shared/text-match，本域入口只做参数选择——
  // 发票/涉税表格需要"整串重复两遍"折叠（快手「处理记录」的月份被渲染两次）。
  return normalizeCellTextBase(v, { dedupe: true })
}

/** 已实测可抓取待开票信息的平台（供界面如实展示） */
export const INVOICE_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(INVOICE_PROFILES)

/**
 * 该方向算不算"商家待办"（界面合计、导出列、主进程统计、单测都用这一份）。
 *
 * 规则：**pending 缺省为 true**——老数据与未标注的方向按待办算，只有显式 `false` 才排除。
 * 为什么抽出来：这条规则以前在渲染层、主进程、CSV、单测里各写了一遍（`pending === false`
 * / `pending !== false`），改一处就会与其它几处漂移——而它直接决定"待开票条数与金额合计"，
 * 漂移的表现是数字悄悄不对（2026-10-14 审查 P2-7）。
 */
export function isPendingSection(sec: { pending?: boolean } | null | undefined): boolean {
  return sec?.pending !== false
}

/**
 * 表格行清洗（注入到页面脚本里执行的**源码字符串**，见 task-runner 的 readTable）。
 *
 * 平台表格里有两类"不是数据的数据行"，直接当数据会污染发票清单：
 *  ① 重复表头行——表被拆成两张、或表头在 tbody 里重复渲染时，第一行数据位置又是表头文案
 *     （实测抖店「平台给我开票」：第一行被当成了一条"账单名称/账单类型"的记录）；
 *  ② 空态占位行——没数据时平台渲染一行「暂无数据」（实测抖店「给消费者开票」，
 *     被统计成 1 条待开票记录）。
 *
 * 判据只看文案、不看类名：整行都是空态词 → 丢；非首行且 ≥60% 单元格与表头文案相同 → 丢。
 *
 * **第二个参数 `theadLabels`（2026-10-14 加）**：表头文案的**完整词表**，由调用方把
 * `<thead>` 里**每一行**的表头都拼进来。为什么要它——合并表头（colspan）的表有**两行**表头，
 * 第二行是子列名（实测抖店涉税信息报送页：第一行「销售货物取得的收入」跨 3 列，
 * 第二行才是「收入总额 / 退款总额 / 收入净额」）。只拿第一行当词表时，tbody 里那行重复表头
 * 11 个格子只命中 5 个（45%），过不了 60% 阈值 → **被当成一条真实数据**，
 * 界面上会多出一行"金额"全是表头文案的假记录。
 * 不给这个参数就退回"只看第一行"的老行为（没有 thead 的表仍按第一行当表头）。
 *
 * 写成字符串常量是为了能注入页面脚本，同时也让单测能对着**同一份实现**验证。
 */
export const TABLE_ROW_CLEAN_FN = `
  const __cleanRows = (out, theadLabels) => {
    const EMPTY_WORDS = /^(暂无数据|暂无信息|暂无记录|暂无|没有数据|无数据|no ?data|-|—|--)$/i;
    // P2-11：空表/首行不是数组时不要崩——注入脚本抛异常会让整步报一个看不懂的错，
    // 而"表是空的"本来是正常情况（未开票、页面还没渲染完）。
    if (!Array.isArray(out) || !out.length) return [];
    const given = Array.isArray(theadLabels) ? theadLabels : [];
    const source = given.length ? given : (Array.isArray(out[0]) ? out[0] : []);
    const headerLabels = new Set(source.map(x => String(x).trim()).filter(Boolean));
    const looksLikeHeader = (vals) =>
      headerLabels.size > 0 && vals.length > 0 &&
      vals.filter(v => headerLabels.has(v)).length / vals.length >= 0.6;
    return out.filter((row, idx) => {
      if (!Array.isArray(row)) return false;
      const vals = row.map(x => String(x).trim()).filter(Boolean);
      if (!vals.length) return false;
      if (vals.every(v => EMPTY_WORDS.test(v))) return false;
      // 第 0 行是表头本身（读取侧要靠它取列名）→ 永远保留；
      // 其余行只要通篇是表头文案，就是重复表头行（含合并表头的第二行）
      if (idx > 0 && looksLikeHeader(vals)) return false;
      return true;
    });
  };
`

/** 已知但**未实测到可读发票页**的平台（界面如实说明，不给假锚点） */
export const INVOICE_UNSUPPORTED_NOTE: Readonly<Record<string, string>> = {}
