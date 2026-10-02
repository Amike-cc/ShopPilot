# 发票模块代码审查报告

审查时间：2026-09-30　审查基线：`6233732`（v0.4.57）　工作区状态：发票相关文件无未提交改动

---

## 一、审查范围

| 层 | 文件 | 行数 |
| --- | --- | --- |
| 平台档案 | [constants/invoice.ts](packages/shared/src/constants/invoice.ts) | 446 |
| 采集步骤 | [invoice-steps.ts](packages/shared/src/invoice-steps.ts) | 116 |
| 纯函数 | [invoice-amount.ts](packages/shared/src/invoice-amount.ts)、[invoice-csv.ts](packages/shared/src/invoice-csv.ts)、[store-license.ts](packages/shared/src/store-license.ts) | 39 / 76 / 206 |
| 主进程 | [overview-service.ts](apps/desktop/src/main/services/overview-service.ts)、[profile-misc-handlers.ts](apps/desktop/src/main/ipc/profile-misc-handlers.ts)、[task-runner.ts](apps/desktop/src/main/tasks/task-runner.ts) | 388 / 441 / 3246 |
| 渲染层 | [UnifiedDataPage.vue](apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue)、[DashboardView.vue](apps/desktop/src/renderer/src/features/workbench/DashboardView.vue) | 375 / 1778 |
| 集成 | [scheduler.ts](apps/desktop/src/main/tasks/scheduler.ts)、[task-step-schemas.ts](apps/desktop/src/main/tasks/task-step-schemas.ts)、[retention.ts](apps/desktop/src/main/services/retention.ts)、[agent-service.ts](apps/desktop/src/main/services/agent-service.ts) | — |
| 测试 | `tests/unit/invoice-{center,collect,csv,amount}.test.ts`、`store-license.test.ts` | 74 用例 |

**方法**：通读源码 → 跑单测/ESLint → 用临时探针（已删除）复现可疑行为 → 逐个复核跨进程集成点。

**基线（全部实测）**

- `vitest run`：**72 个测试文件 / 771 个用例全部通过**；发票相关 5 个文件 74 用例全通过。
  唯一报错是 `tests/unit/sales-metrics-scheduler.test.ts` 的收尾竞态（`database is not open`，用例本身已 pass），**与发票模块无关**。
- `eslint` 发票相关 7 个文件：**0 error**，60 warning（全是 `no-explicit-any`）。
- 我用脚本把 4 个平台档案生成的步骤（微信 10 / 拼多多 11 / 抖店 13 / 快手 10 步）**逐条过了 `taskStepSchema` + `stepInputSchemas.strict()`，全部通过**——档案与白名单没有漂移。

---

## 二、结论摘要

| # | 级别 | 问题 | 位置 |
| --- | --- | --- | --- |
| 1 | **P1 安全** | 导出的 CSV 不防公式注入，而抬头/税号是**买家在平台上填的** | invoice-csv.ts:60 |
| 2 | **P1 正确性** | 合计结果为 0 或负数时显示「—」，与条数自相矛盾 | UnifiedDataPage.vue:206,211,249 |
| 3 | **P1 正确性** | 「金额无法解析」提示被藏在 `historical > 0` 分支里，绝大多数情况不显示 | UnifiedDataPage.vue:49 |
| 4 | **P1 正确性** | 采集失败原因/登录态在主进程算好了，发票界面从不渲染 | UnifiedDataPage.vue:24-118 |
| 5 | **P1 正确性** | 微信「给买家开票」挡不住「申请平台开票」的表（两份数据挂不同方向名） | constants/invoice.ts:150-180 |
| 6 | P2 | Agent 工具把「店铺数」说成「待开票清单 N 条」，且明细进不了上下文 | agent-service.ts:2260 |
| 7 | P2 | 测试里自带一份被测实现的副本，会与真实实现漂移 | invoice-collect.test.ts:189,217 |
| 8 | P2 | `buildInvoiceCsv` 表头不转义 | invoice-csv.ts:73 |
| 9 | P2 | 卡片（labels）方向缺 `absentOk`，一项标签缺席就让整轮采集失败 | invoice-steps.ts:71 |
| 10 | P2 | `parseInvoiceAmount` 未锚定，且会把两个数字粘成一个 | invoice-amount.ts:11 |
| 11 | P2 | `__cleanRows` 对空输入解引用 `out[0]`，抛裸异常绕过 emptyOk | constants/invoice.ts:431 |
| 12 | P2 | `normalizeCellText` 去重分支返回压缩串，会吃掉空格/砍半纯数字单号 | constants/invoice.ts:401 |
| 13-15 | P3 | 注释与实现漂移 / 旧 WorkbenchView 死代码 / 若干细枝末节 | 见第四节 |

