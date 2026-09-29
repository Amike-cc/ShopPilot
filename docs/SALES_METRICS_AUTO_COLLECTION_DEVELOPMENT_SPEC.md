# 四平台经营数据自动采集开发文档

更新时间：2026-09-28  
适用项目：`D:\code\电商浏览器`  
当前总体状态：`IMPLEMENTED / PARTIAL`，打包形态 `PACKAGED / INTERNAL_BUILD`  
禁止标记：`VERIFIED`、正式发布（理由见 §12「门槛与当前差距」）

## 1. 目标与边界

本功能为微信小店、拼多多、抖店、快手小店提供按店铺独立的经营数据自动采集。默认每 10 分钟触发一次，采集结果进入统一经营指标表，并保留运行状态与脱敏证据。

本功能只读平台经营数据，不执行付款、下单、退款、发票提交、发货或其他资金/不可逆动作。未经过真实平台验证的字段必须为 `null`，不能用 0 伪造"暂无数据"。

## 2. 状态标记

| 状态 | 含义 |
|---|---|
| `DESIGNED` | 规则和契约已经定义 |
| `IMPLEMENTED` | 代码已经接入 |
| `PACKAGED` | 已进入构建产物 |
| `VERIFIED` | 真实平台和连续运行验收通过 |
| `PARTIAL` | 只有部分平台、字段或链路完成 |
| `BLOCKED` | 被登录、权限、页面改版或数据源阻塞 |
| `UNTESTED` | 尚未做真实平台验证 |

## 3. 数据库迁移

**当前最新版本：`17`（`sales_metrics_traceability`）**

| 版本 | 名称 | 内容 |
|---|---|---|
| 13 | `sales_metrics` | `sales_metrics`（统一指标）、`product_sales_metrics`（商品维度） |
| 16 | `sales_metrics_collection_runtime` | `sales_collection_plans`、`sales_collection_runs`、`sales_metrics_raw` |
| 17 | `sales_metrics_traceability` | 来源可追溯列、运行台账扩展、保留策略索引 |

v17 追加的列：

- `sales_metrics`：`source_type`、`adapter_version`、`metric_definition_version`、`data_status`、`run_id`
- `sales_collection_runs`：`safe_message`、`source_type`、`inserted`、`updated`、`metrics_json`、`data_status`
- `sales_collection_plans`：`last_safe_message`
- `sales_metrics_raw`：`evidence_digest`
- 新索引：`idx_sales_collection_runs_created`、`idx_sales_metrics_raw_captured`

索引清单：

| 表 | 索引 | 用途 |
|---|---|---|
| `sales_collection_plans` | `idx_sales_collection_plans_due(enabled, next_run_at)` | 到期扫描 |
| `sales_collection_runs` | `idx_sales_collection_runs_store_time(store_id, created_at DESC)` | 按店取历史 |
| `sales_collection_runs` | `idx_sales_collection_runs_status(status, created_at DESC)` | 按状态排查 |
| `sales_collection_runs` | `idx_sales_collection_runs_created(created_at DESC)` | 保留策略按时间删 |
| `sales_metrics_raw` | `idx_sales_metrics_raw_run(run_id, captured_at DESC)` | 按运行取证据 |
| `sales_metrics_raw` | `idx_sales_metrics_raw_captured(captured_at DESC)` | 保留策略按时间删 |

外键：三张表都指向 `stores(id) ON DELETE CASCADE`，`sales_metrics_raw.run_id` 指向 `sales_collection_runs(run_id) ON DELETE CASCADE`。硬删除店铺时台账自动消失；软删除（回收站）由计划同步停用计划。

**保留策略**（`RetentionPolicy`，与自动备份同一 6 小时维护循环）：

| 键 | 默认 | 说明 |
|---|---|---|
| `salesRunKeepDays` | 90 | 运行记录保留天数；**不删 `RUNNING`**，那是"被强杀"的现场 |
| `salesRawKeepDays` | 30 | 脱敏证据保留天数 |
| `batchLimit` | 5000 | 单次最多删除行数 |

## 4. 统一数据模型与业务口径

金额一律用人民币分（整数）保存，禁止浮点。字段无真实依据时为 `null`；`0` 只表示平台明确返回的 0。

