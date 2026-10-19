import { describe, it, expect } from 'vitest'
import {
  INVOICE_COLUMNS, INVOICE_PROFILES, INVOICE_SUPPORTED_PLATFORMS,
  invoiceProfileFor, INVOICE_UNSUPPORTED_NOTE, TABLE_ROW_CLEAN_FN, normalizeCellText, isPendingSection
} from '../../packages/shared/src/constants/invoice'
import { buildInvoiceCollectSteps } from '../../packages/shared/src/invoice-steps'
import { stepInputSchemas } from '../../apps/desktop/src/main/tasks/task-step-schemas'

describe('发票档案（抓取待开票信息用）', () => {
  it('统一列定义稳定（界面表头直接用这份）', () => {
    expect(INVOICE_COLUMNS.map(c => c.key)).toEqual(
      ['id', 'period', 'type', 'amount', 'title', 'taxNo', 'status', 'deadline']
    )
  })

  it('已实测平台都有页地址/就绪判据/表头映射/指标名（缺一项就抓不了）', () => {
    // 平台清单是只读常量（不允许被 sort 原地改写），先拷贝再排序
    expect([...INVOICE_SUPPORTED_PLATFORMS].sort()).toEqual(['微信小店', '抖店', '拼多多', '快手小店'].sort())
    for (const [name, p] of Object.entries(INVOICE_PROFILES)) {
      expect(p.platform, name).toBe(name)
      expect(p.pageUrl).toMatch(/^https:\/\//)
      expect(p.urlMarker.length).toBeGreaterThan(0)
      expect(p.tableSelector.length).toBeGreaterThan(0)
      expect(p.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // 每个方向都要有：名称、独立指标名、实测条数；
      // 且必须是「表格方向」（表头特征 + 列映射）或「卡片方向」（标签列表）之一——
      // 两者都没有就等于这个方向抓不到任何东西（实测拼多多给平台开票就是卡片方向）
      expect(p.sections.length, name).toBeGreaterThan(0)
      const metrics = new Set<string>()
      for (const sec of p.sections) {
        expect(sec.name.length, name).toBeGreaterThan(0)
        expect(sec.metricKey.length, `${name}/${sec.name}`).toBeGreaterThan(0)
        expect(sec.measuredRows, `${name}/${sec.name}`).toBeGreaterThanOrEqual(0)
        const isTable = !!sec.pickByHeader
        const isCard = !!sec.labels?.length
        // 2026-10-14 新增第三种：重复卡片列表（拼多多「申请发票」的待开票账单卡片）
        const isCardList = !!sec.cards?.fields.length
        expect(isTable || isCard || isCardList, `${name}/${sec.name} 三种读取方式一个都没声明，抓不到东西`).toBe(true)
        if (isTable) {
          expect(Object.keys(sec.headerMap).length, `${name}/${sec.name}`).toBeGreaterThan(0)
        }
        if (isCardList) {
          // 卡片模式的锚点与字段必须齐全，否则 readCards 直接判参数不合法
          expect(sec.cards!.anchor.length, `${name}/${sec.name}`).toBeGreaterThan(0)
          for (const f of sec.cards!.fields) {
            expect(f.key.length, `${name}/${sec.name}`).toBeGreaterThan(0)
            expect(f.label.length, `${name}/${sec.name}`).toBeGreaterThan(0)
          }
        }
        // 方向之间的指标名不能重复，否则快照互相覆盖
        expect(metrics.has(sec.metricKey), `${name} 指标名重复 ${sec.metricKey}`).toBe(false)
        metrics.add(sec.metricKey)
        // 映射值必须落在统一列里（表头的与卡片标签的都查）
        const valid = new Set(INVOICE_COLUMNS.map(c => c.key as string))
        for (const [h, k] of Object.entries(sec.headerMap)) {
          expect(valid.has(k as string), `${name}/${sec.name} 表头「${h}」映射到未知列 ${k}`).toBe(true)
        }
        for (const l of sec.labels || []) {
          expect(valid.has(l.key as string), `${name}/${sec.name} 标签「${l.label}」映射到未知列 ${l.key}`).toBe(true)
        }
        // labels 模式的列不能重复（否则同一条快照被两个标签覆盖）
        if (isCard) {
          const keys = (sec.labels || []).map(l => l.key)
          expect(new Set(keys).size, `${name}/${sec.name} 标签映射列重复`).toBe(keys.length)
        }
      }
    }
  })

  it('微信小店按实测登记了 3 个方向（申请平台开票 / 给平台开票 / 给买家开票）', () => {
    const wx = invoiceProfileFor('微信小店')!
    expect(wx.deep).toBe(true)
    const names = wx.sections.map(s => s.name)
    expect(names).toEqual(['申请平台开票', '给平台开票', '给买家开票'])
    // 默认方向不需要点页签；其余方向必须给 tabText
    expect(wx.sections[0].tabText).toBeUndefined()
    expect(wx.sections[1].tabText).toBe('给平台开票')
    expect(wx.sections[2].tabText).toBe('给买家开票')
    // 实测条数写进档案（便于发现"这次抓少了"）
    expect(wx.sections[0].measuredRows).toBe(5)
    expect(wx.sections[1].measuredRows).toBe(2)
    // 指标名互不相同（这就是上一版只抓到一个方向的修法）
    expect(new Set(wx.sections.map(s => s.metricKey)).size).toBe(3)
    // 「给平台开票」多一列「处理状态」
    expect(Object.keys(wx.sections[1].headerMap)).toContain('处理状态')
  })

  it('实测地址被钉住（改地址必须同步确认，否则挂在这里）', () => {
    expect(invoiceProfileFor('微信小店')!.pageUrl).toBe('https://store.weixin.qq.com/shop/bill/home')
    expect(invoiceProfileFor('拼多多')!.pageUrl).toBe('https://mms.pinduoduo.com/invoice/center')
    expect(invoiceProfileFor('抖店')!.pageUrl).toBe('https://fxg.jinritemai.com/ffa/m-invoice/merchant-invoice')
    expect(invoiceProfileFor('快手小店')!.pageUrl).toBe('https://s.kwaixiaodian.com/zone/fund/tax-bill/subsidy')
  })

  it('抖店登记了实测到的四个方向，且「给消费者开票」用的是实测表头（曾误登记为猜的拼多多式列名）', () => {
    const dd = invoiceProfileFor('抖店')!
    expect(dd.sections.map(s => s.name)).toEqual(['我给平台开票', '给消费者开票', '平台给我开票', '达人给我开票'])
    expect(dd.sections[0].tabText).toBeUndefined()          // 默认方向，不用点页签
    expect(dd.sections[1].tabText).toBe('给消费者开票')
    expect(dd.sections[2].tabText).toBe('平台给我开票')
    expect(dd.sections[3].tabText).toBe('达人给我开票')
    // 给消费者开票的实测表头（不是拼多多式的「订单号/企业税号」）
    expect(Object.keys(dd.sections[1].headerMap)).toContain('订单信息')
    expect(Object.keys(dd.sections[1].headerMap)).toContain('开票金额')
    expect(Object.keys(dd.sections[1].headerMap)).not.toContain('订单号')
    expect(Object.keys(dd.sections[1].headerMap)).not.toContain('企业税号')
    // 每个方向独立指标名，互不覆盖
    expect(new Set(dd.sections.map(s => s.metricKey)).size).toBe(4)
    expect(dd.sections.map(s => s.metricKey)).toEqual(
      ['invoice.toPlatform', 'invoice.toBuyer', 'invoice.fromPlatform', 'invoice.fromDaren']
    )
  })

  it('抖店「我给平台开票 / 平台给我开票」互为邻居，靠 rejectHeaders 互相挡（表头只差一个字）', () => {
    const dd = invoiceProfileFor('抖店')!
    // 收票方主体 vs 开票方主体——切页签没生效时用来判定"这不是我的表"
    expect(dd.sections[0].rejectHeaders).toEqual(['开票方主体'])
    expect(dd.sections[2].rejectHeaders).toEqual(['收票方主体'])
    // 无表的方向：读到任何邻居的表都要被挡掉
    expect(dd.sections[3].rejectHeaders).toEqual(expect.arrayContaining(['收票方主体', '开票方主体', '订单信息']))
  })

  it('表头映射用实测的列名（微信 账单号 / 拼多多 订单号 / 抖店 账单名称）', () => {
    expect(Object.keys(invoiceProfileFor('微信小店')!.sections[0].headerMap)).toEqual(
      expect.arrayContaining(['账单号', '账单日期', '账单类型', '可开金额'])
    )
    expect(Object.keys(invoiceProfileFor('拼多多')!.sections[0].headerMap)).toEqual(
      expect.arrayContaining(['订单号', '申请时间', '发票金额', '企业税号', '承诺开票时间'])
    )
    expect(Object.keys(invoiceProfileFor('抖店')!.sections[0].headerMap)).toEqual(
      expect.arrayContaining(['账单名称', '账单类型', '收票方主体', '账单总额'])
    )
  })

  it('快手：给平台开票三个页签 + 独立页面上的「达人给我开票」', () => {
    const ks = invoiceProfileFor('快手小店')!
    expect(ks).toBeTruthy()
    expect(ks.urlMarker).toBe('tax-bill/subsidy')
    expect(ks.sections[0].pickByHeader).toBe('账单编号')
    // 实测表头（含单位后缀，必须按原样写才匹配得上）
    expect(Object.keys(ks.sections[0].headerMap)).toEqual(
      expect.arrayContaining(['账单编号', '账单月份', '账单类型', '账单金额（元）', '开票主体名称'])
    )
    /**
     * 2026-10-15 审查 BUG 防回归：「阈值生效时间」**绝不能**再映射成 deadline。
     * 实测它的值是 `2026-06-10(预计)`（预计生效日期，不是承诺期），映射成 deadline 后
     * 界面按"过去的日期 = 已逾期"判，凭空多出 5 条假逾期（KPI 写着「5 条已逾期」，
     * 会把商家推去催一批根本没到期的单子）。它应当落进「其他信息」。
     */
    expect(Object.keys(ks.sections[0].headerMap)).not.toContain('阈值生效时间')
    expect(Object.values(ks.sections[0].headerMap)).not.toContain('deadline')
    expect(INVOICE_UNSUPPORTED_NOTE['快手小店']).toBeUndefined()
    // 前三个页签：未开票账单（默认）+ 处理中 + 处理记录
    expect(ks.sections.map(s => s.name)).toEqual([
      '给平台开票（未开票账单）', '开票处理中', '开票处理记录',
      // 2026-10-14 新增：另一个页面上的收票方向（路由表挖出来的，实测有表）
      '达人给我开票（未开票账单）'
    ])
    expect(ks.sections[0].tabText).toBeUndefined()          // 默认页签，不用点
    expect(ks.sections.slice(1, 3).map(s => s.tabText)).toEqual(['处理中', '处理记录'])
    expect(new Set(ks.sections.map(s => s.metricKey)).size).toBe(4)
    // 第 4 个方向在**另一个页面**（不是 /subsidy）→ 必须带 pageUrl
    expect(ks.sections[3].pageUrl).toBe('https://s.kwaixiaodian.com/zone/fund/tax-bill/seller-issue-invoice')
    expect(ks.sections[3].pickByHeader).toBe('账单ID')
    expect(Object.keys(ks.sections[3].headerMap)).toEqual(
      expect.arrayContaining(['账单ID', '账单月份', '账单类型', '收票方主体', '账单金额（元）'])
    )
  })

  it('快手的「处理中 / 处理记录」表头完全相同 → 必须靠 tabVerify 校验选中态', () => {
    const ks = invoiceProfileFor('快手小店')!
    const [processing, records] = ks.sections.slice(1, 3)
    // 两页签列名一致，按表头做的 expectHeaders/rejectHeaders 分辨不出谁是谁
    expect(Object.keys(processing.headerMap).sort()).toEqual(Object.keys(records.headerMap).sort())
    // 所以每个要点的页签都得带选中态校验
    for (const sec of ks.sections.slice(1, 3)) {
      expect(sec.tabVerify).toEqual({ selector: '.ant-tabs-tab', classIncludes: 'ant-tabs-tab-active' })
      // 页签文案在页面上有同名副本（教程标题），限定到页签容器里点
      expect(sec.tabWithin).toEqual({ selector: '.ant-tabs-tab-btn' })
    }
    // 步骤里真的带上了这两项
    const clicks = buildInvoiceCollectSteps(ks).filter(s => s.type === 'clickByText')
    expect(clicks.length).toBe(2)
    for (const c of clicks) {
      expect(c.input.verifyActive).toBeTruthy()
      expect(c.input.within).toEqual({ selector: '.ant-tabs-tab-btn' })
      expect(c.input.allowJsWhenDetached).toBe(true)
    }
    // 默认页签（未开票账单）没有 tabVerify 的要求，不该被误加
    expect(ks.sections[0].tabVerify).toBeUndefined()
  })

  // 2026-10-14：微信的两个页签补上选中态校验（实测选中类名 text-[#0AB8A6]）。
  // 此前微信没有任何 tabVerify —— 而「给买家开票」的表头与「给平台开票」几乎相同（只靠 rejectHeaders 挡一刀），
  // 切页签失败就会把上一个方向的数据当成它的上报。这条测试钉住"两个要点的页签都必须校验"。
  it('微信小店「给平台开票 / 给买家开票」也要靠 tabVerify 校验选中态（实测 text-[#0AB8A6]）', () => {
    const wx = invoiceProfileFor('微信小店')!
    expect(wx.sections.map(s => s.tabText)).toEqual([undefined, '给平台开票', '给买家开票'])
    for (const sec of wx.sections.slice(1)) {
      expect(sec.tabVerify, sec.name).toEqual({ selector: '[class*="h-[56px]"][class*="mt-[32px]"] span', classIncludes: 'text-[#0AB8A6]', deep: true })
      // **不要**给微信页签加 tabWithin：实测（2026-10-14 真机）一旦限定范围，点击就不再生效
      // （tabVerify 如实报出「申请平台开票(选中)」= 确实没切过去）；不限定范围时该文案在整页只有 1 个候选。
      expect(sec.tabWithin, sec.name).toBeUndefined()
    }
    expect(wx.sections[0].tabVerify).toBeUndefined()   // 默认方向不用点，也不该校验
    const clicks = buildInvoiceCollectSteps(wx).filter(s => s.type === 'clickByText')
    expect(clicks.length).toBe(2)
    for (const c of clicks) {
      expect(c.input.verifyActive).toBeTruthy()
      // 步骤参数要过引擎白名单（verifyActive 里的选择器含方括号，序列化后不能被判成未知字段）
      expect(stepInputSchemas.clickByText.safeParse(c.input).success, JSON.stringify(c.input)).toBe(true)
    }
  })

  it('快手「处理中 / 处理记录」是**已提交、商家无需操作** → pending:false，不计入待开票合计', () => {
    const ks = invoiceProfileFor('快手小店')!
    // 只有「未开票账单」和「达人给我开票」是待办；中间两个是已提交/已通过、无需商家再操作的流水
    expect(ks.sections.map(s => s.pending)).toEqual([undefined, false, false, undefined])
    // pending:false 的方向必须写清原因（界面 tooltip 直接用，不能是空话）
    for (const sec of ks.sections.slice(1, 3)) {
      expect(sec.notPendingNote, sec.name).toBeTruthy()
      expect(sec.notPendingNote!.length).toBeGreaterThan(4)
    }
    // 待办与否用 shared 的 isPendingSection（渲染层/主进程/CSV/这里同一份规则，P2-7 统一）
    const isPending = isPendingSection
    expect(isPending(ks.sections[0])).toBe(true)
    expect(isPending(ks.sections[1])).toBe(false)
    expect(isPending(ks.sections[2])).toBe(false)
    // 2026-10-14：拼多多的「申请记录（平台给商家开票）」也是**记录类**（商家无需再操作），
    // 与快手的「处理中/处理记录」同一语义 → 同样 pending:false。
    for (const name of ['微信小店', '抖店']) {
      for (const sec of invoiceProfileFor(name)!.sections) {
        expect(sec.pending, `${name}/${sec.name}`).not.toBe(false)
      }
    }
    const pdd = invoiceProfileFor('拼多多')!
    expect(pdd.sections.filter(s => s.pending === false).map(s => s.name))
      .toEqual(['申请记录（平台给商家开票）'])
    // 记录类方向必须带"为什么无需操作"的说明，否则界面上会显示成一句空的灰字
    for (const sec of pdd.sections.filter(s => s.pending === false)) {
      expect(sec.notPendingNote?.length || 0, sec.name).toBeGreaterThan(4)
    }
  })
})

describe('发票金额解析（合计用）', () => {
  // 与渲染层 parseAmount 同一套规则（这里独立实现一份做等价性说明，防止规则被改坏而无人察觉）
  const parse = (v: unknown): number | null => {
    const s = String(v ?? '').replace(/\s*\n\s*/g, ' ').trim()
    if (!s || s === '—' || s === '-') return null
    const m = /-?[\d,]+(?:\.\d+)?/.exec(s.replace(/[¥￥$€\s]/g, ''))
    if (!m) return null
    const n = Number(m[0].replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  it('各平台实测的金额写法都能解析', () => {
    expect(parse('¥14.89')).toBeCloseTo(14.89)
    expect(parse('￥9.49')).toBeCloseTo(9.49)
    expect(parse('2.02')).toBeCloseTo(2.02)
    expect(parse('256.24')).toBeCloseTo(256.24)
    expect(parse('1,234.5')).toBeCloseTo(1234.5)
  })
  it('解析不出的返回 null（绝不当作 0 计入合计）', () => {
    expect(parse('')).toBeNull()
    expect(parse('—')).toBeNull()
    expect(parse('-')).toBeNull()
    expect(parse('暂无')).toBeNull()
  })
  it('金额单元格里的换行不干扰解析', () => {
    expect(parse('¥1.50\n已含税')).toBeCloseTo(1.5)
  })
})

describe('CSV 转义（导出用）', () => {
  // 与主进程导出的 esc 同规则：含逗号/引号/换行加引号，内部引号翻倍
  const esc = (v: unknown) => {
    const s = String(v ?? '')
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  it('普通值不加引号', () => {
    expect(esc('2026年04月')).toBe('2026年04月')
    expect(esc('28351275426')).toBe('28351275426')
  })
  it('含逗号/换行/引号的值被正确转义（拼多多订单号带换行，实测踩过）', () => {
    expect(esc('220630-401819647563847\n逾期未开票')).toBe('"220630-401819647563847\n逾期未开票"')
    expect(esc('a,b')).toBe('"a,b"')
    expect(esc('说"明"')).toBe('"说""明"""')
    expect(esc('账单信息：3笔订单；操作：提交发票')).toBe('账单信息：3笔订单；操作：提交发票')
  })
})

describe('发票采集步骤（多开票方向）', () => {
  it('微信：一条任务覆盖 3 个方向，每个方向一条 readTable 且指标名不同', () => {
    const steps = buildInvoiceCollectSteps(invoiceProfileFor('微信小店')!)
    expect(steps[0].type).toBe('navigate')
    expect(steps[1].type).toBe('waitForPage')
    const reads = steps.filter(s => s.type === 'readTable')
    expect(reads.length).toBe(3)                     // 三个方向各读一次
    const metrics = reads.map(r => r.input.metric)
    expect(new Set(metrics).size).toBe(3)            // 指标名不能重复，否则快照互相覆盖
    expect(metrics).toEqual(['invoice.applyPlatform', 'invoice.toPlatform', 'invoice.toBuyer'])
    for (const r of reads) {
      expect(r.input.keepRows).toBe(true)            // 要整表行，不只是行数
      expect(r.input.deep).toBe(true)                // 微信整页在 shadow 内
      expect(String(r.input.pickByHeader)).toBe('账单号')
      // 方向校验：必须带上该方向的实测列名，切方向失败时如实报错而不是错报
      expect(Array.isArray(r.input.expectHeaders)).toBe(true)
      expect((r.input.expectHeaders as string[]).length).toBeGreaterThan(0)
    }
    // 默认方向不点页签；另外两个方向各点一次（共 2 次 clickByText）
    const clicks = steps.filter(s => s.type === 'clickByText').map(s => s.input.text)
    expect(clicks).toEqual(['给平台开票', '给买家开票'])
    // 「给平台开票」的校验列要含「处理状态」（该方向实测多这一列）
    const toPlatform = reads.find(r => r.input.metric === 'invoice.toPlatform')!
    expect(toPlatform.input.expectHeaders).toContain('处理状态')
    // 允许视图未挂载时降级为 JS 点击：采集是从弹层里发起的，而弹层一开原生视图就被摘，
    // 页面视口变 0×0、受信任鼠标到不了页面（实测每个方向切换都报 TASK_TARGET_COVERED）。
    for (const s of steps.filter(s => s.type === 'clickByText')) {
      expect(s.input.allowJsWhenDetached).toBe(true)
    }
  })

  it('实测 0 条的方向带 emptyOk（本来就没数据，不该把整轮判失败）', () => {
    const reads = buildInvoiceCollectSteps(invoiceProfileFor('微信小店')!).filter(s => s.type === 'readTable')
    const toBuyer = reads.find(r => r.input.metric === 'invoice.toBuyer')!
    expect(toBuyer.input.emptyOk).toBe(true)                 // 实测该方向整页无表
    // 有数据的方向不带 emptyOk：那种情况下挑不到表就是真出问题了，必须如实失败
    expect(reads.find(r => r.input.metric === 'invoice.applyPlatform')!.input.emptyOk).toBeUndefined()
    expect(reads.find(r => r.input.metric === 'invoice.toPlatform')!.input.emptyOk).toBeUndefined()
    const dd = buildInvoiceCollectSteps(invoiceProfileFor('抖店')!).filter(s => s.type === 'readTable')
    expect(dd.find(r => r.input.metric === 'invoice.toBuyer')!.input.emptyOk).toBe(true)
  })

  it('空方向带 rejectHeaders：挡住"上一个方向的表"被当成自己的数据', () => {
    const reads = buildInvoiceCollectSteps(invoiceProfileFor('微信小店')!).filter(s => s.type === 'readTable')
    const toBuyer = reads.find(r => r.input.metric === 'invoice.toBuyer')!
    // 「给买家开票」自己没有表；上一个方向「给平台开票」的表头带「处理状态」
    expect(toBuyer.input.rejectHeaders).toEqual(['处理状态'])
    expect(reads.find(r => r.input.metric === 'invoice.applyPlatform')!.input.rejectHeaders).toBeUndefined()
  })

  it('拼多多四个方向：买家方向读表、给平台开票读卡片标签、平台给商家开票读卡片列表 + 申请记录读表', () => {
    const pdd = invoiceProfileFor('拼多多')!
    expect(pdd.sections[0].mergeHeaderTable).toBe(true)
    const steps = buildInvoiceCollectSteps(pdd)
    const reads = steps.filter(s => s.type === 'readTable')
    // 买家方向（本页）+ 申请记录（资金中心，表格）
    expect(reads.length).toBe(2)
    expect(reads[0].input.mergeHeaderTable).toBe(true)
    expect(reads[0].input.metric).toBe('invoice.toBuyer')
    expect(reads[1].input.metric).toBe('invoice.platformToMe')
    expect(reads[1].input.pickByHeader).toBe('发票金额（元）')
    // 2026-10-14 新增：待开票账单是**重复卡片列表** → readCards（readLabelValue 读不了列表）
    const cardReads = steps.filter(s => s.type === 'readCards')
    expect(cardReads.length).toBe(1)
    expect(cardReads[0].input.metric).toBe('invoice.platformToMePending')
    expect(cardReads[0].input.anchor).toBe('账单日期')
    expect((cardReads[0].input.fields as Array<{ key: string }>).map(f => f.key))
      .toEqual(['period', 'amount', 'title'])
    // 「给平台开票」在资金中心（另一站点）→ 先 navigate 到该方向地址，再切页签，再读标签
    const sec = pdd.sections[1]
    expect(sec.pageUrl).toBeTruthy()
    expect(steps.some(s => s.type === 'navigate' && String(s.input.url) === sec.pageUrl)).toBe(true)
    // 三个页签切换：提交发票（给平台开票）、申请发票（平台给商家开票待办）、申请记录（记录）
    expect(steps.filter(s => s.type === 'clickByText').map(s => s.input.text)).toEqual(['提交发票', '申请发票', '申请记录'])
    const labels = steps.filter(s => s.type === 'readLabelValue')
    expect(labels.map(s => s.input.label)).toEqual(['账单日期', '待开票金额（元）', '收票主体'])
    // 一个标签一条独立快照（metric = `<方向指标>.<统一列key>`），collect 侧据此拼成一行
    expect(labels.map(s => s.input.metric)).toEqual([
      'invoice.toPlatform.period', 'invoice.toPlatform.amount', 'invoice.toPlatform.title'
    ])
  })

  it('抖店：四个方向，默认方向不点、其余三个各点一次页签', () => {
    const steps = buildInvoiceCollectSteps(invoiceProfileFor('抖店')!)
    expect(steps.filter(s => s.type === 'readTable').length).toBe(4)
    expect(steps.filter(s => s.type === 'clickByText').map(s => s.input.text))
      .toEqual(['给消费者开票', '平台给我开票', '达人给我开票'])
  })

  /**
   * 抖店发票页是独立微前端，2026-10-14 实测：**不挂调试器时渲染被节流饿死**——
   * 等满 90 秒仍然 0 个 `<table>`（整轮 106 秒后报 TASK_SELECTOR_CHANGED），
   * 挂上调试器 45 秒就出表（1 张表 / 160 行）。三件事缺一不可：
   * 预热刷新（首次加载永久「加载中」）+ 读表期间 unthrottle + 更长的读表超时。
   */
  it('抖店发票：warmReload + unthrottle + 更长读表超时，三件事缺一不可', () => {
    const p = invoiceProfileFor('抖店')!
    expect(p.warmReload, '首次加载渲染不出来，必须预热刷新').toBe(true)
    expect(p.unthrottle, '渲染被节流饿死，必须挂调试器 + 强制焦点').toBe(true)
    expect(p.readTimeoutMs || 0, '实测要 ~45 秒才出表，默认 30 秒不够').toBeGreaterThan(30000)

    const steps = buildInvoiceCollectSteps(p)
    // 预热刷新 = 开头两次 navigate 到同一地址
    expect(steps.filter(s => s.type === 'navigate').length).toBeGreaterThanOrEqual(2)
    const reads = steps.filter(s => s.type === 'readTable')
    expect(reads.length).toBe(4)
    for (const r of reads) {
      expect(r.input.unthrottle, '每个方向都要 unthrottle').toBe(true)
      expect(r.timeoutMs || 0).toBeGreaterThan(30000)
    }
  })

  it('unthrottle 只对确实需要的平台打开（挂调试器期间外部探针连不上该 webview）', () => {
    for (const name of ['快手小店', '拼多多', '微信小店']) {
      expect(invoiceProfileFor(name)!.unthrottle, name).toBeFalsy()
    }
  })

  it('unthrottle 是 readTable 的合法入参（schema 认它，否则建任务就被拒）', () => {
    const schema = stepInputSchemas.readTable
    expect(schema.safeParse({ selector: 'table', unthrottle: true }).success).toBe(true)
  })

  it('readLabelValue 的 metric 过白名单（写全向量的 metric 里带点号）', () => {
    expect(stepInputSchemas.readLabelValue.safeParse({ label: '待开票金额（元）', metric: 'invoice.toPlatform.amount' }).success).toBe(true)
    expect(stepInputSchemas.readLabelValue.safeParse({ label: 'x', metric: 'y', evil: 1 }).success).toBe(false)
  })

  it('卡片标签用 allowText 读（公司名/「2026年05/06月」这类文本不能被数值抽取截断）', () => {
    const steps = buildInvoiceCollectSteps(invoiceProfileFor('拼多多')!)
    for (const s of steps.filter(s => s.type === 'readLabelValue')) {
      expect(s.input.allowText).toBe(true)
      expect(s.input.maxValueLen).toBeGreaterThanOrEqual(60)   // 得装得下"2026年05/06/07/08月"
    }
    expect(stepInputSchemas.readLabelValue.safeParse({ label: 'x', metric: 'y', allowText: true, maxValueLen: 120 }).success).toBe(true)
  })

  it('切方向后必须等重渲染（tabSettleMs）：点页签的下一步应紧跟 waitMs', () => {
    const steps = buildInvoiceCollectSteps(invoiceProfileFor('微信小店')!)
    steps.forEach((s, i) => {
      if (s.type !== 'clickByText') return
      expect(steps[i + 1].type, `点「${s.input.text}」后应紧跟 waitMs`).toBe('waitMs')
    })
  })

  it('readTable 新增字段过白名单，多余键仍被拒', () => {
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', metric: 'invoice.toPlatform', keepRows: true, pickByHeader: '账单号', mergeHeaderTable: true, expectHeaders: ['账单号', '处理状态'], deep: true }).success).toBe(true)
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', metric: 'x', keepRows: true, expectHeaders: ['a'] }).success).toBe(true)
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', metric: 'invoice.toBuyer', keepRows: true, emptyOk: true, rejectHeaders: ['处理状态'] }).success).toBe(true)
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', keepRows: true, evil: 1 }).success).toBe(false)
    // expectHeaders 数量有上限、元素长度有上限
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', expectHeaders: Array.from({ length: 21 }, (_, i) => 'h' + i) }).success).toBe(false)
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', expectHeaders: ['x'.repeat(61)] }).success).toBe(false)
  })

  it('clickByText 的 allowJsWhenDetached 过白名单（切页签降级用），未知键仍被拒', () => {
    expect(stepInputSchemas.clickByText.safeParse({ text: '给平台开票', mode: 'real', allowJsWhenDetached: true }).success).toBe(true)
    // 默认不开：依赖框架真实输入的按钮不能走 JS 合成点击
    expect(stepInputSchemas.clickByText.safeParse({ text: '给平台开票', mode: 'real' }).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ text: 'x', mode: 'real', evil: 1 }).success).toBe(false)
  })

  it('clickByText 的 verifyActive 过白名单（同名页签必须校验选中态）', () => {
    const ok = { text: '处理中', mode: 'real', allowJsWhenDetached: true, within: { selector: '.ant-tabs-tab-btn' }, verifyActive: { selector: '.ant-tabs-tab', classIncludes: 'ant-tabs-tab-active' } }
    expect(stepInputSchemas.clickByText.safeParse(ok).success).toBe(true)
    expect(stepInputSchemas.clickByText.safeParse({ ...ok, verifyActive: { selector: '.ant-tabs-tab' } }).success).toBe(false)   // 缺 classIncludes
    expect(stepInputSchemas.clickByText.safeParse({ ...ok, verifyActive: { selector: '.ant-tabs-tab', classIncludes: 'x', evil: 1 } }).success).toBe(false)
  })
})

describe('单元格文本规范化（界面显示与 CSV 导出共用同一口径）', () => {
  it('压掉内部换行与多空格（拼多多「订单号」把"逾期未开票"折在下一行）', () => {
    expect(normalizeCellText('220630-401819647563847\n逾期未开票')).toBe('220630-401819647563847 逾期未开票')
    expect(normalizeCellText('  a   b  ')).toBe('a b')
    expect(normalizeCellText('账单信息：3笔订单\n；操作：提交发票')).toBe('账单信息：3笔订单 ；操作：提交发票')
  })

  it('整段重复两遍 → 只留一遍（快手「处理记录」的账单月份被渲染两次）', () => {
    // 实测 2026 年 01 月的行：cell.innerText 是 "2026年01月\n\n2026年01月"
    expect(normalizeCellText('2026年01月\n\n2026年01月')).toBe('2026年01月')
    expect(normalizeCellText('2026年01月 2026年01月')).toBe('2026年01月')
    expect(normalizeCellText('审核通过审核通过')).toBe('审核通过')
  })

  it('正常内容原样保留，不做模糊合并', () => {
    expect(normalizeCellText('2026年05月')).toBe('2026年05月')
    expect(normalizeCellText('¥13.91')).toBe('¥13.91')
    expect(normalizeCellText('')).toBe('')
    expect(normalizeCellText(null)).toBe('')
    expect(normalizeCellText(undefined)).toBe('')
    // 两半不一样就不该动（"2026年01月" vs "2026年02月" 只差一个字）
    expect(normalizeCellText('2026年01月2026年02月')).toBe('2026年01月2026年02月')
    // 内容本身是叠字（如"人人"）也要保留，不能被当成重复——每半段至少 2 字符才判重复
    expect(normalizeCellText('人人')).toBe('人人')
    expect(normalizeCellText('五五')).toBe('五五')
    // 边界：半段正好 2 字符（"5月"重复两遍）仍能去重
    expect(normalizeCellText('5月5月')).toBe('5月')
  })
})

describe('表格行清洗（跑的是注入页面的同一份源码）', () => {
  /** 用 TABLE_ROW_CLEAN_FN 的真实源码跑一遍，避免"单测过了、注入的那份没改" */
  const clean = (rows: string[][]): string[][] => {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${TABLE_ROW_CLEAN_FN}; return __cleanRows;`)()
    return fn(rows)
  }

  it('丢掉重复表头行（实测抖店「平台给我开票」第一行数据位置又是表头文案）', () => {
    const out = clean([
      ['', '账单名称', '账单类型', '开票方主体', '账单金额', '', '操作'],
      ['', '账单名称', '账单类型', '开票方主体', '账单金额', '', '操作'],   // 重复表头
      ['穿山甲电商联盟站外推广费(2026/07)', '穿山甲电商联盟站外推广费', '湖北巨量引擎科技有限公司', '¥4.51', '申请开票']
    ])
    expect(out.length).toBe(2)
    expect(out[0][1]).toBe('账单名称')                       // 真正的表头保留（collect 靠第 0 行取列名）
    expect(out[1][0]).toContain('穿山甲')
  })

  it('丢掉「暂无数据」空态占位行（实测抖店「给消费者开票」被算成 1 条待开票）', () => {
    const out = clean([
      ['订单信息', '发票类型', '开票金额'],
      ['暂无数据', '', '', '']
    ])
    expect(out.length).toBe(1)
    expect(out[0][0]).toBe('订单信息')
  })

  // P2-11（2026-10-14）：空表/首行不是数组时不能抛——注入脚本一抛，整步就报一个看不懂的错，
  // 而"表是空的"（还没渲染完 / 该方向本来没有数据）是正常情况。
  it('空表与畸形输入不抛异常（返回空数组）', () => {
    expect(clean([])).toEqual([])
    expect(clean([[]])).toEqual([])
    // 首行不是数组（页面结构异常）时不崩，且不会把后面的行当成表头判据
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => clean([undefined as any, ['a', 'b']])).not.toThrow()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(clean([null as any, ['a', 'b']])).toEqual([['a', 'b']])
  })

  it('正常数据行原样保留，空行与纯破折号行也要丢', () => {
    const out = clean([
      ['账单号', '可开金额'],
      ['B2000000019095846', '¥13.91'],
      ['', '', ''],
      ['-', '—']
    ])
    expect(out.length).toBe(2)
    expect(out[1]).toEqual(['B2000000019095846', '¥13.91'])
  })
})

describe('重复卡片方向（cards）的空语义（2026-10-15 审查 M1 修复）', () => {
  it('卡片方向一律 emptyOk：待开票账单是队列，清零不能变成采集失败', () => {
    const pdd = invoiceProfileFor('拼多多')!
    const cardsSection = pdd.sections.find(s => !!s.cards?.fields.length)
    expect(cardsSection, '拼多多「申请发票」是卡片方向').toBeTruthy()
    // measuredRows 是"实测那一天的快照"，不决定"这个方向能不能空"——以前只在它为 0 时才允许空
    expect(cardsSection!.measuredRows).toBeGreaterThan(0)
    const steps = buildInvoiceCollectSteps(pdd)
    const cardStep = steps.find(s => s.type === 'readCards' && s.input.metric === cardsSection!.metricKey)
    expect(cardStep, '卡片方向应产出 readCards 步骤').toBeTruthy()
    expect(cardStep!.input.emptyOk).toBe(true)
  })
})