---

## 三、缺陷明细

### 1【P1·安全】导出 CSV 未防公式注入

**位置**：[invoice-csv.ts:60-63](packages/shared/src/invoice-csv.ts)

```ts
export function escapeCsvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
```

**实测证据**（探针，值取自真实导出列）：

```
escapeCsvCell("=cmd|'/c calc'!A0")  =>  =cmd|'/c calc'!A0      ← 原样输出
escapeCsvCell("+1+1")               =>  +1+1
escapeCsvCell("@SUM(1)")            =>  @SUM(1)
```

**为什么这里真的会中招**：这份 CSV 是**拿去报税、交给代账**的（文件头注释原话），而它的数据源是平台页面文本 —— 拼多多「订单开票」这一方向正是 **买家向商家发起的开票申请**，「发票抬头 / 企业税号 / 其他信息」由买家填写、原样渲染在商家后台页面上，再被 `readTable` 整表读回、经 `invoiceCsvRows` 原样吐进 CSV。买家把抬头写成 `=HYPERLINK(...)` 或 DDE 载荷，商家/代账用 Excel 或 WPS 打开导出文件即触发（WPS 与旧版 Excel 的拦截弱于新版 Excel）。

**建议修法**：对以 `= + - @ \t \r` 开头的单元格加单引号前缀。注意**不要无脑套到数值列**——`-12.50` 这类负数（退款/冲正，模块自己承认会出现）会被误伤；按列区分（文本列加前缀、金额列不加），或统一改为前置制表符并在导出说明里写清。

---

### 2【P1·正确性】合计为 0 / 负数时显示「—」

**位置**：[UnifiedDataPage.vue:206](apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue)、`:211`、`:249`

```ts
amountText: invoiceAmountText(item.amount, item.amount > 0)              // :206
amountText: invoiceAmountText(sum, withText.some(item => item.amount > 0)) // :211
return { count, amountText: invoiceAmountText(amount, amount > 0), ... }   // :249
```

**契约说的是另一回事**：[invoice-amount.ts:33](packages/shared/src/invoice-amount.ts)

> `hasAny` —— 没有任何可解析金额时返回 '—'，而不是 '¥0.00'（"没数据"和"金额是 0"不是一回事）

即 `hasAny` 的语义是「**有没有解析出金额**」，调用方却传了「**合计是否为正数**」。

**实测证据**：

```
invoiceAmountText(0, false) => '—'      // 界面走的就是这条
invoiceAmountText(0, true)  => '¥0.00'
```

**后果**：某主体只有一条 `¥0.00` 的待开票，或正负相抵后净额为 0（退款/冲正），或净额为负——顶部卡片出现「**待开票条数 1**　**可开金额合计 —**」，主体胶囊同理。金额被藏起来而不是显示 `¥0.00` / `¥-12.50`。

**建议修法**：合计循环里已经在数 `unparsed`，直接用它：`const parsed = count - unparsed`，传 `parsed > 0`。旧 [WorkbenchView.vue:4709](apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue)、`:4714` 是写法更差的同类问题（`l.amount ? ... : '—'`），但该文件已是死代码（见 P3-14）。

---

### 3【P1·正确性】「金额无法解析」提示被条件吞掉

**位置**：[UnifiedDataPage.vue:49-53](apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue)

```html
<p v-if="invoiceTotal.historical" class="inv-note" data-test="invoice-pending-note">
  另有 <b>{{ invoiceTotal.historical }} 条</b>属「已提交 / 已通过」的方向……
  <template v-if="invoiceTotal.unparsed">另有 {{ invoiceTotal.unparsed }} 条金额无法解析为数字，<b>未计入</b>合计。</template>
</p>
```