口径版本：`SALES_METRICS_METRIC_DEFINITION_VERSION = 'sales-metrics-1'`，逐字段定义在
[packages/shared/src/sales-metrics-rules.ts](../packages/shared/src/sales-metrics-rules.ts) 的 `SALES_METRICS_METRIC_DEFINITIONS` 与
[packages/shared/src/contracts/sales-metrics.ts](../packages/shared/src/contracts/sales-metrics.ts) 的常量里：

| 字段 | 口径 |
|---|---|
| `orderCount` | 统计周期内成功创建的订单数（含未付款、不含已取消） |
| `paidOrderCount` | 周期内完成支付的订单数，按支付时间归属 |
| `salesQuantity` | 周期内售出的商品件数（退款件数单独记在 `refundQuantity`） |
| `grossSalesAmountMinor` | 买家实付金额合计（含平台补贴后向商家结算的部分；不含运费与平台佣金） |
| `paidSalesAmountMinor` | 已支付订单的实付金额合计，口径同上 |
| `refundAmountMinor` | 退款成功金额合计，**按退款完成时间**归属（不是申请时间） |
| `refundOrderCount` | 发生退款成功的订单数，按退款完成时间归属 |
| `refundQuantity` | 退款成功的商品件数 |
| `netSalesAmountMinor` | `grossSalesAmountMinor - refundAmountMinor`；**任一算子为 null 则本字段为 null**（禁止用 0 补齐再相减） |
| `adSpendMinor` | 统计周期内的**广告投放消耗**，取平台自身口径（抖店「投放消耗」、拼多多「推广花费」）；快手/微信没有可读来源 → `null`。**不允许按成交额乘系数估算**（估算值看起来齐全，却答不出"这是谁的口径"，会让 ROI 变成假精确） |

其他约定：

- 周期为**左闭右闭**区间 `[periodStart, periodEnd]`。
- 时区统一 `Asia/Shanghai`。
- **跨平台合计只在 `metricDefinitionVersion` 一致时才允许**；不一致时返回 `null`，前端显示"—"（`sumAcrossPlatforms`）。
- 口径未知时必须为 `null`，不允许自动推断。
- 「投产比 ROI」= Σ成交金额 ÷ Σ投放花费，**只用同时报了这两个字段的店铺**（分子分母同源）；
  没有花费来源的店铺不计入，也不拿它们的成交额充分子。

### 4.1 数据状态（前端必须区分）

`dataStatus` 取值：`REAL_VALUE` / `REAL_ZERO` / `PARTIAL` / `NOT_COLLECTED` / `SOURCE_UNVERIFIED` /
`COLLECTION_FAILED` / `LOGIN_REQUIRED` / `VERIFY_REQUIRED` / `PERMISSION_DENIED` / `PAGE_CHANGED` /
`DATA_STALE` / `CIRCUIT_OPEN` / `PAUSED` / `UNKNOWN`。

行级判定（`deriveRowDataStatus`）：九个字段全为 0 → `REAL_ZERO`；有 null → `PARTIAL`；其余 → `REAL_VALUE`。
**八个 0 加一个非 0 是 `REAL_VALUE`**——旧写法会把它判成"真实 0"，前端会把真实成交额显示成 0。

### 4.2 数据新鲜度

`FRESH`（≤10 分钟）/ `AGING`（10～30 分钟）/ `STALE`（>30 分钟）/ `UNAVAILABLE`（从未成功）/
`PARTIAL` / `SOURCE_UNVERIFIED`。

`last_success_at` **只由真正成功（SUCCEEDED/PARTIAL）的运行刷新**；失败不刷新，所以"一直失败但显示新鲜"不会发生。

## 5. 调度

文件：[apps/desktop/src/main/sales-metrics/sales-metrics-scheduler.ts](../apps/desktop/src/main/sales-metrics/sales-metrics-scheduler.ts)

```text
周期       SALES_METRICS_DEFAULT_INTERVAL_MS = 600000（10 分钟）
节拍       TICK_MS = 1000
并发       SALES_METRICS_MAX_PARALLEL = 2（全局）
抖动       SALES_METRICS_JITTER_MIN_MS/MAX_MS = 10s / 60s，按 storeId 稳定派生
预算       Adapter 90 秒 / 单次运行硬上限 180 秒
```

规则：

