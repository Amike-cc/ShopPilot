# 发票中心审查报告（第二轮）

审查时间：2026-10-14　基线：`c70d01d`（v0.4.63，工作区另有未提交改动）　审查范围：发票中心全链路
前作：[docs/invoice-module-review.md](invoice-module-review.md)（2026-09-30，基线 v0.4.57，12 项问题）——本报告**不重复其内容**，只做两件事：**① 逐项复核它的修复状态；② 补它没覆盖的缺陷**。

---

## 〇、本轮改动与修复状态（2026-10-14 晚，按用户要求实施）

用户要求：让发票中心显示营业执照主体，方便申报。范围定为三件事，已实现并验证：

| 改动 | 位置 | 验证 |
| --- | --- | --- |
| 每行显示**开票主体**（已填 + 平台读回的主体与"是否一致"核对） | [UnifiedDataPage.vue](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue) 行内 `inv-entity-line` | E2E 37/37（新增 3 项断言） |
| 新增**「获取主体营业执照」**入口（只对已实测主体页的平台建只读采集任务 → 按主进程判定回填空执照、冲突不覆盖 → 逐店如实列结果） | 同上 + 复用 `overview.entityApply` / `buildEntityCollectSteps` | E2E 37/37（新增 3 项：入口存在、5 家逐店结果、不写已填执照） |
| **导出跟随营业执照筛选**（渲染层传 key，主进程用共享 `groupStoresByLicense` 再筛一遍，不信任店铺 id） | [store-license.ts 新增 `filterRowsByLicenseKey`](../packages/shared/src/store-license.ts)、[profile-misc-handlers.ts](../apps/desktop/src/main/ipc/profile-misc-handlers.ts)、preload/env.d.ts | 单测 6 项 + E2E 3 项（按钮写明"只导该主体"、主进程按 key 复核） |
| 顺带修掉的既有缺陷 | ① 本报告 **A3**（行内保存后陈旧回填会清空执照）已修：`openLicenseEditor` 改从 `ws.stores` 取值、保存后 `reload`；② 补上 `store-license-names` datalist（活页面里此前没有，补录只能手打）；③ 智能体文案「抓取待开票信息」→「采集发票数据」 | E2E 37/37 |
| 验收脚本 | [invoice-license-local-verify.js](../tools/acceptance/invoice-license-local-verify.js) 26 → **37 项**，[release-manifest.js:156](../tools/release/release-manifest.js) 计数同步 | 真机 Electron 实跑 **37/37 通过** |
| 独立复核后修掉的三处（复核交由另一路只读审查，结论逐条复核后采纳） | ① 主体核对结论把"平台没读到的字段"当成一致、把"店里空着"当成冲突 → 抽成共享纯函数 `compareStoreEntity` / `entityVerdictText`（[store-license.ts](../packages/shared/src/store-license.ts)）并补 5 条单测；② **只填了信用代码的主体**导出时标签回落到"全部主体"、文件名不带主体 → 新增 `licenseScopeLabel`（名称 → 代码 → key）并补单测；③ 采集任务没创建/没启动时被静默跳过、却报「没有需要新填的主体」（结论其实来自旧快照）→ 逐店记原因、钉在结果行上，提示改为"N 家没能开始采集" | 单测 1137 → **1145**；E2E 仍 **37/37** |
| 复核提出、本轮一并修掉的细节 | 行内保存后不再整页 loading（只重取发票载荷，滚动位置不丢）；`openLicenseEditor` 不再用旧载荷兜底（否则"清空执照+载荷还是旧值"会把清空撤销）；结果里补上"平台值读于 …"；个人店铺方向的提示文案不再让人重复点 | typecheck 0 错误 / lint 0 错误 |

**仍然未修**（本报告后面各条保持原状）：A1 发票明细不渲染、B2 导出混入 `pending:false` 行且无标记、B3 读取失败显示成"暂无发票记录"、B4 概览待开票不刷新、B5 发票快照以原始 JSON 漏进经营分析，以及第二节表里上一轮的其余各项。

### 〇-补二：2026-10-14 晚 两个高危项已修（"继续"那一轮）

| 缺陷 | 修法 | 验证 |
| --- | --- | --- |
| **A2 空快照覆盖已采数据**（页签没切成功 → 写 `[]` → 读取侧"取最新一条"把上次真采到的行无声盖掉，运行还报 succeeded） | 采集侧改写**带原因的标记** `{empty:true,why}`（[task-runner.ts](../apps/desktop/src/main/tasks/task-runner.ts) 的 `emptyResult`）；读取侧新增纯函数 [invoice-snapshot.ts](../packages/shared/src/invoice-snapshot.ts) `pickSectionRows`：行数据取最新一份**数组**快照、标记只作提示、旧标记（后来成功过）忽略；界面在方向行上标红「本次没读到（时刻）」并用 tooltip 说明"下面是上一次的数据" | 单测 7 条 + **真实库复现**：给「微信小店测试 / 申请平台开票」（5 条）插入标记后 → **行数仍 5**、提示出现、时间戳仍是数据时间；删标记后恢复原状 |
| **上一轮 P1-1 CSV 公式注入**（买家填的抬头/税号以 `=`/`+`/`@` 开头时，Excel/WPS 打开导出文件会当公式执行） | [invoice-csv.ts](../packages/shared/src/invoice-csv.ts) 新增 `neutralizeCsvFormula`：`= + @ \t \r` 开头加 `'` 前缀；`-` 开头但**不是纯数字**的才加（保住退款/冲正的 `-12.50` 不被代账求和搞坏） | 单测 5 条（DDE/WEBSERVICE 载荷、负数不动、整条 CSV 端到端） |

**门槛（修完重跑）**：`vitest` **116 文件 / 1165 用例**通过、`tsc` 0 错误、`eslint` 0 错误、构建成功、发票中心验收 **37/37**。

### 〇-补三：2026-10-14 晚第二轮（"按顺序完成"）——展示层与口径类