外层 `v-if` 管的是「无需操作条数」，内层 `unparsed` 提示被一起关在门里。**只有 `historical > 0` 时**（即该店铺存在快手「处理中/处理记录」这类 `pending:false` 方向）才会露出这句话；微信、拼多多、抖店以及只有「未开票账单」的快手店铺，`historical` 恒为 0。

**后果**：`可开金额` 列是 `—`/`-`/空 时不解析、不计入（这是**正确**的口径），但界面**不会告诉用户少算了多少条**——合计偏小、看不出原因。这正是 [invoice-amount.ts:5-6](packages/shared/src/invoice-amount.ts) 明令要避免的：「绝不把解析失败当 0 加进去（那会让合计看起来齐全、实际少算）」。空金额列在实测表里很常见（`extras` 都专门过滤 `'-'`，说明 `-` 是高频值），所以 `unparsed > 0` 完全可达。

**建议修法**：把这段提成独立段落，条件改为 `v-if="invoiceTotal.unparsed"`。

---

### 4【P1·正确性】主进程算好的采集失败原因，发票界面一处也没用

**位置**：产出在 [overview-service.ts:205-209](apps/desktop/src/main/services/overview-service.ts)，消费缺口在 [UnifiedDataPage.vue:24-118](apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue)

```ts
// overview-service.ts:205
// 最近一次采集失败的原因（界面在"没有数据"时如实展示，而不是只说"暂无"）
lastFail: fail ? { code, message, at } : null,
loginRequired: fail ? String(fail.error_code || '').includes('LOGIN_REQUIRED') : false
```

发票分支里 `row.lastFail`、`row.loginRequired`、`row.unsupportedReason`、`row.entity*`、`row.measuredAt`、`row.manual` **全部没有渲染**。对照旧 [WorkbenchView.vue:1119-1123](apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue) 是渲染的（「上次采集失败：…」+「去登录」）。发票界面只有：

```html
<div v-if="row.sections?.length" class="invoice-sections"> …每方向「0 条」… </div>
<div v-else class="unified-empty compact">{{ row.note || '暂无发票数据' }}</div>
```

而 `sections` 对已登记平台**永远非空**（档案驱动），所以 `v-else` 基本不会出现。

**后果**：采集整体失败（TASK_TARGET_COVERED、选择器改版、登录失效）时，界面呈现与「采集成功但确实没有数据」**完全一致**——每个方向都是「0 条」。这正是仓库里反复出现的那类"比报错更危险的恒错显示"。登录失效本可由用户自己解决，现在也没有入口。

**建议修法**：在 `invoice-row-head` 下方补一段失败提示（复用 `lastFail` / `loginRequired` / `unsupportedReason`），条件 `v-if="!row.count && !row.historyCount && (row.lastFail || row.unsupportedReason)"`。

---

### 5【P1·正确性】微信「给买家开票」的方向判据挡不住「申请平台开票」

**位置**：[constants/invoice.ts:150-180](packages/shared/src/constants/invoice.ts)

三个方向的判据：

| 方向 | expectHeaders（= `Object.keys(headerMap)`） | rejectHeaders | tabVerify |
| --- | --- | --- | --- |
| 申请平台开票（默认） | 账单号、账单日期、账单类型、可开金额 | — | — |
| 给平台开票 | 账单号、账单日期、账单类型、可开金额、**处理状态** | — | — |
| 给买家开票 | 账单号、账单日期、账单类型、可开金额 | **处理状态** | — |

**关键事实**：第 1 与第 3 个方向的 `headerMap` **逐字相同**，第 3 个方向的 `rejectHeaders` 用的是**第 2 个方向**的特征列（「处理状态」）。

**失效路径**：点「给买家开票」后页面若回到**默认页签**（申请平台开票），读到的是默认方向的表——
- `rejectHeaders` 查「处理状态」→ 不命中（默认方向的表没有这列）；
- `expectHeaders` 查 4 列 → **全部命中**。

