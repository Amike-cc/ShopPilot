# ShopPilot Agent 实施进度

> **架构迁移记录（2026-09-30）**：已从多 Agent 编排切换为单一 `root-ceo` 运行时。主 Agent 直接执行软件操作和 Job；历史 Agent、HR、执行助手和按 Agent 模型绑定数据在启动时迁移到 root-ceo 后清理，旧 IPC/schema 仅保留兼容并统一返回 `AGENT_SINGLETON_ONLY`。因此本文件早期的子 Agent 验收结果属于历史快照，不代表当前能力；当前验收必须断言只有一个 active root-ceo。

更新时间：2026-10-01

## 当前级别

`PACKAGED / PARTIAL`（本地 Electron、目录包、NSIS 安装/升级/卸载、隔离降级回滚和 CDP 夹具通过；当前唯一运行时 Agent 为 `root-ceo`。真实文本接口连接、单轮 Agent 对话和一个只读纯模型 Job 已于 2026-10-01 通过实测；真实 fallback、费用对账、真实店铺副作用、完整人工桌面逐项验收和 OS 级破坏性夹具仍为 partial/untested）。

> **当前能力口径（2026-09-30）**：运行时只保留 `root-ceo`。它直接负责对话、规划、软件/浏览器操作、Job 执行、审核和记忆治理；Job 仍复用 `TaskRunner` 并保留 evidence、模型 Profile/fallback、预算、技能、插件、确认和恢复机制。历史 Agent、HR、执行助手和按 Agent 模型绑定数据会在启动迁移到 `root-ceo`，旧接口统一返回 `AGENT_SINGLETON_ONLY`。下方 A-M0–A-M6 阶段表、旧多 Agent 验收数字和设计冲突记录保留作迁移历史，不代表当前可创建或调度子 Agent。

## 电商运营能力设计基线（2026-10-01）

- `docs/ECOMMERCE_AGENT_CAPABILITY_SPEC.md` 已完成 `DESIGNED`：定义商品、库存/SKU、订单履约、售后退款、经营数据、财务、内容营销、客服、调度恢复的完整闭环，以及统一动作、确认、幂等、隐私和真实验收门槛。
- M0 文档与契约设计完成；M1～M6 仍按文档逐阶段实施，尚未因此宣称“全部电商能力完成”。
- 商品 IPC/服务已经存在，但只有接入 Agent 工具目录、Main 执行分支、测试和真实平台证据后，才可把对应领域从 `PARTIAL` 升为 `VERIFIED`。

### M1 商品域 Agent 接入（2026-10-01，本轮）

- **状态：`IMPLEMENTED / PARTIAL`**。11 个商品动作已统一经过 `agentSoftwareActionSchema → Main 校验 → Product*Service → SQLite 台账`；发布打开/代填与回读建议仍受人工确认，应用不会点击发布、保存或提交。
- Agent 软件执行结果新增 `results[]` 结构化回执：包含 `status`、`reasonCode`、`safeMessage`、脱敏摘要和 evidence（source/capturedAt/runId/counts）；技能嵌套执行会透传商品回执。
- 验证：`pnpm.cmd typecheck` 通过；商品/Agent 定向套件 8 个文件、145 条通过；结构化回执契约 `tests/unit/agent-product-result.test.ts` 2 条通过。
- 未闭环：真实店铺四平台 Agent 调用、登录过期/安全验证/页面改版/网络失败/重复执行/进程重启，以及真实人工发布回读和 Windows 逐项验收；这些保持 `PARTIAL`、`UNTESTED` 或 `NOT_VERIFIED`，不提升为 `VERIFIED`。
- 真实只读验收尝试因打包启动后 60 秒内未发现 `window.shopilot.products` 而阻塞，未触达平台页面；证据：`artifacts/agent/product-m1-sync-real-verify-20261001.json`。

### M2 库存、价格和 SKU Agent 接入（2026-10-01，当前轮）

- **状态：`IMPLEMENTED / PARTIAL`**。新增 `inventoryCollect`、`inventoryDiff`、`inventoryWriteback`、`skuCollect`、`skuDiff`、`skuWriteback`，并登记 `orderCollect`，统一经过共享 schema、Main 店铺校验和 `InventorySkuService`/TaskRunner。
- 采集和差异只读取 `product_platform_links` / `product_sku_links` 快照；差异保留字段级 before/after，并用 `storeId + platform + productId + skuId + inputHash` 生成幂等键。
- 写回只创建 `commerce_writeback_proposals` 人工确认提案，记录 confirmation、before/after、幂等键和 `side_effect_started`；没有真实平台适配器证据时返回 `NOT_VERIFIED`，不会写平台或把多规格降级为单规格。
- 新增迁移 v25、服务测试 `tests/unit/inventory-sku-service.test.ts`；schema/catalog/migration/Agent 测试均通过。当前全量套件为 87 个文件、960 条测试。
- 证据文件：`artifacts/agent/inventory-sku-m2-20261001.json`；真实四平台采集、写回和回读仍明确标记 `NOT_VERIFIED`。
- 未闭环：四平台真实库存/价格/SKU 页面采集、登录过期/安全验证/页面改版/网络失败、人工确认后的真实写回与平台回读，保持 `NOT_VERIFIED/UNTESTED`。

### M3 订单履约、售后和退款 Agent 接入（2026-10-01，当前轮）

- **状态：`IMPLEMENTED / PARTIAL`**。新增 `fulfillmentPrepare`、`fulfillmentConfirm`、`fulfillmentVerify`、`afterSaleCollect`、`refundReview`、`refundConfirm`、`refundVerify` 的 Main 执行分支。
- 新增 `OrderLifecycleService` 和迁移 v26。发货和退款只创建 `order_action_proposals`；记录确认 ID、before/after、幂等键和 `side_effect_started`，确认后没有真实平台能力时返回 `NOT_VERIFIED`。
- 订单隐私边界保持不变：提案只保存脱敏订单状态、金额和时间，不保存买家身份、联系方式、地址、聊天正文或原始页面数据。
- 退款必须提供明确 `amountMinor`，超过本地实付金额直接拒绝；没有平台回读时发货/退款状态返回 `UNKNOWN`。
- 验证：M3 定向套件 36 条通过，`pnpm.cmd typecheck` 通过。证据文件：`artifacts/agent/order-lifecycle-m3-20261001.json`。
- 未闭环：真实平台发货、物流单号、售后列表、退款提交和回读，以及登录过期、页面改版、网络失败、重启恢复和 Windows 逐项验收，继续保持 `NOT_VERIFIED/UNTESTED`。

## 阶段状态

| 阶段 | 状态 | 已落库 | 未闭环 |
|---|---|---|---|
| A-M0 | IMPLEMENTED | `packages/shared/src/schemas/agent-domain.ts`、错误码、IPC、迁移 v5→v11（v6 租约/确认、v7 价格、v8 技能/插件、v9 上下文窗口、v10 自动记忆治理、v11 记忆近重复指纹）、root-ceo、路径/隐私规则和契约测试 | 正式人工评审记录 |
| A-M1 | PARTIAL | Profile CRUD、safeStorage、`hasKey` DTO、绑定/解绑继承、真实测试入口、能力探测落库、fallback 白名单（503 降级 / 401 拒绝降级）、真实 fallback 路由（本地夹具）、真实 `deepseek-flash` 文本连接和纯模型 Job | 真实 fallback、能力探测完整闭环、服务商费用对账 |
| A-M2 | PARTIAL | root-ceo + `mode=hr`、岗位预览、probation、确认激活、暂停/恢复/退休（暂停 Agent 拒绝新 Job 有本地验收）；可见智能体回合（模型自选白名单软件操作：查询/店铺/任务/采集/备份/记忆，只读与采集立即派单、危险动作先确认；全局设置禁入）、工具目录（提示词白名单由 `agent-tools.ts` 生成）、技能与插件（`createSkill`/`runSkill` 自动执行，声明式、无新权限）、技能/插件 JSON 分享包导入导出（设置面板，需确认、整体校验）、团队/Job 感知问答、对话创建/激活子 Agent、打开应用面板；打包版设置页 Agent SendInput smoke 7/7 | 完整 Windows 桌面逐项人工确认 |
| A-M3 | PARTIAL | Job 状态机、幂等、租约心跳/过期、重启恢复（running → recovery_required → 安全重新排队）、取消、人工确认一次性消费、结果审核、TaskRunner 证据链和 lease owner 防旧 Worker 写回；root-ceo 直接完成真实只读纯模型 Job 并落库用量、结果和审核；自治运营：非资金 Job 无需审批，资金 Job 保留确认门禁 | 真实 fallback、真实浏览器/店铺副作用和完整人工确认 |
| A-M4 | PARTIAL | 独立记忆目录、manifest、hash、FTS5/LIKE + 中文 bigram、脱敏、quarantine、审核、对话/Job/反馈自动候选、sourceRef 去重、**可写子 Agent 按冻结 `memoryScope` 归属 private/store 候选，权限撤销时安全回退 root-ceo**、**private 记忆使用 safeStorage 包装密钥的 AES-256-GCM 文件格式（兼容旧 `.md` 读取）**、**近重复收敛（规范正文指纹 `dedupe_key` + `repeat_count`，合并后标记 `origin=consolidated`，被合并项保留为 stale+archived 可追溯）**、**模型主动检索（`searchMemory`）回传已审核正文**、加密快照、Main 原生确认恢复、损坏正文恢复为 conflict 版本、重启恢复、正文和加密快照原子 I/O 故障回滚、符号链接 containment | OS 级断电/磁盘满和跨设备恢复、跨设备恢复密钥迁移和真实人工桌面验收 |
| A-M5 | PARTIAL | 成功率、首次成功率、人工修正率、fallback/预算阻塞（日预算阻断有本地 Job 证据）、可配置单价（币种 + 每百万 token 输入/输出价）与按 token 的成本估算（未配置价格时保持“未估算”）、命中/采纳/拒绝反馈驱动 confidence/排序、stale/conflict/retention 归档、近重复合并、Profile 健康度、Job 结果反馈、CEO 周期复盘摘要（复盘直接复用 `maintainMemories`，不再复刻一份治理 SQL） | 真实成本仍依赖用户配置单价而非服务商对账；后台周期调度和完整破坏性可靠性治理仍待专用夹具 |
| A-M6 | PACKAGED/PARTIAL | typecheck、单测、build、目录包、NSIS 安装/升级/卸载、隔离降级回滚、本地 Electron/CDP、真实 Windows SendInput Agent 设置 smoke 7/7 | 完整 Windows 桌面逐项验收、真实店铺、真实模型 |

## 关键证据