1. 每个店铺一条计划；新店铺在"读计划列表时按需同步"或 30 秒节流同步中自动建计划。
2. 首次执行时间 = `now + 周期 + 抖动`，不在启动时突发采集。
3. 同一店铺串行：内存锁 + 每店一条 RUNNING 运行记录。
4. 停机期间错过的周期**不补发**：启动时把已过去的计划点重锚为 `now + 周期 + 抖动`（`anchorNextRun`）。
5. 店铺从 `listStores()` 消失（软删除）后计划被停用并置 `DISABLED`。
6. 所有数据库访问都在 try/catch 内，库被关掉也不会把异常抛到主进程。
7. 退出（`before-quit`）时停止调度并把在跑的运行标记为 `INTERRUPTED`；被强杀则由下次启动的 `reconcileOrphanRuns` 收敛。
8. 每次触发写运行记录，每次完成更新计划状态与 `next_run_at`。

## 6. 状态机、退避与熔断

状态集合（`SALES_METRICS_COLLECTION_STATUSES`）：
`NOT_CONFIGURED` `NOT_VERIFIED` `READY` `RUNNING` `SUCCEEDED` `PARTIAL` `LOGIN_REQUIRED`
`VERIFY_REQUIRED` `PERMISSION_DENIED` `PAGE_CHANGED` `NO_METRICS_FOUND` `TIMEOUT` `NETWORK_ERROR`
`DATA_SOURCE_NOT_VERIFIED` `STALE` `CIRCUIT_OPEN` `DISABLED` `ALREADY_RUNNING` `INTERRUPTED` `ERROR`

转换规则（`planTransition`，纯函数、可单测）：

| 运行结果 | 连续失败 | 退避 | 下一次运行 |
|---|---|---|---|
| `SUCCEEDED` / `PARTIAL` | 清零 | — | `now + 周期 + 抖动` |
| `DATA_SOURCE_NOT_VERIFIED` / `NOT_VERIFIED` | 清零 | — | `now + 周期 + 抖动`（不算系统故障，但也不显示为正常数据） |
| 第 1 次失败 | +1 | 2 分钟 | `max(正常周期, now+2分钟)` |
| 第 2 次失败 | +1 | 5 分钟 | `max(正常周期, now+5分钟)` |
| 第 3 次及以后 | +1 | 60 分钟 | `max(正常周期, now+60分钟)` |
| 连续失败 ≥ 5 次 | — | — | **`CIRCUIT_OPEN`，停机等人工恢复** |
| `LOGIN_REQUIRED` / `VERIFY_REQUIRED` / `PERMISSION_DENIED` / `PAGE_CHANGED` | 不累计 | — | **停机等待用户处理** |
| `INTERRUPTED`（应用退出） | 不累计 | — | 正常周期 |

要点：退避取「正常周期」与「退避窗口」的较大者——旧实现固定 `now+周期`，60 分钟的退避会被 10 分钟周期吃掉。
「需要用户处理」的状态不重试：重试不会改变结果，只会把日志刷满。

## 7. IPC 与实时事件

计划管理（全部 `familyHandle` + Zod `strict` + `IPCResult` + `requestId`）：

| 通道 | 入参 |
|---|---|
| `salesMetrics:plan:list` | `{ storeId?, platform? }` |
| `salesMetrics:plan:get` | `{ storeId }` |
| `salesMetrics:plan:update` | `{ storeId, enabled?, intervalMs? }`（周期限 1 分钟～24 小时，至少要改一项） |
| `salesMetrics:plan:pause` | `{ storeId }` |
| `salesMetrics:plan:resume` | `{ storeId }` |
| `salesMetrics:plan:runNow` | `{ storeId, periodType? }`（只入队，结果走事件） |
| `salesMetrics:runs:list` | `{ storeId?, platform?, status?, page?, pageSize? }` |
| `salesMetrics:health` | `{}` |
| `salesMetrics:collect` / `latest` / `list` / `products` / `topProducts` | 既有的只读查询/一次性采集 |

事件（只允许九个字段：`storeId` `platform` `runId` `status` `reasonCode` `collectedAt`
`nextRunAt` `consecutiveFailures` `freshness`）：

| 事件 | 负载 |
|---|---|
| `salesMetrics:runStarted` | 九字段 |
| `salesMetrics:runFinished` | 九字段 |
| `salesMetrics:planUpdated` | 九字段 |
| `salesMetrics:healthChanged` | **匿名聚合**：`computedAt` `counters` `nextRunAt` `lastSuccessAt`（不含任何店铺标识或原因码） |