于是「申请平台开票」的数据被当作「给买家开票」上报，界面出现两份内容一模一样、却挂不同方向名的记录。档案注释自己写明这"是最危险的静默错误"，但当前只堵住了相邻的第 2 个方向，没堵住同表头的第 1 个。

**旁证**：微信方向全部走 `allowJsWhenDetached: true`（视图被摘除时降级 JS 点击，见 invoice-steps.ts:14-21），JS 合成点击的可靠性本就低于受信任点击；而**只有快手**用了 `tabVerify` 校验选中态。微信恰恰是最需要它、且唯一有"两个方向表头完全相同"的平台。

**建议修法**（任选其一，前两个更稳）：
1. 给微信三个方向都补 `tabVerify`（页签选中态），与快手对齐；
2. 给「申请平台开票」方向也加 `rejectHeaders` 需配合可区分列——目前无可用列，故实质只能走 tabVerify；
3. 退而求其次：把「给买家开票」的 `emptyOk` 语义收紧，命中"与上一方向完全相同的数据"时落 0 条。

---

### 6【P2】Agent 工具 `overviewInvoiceCenter` 把店铺数说成清单条数

**位置**：[agent-service.ts:2260-2267](apps/desktop/src/main/services/agent-service.ts)

```ts
const center = overviewInvoiceCenter()
const rows = Array.isArray(center.rows) ? center.rows : []   // ← 每店一行，不是每条发票
const head = rows.slice(0, 5).map(formatOverviewRow)
messages.push(rows.length
  ? `待开票清单共 ${rows.length} 条…：\n${head.join('\n')}`
  : '待开票清单为空…')
```

`collectInvoiceRows()` 是 `stores.map(...)`，所以 `rows.length` **恒等于未删除店铺总数**，与"待开票条数"无关（真正待办数在 `row.count`）。

并且 `formatOverviewRow` 只取对象**前 8 个键**并按 `String(value).slice(0,40)` 拼行——店铺行的键序是 `storeId, storeName, platform, count, licenseName, licenseNo, entity, entitySupported…`，也就是说喂给模型的是：

```
· storeId=…｜storeName=…｜platform=拼多多｜count=3｜licenseName=…｜licenseNo=…｜entity=[object Object]｜entitySupported=true
```

**真正的 `sections / items`（每条发票记录）一条都没进上下文**，`entity` 还渲染成了 `[object Object]`。

**后果**：与 2026-09-28 修掉的 `row.count`「恒错数字」是同一类错误（见 overview-service.ts:175-179 的注释），只是搬到了 Agent 通道上。

**建议修法**：把 `count` 求和作为条数，并把 `sections[].items[].cells` 摘要成行（可复用 `INVOICE_COLUMNS` 的 label），`entity` 单独格式化。

---

### 7【P2】测试里自带一份被测实现的副本

**位置**：[invoice-collect.test.ts:189-196](tests/unit/invoice-collect.test.ts) 复制 `parseInvoiceAmount`；`:217-220` 复制 `escapeCsvCell`

```ts
// 与渲染层 parseAmount 同一套规则（这里独立实现一份做等价性说明，防止规则被改坏而无人察觉）
const parse = (v: unknown): number | null => { … }
```

注释说明了动机，但方向反了：**副本改坏不会让测试红**，只会让测试继续验证一个已经不存在的口径。而真实实现本来就 import 得到（`invoice-amount.test.ts` / `invoice-csv.test.ts` 就是直接 import 的）。CSV 那份已经体现出差异风险——副本和真实实现都漏了"表头不转义"（见下条），谁都没测出来。

**建议修法**：删掉这两个副本，改为 `import { parseInvoiceAmount } from '@shared/invoice-amount'` / `import { escapeCsvCell } from '@shared/invoice-csv'`。

---

### 8【P2】`buildInvoiceCsv` 表头不转义

**位置**：[invoice-csv.ts:69-75](packages/shared/src/invoice-csv.ts)

```ts
const headers = Object.keys(dataRows[0])
return '\uFEFF' + [
  headers.join(','),                                          // ← 未转义
  ...dataRows.map(r => headers.map(h => escapeCsvCell(r[h])).join(','))
].join('\r\n')
```