- 真实模型实测（2026-10-01，使用用户已保存配置）：通过 Windows 原生界面点击「测试文本接口」，`api.deepseek.com` / `deepseek-flash` 连接成功（1338ms）；随后在 Agent 对话框发送仅要求原样回复的校验文本，收到 `SP1001-42`。两次请求均以 `root-ceo` / `model_default-main` 成功写入用量，总计输入 6689、输出 94 tokens；证据见 `artifacts/agent/real-model-smoke-20261001.json`。
- 真实纯模型 Job（2026-10-01，打包 Electron + Agent domain IPC）：Job `ajob_e5c7b9ef-c8d1-4131-be2d-a8af46f8e97f` 使用 `deepseek-flash` 从 `queued → running → succeeded`，返回精确标记 `JOB-SP1001-42`，输入 239 / 输出 217 tokens，结果 `ajres_610d6871-69b7-4d3d-b1f6-275d0c1184b8` 已由 `root-ceo` 审核通过；`storeId`、浏览器 Task/Run 均为空且 `sideEffectStarted=false`。证据见 `artifacts/agent/real-model-job-smoke-20261001.json`。未配置单价，费用保持“未估算”；本次不覆盖 fallback、真实店铺副作用或服务商费用对账。
- `node tools/acceptance/agent-domain-cdp-verify.js`：当前单 Agent 域验收 **13/13**（仅 `root-ceo`；旧多 Agent 87/87 记录保留在下方历史说明）。覆盖单例迁移、旧 Agent 拒绝、root-ceo 通过 TaskRunner 完成浏览器 Job、步骤 evidence 落库、快照归属、模型 Profile、记忆写入与审核。
- `node tools/acceptance/m1-runner.js`：当前工作台全链路真实 Electron/CDP **115/115**；本轮同步验证“Agent 设置”页签名称，并按当前显示店铺校验 webview 重载后的唯一性。
- `node tools/acceptance/agent-cdp-runner.js`：可见智能体真实 Electron/CDP **78/78**（2026-09-26 工具扩充轮）；覆盖经营指标检查走已实测采集（订单/销量/销售额）、多店任务（逐店打开/规划/派发 + 完成后在对话里汇总结果）、**Job 结束后智能体自动续办（读结果并给出下一步）**、对话记忆（后续回合带最近对话与已审核记忆，第二个回合能引用第一句的暗号）、**对话自动滚动到最新消息（消息满 40 条上限后仍贴底，用户报告回归）+ 上翻阅读不打断（「有新消息」按钮、点击回到最新）**、**截图功能已移除（观察不截图、抽屉无预览）**、**待办事件（待确认计划 / 等待确认的 Job / 待审核记忆以通知展示）**、智能体回合（思考过程可见、模型自选只读操作立即执行、第二轮基于结果收尾、非资金计划自动派发/自动执行、资金动作保留确认、例外审批：彻底删除店铺未确认不执行）、自然语言关闭/新建/移入回收站、创建备份、采集派单、工具目录（“查看工具”返回全部工具并执行计划）、技能（**复合指令“制作技能：…看最近 Job 的执行情况”不被查看 Job 快捷路由劫持**、模型自选 createSkill 自动执行并进入软件上下文、思考可见；“运行技能 验收巡检技能”确定性路由逐步执行并回传结果）、插件（“把巡检技能打包成插件”自动执行、“查看插件”列出打包结果、**删插件需人工确认：确认前插件仍在、确认后只删分组而成员技能保留**）、设置面板技能页与插件页（技能页列出技能、带「新建技能」表单可直接创建并落库 `source='user'`、“生成分享包”导出 `shopilot-agent-pack` JSON、粘贴导入后面板与列表更新；插件页独立列出插件与成员技能并可单独导出插件分享包、**插件可改名与改说明并保存**）、**本轮新增只读工具可直接执行（概览统计 / 质量指标 / 重建记忆索引，断言以会话消息回执为准）**、任务详情即时执行且不被当成页面任务、模型 429 自动重试一次、不打开店铺也能对话、主 Agent 自己操作软件（打开目标店铺并自动继续规划）、团队与 Job 感知问答、对话创建/激活子 Agent、打开 Agent 团队面板、Job 完成自动复盘、页面计划经 `job:delegate` 派给 active 子 Agent、主 Agent 不再直接 `task:create/task:run`、TaskRunner 真实读取页面标题、抽屉展示 Job 结果、AI Key 不进入 Job/DOM，runner 已隔离 APPDATA 临时目录。
- `node tools/acceptance/m3-runner.js`：现有 Main-only TaskRunner、Scheduler、人工确认门禁和 AI 任务套件 113/113（2026-09-25 随工具/技能/插件改动复跑通过）；结果写入 `artifacts/agent/m3-runner-latest.txt`。
- `pnpm.cmd typecheck`：通过。
- `pnpm.cmd exec vue-tsc --noEmit`：通过；本轮补齐工作台联合类型、orders IPC 声明和 webview ref 类型。
- `node tools/acceptance/m2-runner.js stage1`：代理/407/备份套件 **30/30**；旧的 `session:status` 敏感字段断言已改为安全摘要、407 重放和 Browser 标签列表行为，环境面板改为只显示 `proxyAuthObserved` 布尔事实。
- 对话历史上限已统一为 **64 轮**（协议、UI 快照、Renderer、Main 入口共用 `AGENT_CONVERSATION_HISTORY_MAX`）；模型侧仍按上下文窗口预算压缩。
- `pnpm.cmd test`：当前 **85 个文件、955 个测试通过**；`pnpm.cmd lint`：退出码为 0，仍保留商品探针等文件的既有 warning；不把 lint 结果冒充单 Agent 完成证据。
- `pnpm.cmd exec vitest run`：同上 54 个文件、546 个测试通过（含 `agent-tools.test.ts`：工具目录与动作类型一一对应、示例均为合法 action、技能步骤禁入清单、审批标记与真实门禁同源、**只读汇总可用而 Job 控制/定义变更/记忆维护不可做技能步骤**、插件改删输入 schema、**计划卡标签表与目录一致**；`agent-step-effects.test.ts`：**副作用/不可重放集合的单一事实来源、`NON_RESUMABLE_TYPES` 集合同一性、`deriveJobRisk` 对 clickByText/setInput/typeText/aiGenerate/loop 判 write 且只读步骤仍判 read**；`agent-step-catalog.test.ts`：编辑器目录 `sideEffect` 与运行时判定逐项一致；`agent-budget.test.ts`：**日预算纯函数（tokens 口径、预留、USD 无单价报不可核算、币种不一致、限额 0）**；`agent-system-prompt.test.ts`：**系统提示词降级（不超预算不改写、从后往前丢保留治理条款、裁剪标记与 droppedChars、单段超长硬截断、无空行长文可裁、用量水位文案）**；`agent-job-prompt.test.ts`：**岗位提示词（岗位/职责/成功标准入提示、治理条款在首行、审核/分析岗专属条款、纯分析 Job 声明、未知岗位与空值退化、字段长度上限）**；`renderer-trust.test.ts`：**渲染层可信判定（主窗口放行、非主窗口/无 host 拒绝、锁定时 APP_LOCKED、Agent 与 AI 家族错误码与文案区分）**；`agent-domain-contract.test.ts`：只读指标（退款金额/退款订单数）不触发资金门禁、三个已实测平台档案逐一守卫、写任务执行者过滤只读 Agent；`agent-invite-task.test.ts`：面板/智能体共用的邀约构造器（缺项逐条说明、AI 话术、商品 ID 规范化、超上限不静默收敛）；`agent-orders-task.test.ts`：订单明细档案红线、整表步骤与统一列映射（表头匹配/多余列/无表头回退）；`agent-software.test.ts`：技能/插件动作与分享包 schema 的边界与拒绝形状；`task-update.test.ts`：任务定义部分更新的字段语义与运行中保护；`agent-memory-rules.test.ts`：自动学习抽取（线索词/忘记优先/8 字下限/4 句与 8 条上限/同轮去重/先脱敏）、近重复归一、中文 bigram 检索、召回打分、类型限额无死分支；`agent-memory-governance.test.ts`：真实迁移建表后覆盖近重复合并（approved 优先、计数折算、隔离/已归档/跨范围/跨类型不合并、可重入）与过期/低置信/保留期归档；`agent-context.test.ts`：token 估算不变式（字符预算永不超 token 预算）、窗口推断优先级、两遍分配（拉丁内容回填到 2 倍以上且仍不超预算）、真实用量累加与峰值水位、面板窗口文案；`agent-ui-state.test.ts`：UI 状态持久化正文上限与进模型单轮上限一致（重启不许塌缩）；`main-bundle-require.test.ts`：主进程/preload 禁止相对 `require` 本地模块；`agent-lease.test.ts`：**租约 sweep 不再无条件续租（无活执行者时让它照常过期）、最长运行时限优先于续租、宽限窗口、startedAt 未知不误杀**；`agent-model-routing.test.ts`：**能力探测参与路由（chat:false 拦、json:false 只警告、离线 fixture 形状必须可用）**；`ipc-trust-guard.test.ts`：**业务 IPC 统一入口（裸 ipcMain.handle 只允许在 family-handle 或断言数≥通道数的家族、每个家族都有校验来源、allowWhenLocked 只属会话安全家族）**）。
- `pnpm.cmd build`：已通过（Electron main/preload/renderer 构建）。
- `pnpm.cmd lint`：通过（0 errors；仓库现有 **1110 条** `any`/风格 warnings——**`packages/shared/**` 已升为 error 级棘轮**，其余四层仍是 warn 的存量债；`pnpm.cmd build`、`pnpm.cmd typecheck` 与 `pnpm.cmd exec vue-tsc --noEmit` 同轮复跑通过）。
- `pnpm.cmd dist:dir` + `node tools/acceptance/packaged-agent-smoke.js`：当前目录包 smoke **10/10**，设置页七个一级页签（配置/达人广场/AI 配置/Agent 设置/技能/插件/关于软件）可切换；Agent 设置四个子页（Agent 设置/模型/记忆/Job）均可渲染；技能页只渲染技能面板（插件卡片 0 张）且带「新建技能」表单（工具下拉实测 33 项、来自 Main 目录），插件页只渲染插件面板（无技能面板），两者都不再重复子页签条。
- `node tools/acceptance/sec-runner.js`：安全能力 44/44（会话包、Cookie、应用锁、代理边界）。
- `node tools/acceptance/m4-runner.js`：完整发布验收 13/13；内含解包版对话链路 19/19、单实例和日志清理、NSIS 静默安装 3/3、覆盖升级 4/4、静默卸载和用户数据保留。
- `node tools/acceptance/agent-memory-resilience-verify.js`：验收专用断电/磁盘满时序（正文重命名前、正文写完、manifest 写完、加密快照重命名前）4/4；文件、加密快照、manifest、SQLite 台账和临时文件均无残留。
- `node tools/acceptance/agent-native-ui-smoke.js`：真实 Windows `SendInput` 聚焦打包窗口、打开设置、进入 Agent 设置并切换 Agent 设置/模型/记忆/Job 四个子页 7/7。
- `pnpm.cmd dist`：NSIS x64 安装包构建通过；安装/升级/卸载由 M4 在临时目录实测。
- `node tools/acceptance/installer-rollback-verify.js`：隔离临时目录中 0.4.47 → 0.4.46 → 0.4.47 降级/恢复 11/11；临时店铺数据在旧版和恢复后的新版均可读取，卸载清理完成。
- `node tools/acceptance/m2-runner.js stage2`：既有环境指纹验收通过。

## 设计冲突记录