| 编号 | 缺陷 | 修法与证据 |
| --- | --- | --- |
| **A1** | 发票明细完全不渲染（屏上只有「方向名 + N 条」，采到的单号/金额/抬头看不到） | [UnifiedDataPage.vue](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue)：每个有记录的方向加「查看明细（N 条）」→ 展开**整行宽**表格（列按方向动态裁：只留有值的列 + 有值时的「其他信息」；最多 200 行，超出提示用导出）。真实库实测：微信「申请平台开票」6 条 / 「给平台开票」2 条，表头与单元格都渲染出来了 |
| **P1-4** | 主进程算好的 `lastFail` / `loginRequired` / `unsupportedReason` / 实测条数**都不显示** | 同上：行内新增红条「最近一次采集失败（时刻）：原因」「该店登录态已失效…+「去登录」（打开后台首页）」「平台未实测原因」；方向行新增「比实测少（N）」黄标（`measuredRows` 兜底）。真机实测：快手那条 `TASK_TAB_NOT_ACTIVE` 失败现在能在界面上看到原因 |
| **P1-5** | 微信发票页签**没有选中态校验**（切页签静默失败会读错方向） | 真机实测：页签是同一容器内的 span，选中态 `text-[#0AB8A6]`、未选中 `ml-[40px]`；容器 class 含 `h-[56px]`+`mt-[32px]`（light DOM 可见）。据此登记 `tabWithin/tabVerify`，并把 `verifyActive` 扩展为支持 **`deep: true`**（穿透开放 ShadowRoot）——实测切到该方向后页签与表格一起进了 micro-app 的 ShadowRoot，document 级选择器一个都看不到，不支持 deep 会把"切成功了"误报成"没切成功" |
| **P1-3** | 「N 条金额无法解析」提示嵌在 `v-if="historical"` 里 → 只有快手（有 pending:false 方向）能看到，其余平台合计偏小却无解释 | 抽成独立的 `invoice-unparsed-note` 段落，任何平台都会显示 |
| **P1-2** | 金额合计用 `amount > 0` 判"有没有值" → 「全是 0.00」与「退款把净额抵成负数」两种真实情况都显示成「—」 | 改为 `count - unparsed > 0`（解析出过至少一条）；主体胶囊同理。单测钉住 0/负数 |
| **B2** | 导出含 `pending:false`（已提交、无需操作）的行，而文件名/合计都叫"待开票"，且没有标记列 | CSV 末尾追加「是否待办」列（**不动**代账习惯的前 14 列顺序）；返回体与 toast 同时给出「待开票 N 条 / 无需操作 M 条」；审计带上两个数 |
| **B3** | 发票通道读取失败被当成"暂无发票记录" | `load()` 收集各通道错误 → 顶部红条列出「发票数据读取失败：…」；空态改为「发票数据没读出来（原因见上方红条）——这不等于"没有发票"」（新增 `invoice-load-failed` 钩子） |
| **B4** | 从发票中心返回经营总览时「待开发票」不刷新 | `navigateTo('overview')` 时补一次 `loadInvoiceTodo()` |
| **B5** | 发票整表快照（最大 2000 行 × 500 字符，且含买家抬头/税号）被 JSON.stringify 后漏进「指标快照」卡片 | 主进程 `overviewDatacenter` 的查询排除 `invoice.%`（发票中心自己有方向+明细展示） |
| **P2-6** | Agent 汇报把"店铺行数"说成"N 条" | 改为「N 家店铺、共 M 条待办」，M 按 `isPendingSection` 口径数真实条目 |
| **P2-7** | "算不算待办"的规则在渲染层/主进程/CSV/单测里各写一遍（改一处就漂移） | 抽 `isPendingSection()` 到 shared，四处统一调用 |
| **P2-8** | CSV 表头没走转义（列名一旦含逗号就整行错位） | `buildInvoiceCsv` 表头也走 `escapeCsvCell` |
| **P2-9** | labels 模式某个标签行不存在时整轮采集判失败（其它标签其实都读到了） | labels 的 `readLabelValue` 加 `absentOk`（缺的列留空，其余照常展示） |
| **P2-10** | 金额解析从任意位置抠第一段数字 → 「2 笔订单」被算成 2.00、「订单号 …」变天文数字 | 改为"整串就是一个金额"（允许货币符号、已知金额前缀词、千分位、末尾「元」）；`2 笔订单`/`订单号…`/`¥1.00（2 笔订单）` 一律判未解析 |
| **P2-11** | 行清洗函数在空表/首行非数组时抛异常（注入脚本一抛，整步报看不懂的错） | `__cleanRows` 加空表与畸形输入保护；单测覆盖 |
| **P2-12** | `normalizeCellText` 去重时返回"压缩掉空格"的半段（与页面文案不一致） | 从**带空格的原文**回填前半段 |

**门槛（第二轮修完）**：`vitest` **116 文件 / 1172 用例**通过、`tsc` 0 错误、`eslint` 0 错误、构建成功、验收 **37/37**。

**另记（本轮实测发现的既有脆弱点，不在本次修复范围）**：
- 快手发票任务真机跑出 `TASK_TAB_NOT_ACTIVE`（点「处理中」页签没切过去）——这正是**旧 tabVerify 在起作用**：以前会静默读到「未开票账单」的数据。失败原因与"店铺窗口未显示时 real 点击不生效"一致，属既有行为，需单独排查。
- 抖店发票任务真机跑出 `TASK_SELECTOR_CHANGED: 超时未出现元素 table`（发票页未渲染出表格）。
- **队列泵不重试**：`pump()` 只在"店铺浏览器已打开"时才启动排队运行（`task-runner.ts` 的 `open.includes(r.storeId)`），而它只在入队/上一轮结束时被调度。真机复现 3 次：某个店的运行入队后，若它的店铺浏览器被窗口管理器回收关闭，这条运行会**一直停在 queued**（既不超时也不重开浏览器），任务也就一直"排队中"。定时采集若走到这条路径会静默不执行——建议后续给 pump 加周期重试（或入队时就打开店铺浏览器）。
- **real 点击偶发不生效**：同一份步骤，微信「给平台开票」页签出现过 2 次点击未生效、1 次成功（都带 tabVerify）。现在这类失败会**如实中止**（而不是读错方向），但会让该轮采集失败——需要单独排查"窗口可见性/焦点"对 trusted-mouse 点击的影响。

### 〇-补六：快手页签"时好时坏"的根因与修复（2026-10-14 晚）