**实测证据**：列名含逗号时表头列数 ≠ 数据列数 → `"店铺,开票方向,b\r\na,x"`（表头 3 列、数据 2 列）。

今天列名都是常量（`INVOICE_COLUMNS` + 固定中文字面量）所以不炸；但 `InvoiceExportColumn.label` 的类型是自由 `string`，属埋雷。修法：`headers.map(escapeCsvCell).join(',')`。

---

### 9【P2】卡片（labels）方向缺"空即可"机制

**位置**：[invoice-steps.ts:71-88](packages/shared/src/invoice-steps.ts)

表格方向有 `emptyOk`（由 `measuredRows === 0` 推出，见 `:91`、`:104`），卡片方向却是"三个标签全部必须读到"：

```ts
for (const l of sec.labels) {
  steps.push({ type: 'readLabelValue', input: { label: l.label, metric: `…`, allowText: true, maxValueLen: 120 } , timeoutMs: 20000 })
}
```

`readLabelValue` 本身支持 `absentOk`（[profile-misc-handlers 同族的 task-step-schemas.ts:379-386](apps/desktop/src/main/tasks/task-step-schemas.ts) 写明「页面上没有这一行算通过，与 readTable 的 emptyOk 同一思路」），但发票这里没传。

**后果**：拼多多「提交发票」页某项标签缺席（无待开票账单、卡片未渲染、页面改版）时，`readLabelValue` 会在 20s 后抛 `TASK_SELECTOR_CHANGED`，而它与前面已读成功的「订单开票」**同属一条任务**——整轮采集判失败，界面弹出上一次失败，同时「订单开票」的数据其实已经落库。按本模块自己的口径（`emptyOk` 的注释：「空方向不该把整轮采集判失败」），这里是不一致的口子。

实测证据（`wx-invite-test/evidence/pdd-cashier.txt`）显示有数据时三个标签都在，所以这是**健壮性缺口而非已复现的 bug**；修法是给这三个步骤加 `absentOk: true`，让"本来就没有"走空值路径。

---

### 10【P2】`parseInvoiceAmount` 未锚定，且会粘连两个数字

**位置**：[invoice-amount.ts:11-26](packages/shared/src/invoice-amount.ts)

**实测证据**：

```
'100 200'      => 100200      ← stripCurrency 把中间空格也删了，两个数字被粘成一个
'2026年05月'    => 2026        ← 未锚定，命中第一个数字串
'(100.00)'     => 100         ← 会计式负数，符号被吞，变成正数
'.56'          => 56
'1.2.3'        => 1.2
```

**当前可达性**：调用点只喂 `cells.amount`（表头映射过的金额列）与 `readLabelValue` 的文本值，所以日常数据里前两条尚未触发。但**合计是要交给代账的数字**，且 `readLabelValue` 的 `allowText` 路径会把整段卡片文本原样带回来（`raw.replace(/\s+/g,' ')`，空格保留），一旦标签旁出现两段数字就会被粘成一个更大的数——这是"静默放大金额"，比解析失败危险。建议：锚定 `^-?[\d,]+(\.\d+)?$`（去掉符号后），或显式拒绝"去掉符号后仍含多个数字段"的串。

---

### 11【P2】`__cleanRows` 对空输入解引用 `out[0]`

**位置**：[constants/invoice.ts:428-443](packages/shared/src/constants/invoice.ts)

```js
const headerLabels = new Set(out[0].map(x => String(x).trim()).filter(Boolean));   // out 为空即抛
```

**实测证据**：`__cleanRows([])` → `TypeError: Cannot read properties of undefined (reading 'map')`。

这段源码被**注入页面脚本**执行（task-runner.ts:1253），异常会让 `executeJavaScript` 直接 reject，运行器只拿到一句裸错误——**绕过了为这个场景准备好的 `emptyOk` 优雅空表路径**（`emptyResult('页面上没有该选择器的表格')`）。可达性偏窄（需要"选择器命中但一张 `<tr>` 都没有"的表格，例如框架先渲染表壳后填行），但修起来是一行：