- 旧代码将 `agents.model_profile_id` 当作主要绑定字段；当前以 `agent_model_bindings` 为事实来源，旧字段只作为兼容缓存。
- 旧 Agent UI/软件 Agent 继续保留，但组织、模型、Job、记忆写入统一经过新增 Main IPC；Renderer 不获得数据库、文件、session 或凭据。
- 既有 TaskRunner 保持全局单 active run；Agent Job 只创建/关联它，不新增浏览器执行器。
- 可见 Agent 对话不再直接 `task:create/task:run`：页面计划统一经 `job:delegate` 派给 active 子 Agent，root-ceo 禁止作为 Job 执行者；软件级操作（开关店铺/切换标签页）仍由主 Agent 执行，不属于任务执行。
- 可见 Agent 对话与店铺上下文解耦：没打开店铺时，纯对话直接回复；需要页面数据的请求由主 Agent 先用软件操作打开/切换目标店铺，再自动继续规划页面任务，仍然不生成未观察的计划、不直接执行任务。
- 可见 Agent 的团队/Job 感知只读且脱敏（名称、岗位、状态、目标摘要、结果数量）；组织变更（创建/激活/暂停/恢复/退休）与关闭店铺必须经计划卡确认，root-ceo 不可变由 Main 校验；面板导航只发 UI 事件，不改数据。
- 模型请求不再吞错：失败保留 HTTP 状态与脱敏响应片段（日志 + 错误消息）；连接失败与明确的 429 按 §27.2 只重试一次，聊天与 Job 两条链路策略一致，401/403/400、取消和超时不重试。
- 主 Agent 改为智能体回合：模型输出 `{"reply","actions"}`，actions 逐条按闭合白名单校验；查询/采集类即时执行并回传模型总结，危险动作先展示计划等确认；协议外输出只当对话，不执行任何动作。确定性关键词快路径（打开/关闭店铺、查看列表、组织管理、面板导航）保留在最前面，省一次模型调用。
- 智能体当前可操作已登记的软件能力：店铺增删改/回收站、任务查看/删除/派单运行/暂停恢复/取消、发票/经营数据/主体采集、下载与书签、备份、记忆写入，以及已接入的商品域动作；电商全闭环能力以 `ECOMMERCE_AGENT_CAPABILITY_SPEC.md` 的矩阵为准。关闭删除、运行任务、备份恢复、商品发布代填/回读写入和组织变更必须先确认。全局设置（AI 配置与 Key、平台地址、应用锁、代理、会话导出、更新）永不进入白名单。
- 路由修复（对话审查发现）：软件功能词（任务/发票/备份/团队/书签等）优先走智能体回合，不再把“读取任务详情”“采集发票”这类软件指令误判成页面任务去观察页面；只有标题/表格/库存/点击等真正的页面任务才进入页面规划。
- 智能体思考能力：回合输出 `{"thought","reply","actions"}`，thought 在对话里以“思考”块展示；最多 3 轮“思考→只读动作→看结果再决定”，真实模型下已验证两轮清点团队、三轮核实任务状态。
- 对话记忆（对话审查发现“没记忆”）：每个回合注入最近 8 轮脱敏对话（conversationHistory）和已审核长期记忆（approvedMemory，≤4000 字符）；Renderer 传最近对话摘要、Main 二次脱敏截断。真机验证：第二句“我刚才说的暗号是什么”正确答出第一句的暗号。
- 多店任务（用户报告“检查所有店铺订单没执行”）：修复 `asksStoreInventory` 把“所有店铺”当成店铺列表的误判（列表意图必须落在结尾）；新增逐店流程：打开→观察→规划→`job:delegate` 派单，最多 5 家，单店失败不中断；“按顺序全查/逐家检查”跟进会用最近一条页面任务作为目标。
- 执行岗自动供给（用户截图 4 家店全失败）：派单时没有 active 子 Agent 就自动创建并激活独立的 operator「执行助手」（scope 全店铺、maxConcurrency=4），不碰 HR 的 probation/paused 子 Agent；已有「执行助手」被暂停则重新激活；审计 `agent.org.autoprovision`，回复说明“已自动创建并激活执行岗”。派单撞上并发上限时 Job 转 `queued`（`queued=true`），租约巡检 `drainDelegatedQueue` 自动补跑 ceo-chat 排队项。
- 执行反馈与订单语义（用户截图“回复后并没有执行”）：多店派单返回 jobIds，Renderer 轮询后在对话里逐个汇总“执行完成：证据 N 条 / 未完成：原因”；“检查订单/销量/销售额”等经营指标意图且无页面指向词时，走已实测经营数据采集（抖店/快手/微信小店），不再让页面规划器读标题。
- 自治运营策略（用户要求）：非资金任务/软件操作生成即执行，不再逐次审批；MONEY_ACTION_RE 命中（付款/支付/下单/退款/收款/开票/投放等）才插入人工确认门禁（页面步骤门禁 + Job waiting_confirmation + 软件计划等待确认）。纯读取（发票采集、读取订单）不算资金。例外审批清单 APPROVAL_REQUIRED_SOFTWARE_ACTIONS 当前含“彻底删除店铺”。全局设置仍禁入。
- 工具/技能/插件（用户要求“AI 要有调用工具、能制作工具、要有插件和技能”）：工具目录 `agent-tools.ts` 是提示词白名单和 listTools 的单一事实来源；技能是声明式数据（`agent_skills`），只能由自动执行类工具组成（资金/例外清单、关店/店铺增删改/任务运行控制/组织变更/书签增删/备份恢复等需人工确认的动作、嵌套技能管理动作一律拒绝），`createSkill`/`runSkill`/`deleteSkill` 自动执行且回传每步真实结果；插件（`agent_plugins`）把技能打包命名，只是分组不携带新权限；技能进入软件上下文和 Agent 抽屉，模型据此选择 runSkill。
- 分享包导入导出（用户要求“插件/技能要能分享”）：`shopilot-agent-pack` v1 JSON 只含名称/说明/状态/步骤，不含 id、时间戳或凭据；导出走设置面板（可复制到剪贴板），导入必须用户点“确认导入”，先整体校验（与 createSkill 同一套禁令）再落库，同名更新、插件引用缺失如实报错；全程不引入文件系统权限。IPC 为 `agent:skill:list|delete`、`agent:pack:export|import`。
- 真机实测轮（2026-09-25，用户要求“你来测试一遍”）：用真实数据副本（不动原库）在隔离实例上按用户路径跑 11 项（对话/工具/技能/插件/记忆/审批/经营数据/面板导入导出/v8 迁移/崩溃恢复），发现并修复 5 个真实问题：  1. **复合指令被快捷路由劫持**：“帮我制作一个技能：…看最近 Job 的执行情况”被当成“查看 Job 列表”，技能没做成。修复：技能/插件管理意图（制作/打包/改名/删除）优先交给智能体回合；`runSkillIntent` 收紧为「运行/执行/跑 + ≤3 字 + 技能」，不再命中“执行情况”。
  2. **资金误判**：`readLabelValue` 读到的「退款金额」「退款订单数」指标文案被资金正则扫到，导致快手/微信小店的采集 Job 被要求人工确认（抖店因文案不同而幸免）。修复：资金判定只扫目标/任务名/描述/输入摘要与**可产生副作用**的步骤；只读步骤（navigate/readText/readLabelValue/waitMs 等，清单与 TASK_STEP_TYPES 对齐）只看类型。三个已实测平台档案有单测守卫，点击类资金动作仍必须确认。
  3. **跳过原因被吞**：采集派单失败只报“跳过：某店”。修复：回执带 Main 的真实错误码/消息（这条修复立刻在真机上暴露了问题 5）。
  4. **采集 Job 永久卡 running**（“检查所有店铺订单没执行/没返回”的真因）：TaskRunner 排队泵只启动“店铺已打开”的运行，而经营数据采集从不打开店铺 → 运行永远排队、租约巡检又持续续期，Job 卡死无反馈。修复：浏览器 Job 在 `runAgentJob` 里自动打开目标店铺（只开店不建标签页，TaskRunner 按第一步 navigate 自己建）；租约巡检对“运行排队 + 店铺未打开”同样兜底开店。
  5. **幂等键跨修复冲突 / 复用终态 Job 算已派发**：旧采集 Job 占着同一幂等键，载荷变化后永远 `AGENT_JOB_DUPLICATE`；命中的旧 Job 已终态却仍计入“已派发”。修复：采集派单用分钟桶幂等键（同一分钟防抖、之后重跑是新采集），复用到终态 Job 时如实标注“已存在同目标采集：状态”，并把“未实测平台（如拼多多）”写进回执。
- 功能审查轮（2026-09-25，用户要求“审查智能体和 Agent 的功能”）：静态契约比对（45 个软件动作 × 执行分支/标签/目录/提示词白名单全部一致，页面规划步骤是闭合白名单且无写入类步骤）+ 关键链路走查，发现并修复：
  1. **只读范围只存不校验**（权限模型缺口）：`storeScope.readOnly` 从未参与 Job 门禁。修复：带 browserTask 的写/提交类 Job 拒绝只读 Agent（`AGENT_PERMISSION_DENIED`，纯模型 Job 不受限）；派单为写任务只选非只读执行者（`selectExecutorAgent({ requireWritable: true })`，含单测）；「执行助手」按需恢复可写并写审计；设置面板 Agent 卡片/创建表单新增「只读范围」开关。
  2. **聊天/回合不记模型用量**（违反 §7.3）：`chatCompleteForAgent` 现在每次调用写 `agent_usage`（成功记 Token 与估算成本、失败记错误码），并发出 `AGENT_USAGE_UPDATED`。
  3. **聊天无备用 Profile 降级**（Job 有、聊天没有）：聊天按白名单降级一次（`canUseFallback`，无页面副作用），日志与用量留痕。
  4. **回执超时静默**：多店/采集 Job 轮询 10 分钟后静默放弃 → 明确提示“还有 N 个 Job 超过 10 分钟未结束”。
  5. **Job 名提取**：采集类目标没有「店铺：X」，回执显示整句 → 回退到「· 店铺名」。
  6. **规格要求的事件从未发出**：`AGENT_STATUS_CHANGED`（组织状态变更/自动供给）与 `AGENT_USAGE_UPDATED`（用量写入）现在会发出；抽屉监听状态变更自动刷新软件上下文。
  7. **错误码登记补齐**：12 个实际抛出的 `AGENT_*` 错误码补进 `error-codes.ts`。
  8. **事件常量统一**：Workbench 的 `'task:progress'`/`'agent:panelOpen'` 字面量监听改用 `EVENT_CHANNELS` 常量（消除字符串漂移）。
  未改动（设计取舍/后续项）：聊天不因日预算硬阻断（已计入用量统计）；插件分享包不落文件（面板 + 剪贴板）；达人邀约发送接入智能体（需先把 `buildInviteTaskPayload` 抽到 shared，等用户确认）；逐条订单明细采集与拼多多经营数据（需真实登录态实测锚点）。
- 能力扩展轮（2026-09-25，用户选定四件事）：
  1. **聊天/回合日预算硬阻断**：与 Job 同口径（tokens 预算按当日该 Agent 用量；0 预算立即拦截），`AGENT_BUDGET_BLOCKED`，恢复预算后对话可用。
  2. **达人邀约发送接入智能体**：`runInvite` 工具；面板与 Main 共用 `buildInviteTaskPayload`（`@shared/invite-task`，单一构造器），按店铺配置派单，缺项逐条说明（`AGENT_INVITE_CONFIG_INCOMPLETE`）、平台未实测明确拒绝（`AGENT_INVITE_UNSUPPORTED`）；发送类动作不进技能。
  3. **逐条订单明细采集**：`collectOrders` 工具 + `@shared/orders-steps`（navigate → waitForPage → 可选周期 → readTable keepRows）；档案红线（未实测不登记），实测后可用设置 `orders.profiles` 即时登记；意图「订单明细/逐条订单/订单列表」优先于经营指标。
  4. **提交本轮全部改动**（见 STATUS_REPORT 2026-09-25 段）。