**现场**：快手发票任务当天 3 次失败（`TASK_TAB_NOT_ACTIVE`：点「处理中」没变成选中态）、2 次成功，同一份步骤。
**定位过程**（全部真机、只读）：
1. 直接在该页用 CDP 受信任鼠标点「处理中」→ **立刻切换成功**；JS 合成点击也成功 ⇒ 页面与页签本身没问题；
2. 在页面注入事件记录器（`Page.addScriptToEvaluateOnNewDocument`，跨导航保留）后跑应用自己的任务：事件**确实**到达（`pointerdown/mousedown/mouseup/click`，`isTrusted: true`，目标 `DIV.ant-tabs-tab-btn` 文案「处理中」）——那一次运行也成功了；
3. 关键差异：该页页签横条的 y 坐标会随上方内容加载在 **515 ↔ 414 之间跳约 123px**。
**根因**：运行器是"先算坐标（`getBoundingClientRect` + 遮挡采样）→ 再由主进程发 `sendInputEvent`"，两步之间页面若继续排版，点击就落在页签下方一百多像素处——点空。以前没有选中态校验，这种点空会**静默读到上一个页签的数据**（「处理中」显示成「未开票账单」）；今天加了 tabVerify 才暴露成失败。
**修复**：`clickByText` 的 `verifyActive` 分支改为**校验不过就重新定位再点一次，最多 3 次**（每次重新 `findTextTarget` 取新坐标并重发点击，单次校验预算 4–8s）。安全性：带 `verifyActive` 的目标都是**选择类控件**（页签、筛选 chip），重复点幂等；真正会提交的动作走 `waitUrl` 那条路（默认 `attempts=1`、必须显式声明），不受影响。三次都不过仍如实报 `TASK_TAB_NOT_ACTIVE`（错误信息里注明"含重试共 3 次"）。
**修复后实测**：快手发票任务连续 3 轮运行全部 `succeeded`，三个方向读数齐备（未开票账单 5 条 / 处理中 0 条（无需操作）/ 处理记录 3 条，均为当次新快照）。

### 〇-补四：微信页签校验的真机验证结论（2026-10-14 晚）

- 实测锚点：页签 span 的选中态类名 `text-[#0AB8A6]`（未选中 `ml-[40px]`）；页签容器 class 含 `h-[56px]`+`mt-[32px]`。
- **必须 `deep: true`**：切到「给平台开票」后页签与表格一起进 micro-app 的 ShadowRoot，document 级选择器全看不到 → 为此给 `verifyActive` 增加 `deep?: boolean`（复用运行器已有的 `ENUM_DEEP_FN` 穿透枚举），schema 同步；快手等非 deep 页签行为零变化。
- **不加 `tabWithin`**：实测给这个页签限定范围后点击不生效（校验如实报「申请平台开票(选中)」）；不限定范围时该文案在整页只有 1 个候选、real 点击有效。
- 端到端实测（经界面点「采集发票数据」→ 任务步骤由档案重写 → 跑完）：`clickByText 给平台开票 → verifiedActive:true`、读到该方向的表（含「处理状态」列，3 行）、`给买家开票 → verifiedActive:true`、该方向无表落 empty 标记。界面读数：`申请平台开票 6 条 / 给平台开票 2 条 / 给买家开票 0 条 + 本次没读到`。

### 〇-补五：P3 死代码清理

`apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue`（346 KB / 6138 行）已删除：
全仓除注释与一次性脚本外**无任何 import**，构建产物里也不含它的钩子；旧界面重制后它只是维护陷阱
（本轮「dat-alist 指向已废弃弹窗」那个悬空入口就出自它）。`workspace.ts` 里指向它的过期注释同步改写。
如需保留可 `git restore` 取回。

**最终门槛**：`vitest` **116 文件 / 1172 用例**通过、`tsc` 0 错误、`eslint` 0 错误（1061 条存量 warning）、构建成功、发票中心验收 **37/37**。

### 〇-补七：快手采集恢复 + 一次自己引入的回归（2026-10-14 傍晚）

1. **快手页签点击的竞态修复**（详见〇-补六）：`verifyActive` 分支改为"校验不过就重试，最多 3 次"——第 2 次仍用受信任鼠标（重新取坐标），第 3 次改用**不经过坐标的 JS 兜底点击**（`jsClickByTextFallback`，新函数）。修复后快手发票任务**连续 3 轮全部 succeeded**，三个方向齐备（未开票账单 5–6 条 / 处理中 1 条 / 处理记录 3–4 条，均为当次新快照）；微信任务同时复测 succeeded（deep 页签校验仍通过）。
2. **我自己引入的回归（验收脚本当场抓住）**：恢复工具栏时发现 `data-test="invoice-export"` 的导出按钮**被此前某次编辑整行删掉**（HEAD 里没有它，所以 git diff 看不出来），验收第 13 步（导出跟随主体筛选）报 `Cannot read properties of null` 才暴露。已按原口径恢复（`.inv-header` 工具栏，文案 `exportScopeLabel`、title `exportScopeTitle`、`@click="exportInvoices"`），并加注释提醒"改这段工具栏必须保留该钩子"。**教训：验收脚本里针对固定钩子的断言，是这类"整行误删"的唯一防线。**
3. **顺带清掉的死代码**：`PlatformIcon` 导入、`invoicePlatforms`、`invoiceSubjectCount`、`invoiceUnlicensedCount`、`invoiceRowStatus`、`invoiceStatusCount`、`invoiceRowDirectionText`（模板里已无引用的半成品筛选/状态遗留）。其中 `invoiceRowAmountText` **接进了行头**（每店「可开 ¥…」，申报逐店对账用）；同时发现发票列表的"平台/状态/时间/文本"筛选**逻辑齐备但没有渲染控件**（`invoicePlatformFilter` 等恒为默认值）——留作后续待办。
4. 另修：导出按钮原来引用的图标变量名是错的（`dataInvoiceExportSheetIcon` 并不存在，导入名是 `dataExportSheetIcon`），已改对；模板里未定义的变量 `tsc` 查不出来（Vue 模板不参与 `tsc --noEmit`），只能靠验收脚本渲染时暴露。

注意：`ENTITY_PROFILES`（[constants/entity.ts](../packages/shared/src/constants/entity.ts)）**目前只登记了快手小店**；微信小店（主体卡 display:none + 代码掩码）、抖店、拼多多都只有"未实测"说明。所以「获取主体营业执照」对这三家平台只能如实回报"暂不能自动获取"，要自动取主体得先在其后台做一次真机锚点实测。

### 〇-补：2026-10-14 晚 主体页真机实测结果（用户登录了全部店铺后）

| 平台 | 实测结论 | 处置 |
| --- | --- | --- |
| 快手小店 | 复测通过：`/zone/shop/info/qualification` 读到「个体工商户名称」「统一社会信用代码」；「企业名称」缺席按 absentOk 容忍 | 档案保持 |
| **拼多多** | **新登记**：`/mallcenter/info/main/index`（店铺信息 → 主体信息标签）的「营业执照信息」区块逐行给出 营业执照 / 个体工商户名称 / 营业执照注册号 / 营业执照有效期。本店是**个人店铺**，四行都是「无」 | 已登记档案（`measuredAt: 2026-10-14`，代码标签候选 = 营业执照注册号 + 统一社会信用代码，名称候选 = 个体工商户名称/企业名称/公司名称） |
| 微信小店 | **取不到**：`/shop/setting/profile` 的主体信息悬浮卡里只有「主体类型 个体工商户」「营业执照类型 三证合一」和**打码**的 `9233**********D310`，**没有主体名称**，且整卡是隐藏浮层 | 保留 unsupported，理由按实测重写（含日期） |
| 抖店 | **没找到可读页**：登录态下查了 店铺管理→常用工具 / 资质中心 `/ffa/grs-new/qualification/list` / 账号管理 `/ffa/w/login/account`，只有「店铺类型 个体店」与品牌·类目·商品资质，没有主体信息页 | 保留 unsupported，理由按实测重写（含日期）；不猜锚点 |