```js
if (!out.length) return out;
```

顺带一提：`vals` 在算表头占比前做了 `.filter(Boolean)`，分母是**非空单元格数**而不是整行列数（注释写的是"≥60% 单元格"）。空列多的行更容易被误判成重复表头行；实测的几张表都没触发，属可选加固。

---

### 12【P2】`normalizeCellText` 去重分支返回压缩串

**位置**：[constants/invoice.ts:401-411](packages/shared/src/constants/invoice.ts)

```ts
const compact = s.replace(/ /g, '')            // ← 去掉了所有空格
if (compact.length >= 4 && compact.length % 2 === 0) {
  const half = compact.slice(0, compact.length / 2)
  if (half === compact.slice(compact.length / 2)) return half   // ← 返回的是 compact 的一半
}
```

**实测证据**：

```
'2026年01月\n\n2026年01月'      => '2026年01月'     ✓ 目标场景，正确
'上海 某某 公司 上海 某某 公司'   => '上海某某公司'    ✗ 空格丢失（返回的不是原文的那一半）
'12341234'                     => '1234'           ✗ 纯数字单号被砍半
'A B A B'                      => 'AB'             ✗
```

去重规则本身是**有意为之**（注释与单测都写明了，单测还专门钉了 `'5月5月' => '5月'` 这个 2 字符边界），问题在实现细节：
- 返回值取自 `compact` 而不是原串 `s`，所以**幸存那一半里的空格也一起没了**；
- 2 字符半段的下限让纯数字串有理论上的砍半风险——账单号/流水单号是长数字（实测 `28351275426`、`220630-401819647563847`），16 位流水号恰好是 8 位重复就会被静默截断。

**建议修法**：只在**原文里两半之间存在空白/换行**时才判重复（那才是实测到的"渲染两遍"特征），并用 `s` 的对应切片作为返回值：

```ts
const m = /^([\s\S]+?)\s+(\1)$/.exec(s)   // 两半相同且中间有空白
if (m) return m[1].trim()
```

---

## 四、P3 清理项

**13. 注释与实现漂移（4 处）**

- [overview-service.ts:48-52](apps/desktop/src/main/services/overview-service.ts)：注释写"导出给 **services/overview-service.ts** 复用"、"**overview-service 反过来 import 本文件**，构成循环 import"——这段注释现在**就在 overview-service.ts 里**，描述的是它 import 自己。2026-09-26 审计那次"打破环"的重构把两个文件合并后没同步注释。
- [overview-service.ts:245](apps/desktop/src/main/services/overview-service.ts)：「metric = `invoice.rows`」——实际指标名是 `invoice.<方向>`（`invoice.applyPlatform` 等），`invoice.rows` 在代码里根本不存在。
- [constants/invoice.ts:16](packages/shared/src/constants/invoice.ts)：文件头「红线 / 实测记录」写着「快手小店：**未找到可读取的发票页**（后台整页无「发票」入口，资金类路径均重定向回后台首页）→ 不登记」，而同文件 306-375 行登记了完整的快手档案（3 个页签、`measuredAt: '2026-09-14'`），单测 [invoice-collect.test.ts:124-139](tests/unit/invoice-collect.test.ts) 也钉住了它。**该文件自称"锚点必须实测"是模块红线，这处矛盾需要澄清**（我理解是后来补测了，但文件头没改）。
- [task-step-schemas.ts:74-75](apps/desktop/src/main/tasks/task-step-schemas.ts)：「抖店「给消费者开票」结构未验」——档案里已按实测表头登记（constants/invoice.ts:261-278 明确写"此前这里登记的是**猜的**拼多多式列名，已按实测改正"）。

**14. 旧 `WorkbenchView.vue` 整套发票实现仍在仓库（死代码）**