- 连带修复（真机/验收暴露）：**Job 载荷清洗嵌套上限 6→16 层且超限如实报错**（旧实现把邀约 `loop → steps → input` 载荷第 6 层静默替换成字符串，Agent 派单必报 `TASK_INVALID_STEP`，面板直建却正常）；**凭据不可解密不再让应用启动失败**（`credential-store.decrypt` 按「未配置」处理并记日志；夹具复现 `ensureAgentRuntimeBootstrap → getAiConfig → hasAiKey` 抛错导致整个应用起不来）；显式指定的店铺全部无效时如实说明（不再静默“未派发”）。
- 功能完善轮（2026-09-25，用户要求“完善智能体和 Agent 的功能”）：
  1. **订单明细可见闭环**：数据中心新增「订单明细」区块（`overview:orders`）：按实测档案把整表快照映射成统一列（**第 0 行是表头**、按表头文案匹配、多余列进 extras、无表头退回档案列序），每店展示最近一次采集 + 一键「采集订单明细」（与面板/智能体共用 `buildOrdersCollectSteps`），支持展开全部行。
  2. **智能体可读订单明细**：新增只读工具 `getOrderDetails`（读最近一次快照，最多 20 条；**买家列不进模型上下文**）；意图路由区分「采集」与「查看」：`采集/抓取/拉取/更新` → 派单采集；`查看/最近/列出` → 直接读快照不派单。
  3. **技能生命周期**：新增 `updateSkill`（改名/描述/启用停用）+ `agent:skill:update` IPC + 设置面板「停用/启用」按钮；停用后 `runSkill` 如实拒绝（`AGENT_SKILL_NOT_FOUND`）；改名冲突如实报错；技能禁入清单含 `updateSkill`。
  4. **对话自动滚动到最新消息**（用户报告“对话要自己滚动”）：根因是消息列表有 **40 条上限**（`slice(-40)`，满后 push 会 shift，长度恒定），而抽屉只 `watch(messages.length)`——满了之后 watcher 永不触发、对话不再跟随。改为**签名式 watcher**（最后一条的 id/文本 + 思考中 + 计划卡/任务卡/软件上下文），并在 `nextTick` + 下一帧各贴底一次（smooth 动画与晚到布局都不会停在半途）；抽屉打开时也立即贴底。
  5. **上翻阅读不打断**（用户追加要求）：用户主动往上翻后新内容不再强拉到底，只在抽屉里显示「有新消息 ↓」按钮（点击回到最新并恢复跟随）；自己发消息仍直接跟到底；补滚的下一帧回调只在仍「跟随最新」时执行（否则会把用户手动上翻又拉回去）。
  6. **删除截图功能 + 截图位置改为「待办事件」**（用户要求）：观察不再 `capturePage`（`screenshot.available=false`，字段保留兼容旧契约），抽屉移除截图预览；原位置改为**待办事件（消息通知）**列表：待确认计划、等待人工确认的 Job、未完成/被阻塞的 Job、结果待审核（软件上下文新增 `unapprovedCount`）、记忆待审核（新增 `pendingMemoryReview` 计数，不带正文）；Job 条目点击直达 Job 看板，记忆条目打开 Agent 团队面板。
  7. **Job 结束后自动续办**（用户：“我提出问题，智能体想办法执行或者解决问题”）：派发的任务结束后，Renderer 在回报结果之后把「用户目标 + Job 结果摘要」交回智能体回合（`agent:job:followUp`，系统提示明确“这是结果回报不是新请求”）——达成给结论、未达成看失败原因换办法或如实说明需要用户配合；只读动作立即执行、资金/需确认动作仍走计划卡、页面任务仍需用户确认；同一批只续办一次，用户发了新消息就跳过（以新消息为准）。
- 验收抖动修复（可见 CDP 出现过 1 项 FAIL）：自治自动执行下“打开店铺并继续规划”的中间软件计划卡是瞬态的，断言改为同时接受稳定的对话标记“正在打开并继续规划”；功能本身无回归（最终任务计划卡已生成，店铺已自动打开）。
- 记忆完善轮（2026-09-26，用户要求“完善并修复”）：先对记忆系统做能力审计（工程可靠性高、学习智能弱），再按审计结论逐项修复并验证：
  1. **模型主动检索拿不到正文**：`searchMemory` 工具只回“命中 N 条”，检索到的正文被直接丢弃，模型只能吃每回合自动注入的那一小片记忆。修复：新增 `recallMemories`（与自动注入同一套排名/预算/打包），工具回传 `<approved_memory_data>` 正文；仍只回 `approved`，待审核候选只报数量——审核门禁不会因为模型主动查询而被绕过。
  2. **`consolidated` 来源是空壳**：枚举/CHECK/配额统计里都有它，但没有任何代码产生，等于没有合并机制，同义候选会无限堆积。修复：迁移 v11 新增 `dedupe_key`（规范正文指纹：大小写/空白/中英文标点/全角归一）+ `repeat_count` + 索引；写入路径同 Agent/店铺/范围/类型且规范正文相同 → 不新建，记一次“重复观察”（提升置信度与新鲜度）；治理路径同钥匙只留一条（`approved` 优先、计数折算、标记 `origin=consolidated`），被合并项保留为 `stale+archived` 可追溯；历史行指纹在“重建索引”时按正文补齐（指纹写入单独 try，绝不把完好记忆误判成损坏）。超过 2000 字的正文不参与去重，避免把两次不同 Job 的 episodic 证据误并。
  3. **学习路径零测试**：`learnFrom*` 依赖 electron/sqlite、规则又与 I/O 混写，导致“学什么”从未被自动化覆盖。修复：规则抽到 `packages/shared/src/agent-memory-rules.ts`、治理 SQL 抽到 `apps/desktop/src/main/services/agent-memory-governance.ts`（两者均无 electron 依赖），新增 28 个用例直接覆盖学习决策、近重复归一、中文 bigram 检索、召回打分与合并分支（含“待审核合并后仍是待审核、绝不自动批准”与隔离/已归档/跨范围/跨类型不参与）。合并分支在真机上只跑到“无重复组”就返回，因此专门用 node:sqlite 跑真实迁移建表来覆盖。
  4. **打包后 `MODULE_NOT_FOUND`（真机验收当场暴露）**：`require('./agent-memory')` 在 rollup 内联后指向不存在的文件，CEO 复盘三项验收直接失败；**同类潜伏 bug 早已存在**于 Job 反馈路径（带 `memoryId` 的反馈必报错）。修复：改用 `await import()`（同文件已有可用模式）并把 `qualityReviewSummary`/`addJobFeedback` 改为 async（IPC 层本就 `await fn(...)`）；新增 `tests/unit/main-bundle-require.test.ts` 守卫主进程/preload 不再出现相对 `require`。
  5. **记忆类型死分支**：`memoryLimit()` 判过的 `working` 在 `AGENT_MEMORY_TYPES` 与 DB CHECK 里都不存在。修复：改为契约驱动的 `MEMORY_TYPE_LIMITS`（新增类型缺限额直接编译失败），并有单测断言枚举与限额一一对应。
  6. **复盘里有两份治理 SQL**：`qualityReviewSummary` 复刻了过期/低置信度/保留期逻辑，规则一改就漂移。修复：统一调用 `maintainMemories`，复盘摘要新增 `consolidated`，面板“自动整理”提示“合并重复记忆 N 条”。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` 43 文件/454 测试通过（基线 4 个失败清零）；`pnpm.cmd build` 通过且产物中相对 `require` 为 0；`agent-domain-cdp-verify.js` 记忆相关项全部通过（写入/审核/检索/店铺隔离/索引重建/损坏恢复/重启/CEO 复盘），记忆 DTO 已带 `repeatCount`；`agent-memory-resilience-verify.js` 4/4。本轮复跑 `agent-domain-cdp-verify.js` 为 **78/82**：失败 4 项为“技能停用/启用”“达人邀约 ×3”，由工作区在途改动把 `runInvite`/`deleteSkill`/`updateSkill` 加入强制确认清单、而验收脚本仍按自动执行断言引起，与本轮记忆改动无关（改前为 75/82，其中 3 项即上述 `MODULE_NOT_FOUND`）。
  未闭环：OS 级断电/磁盘满、跨设备恢复密钥迁移和真实人工桌面验收；检索仍是词法级（FTS5 + bigram），无语义/向量——这是“记忆正文不外发”的架构取舍；`agent_memory_events.event_type` 的 CHECK 只允许 `hit/adopted/rejected`，合并没有写事件（改它需重建表；被合并项以 `stale+archived` 留在库内可追溯）。
- 上下文完善轮（2026-09-26，用户要求“按顺序”，按审计优先级 P0→P1a→P1b→P2 执行）：
  1. **P0 重启后对话历史塌缩为 200 字**：Renderer 内存里单条消息上限 2000 字，但持久化时只存 200 字摘要，重载又用它重建 `messages`，等于每次重启把旧轮次砍到 1/10（长结论只剩开头一句，指代消解随之失效）。修复：三处协同——`AGENT_UI_MESSAGE_TEXT_MAX=2000` 契约（`agentUiMessageSummarySchema`）、主进程写入不再截到 200（仍走 `redactAgentText` 脱敏）、Renderer 存正文；不变量是“持久化上限 == 进模型的单轮上限”，超限直接拒绝而不是静默截断；旧快照（200 字）仍兼容。
  2. **P1a 窗口与水位不可见**：模型 Profile DTO 新增 `resolvedContextWindowTokens` / `resolvedContextSource`（由 Main 用同一份 `resolveModelContextWindow` 推导，`.strict()` 契约同步），面板从“自动推导”改为显示 `128k（按模型名推导）` 这类具体数值与来源；回合结果新增 `usage`（服务商真实 `usage`，`calls`/输入输出累加/`peakInputTokens` 单次峰值即真实水位/生效窗口/是否上报），对话气泡显示一行“2 次调用 · 上下文 5.2k / 128k（占输入预算 4%）”。估算值只用于预算、不上报；成本仍按真实 usage 计算。
  3. **P1b 字符子预算欠填充**：预算侧按最坏情况（全中文，1 token≈1.35 字）折算字符份额，拉丁/JSON 为主的内容只用到约 1/2.7 容量，而最终 `compactAgentPrompt` 只缩不放，欠填充被固化。修复：新增 `fitTextToTokens`（先保守切片兜住“绝不超预算”，再用真实估算二分回填）作为“两遍分配”的第二遍，`compactTextForContext` 改为按 token 份额填充，记忆条目打包从字符核算改为 token 核算（中文口径不变，拉丁内容不再白扔）。`compressAgentHistory` 保留字符核算：它的结构性测试已固定该口径，且中文内容本就接近最坏情况、无欠填充可捡。
  4. **P2 真机验收补上下文断言**：`agent-domain-cdp-verify.js` 新增 5 项——模型名提示推导 128k（来源 `model-name`）、手动 override 优先（8192/`override`）、未知家族保守兜底 32k（`provider-default`）、**40 轮 × 1900 字长历史压缩后仍能完成回合（不超窗失败）**、回合结果携带真实用量与生效窗口（实测 `{"calls":1,"inputTokens":5,"outputTokens":7,"peakInputTokens":5,"contextWindowTokens":32768,"usageReported":true}`，即本地夹具返回的真实 usage）。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` 44 文件/467 测试通过；`pnpm.cmd build` 通过；`agent-memory-resilience-verify.js` 4/4；`agent-domain-cdp-verify.js` **83/87**，新增 5 项全部通过，失败 4 项仍为上一轮记录在案的“技能停用/启用 + 达人邀约 ×3”（工作区在途把 `runInvite`/`deleteSkill`/`updateSkill` 加入强制确认清单、验收脚本口径未跟进），与上下文改动无关。
  未闭环（本轮未改）：对话历史仍使用 `app_settings` 中的有界 UI 快照（尚无独立 conversation table），硬地平线已统一为 64 条；`compressAgentHistory` 的字符口径未改为 token 口径（见 P1b 说明）；无真实 tokenizer、无 prompt 缓存/流式，多轮回合仍整段重发（成本随轮次近似线性放大）；截图能力移除后上下文里没有图像。
