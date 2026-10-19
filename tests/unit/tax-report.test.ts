import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  TAX_COLUMNS, TAX_PROFILES, TAX_SUPPORTED_PLATFORMS, TAX_UNSUPPORTED_NOTE,
  TAX_TASK_PREFIX, TAX_DATA_DISCLAIMER, TAX_RAW_KEYS, isTaxCollectTask, taxProfileFor
} from '../../packages/shared/src/constants/tax'
import { buildTaxCollectSteps } from '../../packages/shared/src/tax-steps'
import { taxAmountText, taxIncomeFromCells, parseTaxIncomeCell, taxPeriodNetTotal } from '../../packages/shared/src/tax-income'
import { TABLE_ROW_CLEAN_FN } from '../../packages/shared/src/constants/invoice'
import { TASK_STEP_TYPES } from '../../packages/shared/src/schemas/task'
// 主进程的读取器：这里直接引用**同一份实现**做单测（它只 type-import electron，运行时不依赖）
import { epochToQuarterText } from '../../apps/desktop/src/main/tasks/api-reader'
import { stepInputSchemas } from '../../apps/desktop/src/main/tasks/task-step-schemas'

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const PAGE = [
  'apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue',
  'apps/desktop/src/renderer/src/features/workbench/use-invoice-detail.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-tax-license.ts',
  'apps/desktop/src/renderer/src/features/workbench/use-data-collection.ts',
].map(p => readFileSync(resolve(p), 'utf8')).join('\n')
const OVERVIEW_SERVICE = read('apps/desktop/src/main/services/overview-service.ts')
const PRELOAD = read('apps/desktop/src/preload/index.ts')
const ENV_DTS = read('apps/desktop/src/renderer/src/env.d.ts')
const IPC_CONTRACT = read('packages/shared/src/contracts/ipc.ts')
const HANDLERS = read('apps/desktop/src/main/ipc/profile-misc-handlers.ts')

/* 真机实测的原始单元格文本（快手「销售货物取得的收入」列），数字用合成值：
   形状必须与实测一致（`标签 (元): 数值` 三段拼在一格里）。 */
const GOODS_CELL = '销售货物收入金额 (元): 1,234.56 销售货物退款金额 (元): 34.56 销售货物收入净额 (元): 1,200.00'
const SERVICE_CELL = '销售服务收入金额 (元): 100.00 销售服务退款金额 (元): 0.00 销售服务收入净额 (元): 100.00'