[App.vue:3](apps/desktop/src/renderer/src/App.vue) 注释即「旧 WorkbenchView 保留在仓库中作为历史兼容代码，运行时不再作为入口」，全仓库无任何 `import WorkbenchView`。但它里面（约 4600-5400 行区间）**另有一整套**发票中心实现：`parseAmount`、`fmtAmount`、`licenseSummary`、`invoiceAllRows`、`filterSections`、`invoiceOnlyWithData`……而 [invoice-amount.ts:7](packages/shared/src/invoice-amount.ts) 抽这个模块的理由正是「解析规则以前写在旧 WorkbenchView 里，界面重制后新页面要用同一套，抽到这里免得**两份实现漂移**」——抽出来了，旧的那份没删，漂移照样存在（口径已经不一致：旧版金额用 `l.amount ? … : '—'`，新版用 `amount > 0`；旧版 per-主体有 `historyCount`，新版没有）。

需要注意的是：虽然运行时已无入口，[tools/maintenance/export-copy.js:82](tools/maintenance/export-copy.js) 仍把它列为「关键文件」参与源码导出校验，`wx-invite-test/` 下还有十来个脚本按绝对路径读写它，[docs/task-rpa-roadmap.md:30](docs/task-rpa-roadmap.md)、[docs/AGENT_DEVELOPMENT_SPEC.md:53](docs/AGENT_DEVELOPMENT_SPEC.md) 也还把它当作工作台来引用。**删除前要先清理这些引用**，否则会误伤导出/验收脚本。

建议：整体删除，或至少删掉发票相关段落，避免下一次改动改错文件。

**15. 细枝末节**

| 位置 | 问题 |
| --- | --- |
| [store-license.ts:79](packages/shared/src/store-license.ts) | `}export function groupStoresByLicense(` —— 缺换行，格式瑕疵（lint 未覆盖） |
| [constants/invoice.ts:414](packages/shared/src/constants/invoice.ts) | `INVOICE_SUPPORTED_PLATFORMS` 仅被单测引用，生产代码一律走 `invoiceProfileFor` |
| [constants/invoice.ts:384](packages/shared/src/constants/invoice.ts) | `invoiceProfileFor` 不支持用户覆盖，而 [ordersProfileFor](packages/shared/src/constants/orders.ts) 有 `overrides` 参数。发票锚点是最脆的一类（平台改版就要发版），却没有用户自救通道 |
| [store-license.ts:202-205](packages/shared/src/store-license.ts) | 「名称已一致、仅代码被打码」时 `action` 落到 `'nothing'`（界面话术=「什么都没读到」），语义上更接近 `'same'`。实测：`{licenseName:'A公司',no:''}` + 平台 `{name:'A公司',no:'9233**********D310'}` → `{action:'nothing', conflicts:[], rejected:[licenseNo 打码]}` |
| [task-runner.ts:1258-1259](apps/desktop/src/main/tasks/task-runner.ts) | `pickByHeader` 用**整表 innerText** 匹配（含数据单元格），不是表头行；数据里恰好含「账单号」等词的表会被误选 |
| [retention.ts:136-149](apps/desktop/src/main/services/retention.ts) | 快照按 `(store_id, metric)` 保留 400 条——对发票足够（每 3 小时一条 ≈ 50 天）。`DELETE … LIMIT` 没有 ORDER BY，收敛略慢，非缺陷 |

---

## 五、值得肯定的设计

1. **锚点纪律**：每个平台/方向都标注实测日期与实测条数（`measuredRows`），未实测的平台不登记假选择器，界面对不支持的平台如实说明。
2. **三层方向校验**：`expectHeaders`（缺列就失败）+ `rejectHeaders`（是别人的表就落空）+ `tabVerify`（同名页签校验选中态），并且注释解释了各自**为什么**必要、踩过什么坑。这是本模块最扎实的部分。
3. **区分「本来没有」与「抓失败」**：`emptyOk` + `measuredRows === 0` 让空方向落 0 条快照而不是报错，并在事件失败时把 `FOREIGN_TABLE / PICK_MISS / HEAD_MISS` 分成不同文案。
4. **`pending` 标记**：把「处理中/处理记录」这类已提交流水排除在待办条数与金额合计外，并在界面写明原因（`notPendingNote`），而不是偷偷不算。
5. **金额口径保守**：解析失败返回 `null` 并计数，绝不当作 0 相加；`'—'` 与 `'¥0.00'` 严格区分（虽然界面调用错了，见 P1-2）。
6. **测试直接跑注入页面的同一份源码**（`TABLE_ROW_CLEAN_FN`），避免"单测过了、注入的那份没改"——这个手法值得在其它模块推广。
7. **保留策略覆盖到位**：`store_snapshots` 每店每指标留 400 条，手动录入的行（`source_run_id IS NULL`）永不删。