应用锁定时所有经营数据业务通道被拒（`APP_LOCKED`）；`security:*` 与标题栏装饰通道例外。

## 8. 平台 Adapter

三个"锚点已实测"的平台共用基类
[sales-metrics-dom-adapter.ts](../apps/desktop/src/main/platform-adapters/sales-metrics-dom-adapter.ts)，
锚点全部来自 [packages/shared/src/constants/business.ts](../packages/shared/src/constants/business.ts) 的 `BUSINESS_PROFILES`（含实测日期）。
读取原语在 [sales-metrics-page-reader.ts](../apps/desktop/src/main/platform-adapters/sales-metrics-page-reader.ts)。

一次采集：校验周期口径 → 需要时导航到已登记页面 → 点周期控件（受信任鼠标）→ **确认周期真的生效** → 按标签文案逐指标读值 → 汇总状态。

**「点到控件」不等于「周期已生效」**（2026-09-28 实测事故）：微信小店那次点击没生效，采集把默认「今天」视图的
`¥0 / 0 单` 当成 `LAST_7_DAYS` 写进了库，而近 7 天真实值是 `¥108.90 / 11 单`——把默认周期的数字标成目标周期，
比没有数字更糟。因此点完之后必须验证，判据任一成立即可：

1. 首个指标的值与点击前不同；
2. 档案声明的 `periodAppliedText` 出现（微信实测：近7天视图显示「较上周期 X%」，默认「今天」视图显示的是「昨日 X」）；
3. **控件自身显示目标周期已被选中**（`readPeriodControlState`：该页签的文字色/背景色与同组页签不同）。
   这条**点击前也认**——页面本来就停在目标周期时（SPA 记住上次选择），点击是空操作、值也不会变，
   判据 ①② 必然都不成立：快手因此连续 9 次被判 `PERIOD_NOT_APPLIED` 而停采（2026-09-29 实测）。
   它不放松 2026-09-28 那次的判据：那次点击失败后页面仍停在「今天」，目标页签并未呈现选中态，③ 不成立。

三条都不成立 → `PERIOD_NOT_APPLIED`，**一个字段都不写**（下次周期到点再试）。判定成功的依据会写进运行记录的
`safeMessage`（`周期判据：VALUE_CHANGED / MARKER / CONTROL_SELECTED / BASE_SELECTED`），事后可核对"这条数据凭什么是这个口径"。

**统一字段映射由档案显式声明**（`BizMetricAnchor.salesField` / `salesUnit`），不按中文文案推断。档案同时声明 `salesPeriodType`，
采集按它落 `period_type`（否则会把 7 天的数字标成今天）。

| 平台 | 档案周期 | 已登记字段 | 状态 |
|---|---|---|---|
| 微信小店 | `LAST_7_DAYS`（点「近7天」） | 成交金额→`grossSalesAmountMinor`、成交订单数→`paidOrderCount`、成交退款金额→`refundAmountMinor`；销量/退款订单数/投放花费无可靠来源 → `null` | `IMPLEMENTED` + 字段来源已真实验证 |
| 快手小店 | `LAST_7_DAYS`（点「近7日」） | 成交金额、成交订单数、成交件数→`salesQuantity`、退款金额(退款日)→`refundAmountMinor`、成交退款订单数→`refundOrderCount`；无投放消耗来源 → `null` | `IMPLEMENTED` + 字段来源已真实验证 |
| 抖店 | `TODAY`（首页卡片「实时」） | 成交金额→`grossSalesAmountMinor`、**成交订单数→`paidOrderCount`（2026-09-29 新识别）**、**投放消耗→`adSpendMinor`（同上）**；退款两项**故意不登记**（列默认按「支付时间」归属，与本仓 `refundAmountMinor` 的"按退款完成时间"定义不符，列内下拉切基准实测不可靠） | `IMPLEMENTED` + 字段来源已真实验证（2026-09-29） |
| 拼多多 | `TODAY`（首页卡片，无周期控件；「7日/30日」页签只切趋势图） | 成交金额→`grossSalesAmountMinor`、成交订单数→`paidOrderCount`、**推广花费→`adSpendMinor`（2026-09-29 新识别）**；销量/退款金额/退款订单数无可靠来源 → `null`（首页「退款/售后」是待处理工单数，不是退款金额） | `IMPLEMENTED` + 字段来源已真实验证（2026-09-29） |