describe('涉税报送档案（抓取平台报送数据用）', () => {
  it('统一列定义稳定（界面表头直接用这份）', () => {
    expect(TAX_COLUMNS.map(c => c.key)).toEqual([
      'period', 'netTotal', 'subject', 'taxNo',
      'goodsAmount', 'goodsRefund', 'goodsNet',
      'serviceAmount', 'serviceRefund', 'serviceNet',
      'commission', 'orders', 'settleTotal', 'refundTotal',
      'shopCode', 'role'
    ])
  })

  it('已实测平台都有页地址/就绪判据/表头映射/指标名（缺一项就抓不了）', () => {
    expect([...TAX_SUPPORTED_PLATFORMS].sort()).toEqual(['快手小店', '抖店', '微信小店'].sort())
    for (const [name, p] of Object.entries(TAX_PROFILES)) {
      expect(p.platform, name).toBe(name)
      expect(p.pageUrl).toMatch(/^https:\/\//)
      expect(p.urlMarker.length).toBeGreaterThan(0)
      expect(p.tableSelector.length).toBeGreaterThan(0)
      expect(p.measuredAt, `${name} 必须登记实测日期`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(p.sections.length, name).toBeGreaterThan(0)
      const metrics = new Set<string>()
      // 表头只能映射到「展示列」或「原始来源键」——别的键在界面上没人消费，等于把数据丢了
      const valid = new Set<string>([...TAX_COLUMNS.map(c => c.key as string), ...TAX_RAW_KEYS])
      for (const sec of p.sections) {
        expect(sec.name.length).toBeGreaterThan(0)
        // 读接口的方向没有表格、也就没有表头特征（微信小店就是这种）
        if (!sec.api) {
          expect(sec.pickByHeader, `${name}/${sec.name} 没有表头特征就挑不到正确的表`).toBeTruthy()
        }
        expect(Object.keys(sec.headerMap).length).toBeGreaterThan(0)
        // 指标名不能重复，否则快照互相覆盖
        expect(metrics.has(sec.metricKey), `${name} 指标名重复 ${sec.metricKey}`).toBe(false)
        metrics.add(sec.metricKey)
        for (const [h, k] of Object.entries(sec.headerMap)) {
          expect(valid.has(k as string), `${name}/${sec.name} 表头「${h}」映射到未知列 ${k}`).toBe(true)
        }
      }
    }
  })

  it('实测地址被钉住（改地址必须同步确认，否则挂在这里）', () => {
    expect(taxProfileFor('快手小店')!.pageUrl)
      .toBe('https://s.kwaixiaodian.com/zone/fund/accounting/tax-information-submission')
    expect(taxProfileFor('快手小店')!.urlMarker).toBe('tax-information-submission')
  })

  it('表头映射用**实测的列名**（含单位后缀的全角括号，必须原样写才匹配得上）', () => {
    const ks = taxProfileFor('快手小店')!
    expect(Object.keys(ks.sections[0].headerMap)).toEqual([
      '店铺唯一识别码', '角色', '涉税数据所属期', '主体名称', '纳税人识别号',
      '销售货物取得的收入', '销售服务取得的收入', '支付给平台的佣金、服务费金额（元）', '交易订单笔数'
    ])
    // 「操作」列是「导出明细」按钮，不是数据 —— 不该被映射，否则表里多一列按钮文案
    expect(Object.keys(ks.sections[0].headerMap)).not.toContain('操作')
  })

  it('表头与数据分属两张 table → 必须 mergeHeaderTable（实测该页 #0 只有表头行）', () => {
    expect(taxProfileFor('快手小店')!.sections[0].mergeHeaderTable).toBe(true)
    const reads = buildTaxCollectSteps(taxProfileFor('快手小店')!).filter(s => s.type === 'readTable')
    expect(reads[0].input.mergeHeaderTable).toBe(true)
  })

  // 这条是**刻意的设计决定**，不是漏写：这张表的行数 = 该店过了几个报送期，随经营时长增长。
  // 拿一个固定条数当"比实测少"的阈值，会把经营 3 个月的店永远报成抓漏。
  it('刻意不设 measuredRows（行数随经营时长变，不能当抓漏阈值）', () => {
    for (const p of Object.values(TAX_PROFILES)) {
      for (const sec of p.sections) {
        expect(sec, `${p.platform}/${sec.name} 不该有 measuredRows`).not.toHaveProperty('measuredRows')
      }
    }
    // 步骤里也不该冒出 measuredRows（引擎没有这个入参，写了反而过不了白名单）
    for (const s of buildTaxCollectSteps(taxProfileFor('快手小店')!)) {
      expect(s.input, s.type).not.toHaveProperty('measuredRows')
    }
  })

  it('报送期为空的展开明细行不算记录（抖店季度行下面挂着「结算明细…」那行）', () => {
    for (const name of ['快手小店', '抖店']) {
      expect(taxProfileFor(name)!.sections[0].requireFields, name).toEqual(['period'])
    }
    // 主进程真的按它过滤（不是只有档案里写着）
    expect(OVERVIEW_SERVICE).toContain('section.requireFields')
    expect(OVERVIEW_SERVICE).toMatch(/required\.every\(key => String\(item\.cells\[key\]/)
  })

  it('未实测的平台必须逐家给原因（不许显示成"这家没有涉税数据"）', () => {
    for (const name of ['拼多多']) {
      expect(TAX_UNSUPPORTED_NOTE[name], name).toBeTruthy()
      expect(TAX_UNSUPPORTED_NOTE[name].length, name).toBeGreaterThan(8)
      expect(taxProfileFor(name), `${name} 未实测就不该有档案`).toBeNull()
    }
    // 已实测的平台**不许**再留在"未实测说明"里（两边都写会让界面自相矛盾）
    expect(Object.keys(TAX_UNSUPPORTED_NOTE)).not.toContain('抖店')
    expect(Object.keys(TAX_UNSUPPORTED_NOTE)).not.toContain('微信小店')
  })

  /* ---- 微信小店：唯一一个"读接口响应"而不是"读表格"的方向 ---- */
  it('微信小店：声明了 api，且页面上本来就没有可读表格', () => {
    const p = taxProfileFor('微信小店')!
    expect(p.pageUrl).toBe('https://store.weixin.qq.com/shop/funds/moneyManage?section=5')
    expect(p.urlMarker).toBe('funds/moneyManage')
    expect(p.measuredAt).toBe('2026-10-14')
    const sec = p.sections[0]
    expect(sec.api, '没有 api 就退化成读表，读不到任何东西').toBeTruthy()
    expect(sec.api!.urlMarker).toBe('listQuarterTax')
    expect(sec.api!.rowsPath).toBe('dataList')
  })

  it('微信小店：步骤里是 readApi 而不是 readTable（走错步骤会去读一张不存在的表）', () => {
    const types = buildTaxCollectSteps(taxProfileFor('微信小店')!).map(s => s.type)
    expect(types).toEqual(['navigate', 'waitForPage', 'waitMs', 'readApi'])
    expect(types).not.toContain('readTable')
  })

  it('微信小店：字段映射的 key 与统一列、section.columns **完全对齐**（错位就整体读错）', () => {
    const sec = taxProfileFor('微信小店')!.sections[0]
    const keys = sec.api!.fields.map(f => f.key)
    expect(keys).toEqual(['period', 'settleTotal', 'refundTotal'])
    // api-reader 生成的合成表头就是这些 key，又用 columns 按列序映射 → 两者必须一模一样
    expect(sec.columns).toEqual(keys)
    const valid = new Set(TAX_COLUMNS.map(c => c.key as string))
    for (const k of keys) expect(valid.has(k), `未知列 ${k}`).toBe(true)
    // 报送期必须有值：接口没有表头文案兜底，这条是把"字段改名了"挡成失败的唯一防线
    expect(sec.requireFields).toEqual(['period'])
  })

  it('微信小店：金额单位声明为「分」、时间是「季度」（实测值算得对）', () => {
    const fields = taxProfileFor('微信小店')!.sections[0].api!.fields
    expect(fields.find(f => f.key === 'settleTotal')!.as).toBe('cents')
    expect(fields.find(f => f.key === 'refundTotal')!.as).toBe('cents')
    expect(fields.find(f => f.key === 'period')!.as).toBe('epochQuarter')
    // 真机抓到的两个 taxTime（季度末的秒级时间戳）
    expect(epochToQuarterText(1782748800)).toBe('2026年第二季度(4-6月)')
    expect(epochToQuarterText(1790697600)).toBe('2026年第三季度(7-9月)')
    expect(epochToQuarterText(Number.NaN)).toBe('')
  })

  it('readApi 是白名单里的步骤类型（不接受任意代码）', () => {
    expect(TASK_STEP_TYPES).toContain('readApi')
    expect(PAGE).toContain("taxCellOf(item, 'settleTotal')")
    expect(PAGE).toContain("taxCellOf(item, 'refundTotal')")
  })

  // 抖店这一页是 2026-10-14 从**平台自己的接口流量**里找到的（左侧导航 10 个分组里没有入口），
  // 页面结构与快手完全不同：合并表头（colspan）+ tbody 里一行重复表头。
  it('抖店：地址钉住，且不靠猜——记的是从接口流量里读到的那条路由', () => {
    const p = taxProfileFor('抖店')!
    expect(p.pageUrl).toBe('https://fxg.jinritemai.com/ffa/fxg-bill/tax-bill')
    expect(p.urlMarker).toBe('fxg-bill/tax-bill')
    expect(p.measuredAt).toBe('2026-10-14')
  })

  it('抖店：合并表头 → 用 columns 按列序映射，且列序是真机逐格数出来的 11 列', () => {
    const sec = taxProfileFor('抖店')!.sections[0]
    expect(sec.columns).toEqual([
      'period', 'netTotal',
      'goodsAmount', 'goodsRefund', 'goodsNet',
      'serviceAmount', 'serviceRefund', 'serviceNet',
      'commission', 'orders',
      ''                       // 「下载明细」按钮列：明确忽略，不能当数据
    ])
    // 每一列必须落在统一列里（空串除外）——位置映射本来就脆，映射到不存在的列更没人发现
    const valid = new Set(TAX_COLUMNS.map(c => c.key as string))
    for (const key of sec.columns!) {
      if (!key) continue
      expect(valid.has(key), `columns 里有未知列 ${key}`).toBe(true)
    }
    // 用了位置映射就必须**同时**保留表头校验词，否则改版时读错位也发现不了
    expect(Object.keys(taxProfileFor('抖店')!.sections[0].headerMap).length).toBeGreaterThan(0)
    expect(buildTaxCollectSteps(taxProfileFor('抖店')!)[3].input.expectHeaders).toContain('报送数据时间')
  })

  it('抖店：表头校验词用实测文案（合并表头下只拿它校验，不用它取列）', () => {
    const keys = Object.keys(taxProfileFor('抖店')!.sections[0].headerMap)
    expect(keys).toEqual([
      '报送数据时间', '收入净额合计', '销售货物取得的收入', '销售服务取得的收入',
      '支付给平台的佣金/服务费总额', '交易订单笔数(笔)'
    ])
    // 「操作」是「下载明细」按钮列，不是数据
    expect(keys).not.toContain('操作')
  })

  it('原始来源键在界面上**真的被解析使用**（否则等于采回来一堆没人看的文本）', () => {
    expect(TAX_RAW_KEYS).toEqual(['goodsIncome', 'serviceIncome'])
    // 快手那种"一格三段式文本"要拆；抖店那种"三列分开"要直接读 —— 统一走 taxIncomeFromCells
    expect(PAGE).toContain("taxIncomeFromCells(row?.cells, 'goods')")
    expect(PAGE).toContain("taxIncomeFromCells(row?.cells, 'service')")
    // 三段展示列确实都在表头里（拆出来却没人显示 = 白拆）
    for (const label of ['货物收入金额', '货物退款', '货物收入净额', '服务收入金额', '服务退款', '服务收入净额']) {
      expect(PAGE, label).toContain(label)
    }
  })

  it('空档案允许空表（新店还没到报送期），但表头对不上时仍如实失败', () => {
    expect(taxProfileFor('快手小店')!.sections[0].emptyOk).toBe(true)
    const read0 = buildTaxCollectSteps(taxProfileFor('快手小店')!)[3]
    expect(read0.input.emptyOk).toBe(true)
    // emptyOk 只放行"表头对但没有数据行"；expectHeaders 仍在，页面改版照样报错
    expect(read0.input.expectHeaders).toEqual(Object.keys(taxProfileFor('快手小店')!.sections[0].headerMap))
  })
})

describe('涉税报送任务的识别与口径', () => {
  it('前缀就是实际生成的任务名开头', () => {
    expect(TAX_TASK_PREFIX).toBe('涉税报送采集 ·')
    expect(isTaxCollectTask(`${TAX_TASK_PREFIX}快手小店`)).toBe(true)
    expect(isTaxCollectTask({ name: `${TAX_TASK_PREFIX}抖店` })).toBe(true)
  })

  it('只认前缀，不误伤别的任务（尤其发票采集）', () => {
    for (const name of ['发票采集 ·快手小店', '经营指标采集 · 抖店', '商品同步 · 抖店', '涉税信息报送', '']) {
      expect(isTaxCollectTask(name), name).toBe(false)
    }
    expect(isTaxCollectTask(null)).toBe(false)
    expect(isTaxCollectTask(undefined)).toBe(false)
  })

  it('主进程用同一个前缀查"最近一次运行"（前缀只有一处定义）', () => {
    expect(OVERVIEW_SERVICE).toContain('TAX_TASK_PREFIX')
    expect(OVERVIEW_SERVICE).not.toContain("'涉税报送采集 ·%'")
  })
})

describe('平台自己的用途限制（必须与数据同屏）', () => {
  it('免责声明非空，且**明确写着不得作为税务申报依据**', () => {
    expect(TAX_DATA_DISCLAIMER.length).toBeGreaterThan(10)
    expect(TAX_DATA_DISCLAIMER).toContain('不得作为税务申报')
  })

  it('免责声明随接口一起返回（不是只写在常量文件里）', () => {
    expect(OVERVIEW_SERVICE).toContain('TAX_DATA_DISCLAIMER')
    expect(OVERVIEW_SERVICE).toMatch(/disclaimer:\s*TAX_DATA_DISCLAIMER/)
  })

  it('界面把免责声明**渲染在数据旁边**，且不硬编码文案（文案来自主进程）', () => {
    expect(PAGE).toContain('data-test="tax-disclaimer"')
    // 渲染的是接口给的 taxDisclaimer，而不是把句子抄进模板
    expect(PAGE).toContain('{{ taxDisclaimer }}')
    // 抄一份整句出来就会漂移——而这句话是不能漂移的（注释里提到短语没关系，整句不行）
    expect(PAGE).not.toContain(TAX_DATA_DISCLAIMER)
  })
})

describe('涉税报送：IPC 四处齐备', () => {
  it('channel / handler / preload / 类型声明都接了', () => {
    expect(IPC_CONTRACT).toContain("OVERVIEW_TAX_REPORT: 'overview:taxReport'")
    expect(HANDLERS).toContain('IPC_CHANNELS.OVERVIEW_TAX_REPORT')
    expect(HANDLERS).toContain('overviewTaxReport')
    expect(PRELOAD).toContain('IPC_CHANNELS.OVERVIEW_TAX_REPORT')
    expect(ENV_DTS).toContain('taxReport: () => Promise<IPCResult>')
  })

  it('界面用的钩子都在（采集入口 / 数据行 / 明细表 / 逐店失败态）', () => {
    for (const hook of ['tax-report', 'tax-collect', 'tax-row', 'tax-period-row', 'tax-load-failed']) {
      expect(PAGE, hook).toContain(`data-test="${hook}"`)
    }
    // 按店铺动态绑定的钩子（写死一个店名就没法多店用了）
    expect(PAGE).toContain(":data-test=\"'tax-table-' + row.storeId\"")
    expect(PAGE).toContain(":data-test=\"'tax-summary-' + row.storeId\"")
    // 三种"读不到"要分得开：登录失效 / 采集失败 / 平台未实测
    expect(PAGE).toContain("'tax-login-required-' + row.storeId")
    expect(PAGE).toContain("'tax-last-fail-' + row.storeId")
    expect(PAGE).toContain("'tax-unsupported-' + row.storeId")
  })

  it('读取失败不能退化成"没有报送数据"（与发票的 B3 同一条规矩）', () => {
    expect(PAGE).toContain('涉税报送数据读取失败')
    expect(PAGE).toContain('这不等于"没有报送数据"')
  })
})

describe('涉税数据按主体统计（界面）', () => {
  it('默认「按主体统计」，可切回「按店铺」', () => {
    expect(PAGE).toContain("ref<'subject' | 'stores'>('subject')")
    expect(PAGE).toContain('data-test="tax-view-switch"')
    expect(PAGE).toContain('data-test="tax-view-subject"')
    expect(PAGE).toContain('data-test="tax-view-stores"')
  })

  it('归组与合计用 shared 的纯函数（不在界面里另写一份口径）', () => {
    expect(PAGE).toContain('@shared/tax-subject')
    expect(PAGE).toContain('groupTaxPeriodsBySubject')
    expect(PAGE).toContain('taxSubjectTotals')
  })

  it('钩子齐备（合计 / 主体行 / 逐期明细 / 核对结论）', () => {
    for (const hook of ['tax-totals', 'tax-subject-list', 'tax-subject-period']) {
      expect(PAGE, hook).toContain(`data-test="${hook}"`)
    }
    expect(PAGE).toContain("'tax-subject-' + group.key")
    expect(PAGE).toContain("'tax-verdict-' + group.key")
    expect(PAGE).toContain("'tax-subject-toggle-' + group.key")
  })

  it('「未读到主体信息」有明确显示名（不显示成空白行）', () => {
    expect(PAGE).toContain('UNKNOWN_TAX_SUBJECT_LABEL')
    expect(PAGE).toContain('taxSubjectLabel')
  })

  it('营业执照随涉税载荷一起返回（界面才有得核对）', () => {
    // 发票与涉税**两份**载荷都要带这两列（各一处，恰好 2 次）
    const hits = (OVERVIEW_SERVICE.match(/licenseName: normalizeLicenseName\(s\.license_name\)/g) || []).length
    expect(hits, '发票与涉税载荷都要带营业执照').toBe(2)
    expect(PAGE).toContain('taxLicenseVerdictText')
  })
})

describe('收入三段：两种平台形态的统一入口', () => {
  it('快手形态（一格三段式文本）能拆', () => {
    const out = taxIncomeFromCells({ goodsIncome: GOODS_CELL }, 'goods')
    expect(out.amount).toBeCloseTo(1234.56)
    expect(out.refund).toBeCloseTo(34.56)
    expect(out.net).toBeCloseTo(1200)
    expect(out.reconciles).toBe(true)
  })

  it('抖店形态（三列分开）能读', () => {
    const out = taxIncomeFromCells(
      { goodsAmount: '￥1,324.88', goodsRefund: '￥0.00', goodsNet: '￥1,324.88' }, 'goods'
    )
    expect(out.amount).toBeCloseTo(1324.88)
    expect(out.refund).toBeCloseTo(0)
    expect(out.net).toBeCloseTo(1324.88)
    expect(out.reconciles).toBe(true)
  })

  it('抖店形态：三段对不上时如实标出', () => {
    const out = taxIncomeFromCells({ goodsAmount: '100.00', goodsRefund: '0.00', goodsNet: '99.00' }, 'goods')
    expect(out.reconciles).toBe(false)
  })

  it('两种形态都读不到时是「没读到」而不是 0', () => {
    const out = taxIncomeFromCells({}, 'goods')
    expect(out.parsed).toBe(false)
    expect(out.amount).toBeNull()
    expect(out.net).toBeNull()
    expect(taxIncomeFromCells(null, 'service').parsed).toBe(false)
  })

  it('服务口径不会被货物口径的列串读', () => {
    const out = taxIncomeFromCells(
      { goodsAmount: '100.00', goodsNet: '100.00', serviceAmount: '9.00', serviceNet: '9.00' }, 'service'
    )
    expect(out.net).toBeCloseTo(9)
  })
})

describe('合并表头表格的重复表头行（抖店涉税报送页实测形状）', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clean = new Function(`${TABLE_ROW_CLEAN_FN}; return __cleanRows`)() as (rows: any[], thead?: string[]) => any[]
  const thead1 = ['报送数据时间', '收入净额合计', '销售货物取得的收入', '销售服务取得的收入', '支付给平台的佣金/服务费总额', '交易订单笔数(笔)', '操作']
  const thead2 = ['收入总额', '退款总额', '收入净额', '收入总额', '退款总额', '收入净额']
  // tbody 第一行又是表头文案（11 格）
  const dup = ['报送数据时间', '收入净额合计', '收入总额', '退款总额', '收入净额', '收入总额', '退款总额', '收入净额', '支付给平台的佣金/服务费总额', '交易订单笔数(笔)', '操作']
  const data = ['2026年第三季度(7-9月)', '￥1,417.74', '￥1,324.88', '￥0.00', '￥1,324.88', '￥92.86', '￥0.00', '￥92.86', '￥81.65', '54', '下载明细']

  it('只拿第一行表头当词表时，重复表头行**漏过** 60% 阈值（45%）——这就是要传 thead 全表头的原因', () => {
    const out = clean([thead1, thead2, dup, data], thead1)
    expect(out.length, '漏过 → 会被当成一条真实数据').toBe(4)
    expect(out[2]).toEqual(dup)
  })

  it('传 thead 全部表头行后：重复表头行被丢掉、真实数据行保留', () => {
    const out = clean([thead1, thead2, dup, data], [...thead1, ...thead2])
    expect(out.length).toBe(2)            // 表头行本身 + 一条真数据
    expect(out[0]).toEqual(thead1)
    expect(out[1]).toEqual(data)
  })

  it('不传词表时退回老行为（没有 thead 的表仍按第一行当表头）', () => {
    const out = clean([thead1, dup, data])
    expect(out[0]).toEqual(thead1)
    expect(out[out.length - 1]).toEqual(data)
  })
})

describe('收入三段解析（申报看净额，核对看金额与退款）', () => {
  it('实测形状（`标签 (元): 数值` 三段拼在一格）能拆出来', () => {
    const goods = parseTaxIncomeCell(GOODS_CELL, 'goods')
    expect(goods.amount).toBeCloseTo(1234.56)
    expect(goods.refund).toBeCloseTo(34.56)
    expect(goods.net).toBeCloseTo(1200)
    expect(goods.parsed).toBe(true)
    expect(goods.reconciles).toBe(true)   // 1234.56 − 34.56 = 1200.00
  })

  it('服务口径用另一组标签，不会被货物口径串读', () => {
    const service = parseTaxIncomeCell(SERVICE_CELL, 'service')
    expect(service.amount).toBeCloseTo(100)
    expect(service.refund).toBeCloseTo(0)
    expect(service.net).toBeCloseTo(100)
    // 拿货物标签去解服务文本 → 一个都解不出来（而不是解出错的值）
    const wrong = parseTaxIncomeCell(SERVICE_CELL, 'goods')
    expect(wrong.parsed).toBe(false)
    expect(wrong.amount).toBeNull()
  })

  it('解析不出就是 null，绝不当 0', () => {
    for (const v of ['', '   ', '—', '-', '暂无数据', null, undefined]) {
      const out = parseTaxIncomeCell(v, 'goods')
      expect(out.parsed, String(v)).toBe(false)
      expect(out.amount).toBeNull()
      expect(out.net).toBeNull()
    }
  })

  it('三段对不上时如实标出来（平台自己给的数不相等 → 申报前要看见）', () => {
    const bad = parseTaxIncomeCell('销售货物收入金额 (元): 100.00 销售货物退款金额 (元): 0.00 销售货物收入净额 (元): 99.00', 'goods')
    expect(bad.reconciles).toBe(false)
    // 差 1 分钱算四舍五入，不误报
    const rounding = parseTaxIncomeCell('销售货物收入金额 (元): 100.00 销售货物退款金额 (元): 0.01 销售货物收入净额 (元): 99.99', 'goods')
    expect(rounding.reconciles).toBe(true)
  })

  it('期间净额 = 货物净额 + 服务净额；任一段缺失返回 null（不给少算的数）', () => {
    const goods = parseTaxIncomeCell(GOODS_CELL, 'goods')
    const service = parseTaxIncomeCell(SERVICE_CELL, 'service')
    expect(taxPeriodNetTotal(goods, service)).toBeCloseTo(1300)
    const missing = parseTaxIncomeCell('', 'service')
    expect(taxPeriodNetTotal(goods, missing)).toBeNull()
  })

  it('金额展示：解析不出显示「—」，不是 ¥0.00', () => {
    expect(taxAmountText(1200)).toBe('¥1,200.00')
    expect(taxAmountText(0)).toBe('¥0.00')
    expect(taxAmountText(null)).toBe('—')
    expect(taxAmountText(undefined)).toBe('—')
  })
})

describe('涉税报送采集步骤', () => {
  const p = taxProfileFor('快手小店')!

  it('navigate → waitForPage → 等页面取数 → readTable', () => {
    const steps = buildTaxCollectSteps(p)
    expect(steps.map(s => s.type)).toEqual(['navigate', 'waitForPage', 'waitMs', 'readTable'])
    expect(steps[0].input.url).toBe(p.pageUrl)
    expect(steps[1].input.urlIncludes).toBe(p.urlMarker)
    expect(Number(steps[2].input.ms)).toBeGreaterThanOrEqual(3000)
  })

  it('读表带整表行、表头特征与列校验（拼不出这些就等于抓不到）', () => {
    const read0 = buildTaxCollectSteps(p).find(s => s.type === 'readTable')!
    expect(read0.input.selector).toBe(p.tableSelector)
    expect(read0.input.metric).toBe('tax.report')
    expect(read0.input.keepRows).toBe(true)
    expect(read0.input.pickByHeader).toBe('涉税数据所属期')
    expect(read0.input.expectHeaders).toEqual(expect.arrayContaining(['涉税数据所属期', '纳税人识别号']))
  })

  it('步骤参数全部过引擎白名单（多余键会被拒）', () => {
    for (const s of buildTaxCollectSteps(p)) {
      const schema = (stepInputSchemas as Record<string, { safeParse: (v: unknown) => { success: boolean } }>)[s.type]
      expect(schema, `没有 ${s.type} 的白名单`).toBeTruthy()
      expect(schema.safeParse(s.input).success, `${s.type} ${JSON.stringify(s.input)}`).toBe(true)
    }
    // 反面：未知键仍然被拒
    expect(stepInputSchemas.readTable.safeParse({ selector: 'table', metric: 'tax.report', keepRows: true, evil: 1 }).success).toBe(false)
  })

  it('全是只读步骤（不含任何点击/提交类动作）', () => {
    const types = new Set(buildTaxCollectSteps(p).map(s => s.type))
    for (const t of types) expect(['navigate', 'waitForPage', 'waitMs', 'readTable']).toContain(t)
  })
})

describe('涉税报送：本次没读到 / 口径与列数（2026-10-15 审查修复）', () => {
  it('"本次没读到"必须在涉税分区如实显示（不能把上一次的数据当本次结果）', () => {
    expect(PAGE).toContain("'tax-empty-note-' + row.storeId")
    expect(PAGE).toContain('taxEmptyNotes')
  })

  it('界面文案不留 markdown 星号（模板文本节点不解析 **，会原样显示）', () => {
    expect(PAGE).not.toContain('归组按**')
  })

  it('抖店按列序映射必须带列数校验（平台插列会整体错位 → 如实失败）', () => {
    const dou = TAX_PROFILES['抖店']
    const sec = dou.sections[0]
    expect(sec.columns?.length).toBe(11)
    const steps = buildTaxCollectSteps(dou)
    const step = steps.find(s => s.type === 'readTable')
    expect(step?.input.expectColumnCount).toBe(11)
    // strict schema：引擎认识这个输入（拼错的键会被拒，不会静默失效）
    expect(stepInputSchemas.readTable.parse({ selector: 'table', expectColumnCount: 11 }).expectColumnCount).toBe(11)
  })

  it('涉税整表快照不进"指标快照"；涉税采集任务不计入概览任务总数', () => {
    expect(OVERVIEW_SERVICE).toContain("sn.metric NOT LIKE 'tax.%'")
    const idx = OVERVIEW_SERVICE.indexOf('SELECT COUNT(*) c FROM tasks WHERE')
    const snippet = OVERVIEW_SERVICE.slice(idx, idx + 400)
    expect(snippet).toMatch(/NOT LIKE \? AND COALESCE\(name, ''\) NOT LIKE \?/)
    expect(snippet).toContain('INVOICE_TASK_PREFIX')
    expect(snippet).toContain('TAX_TASK_PREFIX')
  })
})