- 设置页拆分（2026-09-26，用户要求“设置中增加：插件和技能”后再明确“插件、技能 是分开的，不要合并在一起”）：设置页签条为 **配置 / 达人广场 / AI 配置 / Agent 团队 / 技能 / 插件 / 关于软件** 七个一级页签，`Agent 团队` 只留组织 / 模型 / 记忆 / Job 四项。实现上不复制代码也不复制样式：`AgentAdminPanel` 用可选 `panels` 挂载参数按传入页签集渲染（`['skills']`、`['plugins']` 各挂一处），单一页签时不渲染子页签条，且只挂技能或插件面板时不再顺带拉组织/模型/Job/记忆。两个面板数据与状态完全独立：技能页=技能列表（导出此技能/停用·启用/删除）+ 技能分享包导入导出；插件页=插件列表（含成员技能名）+ 插件分享包导入导出。插件不能脱离成员技能单独存在，因此插件页的导出按**成员技能名反查**后复用同一个 `packExport` 接口（Main 只在“该插件的所有技能都在选中集合里”时才导出插件本身），未新增插件专属接口；技能页的“所属插件”与插件页的“成员技能”都由同一份列表解析，不额外请求 Main。
  验收脚本同步改口径并**验证“不混”**：`packaged-agent-smoke.js` 断言七个一级页签、技能页只渲染技能面板（插件卡片数 0）、插件页只渲染插件面板（无技能面板），9/9；`agent-cdp-verify.js` 把原来“插件和技能页列出已创建的技能”拆成两条——技能页只列技能、不混插件；插件页独立列出插件与成员技能、技能面板不混入，并新增“插件页可单独导出插件分享包”（断言导出 JSON 里 `plugins.length >= 1`）；`agent-native-ui-smoke.js` 只遍历四个子页，无需改。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` 44 文件/467 测试通过；`pnpm.cmd dist:dir` + 打包 smoke 9/9；`agent-cdp-runner.js` 69/69。
- 面板直接创建技能（2026-09-26，用户问“检查软件可以创建技能吗”，先真机验证、再要求补入口）：此前技能只能由模型 `createSkill` 或导入分享包创建，面板没有入口（preload 也没有 `skillCreate`）。
  1) 真机验证（真实 userData + 真实 `deepseek-flash`，不隔离不替换端点）：对话说“帮我制作一个技能：先列出所有店铺，再看最近的 Job。技能名叫「店铺巡检」”，模型自选 `createSkill` → 真实库落 `店铺巡检 | enabled | ai | [listStores, listJobs]`，技能页出现卡片（`ai · 2 步 · 独立技能`）；随后按用户要求用 App 自己的 `skillDelete` 删除并回读 0，真实库恢复验证前状态。附带发现：模型第一轮会先反问名称/用途/步骤，第二轮才建。
  2) 新入口：设置 → 技能 →「新建技能」表单（名称/说明/用途 + 步骤行：工具下拉 + 参数 JSON + 添加/移除，1～8 步），落库 `source='user'`，与模型 `createSkill` 同一套校验（同名即更新）。
  3) 单一事实来源：把 `AGENT_CONFIRM_REQUIRED_ACTIONS` 从 Main 挪到 `packages/shared/src/agent-domain-rules.ts`，在 `@shared/agent-tools` 新增 `skillStepEligible` 与 `listSkillStepTools`；Main 的技能校验与表单工具下拉共用同一判定，界面给不出会被拒的步骤（工具目录 53 项 → 表单只列 27 项），绕过界面直接提交需确认工具仍被 `AGENT_CONFIRMATION_REQUIRED` 拒绝（验收里有这条）。参数模板由目录示例去掉 `type`、字符串占位清空（数组/数字/布尔保留），避免把示例里的 `"..."` 当真实参数提交。
  4) 新增 `AGENT_SKILL_CREATE` / `AGENT_SKILL_TOOLS` 两个 IPC 与 `agentSkillCreateInputSchema`。踩到的坑记录：新 schema 是 strict 的，而模型动作自带 `type:'createSkill'`，第一版直接把整个 action 丢进去 → ZodError 让模型创建技能全线失败（连带 7 项验收失败 + 两项滚动验收因回合卡在失败态而失败）；修法是在解析前只摘掉 `type` 这一个键，其余多余键仍被严格拒绝。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` 44 文件/470 测试通过（新增 3 项：资格判定、面板工具目录、创建输入 schema）；`pnpm.cmd build` 通过；`dist:dir` + 打包 smoke 10/10；`agent-cdp-runner.js` **72/72**（新增：工具下拉过滤、面板创建技能、绕过表单被拒）。