**实测顺带挖出并修掉的两个真缺陷**：

1. **占位文案会被当成真值写进执照**（高危）：拼多多个人店铺的「营业执照信息」四行都写「无」——「无」不是掩码、长度也合法，原实现会把它写成"主体名称=无"（比不填更糟：申报表上出现假主体）。已在 `decideLicenseWrite` 加 `PLACEHOLDER_RE`（无/暂无/未填写/保密/-/N/A…），显示侧同步新增 `platform-placeholder` 结论（不再说"平台读到了"）。单测钉住，并在**真实库**上验证：`entityApply` 对慕么美返回 `nothing` + 两条 rejected，`written: {}`，主体未被改动。
2. **代码标签文案会随主体形态变**：`noAnchor` 单值不够 → 档案新增 `noAnchors` 候选（与 `nameAnchors` 同一思路，缺席不失败），步骤构造同步。

**真机验证（真实库 + 真实登录态，我的构建）**：为快手/拼多多各跑一条只读采集任务 + `overview.entityApply()` → 快手 `same`（不覆盖）、拼多多 `nothing`（占位被拒）、微信/抖店 `unsupported` + 具体原因；**四家店的主体字段一个都没被改**。

---

## 一、实测基线（本次跑过的）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `node node_modules/vitest/vitest.mjs run` | **115 文件 / 1130 用例全部通过**，退出码 0（输出里仍有 `sales-metrics-scheduler` 的收尾竞态告警，不影响结果） |
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | **0 error** |
| Lint | `node node_modules/eslint/bin/eslint.js <9 个发票相关文件>` | **0 error**，141 warning（全部 `no-explicit-any`） |
| 行为探针 | 临时 vitest 探针（已删除）直调生产函数 | 见下方各条「实测」 |

探针原始输出（节选，全部来自真实生产实现，非副本）：

```
escapeCsvCell("=cmd|'/c calc'!A0") => "=cmd|'/c calc'!A0"     ← 原样
escapeCsvCell("+1+1")/("@SUM(1)")/("\t=1+1") => 原样
buildInvoiceCsv([]) => "\uFEFF"（长度 1，只有 BOM、没有表头行）
invoiceAmountText(0,false)='—' / (0,true)='¥0.00' / (-12.5,false)='—' / (-12.5,true)='¥-12.50'
parseInvoiceAmount('100 200')=100200 / ('2026年05月')=2026 / ('(100.00)')=100 / ('1.2.3')=1.2
normalizeCellText('12341234')='1234' / ('A B A B')='AB' / ('上海 某某 公司 上海 某某 公司')='上海某某公司'
__cleanRows([]) => TypeError: Cannot read properties of undefined (reading 'map')
导出列 = 店铺/平台/营业执照/统一社会信用代码/开票方向/8 个统一列/其他信息（无「是否待办」列）
```

审查方法：通读源码 → 独立跑门槛 → 三路并行深挖（主进程链路 / 渲染层 / 测试覆盖率）→ **逐条复核每条结论的原文与行号**（其中驳回 1 条子代理结论：`tools/acceptance/invoice-license-local-verify.js` 实际执行 26 项断言，[release-manifest.js:156](../tools/release/release-manifest.js) 的「26 项」标注是**正确的**）。

---

## 二、上一轮 12 项的修复状态：**一项未修**

`docs/invoice-module-review.md` 的 12 项在 v0.4.57 → v0.4.63 之间全部原样存在（行号已随代码增长偏移，下列为**当前**位置）：