> 拼多多的接入方式与前三家一致：走 `BUSINESS_PROFILES` 的 DOM 锚点档案（`PddAdapter extends SalesMetricsDomAdapter`）。
> 它的数据中心页（`sycm/stores_data`、`sycm/evaluation`）数字是**反抓取字体**（私有区码位，取文本为乱码），
> 因此不登记那两页、也不做字体映射破解；旧的"网络观察 + JSON 抽取器"路线注册表为空，已标注为非生产路径。

### 8.0 多口径采集（同一页面多个周期控件）

一次采集默认采档案的**主口径**（`salesPeriodType` + `periodText`），另外按 `extraPeriods` 依次补采同页其它周期：

| 平台 | 主口径 | 附加口径 | 实测依据（2026-09-29） |
|---|---|---|---|
| 快手小店 | 近7日 → `LAST_7_DAYS` | 近30日 → `LAST_30_DAYS` | 点「近30日」后 成交金额 0 → ¥142.71、订单 13、退款 ¥35.12/3 |
| 微信小店 | 近7天 → `LAST_7_DAYS` | 今天 → `TODAY`、近30天 → `LAST_30_DAYS` | 近30天 ¥237.60 / 24 单 / 退款 ¥19.80；今天全 0 |
| 抖店 | 实时 → `TODAY` | 无 | 首页卡片里的「近7日」是对比标签（`compareLabel`），点了数值不变 |
| 拼多多 | 今日 → `TODAY` | 无 | 首页「7日/30日」只切趋势图，卡片数值不变 |

规则：

- **每个口径独立验证**：值变化 / 档案声明的生效文案 / 控件自身显示选中，三条任一成立才算该口径生效（**控件选中态那条点击前也认**，覆盖"页面本来就停在目标口径"）。
- **主口径失败 = 整次失败；附加口径失败 = 部分成功**（主口径的行照旧落库，`safeMessage` 里逐个写明哪个口径为什么没成）。
- 请求的口径必须**在档案登记集合内**（主口径或附加口径），否则 `PERIOD_SEMANTICS_MISMATCH` 拒绝落库。
- 附加口径**在进门时按预算一次性决定**是否采（< 45 秒只采主口径并在记录里写明未采口径）：真实路径预算为调度器 120 秒 / 手动采集 60 秒；单次运行硬上限 180 秒。
- 一次采集可写多行（库里按 `(platform, store_id, period_start, period_end)` 唯一）；**每行按它自己的口径归一化**，运行快照取主口径那一行。

### 8.1 真实验证结果（2026-09-28，真实登录态，可复现）

| 平台（店铺） | 结果 | 读到什么 |
|---|---|---|
| 微信小店（微信小店测试） | `SUCCEEDED` | `LAST_7_DAYS`（09/22 00:00 → 09/28 23:59）成交金额 `¥108.90`、成交订单 `11`、退款金额 `¥0.00`；退款订单数与销量 `null`（无可靠来源） |
| 快手小店（福气满满） | `SUCCEEDED` | `LAST_7_DAYS` 成交金额 `¥9.80`、成交订单 `2`、销量 `2`、退款金额 `¥0.00`、退款订单 `0` |
| 抖店（1111） | `SUCCEEDED` | `TODAY`（09/28 00:00 → 23:59）成交金额 `¥0.00`（页面确实是 0）；其余 `null` |
| 拼多多（慕么美） | `SUCCEEDED` | `TODAY` 成交金额 `¥234.92`、成交订单 `8`（同日 21:55 实测值）；销量/退款为 `null`（首页无可靠锚点）。证据字段 `grossSalesAmountMinor`+`paidOrderCount` 均 present，`adapterVersion=pdd-sales-v2` |

三次连续探测结果一致（数值与口径完全相同），每次都是 `sourceType=DOM`、`adapterVersion` 分别
`wechat-shop-sales-v1` / `kuaishou-sales-v1` / `doudian-sales-v1`、`freshness=FRESH`、`dataStatus=REAL_VALUE`。
库内核对：`sales_metrics` 每个 (平台, 店铺, 周期) **只有一行**（`duplicateGroups=0`）、脱敏证据 36 行、
计划 `last_status=SUCCEEDED` 且 `consecutive_failures=0`、无残留 `RUNNING`。

### 8.2 窗口必须保持前台（真机结论）