- 验证技能回收（2026-09-26，用户选择“删掉”）：真机验证留下的「店铺巡检」按用户要求用 App 自己的 `skillDelete` 删除，`skillList` 回读 `[]`、技能页回到空态文案、真实库 `agent_skills` 为空。
- 智能体工具扩充轮（2026-09-26，用户先问“软件里的智能体可以调用什么工具/现在有什么/缺什么”，再选择补四类：Job 闭环、组织 updateAgent、插件改删+任务编辑、数据中心只读+复盘/维护）：
  1. **目录 55 → 74 项**（契约测试保证与 `AGENT_SOFTWARE_ACTION_TYPES` 一一对应、每个示例都能被自身 schema 解析）：Job 闭环 `getJobDetail`/`jobFeedback`/`reviewJobResult`/`approveJob`/`resumeJob`/`cancelJob`；组织 `updateAgent`/`bindAgentModel`；插件 `updatePlugin`/`deletePlugin`；任务定义 `updateTask`；只读汇总 `overviewStats`/`overviewDatacenter`/`overviewInvoiceCenter`；主体回填 `applyEntity`；质量与记忆 `qualityMetrics`/`qualityReview`/`memoryRebuild`/`memorySnapshot`。**快照的恢复/查看（memorySnapshotRestore/Inspect）故意不暴露**：恢复是破坏性动作、查看要任意文件路径。
  2. **门禁**：`AGENT_CONFIRM_REQUIRED_ACTIONS` 22 → 31 项（新增 approveJob/reviewJobResult/cancelJob/updateAgent/bindAgentModel/updatePlugin/deletePlugin/updateTask/applyEntity）；技能资格判定同步为 74−41=**33 项**（jobFeedback/resumeJob/memoryRebuild/memorySnapshot 进“禁止嵌套/维护类”清单）。`approveJob` 只处理状态为 `waiting_confirmation` 的 Job，确认凭证取自 Job 行本身，不构成自我批准通道。
  3. **修掉提示词与门禁长期分歧**：`toolApprovalRequired`（提示词给工具打「需确认」标记、技能步骤资格判定）此前只看 3 项例外清单 + 资金名匹配，而真正会弹确认卡的有 20+ 个动作——提示词等于在告诉模型“这些都自动执行”。现在它与 `AGENT_CONFIRM_REQUIRED_ACTIONS` 同源。
  4. **服务层补齐（此前连服务都没有）**：`taskStore.updateTask`（部分更新；`undefined`=不改、`storeScope/schedule: null`=清空、`steps` 整体替换并重排；运行中只允许改名称/计划，改步骤 `TASK_BAD_STATE`；复用 `taskCreateSchema.shape.*` 与 `validateStepInput`，非法输入在写库前拒绝；审计 `task.update`）；新建 `services/overview-service.ts`（stats/invoiceCenter/entityApply/datacenter 从 IPC 抽出，四个 handler 变薄包装，`overview:invoiceExport` 一行未改）；`updateAgentPluginByUser`/`deleteAgentPluginByUser` + `syncSkillMembership`（`agent_plugins.skill_ids_json` ↔ `agent_skills.plugin_id` 双向一致，技能移入新插件时从旧插件摘除；删插件只解除分组、成员技能保留）；新 IPC `task:update`/`agent:plugin:update`/`agent:plugin:delete` 与 preload `task.update`/`pluginUpdate`/`pluginDelete`。
  5. **面板入口**：插件卡片新增「编辑/删除」（改名/说明/成员技能，成员按名称反查）；任务卡片新增「编辑」，复用自定义任务编辑器（与「复制」同一套步骤转换），保存走 `TASK_UPDATE`，且**步骤未改动时不发 `steps`**（否则编辑一个正在运行的任务只因改了名字就被 Main 拒掉）。
  6. **执行器**：19 个 case 全部落到 Main 真实服务（先做存在性校验：任务/店铺/子 Agent/插件都在 `validateSoftwareAction` 里查）；只读工具的输出在 Main 侧就压成有界摘要（标量字段 + 条数上限 + 只读前 N 条），避免整份数据进 previousResults 撑爆上下文预算。
  7. **本轮顺带修掉三个真 bug（都是实测暴露）**：① `syncSkillMembership` 的 `SELECT ... WHERE id<>?` 漏传参 → `RangeError: Too few parameter values`，插件改名**已落库却报失败**（面板显示"保存失败"，实际已生效）；② 软件计划卡的 `actionLabel` 是 14 项局部映射 + 强转 `Record<AgentSoftwareActionType,string>`，新增工具在卡片上显示成 `undefined · 需确认` —— 改为共享纯数据表 `packages/shared/src/agent-tool-labels.ts`（74 项）+ 契约测试防漂移；**渲染层不能引 `@shared/agent-tools`**（它连带 `@shared/agent-domain-rules` → `node:crypto`，浏览器构建直接失败，本轮实测撞到过）；③ `writeAudit` 在店铺被彻底删除后仍带旧 `store_id` 会违反外键、**整条审计被静默吞掉**（现在先确认店铺存在，不在就写 NULL）。
  8. **验收暴露的第四个 bug（与 createSkill 同类）**：执行器把带 `type` 的模型动作直接喂给面板用的严格输入 schema，报 `unrecognized_keys: ["type"]` —— 智能体删插件能出确认卡、点确认却失败。修法沿用 `createSkill` 的既有约定：`stripActionType` 只摘 `type` 一个键，其余多余键仍严格拒绝。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` **45 文件/483 测试通过**（新增：门禁分类、技能资格（只读汇总可用、Job 控制/定义变更/记忆维护不可用）、插件改删输入 schema、标签表与目录一致性；外加任务编辑 9 项）；`pnpm.cmd build` 通过；`pnpm.cmd dist:dir` + 打包 smoke **10/10**（技能页工具下拉实测 **33 项**，即新增工具后的可选集合）；`agent-cdp-runner.js` **78/78**（新增 6 项：插件页改名+改说明、删插件保留成员技能、只读概览统计/质量指标/记忆索引重建可直接执行、删插件需人工确认且确认后只删分组；并加固了两条易脆断言——`skillList` 空载荷不再被当成“已删除”、确认按钮 disabled 时重试点击）。
  未闭环（本轮未改）：`memorySnapshot` 只给“创建”，恢复/查看仍只在设置面板；`overviewInvoiceCenter` 的列名直接来自发票页实测映射（未实测平台仍如实为空）；`overview-service.ts ⇄ ipc/profile-misc-handlers.ts` 存在循环 import（两模块顶层无互相求值，tsc/rollup 单文件打包下安全，已在两处注释写明；彻底消除需把 150 行发票取数逻辑搬进 service 并改 `overview:invoiceExport` 调用点）。
- AI 架构审计轮（2026-09-26，用户问“审查一下 AI 的底层架构完整吗”）：按五层并行只读审计（模型接入 / 上下文与提示词 / 记忆与学习 / 编排与执行 / 安全与观测），主 Agent 逐条复核高危结论，报告落 `docs/AI_ARCHITECTURE_AUDIT.md`（区分「已复核」与「子代理报告未复核」，未实测项一律标注）。总评：**骨架完整、治理层不完整**——分层/契约/失败语义/验收脚本规模在能长期演进的水位，但安全、成本、副作用的**判定基准存在多份互相矛盾的实现**。已复核的 P0 三条：
  1. **副作用边界四份定义打架**：`agent-domain-rules.deriveJobRisk` 只用文案正则（`\bclick\b` 匹配不到 `"type":"clickByText"`、`setInput`、`typeText`、`aiGenerate`、`ensureRows*`、`useTab`、`loop`、`clickAll`、`clickIfPresent`），引擎 `NON_RESUMABLE_TYPES` 有 13 项，规划器只有 2 项，编辑器目录还把 `pressKey` 标成副作用 → 这类浏览器 Job 被判 `read`：可派给只读执行者，且不置 `side_effect_started`，于是 `resumeAgentJob` 放行“安全恢复”而恢复是新 run 从第 0 步重放 → 重复点击/重复写入。
  2. **资金采集 Job 的“确认”是走过场**：`agent-service.ts` 先按资金文案设 `requiresConfirmation`，紧接着用 **Job 自己的 confirmationId** 调 `approveAgentJob(approved:true)` 再执行；软件计划路径同样只校验渲染层自报的布尔。
  3. **预算形同虚设**：聊天路径与 Job 路径各写一遍 `if (amount <= 0 || (currency === 'tokens' && used >= amount))` → 配 USD 预算时恒为 false，永不阻断；且只用已用量比较、无预留，单次调用（max_tokens 上限 128000）即可越过日上限。另外 legacy `ai-client.chatComplete` 栈（邀约话术）不返回 usage、不重试、不受预算约束，`withTimeout` 只 `Promise.race` 不 abort；`assertTrustedRenderer` 只覆盖 agent 两个 handler 家族（`ai-handlers` 6 个通道无校验）；能力探测结果不参与路由。
- AI 架构审计 P0 收敛轮（2026-09-26，用户答“继续”并选定**方案 A：采集保持自动执行**）：三条 P0 全部落地并实跑验证。
  1. **副作用边界收敛为单一事实来源**：新增 `packages/shared/src/agent-step-effects.ts`（`AGENT_SIDE_EFFECT_STEP_TYPES` 11 项、`AGENT_NON_RESUMABLE_STEP_TYPES` = 副作用 ∪ {waitForUserConfirmation, useTab}，与原引擎 13 项逐项一致、`collectStepTypes` 递归进 loop body）。消费方全部改为同源：`task-step-schemas.NON_RESUMABLE_TYPES` 现在**就是**该集合（集合同一性）、`agent-planner.SIDE_EFFECT_TYPES` 指向它、`deriveJobRisk` 先判步骤类型再判文案。效果：这批 Job 不再被判 `read` → 不再派给只读执行者、`side_effect_started` 正确置位、`resumeAgentJob` 拒绝重放（顺带让 `canUseFallback(..., risk==='submit')` 与 probation 门禁的输入变准）。顺带修掉**第四份**口径：`custom-task.STEP_CATALOG` 的 `pressKey` 标成 `sideEffect:true, idempotent:false`（只按 Escape 收浮层、不改数据、可安全重放），已改回 `false/true`。
  2. **删掉资金采集自批**：采集派单改 `requiresConfirmation: false`，删掉“用 Job 自己的 confirmationId 自我批准”的代码；资金门禁本身没放松——`money && !requiresConfirmation` 仍拒绝，只多了 **Main 内部**参数 `moneyConfirmationSatisfied`（`delegateAgentTask(raw, { userInitiatedCollect: true })` 传入，`agentTaskDelegateSchema`/`agentJobCreateSchema` 都是 `.strict()`，渲染层塞不进）。真落到 `waiting_confirmation` 时如实跳过并提示去 Job 看板批准。
  3. **预算口径修正 + 请求前预留**：新增纯函数 `packages/shared/src/agent-budget.ts`（`evaluateDailyBudget`/`estimateReserveCost`）：tokens（或留空）按用量+本次 `max_tokens` 预留比较；其他货币必须配同币种单价，否则报 `AGENT_BUDGET_UNENFORCEABLE`（宁可拒绝也不假装预算生效），配了则按 `agent_usage.cost_json` 的已用成本 + 预留成本比较；限额 ≤0 直接阻断。聊天路径与 Job 路径（`blocked_budget` 分支，事件里带 `budgetScopes`）改为调用同一纯函数。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` **48 文件/504 测试通过**（新增 `agent-step-effects.test.ts`、`agent-step-catalog.test.ts`、`agent-budget.test.ts` 共 21 条）；`pnpm.cmd build` 通过；`dist:dir` + 打包 smoke **10/10**；`agent-cdp-runner.js` **78/78**（采集派单行为改动无回归）；`agent-domain-cdp-verify.js` **83/87**（4 项仍为在途确认门禁改动引起：`runInvite`/`updateSkill` 已进 `AGENT_CONFIRM_REQUIRED_ACTIONS` 而旧脚本仍按“无需确认”断言）。未动的 P1/P2 清单（岗位层提示词、小窗口系统提示超窗、ai-handlers 无可信校验、审计关联键、能力探测不参与路由、租约 sweep 无条件续租、记忆自审/快照复活 approved、legacy ai-client 栈、单文件打包与无 CI）已在审计报告里逐条留证。