| 原编号 | 级别 | 现状 | 当前位置 | 本次复核证据 |
| --- | --- | --- | --- | --- |
| 1 | P1 安全 | **未修** | [invoice-csv.ts:60-63](../packages/shared/src/invoice-csv.ts#L60-L63) | 探针：`=cmd\|'/c calc'!A0` 原样输出，无 `'` 前缀 |
| 2 | P1 正确性 | **未修** | [UnifiedDataPage.vue:229](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L229)、`:234`、`:272` | 探针：`invoiceAmountText(-12.5,false)='—'` |
| 3 | P1 正确性 | **未修** | [UnifiedDataPage.vue:49](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L49) | `unparsed` 提示仍嵌在 `v-if="invoiceTotal.historical"` 里 |
| 4 | P1 正确性 | **未修** | 产出 [overview-service.ts:197](../apps/desktop/src/main/services/overview-service.ts#L197)、`:205-209`；消费缺口 `UnifiedDataPage.vue:82-122` | 全仓 grep：`lastFail`/`loginRequired`/`unsupportedReason`/`measuredAt`/`entity*` 只命中死代码 WorkbenchView |
| 5 | P1 正确性 | **未修** | [constants/invoice.ts:150-181](../packages/shared/src/constants/invoice.ts#L150-L181) | 微信 3 个方向仍**都没有** `tabVerify`（只有快手有） |
| 6 | P2 | **未修** | [agent-service.ts:2589-2596](../apps/desktop/src/main/services/agent-service.ts#L2589-L2596) | 仍 `rows.length`（=店铺数）说成「待开票清单共 N 条」 |
| 7 | P2 | **未修** | [invoice-collect.test.ts:187-231](../tests/unit/invoice-collect.test.ts#L187-L231) | `parse`/`esc` 两份手抄副本仍在，真实函数未被 import |
| 8 | P2 | **未修** | [invoice-csv.ts:73](../packages/shared/src/invoice-csv.ts#L73) | 仍 `headers.join(',')`，未转义 |
| 9 | P2 | **未修** | [invoice-steps.ts:71-87](../packages/shared/src/invoice-steps.ts#L71-L87) | labels 方向仍无 `absentOk` |
| 10 | P2 | **未修** | [invoice-amount.ts:22](../packages/shared/src/invoice-amount.ts#L22) | 探针：`'100 200'` → `100200` |
| 11 | P2 | **未修** | [constants/invoice.ts:457](../packages/shared/src/constants/invoice.ts#L457) | 探针：`__cleanRows([])` 抛 TypeError |
| 12 | P2 | **未修** | [constants/invoice.ts:427-437](../packages/shared/src/constants/invoice.ts#L427-L437) | 探针：`'12341234'`→`'1234'` |

P3 清理项同样全部在：注释漂移（`overview-service.ts:48-52` 描述「overview-service 反过来 import 本文件」、`:245` 写不存在的 `invoice.rows`）、[constants/invoice.ts:16](../packages/shared/src/constants/invoice.ts#L16) 与同文件 306-375 行自相矛盾（文件头说快手不登记）、[task-step-schemas.ts:81](../apps/desktop/src/main/tasks/task-step-schemas.ts#L81)「抖店给消费者开票结构未验」与已实测档案矛盾、[store-license.ts:79](../packages/shared/src/store-license.ts#L79) 缺换行、`INVOICE_SUPPORTED_PLATFORMS` 仅单测引用、`invoiceProfileFor` 无 overrides 而 [ordersProfileFor](../packages/shared/src/constants/orders.ts#L68) 有、死代码 `WorkbenchView.vue`（6138 行，发票实现约 4480-5100 行）仍在并被 `tools/maintenance/export-copy.js:82` 当关键文件。

---

## 三、本次新增缺陷

### A1【高】发票明细一条都不渲染：页面只有「方向名 + 条数」

**位置**：[UnifiedDataPage.vue:116-121](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L116-L121)（消费面）、[overview-service.ts:113-121](../apps/desktop/src/main/services/overview-service.ts#L113-L121)（产出面）

```html
<div v-for="section in row.sections" :key="…" class="invoice-section" data-test="invoice-section">
  <span>{{ section.name }}<em v-if="section.pending === false" …> 无需操作</em></span>
  <b>{{ section.items?.length || 0 }} 条</b>
</div>
```

**证据**：`items[].cells` 全文只出现在 `:223`、`:265`（只用于求和）；`extras`、IPC 返回的 `columns` 在渲染层**零引用**（已 grep）。主进程却把整行都算好了（`cells` 8 个统一列 + `extras` 未映射列）。
**后果**：用户看不到任何**单号 / 金额 / 抬头 / 税号 / 承诺期**，"下一步去平台开票"只能靠导出 CSV 或自己进后台；KPI 的金额也没有任何可核对明细。与本页副标题「只展示平台页面采集到的**记录**」([:76](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L76))、应用卡「汇总真实待开票**记录**」（[UnifiedAppsPage.vue:404](../apps/desktop/src/renderer/src/features/workbench/UnifiedAppsPage.vue#L404)）以及 0.4.22 版发版说明「真的把待开票清单读回来展示」都不符。旧弹窗（死代码 [WorkbenchView.vue:1135-1142](../apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue#L1135-L1142)）有完整表格与「其他信息」列。
**触发**：任意有数据的店铺 → 展开任意一行。
**修法**：按 `INVOICE_COLUMNS` 把 `items[].cells` 渲染成（可折叠的）表格 + `extras` 摘要。数据已在 IPC 载荷里，属纯渲染改动。

### A2【高】`emptyOk` 方向的瞬时读取失败会写空快照**覆盖已采到的行**，而运行仍报成功

**位置**：[invoice-steps.ts:91-104](../packages/shared/src/invoice-steps.ts#L91-L104) → [task-runner.ts:1538-1544](../apps/desktop/src/main/tasks/task-runner.ts#L1538-L1544)、`:1590-1599` → 读取侧 [overview-service.ts:62-68](../apps/desktop/src/main/services/overview-service.ts#L62-L68)、`:161-170`

```ts
const verifiedEmpty = sec.measuredRows === 0           // 档案里"实测 0 条"→ 允许空
… ...(verifiedEmpty ? { emptyOk: true } : {})
const emptyResult = (why: string) => { if (input.metric) TaskStore.insertSnapshot(storeId, metric, input.keepRows ? [] : 0, run.runId) … }
if (rows === 'PICK_MISS') { if (emptyOk) return emptyResult('页面上没有表头含…的表格') … }
```

`insertSnapshot` 是**纯 INSERT**（[task-store.ts:334-338](../apps/desktop/src/main/tasks/task-store.ts#L334-L338)），读取侧取 `ROW_NUMBER() … ORDER BY rowid DESC` 的第一条 → 新写的 `[]` 直接成为"最新数据"。
**后果**：抖店「给消费者开票」、微信「给买家开票」（档案实测当天 0 条 → `emptyOk`）**本来就会随买家申请而长出数据**。一旦某轮页签没切成功 / 页面未加载完，读到别方向的表 → FOREIGN_TABLE → `emptyResult` 写入 `[]` → 屏上该方向归零、`capturedAt` 却是**最新时间**、run 状态 succeeded、`lastFail` 保持 null（且界面根本不渲染失败，见 B3/上一轮 P1-4）→ **已采到的真实待开票记录无声消失**。
**触发**：上述方向先成功采到数据，之后出现一次页签/加载瞬时失败。
**置信度**：机制 CONFIRMED（写 `[]`、按 rowid 取最新、不抛错三处全部追通）；瞬时条件是否常见需真机一轮确认。
**修法**：`emptyOk` 只应表达"这一步不算失败"，不该写成权威空结果——`emptyResult` 改为**不写快照**（或写带 `suspicious:true` 标记的快照），读取侧遇到可疑空时保留上一份并提示"本次没读到"。同时 `verifiedEmpty` 的语义要从"档案实测过 0 条"改成"该方向确实可以没有数据"。

### A3【高】行内保存营业执照后行数据陈旧：标签不更新，**再点一次保存会把刚填的执照清空**

**位置**：[UnifiedDataPage.vue:86-93](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L86-L93)（读 payload 的行对象）、`:275-290`（保存）、[workspace.ts:526-534](../apps/desktop/src/renderer/src/stores/workspace.ts#L526-L534)

```ts
{{ row.licenseName || '未填营业执照' }}            // ← row 来自一次性 IPC 载荷
const result = await ws.setStoreLicense(row.storeId, licenseDraft.name.trim(), licenseDraft.no.trim())
// workspace.ts:532 只有 await this.refreshStores()，从不重取 invoiceCenter
function openLicenseEditor(row: any) { licenseDraft.name = row.licenseName || '' … }   // ← 仍用陈旧 row 回填
```

**后果（无条件成立）**：保存成功后胶囊条立刻变成「B 公司 2 家」，但这一行仍显示「未填营业执照」、tooltip 仍是「点这里填营业执照」——同屏自相矛盾。
**后果（第二步）**：用户见标签没变会再点一次 → 编辑框按陈旧 `row` 回填成**空** → 直接点「保存」→ `setStoreLicense(id, '', '')`（空串合法，[schemas/store.ts:22](../packages/shared/src/schemas/store.ts#L22)、`:27-32`）→ **刚填好的主体与信用代码被静默清空**，toast 仍报「营业执照已保存」。发票按主体分账，错一个公司就是错票。
**对照**：旧实现刻意避开过这一点——[WorkbenchView.vue:4589-4591](../apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue#L4589-L4591) 注释「行内刚改完主体要立刻生效，不能等下一次『刷新』把发票数据重新拉一遍」。
**触发**：发票中心 → 行内补录主体并保存 → 再点该行标签 → 直接保存。
**修法**：标签与草稿都从 `ws.stores` 取值（或保存成功后 `await load()`）；`openLicenseEditor` 以 `ws.stores` 为准。

### B1【中】导出不跟随「营业执照」筛选：选中 A 公司导出，拿到全部主体

**位置**：[profile-misc-handlers.ts:288-294](../apps/desktop/src/main/ipc/profile-misc-handlers.ts#L288-L294)（通道**无入参**）、[preload/index.ts:115](../apps/desktop/src/preload/index.ts#L115)、[UnifiedDataPage.vue:245-249](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L245-L249) vs `:432`

屏上 KPI 明确「跟着当前筛选走」（`:251` 注释），导出却是 `collectInvoiceRows()` 全量；文件自带「营业执照 / 统一社会信用代码」两列 → 把 A 公司的清单交给 A 的代账时，顺带带出其他主体的单号/金额/税号，toast 也不说范围。
**修法**：通道加经 strict schema 校验的 `storeIds`/`licenseKey`，或在按钮与文件名上写明「导出全部主体」。

### B2【中】导出把 `pending:false`（已提交/已通过）一起导出且无标记，三处口径互相打架

**位置**：[invoice-csv.ts:44-56](../packages/shared/src/invoice-csv.ts#L44-L56)（全文不含 `pending`）、[profile-misc-handlers.ts:294](../apps/desktop/src/main/ipc/profile-misc-handlers.ts#L294)、`:303`（文件名 `待开票清单-YYYY-MM-DD.csv`）、[UnifiedDataPage.vue:432](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L432)

探针实测导出列为：`店铺/平台/营业执照/统一社会信用代码/开票方向/单号·账单号/…/其他信息`——**没有「是否待办」列**。
**后果**：快手店铺（未开票账单 5 + 处理记录 3）屏上「待开票条数 5」，导出 toast 却说「已导出 **8** 条记录」，文件里 3 行是已审核通过的流水；同页 [:50-51](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L50-L51) 刚声明这些行「不计入」；代账按「可开金额」列求和会把已提交的账单再算一遍（同一账单在「未开票账单」与「处理记录」各占一行）。
**修法**：导出按 `sec.pending !== false` 过滤（或加「是否待办」列并把按钮/文件名改成「全部记录」），toast 用过滤后的条数。

### B3【中】发票读取失败被当成「暂无发票记录」

[UnifiedDataPage.vue:340](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L340)：`invoiceData.value = responses[2].ok ? responses[2].data : { rows: [] }`——只有 `responses[0]`（datacenter）失败才 throw 并显示 `errorMessage`。`overview:invoiceCenter` 返回 `ok:false` 时页面安静显示「暂无发票记录。采集结果会由本机任务写入数据库。」，与「确实没采过」不可区分（旧实现是 toast 报错，[WorkbenchView.vue:4851](../apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue#L4851)）。orders 分支同样。

### B4【中】概览「×× · 待开发票」采集后不刷新

[DashboardView.vue:1396-1400](../apps/desktop/src/renderer/src/features/workbench/DashboardView.vue#L1396-L1400) 的刷新被 `isOnOverview.value &&` 挡着，`loadInvoiceTodo()` 只在挂载（`:1011`）与该事件里调用，[navigateTo](../apps/desktop/src/renderer/src/features/workbench/DashboardView.vue#L1149-L1185) 不重取。而 DashboardView 由 App.vue 常驻挂载。
**触发**：经营总览 → 进发票中心 → 采集 → 返回经营总览：待办卡与「N 项待处理」仍是采集前的数字（本会话内不恢复）。
**修法**：切回 overview 时补一次 `loadInvoiceTodo()`。

### B5【中】发票整表快照以**原始 JSON** 漏进「经营分析 → 指标快照」

[overview-service.ts:327-338](../apps/desktop/src/main/services/overview-service.ts#L327-L338) 的快照查询**不筛指标**（datacenter 里 `invoice.*` 与 `biz.*` 一起返回），[UnifiedDataPage.vue:17](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L17) 用 `displayValue` 渲染，而 `displayValue` 对对象走 `JSON.stringify`（`:337`）。
**后果**：经营分析页会出现 `invoice.toPlatform = [["账单名称",…],["28351275426",…]]` 这类整表 JSON（单方向上限 2000 行 × 500 字符），既是视觉垃圾也是性能尖峰；同时**买家填写的抬头/税号**会以原始 JSON 出现在与发票无关的卡片上——而发票中心本身反而看不到这些字段（见 A1）。
**修法**：datacenter 排除 `invoice.%`（或渲染层过滤），或只显示行数摘要。

### B6【低】其它已核实项（表格）

| # | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| C1 | [profile-misc-handlers.ts:296](../apps/desktop/src/main/ipc/profile-misc-handlers.ts#L296) + [UnifiedDataPage.vue:5](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L5) | 导出按钮常亮（旧版有 `:disabled="!invoiceTotal.count"`），错误文案指引点击**已不存在**的「抓取待开票信息」（活页面叫「采集发票数据」） | 空数据时点导出只得到一句指向旧 UI 的错误 |
| C2 | [UnifiedDataPage.vue:359-372](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L359-L372) | `ensureCollectTask` 丢弃 `task.update` 的返回值；任务有未结束运行时 update 会抛 `TASK_BAD_STATE`（[task-store.ts:171](../apps/desktop/src/main/tasks/task-store.ts#L171)） | toast 宣称「发票每 3 小时自动更新一次」，而上方自动更新条同时显示「尚未启用」 |
| C3 | [UnifiedDataPage.vue:408](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L408)、`:420` | 开关/状态用 `ws.tasks.find`（列表序 `created_at DESC`），而认领任务按 `updatedAt` 取最新 | 库里若有历史重复「发票采集 ·」任务，可能只切到其中一条（SUSPECTED） |
| C4 | [UnifiedDataPage.vue:238-242](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L238-L242) | 在「未填写」筛选下补录最后一家店的执照后，该组消失 → 筛选静默跳回「全部」 | 列表从 1 家变成全部，用户以为筛选坏了 |
| C5 | [commerce-insight-service.ts:106-111](../apps/desktop/src/main/services/commerce-insight-service.ts#L106-L111) | 智能体导出写 `path.resolve(process.cwd(),'artifacts','agent')`；`buildInvoiceCsv([])` 只有 BOM（探针），仍无条件写文件；[agent-service.ts:2102-2109](../apps/desktop/src/main/services/agent-service.ts#L2102-L2109) 无局部 try/catch | 打包安装后 cwd 可能不可写 → 异常冲出整个计划、无审计；零命中时留下一个只有 BOM 的空 CSV 并报 PARTIAL |
| C6 | [profile-misc-handlers.ts:301-309](../apps/desktop/src/main/ipc/profile-misc-handlers.ts#L301-L309) | 保存框不补/不校验 `.csv` 扩展名；`writeFileSync` 失败只返回 INTERNAL_ERROR，**不留审计** | 用户输入 `报表.txt` 得到 CSV 内容；导出尝试（含失败）无痕 |
| C7 | [env.d.ts:105-106](../apps/desktop/src/renderer/src/env.d.ts#L105-L106)、[overview-service.ts:181-210](../apps/desktop/src/main/services/overview-service.ts#L181-L210) | 载荷无共享类型，只有 `Promise<IPCResult>`；主进程返回约 25 个字段，界面只用约 10 个 | 字段改名/漏传只在运行时变 `undefined`（历史上已因此出现「恒显 0 条待办」） |
| C8 | [overview-service.ts:62-68](../apps/desktop/src/main/services/overview-service.ts#L62-L68)（无 LIMIT，对比 `:337` 的 `LIMIT 600`）；[task-runner.ts:1570](../apps/desktop/src/main/tasks/task-runner.ts#L1570)、`:1588` 的 `slice` 截断无标记 | 单方向载荷上限 ≈2000 行 ×15 列 ×500 字符；`UnifiedDataPage.vue:433` 对**任意**任务终态事件整页重载（`:9` 的 loading 会替换整页） | 多店大表时卡顿/内存尖峰；截断后界面与 CSV 都当完整数据；并发 load 无请求序号守卫 |
| C9 | [overview-service.ts:102-111](../apps/desktop/src/main/services/overview-service.ts#L102-L111) | `mapSection` 假定 `raw[0]` 就是表头行，且不校验"命中列数 > 0"；`expectHeaders` 校验的是前 3 行文本（[task-runner.ts:1575-1582](../apps/desktop/src/main/tasks/task-runner.ts#L1575-L1582)），真表头在第 2 行也能通过 | 表内若有标题/说明行，映射全空但这些行仍计入「待开票条数」并导出成空行（叠加 A1 后屏上完全看不出来） |
| C10 | [overview-service.ts:124-128](../apps/desktop/src/main/services/overview-service.ts#L124-L128) | 快照不记来源档案/平台；[store-manager.ts:201-204](../apps/desktop/src/main/stores/store-manager.ts#L201-L204) 允许改 platform | 改平台后旧快照被新档案 headerMap 重新解释（列大面积为空却仍计数）。UI 暂无改平台入口，暂不可达 |
| C11 | [UnifiedDataPage.vue:440](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L440) 内 `.invoice-row{background:rgba(8,16,31,.45)}` | 浅色主题（`.dashboard-shell --dash-text:#0f1729`，[DashboardView.vue:1463](../apps/desktop/src/renderer/src/features/workbench/DashboardView.vue#L1463)）里唯一的深色行底 | 白卡里一块中灰近黑的行（深色文字对比约 5.6:1，可读但刺眼）；纯视觉问题 |
| C12 | [agent-service.ts:2589-2596](../apps/desktop/src/main/services/agent-service.ts#L2589-L2596)、[schemas/agent.ts:150](../packages/shared/src/schemas/agent.ts#L150) + [agent-service.ts:1648](../apps/desktop/src/main/services/agent-service.ts#L1648) | ①（= 上轮 P2-6）把店铺数说成「待开票清单 N 条」；②`openPanel: 'invoiceCenter'` 仍发 `agent:panelOpen`，而工作区已无渲染层监听（`tests/unit/customer-service-independence.test.ts:42` 反而钉住了"Dashboard 不许含它"） | Agent 侧口径错 + 「已打开发票中心」为静默空操作（当前软件计划入口不可达） |

---

## 四、测试与验收盲区（覆盖「活页面」的几乎没有）

**没有任何测试覆盖**：

- `collectInvoiceRows()` 整个主进程聚合器（[overview-service.ts:54-212](../apps/desktop/src/main/services/overview-service.ts#L54-L212)）：方向→快照映射、`mapSection` 表头映射/`extras`、labels 模式拼接、`pending`→`count`、`lastFail`/`loginRequired`。现有引用都只是**源码文本正则**。
- `readTable` 的运行期分支：`expectHeaders`/`rejectHeaders`/`PICK_MISS`/`HEAD_MISS`/`FOREIGN_TABLE`/`emptyOk`/`mergeHeaderTable`（[task-runner.ts:1545-1607](../apps/desktop/src/main/tasks/task-runner.ts#L1545-L1607)）——正是防「两个方向显示同一批数据」的那套护栏。
- 导出语义：是否含 `pending:false`、是否跟随主体筛选、公式前缀、空结果（[invoice-csv.test.ts](../tests/unit/invoice-csv.test.ts) 只测行组装/转义/BOM）。
- labels（卡片）方向：从步骤到读取**零覆盖**（验收脚本只种了 `invoice.toPlatform` 一条快照）。
- 界面：`[data-test="invoice-section"]` 内容、「无需操作」标记、`lastFail` 提示、明细渲染——都没有断言。
- 载荷形状（C7）与截断标记（C8）。

**验收脚本问题**：

- [tools/acceptance/invoice-license-local-verify.js](../tools/acceptance/invoice-license-local-verify.js)：选择器与当前 UI **全部对得上**（逐条核对过）；执行 26 项断言，与 release-manifest 标注一致。但 `openInvoiceCenter()` 里 `if (nav) nav.click()` / `if (tab) tab.click()` 属静默跳过——选择器过期时只会看到「打不开」这种误导性失败。
- `wx-invite-test/verify-invoice-pro.mjs:30,47-49`、`verify-invoice-center.mjs:34-39`、`verify-invoice-collect.mjs:29-31`、`check-invoice-table.mjs:18` 等十来个脚本仍以 `[data-test="invoice-center-open"]`/`invoice-center-modal`/`invoice-search` 为入口——**这些钩子只存在于死代码 WorkbenchView**。它们若还当"发票中心验收"跑，就是**假绿灯**。

**测试卫生**：[invoice-collect.test.ts:187-231](../tests/unit/invoice-collect.test.ts#L187-L231) 的 `parse`/`esc` 是手抄副本（真实函数没 import，改坏真实实现不会红）；`:112-122` 用 `Object.keys(fixture.headerMap)` 对自己做 `arrayContaining`；[invoice-csv.test.ts:76-80](../tests/unit/invoice-csv.test.ts#L76-L80) 用朴素 `split(',')` 验表头（fixture 一出现逗号就会得出错误结论）。

---

## 五、已复核、确认没问题的部分

- **采集链路设计扎实**：锚点纪律（每方向记 `measuredAt`/`measuredRows`，未实测不登记假选择器）、三层方向校验（`expectHeaders` + `rejectHeaders` + 快手 `tabVerify` 选中态，且 `verifyActive` 按"被点的那一个"校验，[task-runner.ts:2232-2261](../apps/desktop/src/main/tasks/task-runner.ts#L2232-L2261)）、方向间 `metricKey` 唯一且 labels 两侧拼接逐字一致、表头映射以**快照里存下来的表头行**为准（档案修正对旧快照一致生效）；`emptyOk` 区分「本来没有」与「抓失败」的思路正确（问题只在 A2 的写法）。
- **每店每指标取最新**的排序与归属正确（`ROW_NUMBER() … ORDER BY rowid DESC`，`insertSnapshot` 用 `Date.now()`，无回填路径；手动指标被 `^biz\.[a-zA-Z]+$` 限制，污染不到 `invoice.*`）；保留策略同口径。
- **`pending` 口径在计数侧四处一致**（主进程 `count`、KPI、胶囊、行内「无需操作」、概览待办卡）——已提交流水**不会**泄进屏上的条数/金额，**只有导出会**（B2）。
- **营业执照筛选用共享归属表**：`licenseGroups.keyByStore.get(row.storeId)`（[UnifiedDataPage.vue:247](../apps/desktop/src/renderer/src/features/workbench/UnifiedDataPage.vue#L247)），不做每店各算；胶囊「N 家」与主进程 `stores.map`（同一 `deleted_at IS NULL` 谓词）同源，"同名无码店并进有码主体"在筛选与计数两侧一致（不会出现"写 2 家只筛出 1 家"）。
- **筛选后的 KPI vs 固定胶囊**语义自洽；`activeLicense` 对失效 key 会回退。
- **3 小时自动更新链路**：`INVOICE_TASK_PREFIX` 单一事实来源、`{everyMs:10800000, backgroundOpen:true}` 过 strict schema、`schedule:null` 真能清库列、不带 steps 时不被运行态拒绝、面板状态取自 `schedule.everyMs`/`lastFiredAt`（调度器会写），无任务时如实说"先点一次采集"。
- **开票页跳转**：优先档案实测发票页 → 退回后台地址 → 都没有则置灰；tooltip 如实说明"未实测"；走 `ws.openStore` + 新标签页（隔离店铺浏览器），非 `window.open`/shell；渲染层无 `v-html`。
- **行内保存的失败路径正确**（字段级校验消息显示、编辑框不关、不落库）。
- **导出基础正确性**：UTF-8 BOM、CRLF、逗号/引号/换行转义正确；列顺序单一来源 `INVOICE_COLUMNS`；空结果返回可读错误且**不写空文件**（UI 路径）；保存路径只来自系统对话框，无注入面。
- **主进程无算术风险、无 N+1**（整个汇总 3 条 SQL）；`error_message` 截断 240 字符。

---

## 六、建议修复顺序

1. **A2**（空快照覆盖真实数据）—— 一行改「不写快照」+ 读取侧保留旧值；这是唯一会**丢数据**的缺陷。
2. **A3**（行内保存后陈旧回填会清空执照）—— 标签与草稿改从 `ws.stores` 读，或保存后 `load()`。
3. **A1 + B3 + 上一轮 P1-4**（明细渲染 + 失败原因渲染）—— 一次把「屏上看不到东西」的三件事一起补上：明细表格、`lastFail`/`loginRequired`/`unsupportedReason`、"比实测少"提示。
4. **上一轮 P1-1（CSV 公式注入）+ B2（pending 混入）+ B1（筛选）**—— 同一处导出逻辑一起改：文本列加 `'` 前缀、按 `pending` 过滤/加列、按当前主体筛选（或写明"全部主体"）。
5. **上一轮 P1-2/P1-3**（金额 `-`/0 与未解析披露）—— 两处都是 `amount > 0` 与 `v-if` 归属的错，改 3 行。
6. **上一轮 P2-11 / P2-12 / P2-8**（`__cleanRows` 空判、`normalizeCellText` 原文切片、表头转义）—— 各自 1 行 + 单测。
7. **B4 / B5 / C1 / C2**（概览不刷新、快照 JSON 泄漏、按钮与文案、toast 假承诺）。
8. **测试补口**：给 `collectInvoiceRows()` 一条 DB 级用例（方向→快照映射 + pending 排除 + labels 拼接），给 `readTable` 的四种返回抽成纯函数用例，给导出加"公式前缀/是否含 pending/筛选"三条用例；删掉 [invoice-collect.test.ts:187-231](../tests/unit/invoice-collect.test.ts#L187-L231) 的副本与 `wx-invite-test` 里指向死入口的"发票验收"。
9. **P3**：注释同步（4 处）、删除死代码 `WorkbenchView.vue` 的发票段落或整文件（先清 `tools/maintenance/export-copy.js`、`wx-invite-test/*`、docs 引用）。

---

## 七、需要真机才能定论的（本报告已标注 SUSPECTED 的部分）

1. A2：任一 `emptyOk` 方向先有数据、再遇一次页签/加载失败的轮次——看方向条数是否归零而 run 仍是 succeeded。
2. B2：一份真实快手导出——确认同一账单是否同时出现在「未开票账单」与「处理记录」。
3. C3：库里是否存在同店同前缀的重复「发票采集 ·」任务（`SELECT store_scope, COUNT(*) c FROM tasks WHERE name LIKE '发票采集 ·%' GROUP BY store_scope HAVING c>1`）。
4. C5：打包安装后 `process.cwd()` 是否可写。
5. B5/C8：真实库 `SELECT length(value_json) FROM store_snapshots WHERE metric LIKE 'invoice.%'` 的量级分布。