---

## 六、复核通过、无问题的集成点

这些是我逐条查过、确认没有问题的（列出以免重复排查）：

- **步骤 ↔ 白名单**：4 个平台档案生成的 10/11/13/10 步，逐条通过 `taskStepSchema`（`strict`）+ `stepInputSchemas[type]`（`strict`）。`readTable` 的 `rejectHeaders/expectHeaders/pickByHeader/mergeHeaderTable/emptyOk/keepRows`、`clickByText` 的 `allowJsWhenDetached/within/verifyActive`、`readLabelValue` 的 `allowText/absentOk` 都已在 schema 里声明，没有"拼错一个键就静默失效"的风险。
- **定时链路**：任务以 `storeScope` 绑定店铺 → `scheduler.tick` 跳过无 `storeScope` 的任务 → `fireScheduled` 按 `schedule.backgroundOpen` 后台开页面（`openStoreBrowser({display:false})`），失败只降级为"排队等用户开"，不抛。`agentScheduleSchema` 是 `strict` 且含 `backgroundOpen`（正是修掉"静默 strip"那次问题的结果）。
- **任务更新语义**：`updateTask` 是部分更新，"未传的字段保留原值"——`ensureCollectTask` 只传 `name/steps/schedule`，不会清掉 `storeScope`（否则任务会永远不被调度）。
- **导出与展示同源**：`overview:invoiceExport` 与 `overview:invoiceCenter` 都调 `collectInvoiceRows()`，没有第二处取数实现；`invoiceCsvRows` 的列顺序由 `INVOICE_COLUMNS` 单一来源决定。
- **待办数字口径**：[DashboardView.vue:1026-1036](apps/desktop/src/renderer/src/features/workbench/DashboardView.vue) 的概览待办卡用主进程的 `count`（已按 `pending` 过滤）并 `filter(count > 0)`，与发票中心口径一致。
- **IPC/preload**：`OVERVIEW_INVOICE_CENTER` / `OVERVIEW_INVOICE_EXPORT` 在 `contracts/ipc.ts`、`preload/index.ts`、`env.d.ts`、`profile-misc-handlers.ts` 四处齐备，导出前有 `dataRows.length` 空判并返回可读错误。

---

## 七、建议修复顺序

1. **P1-1 CSV 公式注入**（安全，一行改动 + 一条单测）
2. **P1-2 / P1-3 金额与未解析提示**（同一处逻辑，一起改；补 `invoiceAmountText` 的调用侧单测）
3. **P1-4 失败原因渲染**（补 UI，避免"静默 0 条"）
4. **P1-5 微信 tabVerify**（档案层一行，风险最高的静默错报）
5. P2-7 删除测试副本 → P2-8 表头转义 → P2-11 `__cleanRows` 空判 → P2-12 `normalizeCellText` 返回原文切片（都是小改）
6. P2-10 金额解析锚定 → P2-9 labels `absentOk` → P2-6 Agent 工具口径
7. P3 注释同步 + 删除旧 WorkbenchView 发票段落

---

## 附：本次审查的环境说明

- 工作区 `D:\code\电商浏览器` 起初无法为沙箱授权写权限（`SetNamedSecurityInfoW failed (Win32 5)`），已用 DSH 自带的诊断脚本修复并**验证通过**（`writeOwner: false → true`）。备份与回滚命令在 `D:\code\dsh-acl-recovery\`。
- 本机 PowerShell 执行策略禁止运行 `.ps1`，因此 `pnpm` 直接调用被拦；测试与 lint 改用 `node node_modules\vitest\vitest.mjs` / `node node_modules\eslint\bin\eslint.js` 执行，结论不受影响。
- 审查过程中只新建并删除了一个临时探针测试文件（`tests/unit/zz-review-probe.test.ts`，用于复现第二节的实测输出），**未改动发票模块任何源码**。