- AI 架构审计 P1 收敛轮（2026-09-26，用户答“继续”）：四条治理层缺口落地，均先复核 file:line 再改、每条都有单测。
  1. **小窗口系统提示词降级**：新增 `compactSystemPrompt(system, budgetTokens)`（`@shared/agent-context`）——按段落从后往前丢、治理条款写最前所以优先保留、每次裁剪插显式标记，连第一段都放不下才硬截断；聊天路径与 Job 路径都以**输入预算的 50%** 为系统提示词上限并 `logMain('warn')` 留痕。新增 `AgentContextUsage.systemPromptDroppedChars`（多轮累计），`describeAgentContextUsage` 在气泡/面板水位后追加“· 系统提示词已按窗口裁剪 N 字”——不再“一个字不裁、撞线就抛 `AGENT_CONTEXT_TOO_LARGE` 却不给可操作线索”。该错误码保留为兜底，消息里带上具体 token 数。
  2. **AI 配置通道补可信校验**：复核发现 `assertTrustedRenderer` 只在两个 Agent handler 家族各写一份（措辞/错误码还不一致），`ipc/ai-handlers.ts` 的 6 个通道（含 `ai:keySet`/`ai:config:set`）完全没有。新增 `services/renderer-trust.ts`（electron 侧）+ `services/renderer-trust-rules.ts`（纯判定），三处旧实现收敛为一份；AI 家族新增 `AI_FORBIDDEN`（`APP_LOCKED` 复用既有码）并进 `@shared/errors/error-codes` 目录。
  3. **子 Agent 岗位层提示词**：`executeModelJob` 原先写死一句“你是 ShopPilot 的只读分析 Agent…”，岗位/职责/成功标准都没进模型。新增 `buildAgentJobSystemPrompt()`（`@shared/agent-job-prompt`）：治理条款排第一行、随后名称/岗位/职责/成功标准、再按岗位追加条款（审核岗强调证据、数据分析岗强调口径）；`AGENT_ROLE_LABELS` 与界面下拉/`ROLE_TEMPLATES` 统一叫法（商品运营/数据分析/审核 Agent/内容文案/客服质检）。取不到执行者记录时退化成通用提示，不阻断 Job。
  4. **legacy AI 栈纳入计量与预算**：新增 `services/model-governance.ts`（只依赖 db + shared，避免与 agent-runtime 成环）提供 `resolveMeteringTarget`/`dailyUsageSnapshot`/`assertMeteredBudget`/`recordModelUsage`；`agent-runtime` 的 `recordChatUsage` 与当日用量快照改为复用它（用量与记账只剩一份实现）。`ai-client.chatComplete`（测试连接、达人邀约话术）现在请求前按本次 `max_tokens` 做预留校验、成功/失败都写 `agent_usage`、并开始读服务商 `usage`；解析不到计量目标时记 warn 说明“未计量”，不假装已计量。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` **51 文件/525 测试通过**（当时；新增 `agent-system-prompt.test.ts`、`agent-job-prompt.test.ts`、`renderer-trust.test.ts` 共 21 条）；`pnpm.cmd build` 通过；`agent-cdp-runner.js` 78/78；`agent-domain-cdp-verify.js` 83/87（4 项当时仍为在途确认门禁改动引起，已在下一轮定调后转绿）；`dist:dir` + 打包 smoke 10/10。未动的 P2：能力探测不参与路由、租约 sweep 对 running 无条件续租、记忆自审/快照复活 approved、失败运行不写 `agent_job_results`、`dependencies` 恒空、其余 IPC 家族无统一可信校验、单文件打包、无 CI。
- 确认门禁定调轮（2026-09-26，用户答“把这两个动作撤出名单”）：把 `runInvite`（达人邀约：用户自己发起、额度用尽自动停止、明细进实时日志）与 `updateSkill`（技能改名/启停：可逆的本地定义变更）从 `AGENT_CONFIRM_REQUIRED_ACTIONS` 撤出（31 → 29 项），验收脚本里长期挂账的 4 项断言随之转绿（**agent-domain-cdp-verify 87/87**）。撤出**不等于降级**：新增 `AGENT_SIDE_EFFECT_SOFTWARE_ACTIONS` + `softwareActionHasSideEffect()`（shared），`agent-service.planFromActions` 改为「risk 看副作用集合、requiresConfirmation 看确认集合」，因此这两个动作仍是 `risk=write`、只读执行者仍不能接、`side_effect_started` 照置位（不可“安全恢复”重放），也仍在 `AGENT_SKILL_FORBIDDEN_STEPS` 里（撤出确认不会让它们变成合法技能步骤）。顺带修掉确定性意图路径给 `runInvite` 标 `read` 的问题。新增契约测试：确认集合 ⊆ 副作用集合、两个例外动作必须仍是副作用、只读动作两边都不在。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` **51 文件/526 测试通过**（+1 条）；`pnpm.cmd build` 通过；`agent-cdp-runner.js` 78/78；`agent-domain-cdp-verify.js` **87/87**；`dist:dir` + 打包 smoke 10/10。
- P2 复核与收敛轮（2026-09-26，七条先复核再改，误报如实记录）：① **租约 sweep 不再无条件续租**（属实）：新增 `packages/shared/src/agent-lease.ts` 的 `evaluateLeaseSweep`——只有活着的执行者（模型 controller 在飞 / TaskRunner 运行仍在跑）或刚启动的宽限窗口才续租，另加最长运行时限 `agent.jobs.maxRunMs`（默认 30 分钟）→ 一律 `recovery_required` 交人工（不自动重排：可能已有副作用）；`sweepAgentJobs` 改为"先对账（开店兜底 + 同步运行结果）再判租约"。② **能力探测参与路由**（属实）：新增 `modelCapabilityVerdict()`——`chat:false` 拦下（聊天链路报 `AGENT_MODEL_INCAPABLE`，Job 链路 `blocked_permission` + 事件），`json:false` **只 warn 不拦**（口径由真机验收校准：离线 fixture 的探测结果就是 `json:false`，一律拦会让 domain 套件 8 项转红）。③ **其余 8 个 IPC 家族 92 个通道铺开可信校验**（属实）：新增 `ipc/family-handle.ts`（`familyHandle(feature)`），错误码 `IPC_FORBIDDEN`，发送方必须是应用主窗口；应用锁家族显式 `allowWhenLocked`（解锁/锁状态/设置主密码），否则用户永远解不开锁。④ **误报并给出证据**：失败运行不写 `agent_job_results` 是**契约**（验收脚本 5 处断言失败/取消/阻塞/恢复类 Job 结果必须为空，证据在 `agent_job_events`，续办已带 `events.at(-1).reason`）；`dependencies` 经 `agent:job:create` 可达（schema 12 个上限 + 去重/成环校验 + run 前门禁），只有聊天派单恒 `[]`（未来 Job id 不存在），`drainDelegatedQueue` 只补 ceo-chat 是注释明写的设计；记忆自审实为"按 Agent 权限（root-ceo 或 `review_job`）+ 范围 + hash + 敏感扫描"的审核岗定义，不是渲染上下文旁路；快照恢复是 AES-256-GCM（篡改即解密失败）+ 逐条脱敏/敏感扫描/上限/hash 重算 + root-ceo + confirmed + 审计，"按原状态恢复"是灾难恢复应有语义（残留：`confirmed` 仍是渲染层布尔）。⑤ **CI 与流水线**：新增 `tools/ci/verify.ps1`（typecheck → 单测 → build，已实跑通过）与 `.github/workflows/ci.yml`（windows-latest 调它，**未在真实 CI 上跑过**）；把 `agent-cdp-runner`、`agent-domain-cdp-verify`、`agent-memory-resilience-verify`、`packaged-agent-smoke` 补进 `run-acceptance.ps1`（原先只能手跑）。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` **54 文件/546 测试通过**（+3 文件/+20 条）；`tools/ci/verify.ps1` → **CI_ALL_PASSED**；`pnpm.cmd build` 通过；`agent-cdp-runner.js` 78/78；`agent-domain-cdp-verify.js` **87/87**；`agent-memory-resilience-verify.js` 4/4；`dist:dir` + 打包 smoke 10/10。未闭环：`confirmed` 渲染层自报、审计关联键与关键类别零审计、`temperature/max_tokens` 4 处请求体构造点、主进程单文件 1.45MB、`any` 579 处/90 文件、`overview-service ⇄ ipc` 成环。
- 过期断言修正（2026-09-26，随上一项设置页改动发现，**非本轮改动引起**）：`agent-cdp-verify.js` 的“采集类只读动作走派单并如实汇报”原来要求出现可点击的 `.agent-software-plan-card`。但只读采集按**已提交**的自治策略（`stores/agent.ts`：`requiresApproval !== true` 即 `autoRun='software'`）在生成计划后立即执行，卡片只是转瞬即逝的中间态，该断言因此稳定失败（连跑两次 66/67，诊断串 `card=无（只读计划已自动执行）`；`git diff HEAD` 确认自动执行逻辑不在未提交改动里）。已把卡片降级为诊断信息，断言收敛到真正要保证的行为（派单链路走过 + 如实汇报 未派发/已派发），并在脚本里写明原因与依据。
- `AGENT_DEVELOPMENT_SPEC.md` 旧版 §45 的 DESIGNED 状态已更新为本次实际阶段状态，历史描述保留为基线说明。
- P3 复核与收敛轮（2026-09-26，承接 P2 未闭环六条，先复核再改，误报与"接受的技术债"如实记录）：
  1. **审计关联键与关键类别零审计**（属实）：新增 `auditRequestId(id, detail)` 约定（每次调用真实 id + `#说明`：失败带错误码、成功带最小上下文），8 处常量 `requestId` 全部换成真实 id；`queryAudit` 支持按 `requestId` 精确/前缀过滤（`%`/`_` 当字面量，带 ESCAPE），`audit:query` 的 filter 由"any 直通"改为 `auditQueryFilterSchema` strict；补 `ai.config`（记录变更字段/失败码）与 `agent.skill.create|update|delete|run`、`agent.plugin.create|update|delete`、`agent.pack.import|export` 审计，落在各动作的唯一漏斗上（技能 upsert/update/delete、插件改删、包导入导出），模型自选建的技能 `actor=root-ceo`、用户手建 `user`；对话里的删除/改名技能改为复用带审计的服务函数（原先直接 DELETE 不留痕）。
  2. **`overview-service ⇄ ipc` 成环**（属实）：把 `collectInvoiceRows`/`collectEntities` 搬进 `services/overview-service.ts`，方向变单向 `ipc → services`（发票导出仍共用同一份取数），新增 `tests/unit/main-layer-direction.test.ts` 把"services/stores/tasks/browser 不得 import ipc"变成契约。
  3. **`temperature/max_tokens` 多构造点**（属实且已漂移：Job 路径少 `stream:false`、鉴权头大小写不一）：新增 `services/model-request.ts`（请求体/请求头/输出上限唯一构造点，默认上限 128000），五个调用点（legacy 对话、Agent 对话、Job、健康检查）全部改走它；`model-request.test.ts` 10 条 + 源码级守卫禁止再手写 `max_tokens:`；整理时测试抓到两个真实缺陷（`Number(null)===0` 把"没传温度"变成温度 0；`Infinity` 收敛口径写明取 min）。
  4. **快照恢复 digest 只回传不比对**（属实）：新增 `@shared/memory-snapshot` 的 `verifySnapshotDigest` + `agentMemorySnapshotRestoreSchema`（strict），面板把**自己展示过的 sha256** 回传，Main 与文件实际摘要不一致（含格式非法）一律拒绝；审计记录快照摘要与"是否比对过摘要"。**残留（接受）**：`confirmed` 仍是渲染层布尔，彻底消除需 Main 侧原生确认窗（`session-exporter` 的 `askConfirm` 有先例，但验收脚本要注入 `SHOPILOT_TEST_AUTOCONFIRM`，而 `agent-domain-cdp-verify.js` 是用户未提交在途文件）；风险面已收敛（无业务 preload 的视图/弹窗 + 窗口身份 + 应用锁门禁）。
  5. **`any` 579/90 的旧数字不准**：实测 `no-explicit-any` 为 **941 处/70 文件**（main 597、renderer 202、tests 105、preload 22、shared 15）。本轮加**棘轮**而非一次性全改：`packages/shared/**` 的显式 `any` 由 warn 升为 error，先清干净这 15 处——`douyin-category-tree.ts` 改 `unknown` + 显式收窄（补 9 条边界用例，含"没有子项的根类目会被丢弃"这一契约），`contracts/ipc.ts` 的 `details` 收紧为 `unknown`、信封默认泛型保留 `any` 并在文件内 `eslint-disable` + 写明理由；已用探针验证棘轮会真报错。其余四层仍是 warn 的存量债。
  6. **主进程单文件 1.45MB**（属实，实测 main `1,429.43 kB`/renderer `1,020.08 kB`）：**接受**。Electron 主进程必须单入口，产物大小对已安装桌面应用无用户可见成本；唯一现成杠杆是给 main 开 `build.minify`，但那会毁掉主进程堆栈信息——本项目正是靠它定位 Job/模型失败（日志与打包 smoke 都读错误文案）。
  7. 顺带修掉复核时发现的一个回归：P2 统一"应用锁定时拒绝"后，`App.vue` 在锁屏时调用的标题栏底色通道也被拒（锁屏标题栏停在旧色）。`familyHandle` 现支持按通道放行，只有这一个纯装饰通道例外，守卫测试断言该文件里例外仅此一处。
  验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` **58 文件/589 测试通过**（+4 文件/+43 条）；`pnpm.cmd lint` **0 errors/935 warnings**（棘轮生效，顺带清掉搬移遗留的 12 个未使用 import 错误）；`tools/ci/verify.ps1` → **CI_ALL_PASSED**；`pnpm.cmd build` 通过；`agent-cdp-runner.js` 78/78；`agent-domain-cdp-verify.js` **87/87**；`agent-memory-resilience-verify.js` 4/4；`dist:dir` + 打包 smoke 10/10。

## P4 记忆安全与学习归属收敛（2026-09-27）

- **恢复确认移入 Main**：`agent:memory:snapshot:restore` 不再信任 Renderer 的 `confirmed` 布尔值，IPC 侧调用 Main 托管的 `askConfirm` 原生确认窗；旧字段只为旧版 Preload 兼容，取消发生在备份和写库之前。测试环境可用 `SHOPILOT_TEST_AUTOCONFIRM=1`。
- **子 Agent 私有学习闭环**：Job/反馈候选根据执行者的冻结 `memoryScope`、店铺范围和当前写权限路由到执行者的 private/store 记忆；权限撤销、范围不匹配或旧 Job 快照缺失时回退 root-ceo，仍保留审核门禁与 sourceRef 幂等。
- **private 文件加密**：新 private 记忆写入 `.mem.enc`，使用每文件 AES-256-GCM 数据密钥并由 safeStorage 包装；索引、hash、快照、审核和恢复统一读写解密后的正文，旧 `.md` 数据兼容读取。
- **验证**：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` **59 文件 / 594 条通过**；`pnpm.cmd lint` **0 errors / 1020 warnings**；`pnpm.cmd build` 通过；`pnpm.cmd dist` 通过并生成 x64 NSIS；打包 smoke **10/10**；`agent-memory-resilience-verify.js` **4/4**；`agent-domain-cdp-verify.js` **87/87**；`agent-cdp-runner.js` **78/78**。上述均为本地临时 userData、fixture/model 或 Electron/CDP 验收；真实 Windows 人工点击、真实模型凭据、真实平台店铺副作用及 OS 级断电/磁盘满/跨设备密钥迁移仍保留未验收边界。

## 统一首页与工作台兼容收敛（2026-09-27）