**窗口不在前台时，微信小店（micro-app）与抖店后台的内容区不渲染**，页面只剩导航外壳
（实测外壳正文 106～109 字，渲染完整 2584 字）。此前多轮真实探测失败全部源于这一点，
而不是页面改版，也不是网络问题。

因此：
1. 真实平台验收脚本 `sales-metrics-real-probe.js` 内置**前台保持**（每 2.5 秒 `AppActivate`，
   可用 `SHOPILOT_NO_KEEP_FOREGROUND=1` 关闭）——与 `run-acceptance.ps1` 同一思路。
2. Adapter 里加了区分判据：点不到周期控件或锚点全不命中时，先量正文长度；
   短到只有外壳 → `NETWORK_ERROR / PAGE_NOT_RENDERED`（**可重试**，不会把健康平台停掉），
   正文正常但结构对不上 → `PAGE_CHANGED`（停机等重新实测）。

### 8.3 读取算法要点（都是真机踩出来的）

- 值不再取"标签所在层多出来的整段文本"——抖店卡片是「成交金额 >」与「0」两个兄弟节点，
  微信卡片是「成交金额 ¥0 昨日¥29.7」，整段取回来会带出对比行、解析必然失败，
  表现是"页面上明明写着 0，系统报没有数值"。现在先找**标签之后第一个纯数值元素**，取不到才回退。
- 定位文案时**先做零布局成本的筛选再查可见性**：对整页上万个元素逐个 `innerText`/`getBoundingClientRect`
  会强制样式与布局重算，脚本根本跑不完（表现是"页面上有「近7天」却一直报点不到"）。
- 点不到周期控件时**重载一次再试**，两轮都点不到才按"未渲染/改版"分流（见 §8.2）。
- 页面文本的正则判断留在页面内执行，只把布尔结果带回 Main。
- **周期按天对齐**（`salesMetricsPeriodBounds` 是唯一实现，三处旧副本已删）：`period_end` 取"采集时刻"时，
  每 10 分钟采集一次就是每 10 分钟插一行——`(platform, store, period_start, period_end)` 唯一键形同虚设，
  "重复采集幂等"在真实运行里根本不成立。真机跑通三个平台后查库才发现（微信只有一处门店却有多行同口径数据），
  已改为自然日边界；修正后复跑三平台，`duplicateGroups=0`。
- **改周期要立刻生效**：缩短周期要把下一次采集提前（只提前不延后）。旧实现改了 `interval_ms` 却不重排
  `next_run_at`，连续运行验收脚本因此等了 13 分钟一条运行记录都没有。

## 9. 前端数据中心

[SalesMetricsMonitorCard.vue](../apps/desktop/src/renderer/src/features/workbench/SalesMetricsMonitorCard.vue)，
挂在"数据分析"页（`UnifiedDataPage` 的 analytics 模式）。

展示：店铺 / 平台 / 状态 / 新鲜度 / 成交金额 / 成交订单 / 退款金额 / 最后成功时间 / 平台原始更新时间 /
下一次采集 / 数据来源 / Adapter 版本 / 连续失败次数 / 退避截止 / 最近失败原因 / 最近 24 小时趋势（SVG 迷你图）/
健康计数条 / 运行记录抽屉。

操作：立即采集 / 暂停 / 恢复 / 查看运行记录 / 打开平台页面。

null 与 0 的显示差异：`null` → `—`（并配"从未成功/无来源"等文字），`0` → `¥0.00` / `0`。
趋势图只画有值的成功点，一个点都没有时不画线（而不是画一条 0 的线）。

## 10. 安全边界

- Main 持有 Session/WebContents/页面访问；preload 只暴露受限 API；Renderer 不接触 Cookie/Session/WebContents。
- 只访问已登记的经营数据页面；不执行任意页面脚本（注入的表达式都是纯计算，不写页面全局）。
- 不读取买家姓名、手机号、地址或完整订单正文；证据表只存字段名/来源/置信度/摘要，摘要不可逆。
- 页面 URL 只以 SHA-256 前 32 位形式落库；日志与诊断包不含 Cookie/凭据（验收脚本逐条断言）。
- 页面改版、登录失效、权限不足都停机等待，不自动切换代理、不静默降级、不无限重试。

## 11. 测试分层

| 层 | 命令 | 结果 |
|---|---|---|
| 静态检查 | `pnpm.cmd typecheck` / `pnpm.cmd lint` | 通过（lint 0 error） |
| 单元测试 | `pnpm.cmd exec vitest run` | 66 文件 / 716 用例通过（其中本功能新增 69） |
| 集成（SQLite 真实库） | 同上（用 `node:sqlite` 跑生产迁移） | 通过 |
| Electron/CDP（开发版） | `node tools/acceptance/sales-metrics-cdp-verify.js` | 39/39 通过 |
| 打包启动 | `SHOPILOT_SM_APP_EXE=release/win-unpacked/ShopPilot.exe node tools/acceptance/sales-metrics-cdp-verify.js` | 39/39 通过 |
| 真实平台 | `node tools/acceptance/sales-metrics-real-probe.js` | 见 §8.1（1 成功 / 2 阻塞 / 1 未验证） |
| 连续运行 | `node tools/acceptance/sales-metrics-soak.js --cycles=<n> --interval=<min>` | 已跑压缩档（1 分钟周期）：12 条运行 / 12 个唯一 runId / 0 残留 RUNNING / 间隔严格 2 分钟与 5 分钟（退避档位）/ RSS 108092→107808 KB（无增长）/ 无假 0。**12×10 分钟、24 小时、72 小时三档未跑** |

辅助脚本：`sales-metrics-db-inspect.js`（只读核对界面与 SQLite）、`sales-metrics-anchor-probe.js`（锚点/周期控件诊断 + 截图）。

夹具与真实平台的边界：单测里的页面是**假页面**（脚本感知的桩），只验证"读取算法与状态映射"；
它不能证明平台采集完成，也不允许被引用为真实平台结论。

## 12. 门槛与当前差距

要标记 `VERIFIED`，必须同时满足：

1. 四个平台真实登录态通过 —— ✓（微信 / 快手 / 抖店 / 拼多多，均为真实登录态实测；拼多多 2026-09-28 接入）
2. 四个平台真实字段来源通过 —— ✓（同上；拼多多只登记了两项可读锚点，其余字段如实为 `null`）
3. 四个平台连续成功 12 个 10 分钟周期 —— ✗
4. 四个平台连续运行 72 小时 —— ✗
5. 重启恢复 / 失败退避 / 熔断恢复 / 页面改版保护 —— ✓（Electron/CDP 验收逐项覆盖 + 压缩档连续运行观测到 2/5 分钟退避档位）
6. 真实 0 与 null、失败、过期状态正确 —— ✓（单测逐项锁定；真机上抖店 `¥0.00` 与其余字段 null 并存，微信/快手缺失字段也为 null）
7. 前端、数据库与证据链一致 —— ✓（DB 核对脚本：`duplicateGroups=0`、证据 36 行、无残留 RUNNING）
8. 日志与诊断包无敏感信息 —— ✓（验收脚本断言）
9. Windows 打包版启动与功能验收 —— ✓（`win-unpacked` 39/39）

第 1、2 项已完成（四平台均有真实登录态下的实测来源）；第 3、4 项是纯粹的"时间不够"——需要在能访问四个平台的机器上挂机跑。
因此当前只能停在 `IMPLEMENTED / PARTIAL` + `PACKAGED / INTERNAL_BUILD`。

阻塞与下一步：

1. **拼多多的剩余字段**：首页只给成交金额与成交订单数。销量/退款金额/退款订单数若要接入，
   需要先在数据中心页解决字体反爬（**不做字体映射破解**：那等于把某次映射当契约，
   页面一改就会静默产出错数字）；可行方向是找带字段级证据的 JSON 来源，届时在
   `pdd-sales-metrics-collector` 注册一个 `VERIFIED_REAL_PLATFORM` 抽取器并补实测日期。
2. **连续运行**：在能访问四个平台的机器上跑
   `node tools/acceptance/sales-metrics-soak.js --cycles=12 --interval=10 --real`（约 2 小时），
   再按同样方式跑 24 小时与 72 小时，并把 `artifacts/sales-metrics/soak-report.json` 一起归档。
3. **运维前提**：采集期间窗口需要保持前台（§8.2）。如果长期最小化运行，
   微信/抖店会反复落到 `PAGE_NOT_RENDERED`（可重试、不会停采，但拿不到数据）。
   下一步值得做的加固：检测到"连续多个周期都是 `PAGE_NOT_RENDERED`"时在数据中心显式提示用户"请把窗口保持在前台"。
4. **微信销量/退款订单数**：需要在真实页面上确认是否有独立入口，没有就永久保持 `null`。