- 统一 Dashboard 的店铺行补齐 `store-card` / `store-action` 语义入口和应用内右键菜单：打开/关闭、独立窗口、重命名、环境配置复制、复制店铺 ID、回收站确认均复用现有 Store/Profile/Browser IPC；菜单与原生店铺视图的遮挡同步继续走 `browser.setViewsObscured`。
- 统一店铺浏览器右栏补齐任务确认门禁、`Ctrl+Shift+B`、`ui.rightPanelCollapsed` 持久化和窄轨任务入口；统一任务页的自定义任务对话、真实 TaskRunner 运行路径和任务取消/状态仍走原有 IPC。统一首页左栏补齐 `Ctrl+Shift+E`、`ui.leftSidebarCollapsed` 持久化、44px 窄轨的新建/回收站/设置入口，并保留 `welcome`/`sidebar` 语义以便旧入口平滑迁移。
- 审计查询 Main 侧兼容旧版 `query({ filter: {...} })` 的一层包装，同时保持 strict 字段校验和权限边界；没有新增 API、IPC、数据库表或权限。
- **验证**：`pnpm.cmd typecheck`、`pnpm.cmd test` **59 文件 / 594 条**、`pnpm.cmd lint` **0 errors / 1020 warnings**、`pnpm.cmd build`、`pnpm.cmd dist:dir` 通过；`update-runner.js` **16/16**；`agent-domain-cdp-verify.js` **87/87**；`agent-cdp-runner.js` **78/78**；`agent-memory-resilience-verify.js` **4/4**；打包 Agent smoke **10/10**。M1 中店铺/审计/左右栏/原生视口检查通过，后续旧脚本仍停在旧三栏 `.btn-new`/旧创建弹窗选择器；安全右栏代理/Cookie、邀约实时日志和自定义任务旧拾取器仍需迁移到统一页面后再验收。

## 证据与回滚

证据写入 `artifacts/agent/`，仅包含命令、状态、版本、hash 摘要和脱敏错误码，不写入 API Key、Cookie、Token、客户数据或记忆正文。回滚按迁移 down 脚本、数据库备份和工作区 diff 逐项执行；不得重置用户已有无关改动。

## 统一工作台继续收敛（2026-09-27，本轮）

- 统一首页/店铺浏览器右侧新增真实安全环境面板：代理绑定/测试/删除、指纹校验、加密会话导入导出、Cookie 查询与清理、应用锁、备份/恢复/诊断/审计导出，全部复用现有 `window.shopilot.*` IPC；空代理、无数据和失败状态如实呈现。
- 首页补齐真实书签平台入口、任务运行入口、回收站/设置入口和跨面板人工确认提示；任务运行继续走现有 TaskRunner，未新增执行器。
- 统一设置页补齐配置/达人广场/AI 配置/Agent 团队/关于软件兼容入口；AI endpoint、key、测试、清除、保存和模型列表选择器均使用现有 AI IPC。文本模型、图片模型、图文模型继续独立配置，不复用 Agent 模型配置。
- 统一任务页补齐自定义任务弹窗语义与真实任务步骤；当前平台达人邀约表单按店铺/平台读取已有配置，分类、等级、联系方式和广场地址均进入真实任务载荷；未支持平台明确拒绝，不伪造成功。
- 验证结果：`pnpm.cmd typecheck` 通过；`pnpm.cmd build` 通过；`pnpm.cmd lint` 为 **0 errors / 1039 warnings**；`pnpm.cmd test` 为 **59 文件 / 594 条通过**；M1 **108/108**；M3 **113/113**；自定义任务 **54/54**；安全面板 **44/44**；达人邀约实时日志 **16/16**。各验收脚本结束时的 Electron 退出码 1 是脚本清理进程返回值，套件断言均已通过。
- 本轮只修改 Renderer 页面/组件及其现有 IPC 调用编排；没有新增或修改后端 API、IPC 白名单、数据库表、权限边界或任务执行器。
- 未闭环：真实登录的拼多多/微信小店/快手小店/抖店副作用验收、真实第三方模型凭据和付费生图、真实 Windows 人工逐项点击、OS 级故障恢复、生产发版；这些仍需人工确认，当前不宣称已验证。
- 重启：已使用最新构建启动 `pnpm.cmd dev`，ShopPilot Electron 窗口存在（标题 `ShopPilot`）；因 5173 已被占用，本次 Renderer 选择 5174，未关闭或覆盖其他用户进程。
# 2026-10-01 M4/M5 Agent 领域接入

- `businessMetricsCompare`、`commerceHealth` 已读取 `sales_metrics` 并返回来源/周期/平台/采集时间/缺失原因；null 不补零，跨店健康保留平台和新鲜度差异。
- `invoiceExport` 复用 Main 发票纯函数生成应用管理目录下 CSV，必须人工确认；`entityApply` 复用主体冲突规则，冲突保留原值。
- 迁移 v27 新增内容草稿、经营计划、客服草稿台账；M5 动作已从通用占位切换为本地结构化领域服务。外部内容发布、广告/优惠券投放和客服发送在未实测平台上只生成提案并返回 `NOT_VERIFIED`。
- 新增测试：`tests/unit/commerce-insight-service.test.ts`、`tests/unit/commerce-growth-service.test.ts`；定向套件 24 条通过。
- 状态：M4/M5 本地实现为 `IMPLEMENTED / PARTIAL`；真实平台与 Windows 验收保持 `NOT_VERIFIED/UNTESTED`。
- 继续修正：内容发布必须先经过 `contentReview`；客服发送同时校验 `storeId + conversationId + draftId`；发票导出只导出请求的 invoice ID；主体回填支持按单店作用域，避免跨店写入。
- M6 增量：迁移 v28 增加 `commerce_agent_action_ledger`，Main 为 M4/M5 领域动作记录 inputHash、状态、confirmationId、sideEffectStarted、evidence 和恢复建议；相同动作幂等更新。新增 `tests/unit/commerce-action-ledger.test.ts`。
- M6 扩展：库存/价格/SKU、订单台账、履约/售后/退款和商品域动作纳入同一台账范围；统一记录仍不改变未实测平台的 `NOT_VERIFIED` 边界。


### M6 台账闭环增量（2026-10-01）

本轮补齐订单采集派发、退款审核/确认/回读和全部商品发布 Agent 分支的统一台账写入；`RECOVERY_REQUIRED`、`blocked_budget`、`blocked_permission` 不再降级为普通失败，回执摘要中的副作用标记会持久化为 `side_effect_started=1`。新增 Main-only `agent:commerce:ledger:list` 脱敏查询和 preload 类型声明。台账测试覆盖恢复状态、副作用标记与查询解析。真实平台、真实店铺、重启恢复和 Windows 验收仍为 `NOT_VERIFIED/UNTESTED`，整体保持 `INTERNAL_BUILD`。

M6 继续增量：受跟踪领域动作现在在 Agent Service 进入执行分支前写入 `running` 台账；若已有 `recovery_required` 或 `side_effect_started=1`，不会被新的开始记录覆盖。台账单测新增运行中状态与恢复状态保护用例。

M6 异常恢复闭环增量：跟踪动作在执行前写入 `running`；异常时按副作用风险分别收敛到 `failed` 或 `recovery_required`，并保留人工回读建议；已有恢复状态或副作用标记的同一输入不会被新的开始记录覆盖。定向台账/Agent/订单测试 31 条通过，真实平台和 Windows 验收仍未验证。
M6 最终本地验证（2026-10-01）：`typecheck`、`vue-tsc`、全量 Vitest（90 文件/966 测试）、lint（0 errors）和 build 全部通过；M6 定向台账/订单/Agent 测试 31/31 通过。真实平台、重启恢复与 Windows 验收仍为 `NOT_VERIFIED/UNTESTED`，发布状态保持 `INTERNAL_BUILD`。
M6 安全重试语义增量（2026-10-01）：允许纯读失败和人工确认等待状态在再次通过 Main 门禁后重新进入 `running`；`recovery_required` 与 `side_effect_started=1` 继续保护。台账测试 4/4、全量测试 90 文件/968 条通过。
M6 采集派单台账增量（2026-10-01）：补齐四个旧采集动作 `collectInvoices/collectBusiness/collectEntity/collectOrders` 的统一台账记录，与 M4/M5 和新领域动作保持一致；typecheck 与定向 Agent/台账测试通过。
M6 采集证据计数修正（2026-10-01）：多动作计划按本步骤新增 Job 数量写入 evidence，避免累计计数污染后续动作摘要；全量测试 90 文件/968 条通过，build 通过。
M6 空派单状态增量（2026-10-01）：采集无可执行平台或没有新增 Job 时明确返回 `NOT_VERIFIED/NO_JOB_DISPATCHED`；全量测试 90 文件/969 条通过。
M6 电商确认门禁审计增量（2026-10-01）：新增契约测试确保商品、库存/SKU、履约、退款、主体、内容、广告和客服发送动作同时受人工确认与副作用保护。定向 42/42 通过。
M3 UNKNOWN 状态语义增量（2026-10-01）：履约/退款回读的未知结果显式返回 `UNKNOWN`，台账和查询 schema 同步支持；不再与 `NOT_VERIFIED` 混淆。

### 2026-10-01 真实店铺验收尝试与阻塞

- 只读探针 `node tools/acceptance/product-sync-real-verify.js` 已运行：快手小店真实页面条数 4 与本地 4 一致，重复同步 0 新增/4 跳过；微信小店、抖店、拼多多存在 `NAVIGATION_FAILED` 或运行间不一致，状态保持 `PARTIAL/BLOCKED/UNTESTED`。
- 真实发布、库存/SKU 写回、发货、退款、平台回读、登录过期/安全验证/页面改版/网络失败和电商副作用重启恢复没有可用四平台店铺会话，未执行，不伪造成功。Computer Use 当前无可见 ShopPilot/店铺窗口，Chrome 连接器错误为 `unsupported Codex auth method: apikey`。
- Windows/本地边界证据：打包 Agent 设置 SendInput 7/7、记忆原子恢复 4/4；仍不能替代真实店铺完整验收。证据：`artifacts/agent/commerce-real-acceptance-20261001.json`、`artifacts/agent/commerce-real-acceptance-blocked-20261001.json`。
- 发布状态继续 `INTERNAL_BUILD`。下一步需要四个平台已登录 Windows 会话、测试商品/SKU、可安全测试订单和高风险动作授权；不得提交凭据到报告。

### 真实发布预检跟进（2026-10-01）

微信小店真实预检可达，但店铺为 `offline`，且既有未完成发布与缺少类目导致阻断；应用没有打开页面或提交任何平台数据。测试商品已软删除并核对。其余真实副作用和故障场景仍待可用在线店铺会话与安全测试数据。

### 串行四平台只读跟进（2026-10-01）

进程清理后串行探针观察到：拼多多一次稳定只读成功；抖店/快手首轮失败后重试成功；微信仍导航失败。结果说明当前真实会话/页面就绪不稳定，不能提升到 `VERIFIED`。M3 任务引擎 114/114、root-ceo 域 13/13、Windows Agent 设置 7/7 已通过；真实副作用和故障场景仍待在线店铺会话。

### Agent 能力增量：电商动作台账查询（2026-10-01）

root-ceo 新增只读 `commerceLedgerList` 工具，可查询恢复中、等待确认和最近电商动作的脱敏台账摘要。该工具走共享 schema/catalog、Main ledger service 和结构化 evidence，不访问 Renderer 数据库，也不改变高风险确认门禁。验证：typecheck 通过，相关 32 条测试通过。

### Agent 对话交互重制（2026-10-01）

- root-ceo 对话改为时间线视图，统一呈现用户消息、Agent 回复、折叠思考过程、执行状态和结果。
- 顶部新增会话状态条，明确显示等待确认、执行失败、恢复所需动作；恢复状态提示先回读平台，不盲目重试。
- Composer 增加店铺/页面作用域、快捷意图、发送状态、字符计数和人工确认提示。
- 状态映射、思考分组、恢复提示已补回归测试；Agent UI 定向测试 10/10，typecheck/build 通过。vue-tsc 仍有既有 `UnifiedAppsPage.vue:745` 类型错误。
- 真实平台能力、确认门禁、单 Agent root-ceo 约束未改变，发布状态继续 `INTERNAL_BUILD`。
