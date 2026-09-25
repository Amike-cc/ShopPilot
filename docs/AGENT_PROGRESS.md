# ShopPilot Agent 实施进度

更新时间：2026-09-25

## 当前级别

`PACKAGED`（本地 Electron、目录包、NSIS 安装/升级/卸载、隔离降级回滚和 CDP 夹具通过；真实店铺、真实模型、完整人工桌面逐项验收和 OS 级破坏性夹具仍为 partial/untested）。

## 阶段状态

| 阶段 | 状态 | 已落库 | 未闭环 |
|---|---|---|---|
| A-M0 | IMPLEMENTED | `packages/shared/src/schemas/agent-domain.ts`、错误码、IPC、迁移 v5→v8（v6 租约/确认、v7 价格、v8 技能/插件）、root-ceo、路径/隐私规则和契约测试 | 正式人工评审记录 |
| A-M1 | PARTIAL | Profile CRUD、safeStorage、`hasKey` DTO、绑定/解绑继承、真实测试入口、能力探测落库、fallback 白名单（503 降级 / 401 拒绝降级）、真实 fallback 路由（本地夹具） | 真实服务商凭据下的模型调用 |
| A-M2 | PARTIAL | root-ceo + `mode=hr`、岗位预览、probation、确认激活、暂停/恢复/退休（暂停 Agent 拒绝新 Job 有本地验收）；可见智能体回合（模型自选白名单软件操作：查询/店铺/任务/采集/备份/记忆，只读与采集立即派单、危险动作先确认；全局设置禁入）、工具目录（提示词白名单由 `agent-tools.ts` 生成）、技能与插件（`createSkill`/`runSkill` 自动执行，声明式、无新权限）、技能/插件 JSON 分享包导入导出（设置面板，需确认、整体校验）、团队/Job 感知问答、对话创建/激活子 Agent、打开应用面板；打包版设置页 Agent SendInput smoke 7/7 | 完整 Windows 桌面逐项人工确认 |
| A-M3 | PARTIAL | Job 状态机、幂等、租约心跳/过期、重启恢复（running → recovery_required → 安全重新排队）、取消、人工确认一次性消费、结果审核、TaskRunner 证据链和 lease owner 防旧 Worker 写回；CEO 经 `job:delegate` 派单，root-ceo 禁止作为执行者（AGENT_ROOT_CANNOT_EXECUTE / AGENT_NO_EXECUTOR）；自治运营：非资金 Job 无需审批，资金 Job 保留确认门禁 | 真实服务商模型请求和真实店铺副作用 |
| A-M4 | PARTIAL | 独立记忆目录、manifest、hash、FTS5/LIKE、脱敏、quarantine、审核、加密快照、确认恢复、损坏正文恢复为 conflict 版本、重启恢复、正文和加密快照原子 I/O 故障回滚、符号链接 containment | OS 级断电/磁盘满和跨设备恢复 |
| A-M5 | PARTIAL | 成功率、首次成功率、人工修正率、fallback/预算阻塞（日预算阻断有本地 Job 证据）、可配置单价（币种 + 每百万 token 输入/输出价）与按 token 的成本估算（未配置价格时保持“未估算”）、混合币种不伪造合计、记忆命中/采纳/拒绝、stale/conflict、Profile 健康度、Job 结果反馈、CEO 周期复盘摘要和过期记忆 stale 治理 | 真实成本仍依赖用户配置单价而非服务商对账；完整破坏性可靠性治理仍待专用夹具 |
| A-M6 | PACKAGED/PARTIAL | typecheck、单测、build、目录包、NSIS 安装/升级/卸载、隔离降级回滚、本地 Electron/CDP、真实 Windows SendInput Agent 设置 smoke 7/7 | 完整 Windows 桌面逐项验收、真实店铺、真实模型 |

## 关键证据

- `node tools/acceptance/agent-domain-cdp-verify.js`：本地临时 userData、临时店铺和只读页面，78/78；覆盖模型快照、子 Agent 未绑定模型时继承 default-main（主 Agent AI 配置）、设置页 AI 配置同步到主 Profile 并被子 Agent 继承、解绑恢复继承、CEO 无可用子 Agent 时自动创建并激活「执行助手」（不再报 AGENT_NO_EXECUTOR）、执行者并发已满时派单转入排队而不是失败、root-ceo 禁止作为执行者（AGENT_ROOT_CANNOT_EXECUTE）、CEO 派单经子 Agent 执行并落 TaskRunner 证据、浏览器 Job 在店铺未打开时自动开店并真实执行（真机修复回归）、只读范围的 Agent 不能接收写操作 Job / 写任务派单自动跳过只读执行者（权限模型回归）、非资金写操作无需审批即可运行、资金 Job 仍必须确认、工具/技能/插件（createSkill 走受控计划并进入软件上下文、runSkill 逐步执行回传结果、技能禁止包含资金/不可逆工具、禁止包含关店/删任务等需人工确认动作、禁止嵌套技能管理动作、createPlugin 打包并可列出、未知技能如实报错）、分享包（导出含格式标记且不含 id/时间戳、导入必须先确认、含需确认动作的包整体拒绝不半导入、导入成功且同名幂等更新、插件引用缺失如实报错、非法 JSON 拒绝）、**达人邀约（未实测平台拒绝、配置不完整逐条说明、按店铺配置派发 Job）**、**订单明细（未实测不猜锚点、按实测档案整表采集并逐行落库）**、**聊天日预算硬阻断与恢复**、**Job 载荷嵌套超限如实拒绝**、HTTP 429 只重试一次后成功、能力探测落库（JSON 能力 + healthy）、主模型 503 后按白名单切换备用 Profile（证据记录 fallbackUsed）、401 认证失败不降级（Job failed 且无结果）、日预算阻断、未配置价格时成本“未估算”、配置每百万 token 单价后按 token 估算成本（evidence 和 CEO 复盘同步）、进程被杀后 running → recovery_required → 安全重新排队、暂停 Agent 拒绝新 Job 并可恢复、启用备用 Profile、备用 Profile 循环/停用校验、权限变更阻塞、无 Key 阻塞、safeStorage Key 下本地模型 Job 真实结果、Job 依赖、取消竞态、空/非法 JSON 模型响应的 IPC 错误 envelope、结果审核、记忆隔离、FTS 索引重建 hash 保持、损坏正文 quarantine 后快照恢复为 conflict 版本、同一 userData 重启后记忆检索、CEO 周期复盘摘要和快照路径校验。
- `node tools/acceptance/agent-cdp-runner.js`：可见智能体真实 Electron/CDP 61/61；覆盖经营指标检查走已实测采集（订单/销量/销售额）、多店任务（逐店打开/规划/派发 + 完成后在对话里汇总结果）、对话记忆（后续回合带最近对话与已审核记忆，第二个回合能引用第一句的暗号）、智能体回合（思考过程可见、模型自选只读操作立即执行、第二轮基于结果收尾、非资金计划自动派发/自动执行、资金动作保留确认、例外审批：彻底删除店铺未确认不执行）、自然语言关闭/新建/移入回收站、创建备份、采集派单、工具目录（“查看工具”返回全部工具并执行计划）、技能（**复合指令“制作技能：…看最近 Job 的执行情况”不被查看 Job 快捷路由劫持**、模型自选 createSkill 自动执行并进入软件上下文、思考可见；“运行技能 验收巡检技能”确定性路由逐步执行并回传结果）、插件（“把巡检技能打包成插件”自动执行、“查看插件”列出打包结果）、设置面板技能与插件页（列出技能/插件、“生成分享包”导出 `shopilot-agent-pack` JSON、粘贴导入后面板与列表更新）、任务详情即时执行且不被当成页面任务、模型 429 自动重试一次、不打开店铺也能对话、主 Agent 自己操作软件（打开目标店铺并自动继续规划）、团队与 Job 感知问答、对话创建/激活子 Agent、打开 Agent 团队面板、Job 完成自动复盘、页面计划经 `job:delegate` 派给 active 子 Agent、主 Agent 不再直接 `task:create/task:run`、TaskRunner 真实读取页面标题、抽屉展示 Job 结果、AI Key 不进入 Job/DOM，runner 已隔离 APPDATA 临时目录。
- `node tools/acceptance/m3-runner.js`：现有 Main-only TaskRunner、Scheduler、人工确认门禁和 AI 任务套件 113/113（2026-09-25 随工具/技能/插件改动复跑通过）；结果写入 `artifacts/agent/m3-runner-latest.txt`。
- `pnpm.cmd typecheck`：通过。
- `CI=1 pnpm.cmd test -- --run`：34 个文件、391 个测试通过（CI 环境让现有 `vitest` script 在一次运行后退出）。
- `pnpm.cmd exec vitest run`：34 个文件、391 个测试通过（含 `agent-tools.test.ts`：工具目录与动作类型一一对应、示例均为合法 action、技能步骤禁入清单、审批标记、提示词白名单无脚本面；`agent-domain-contract.test.ts`：只读指标（退款金额/退款订单数）不触发资金门禁、三个已实测平台档案逐一守卫、写任务执行者过滤只读 Agent；`agent-invite-task.test.ts`：面板/智能体共用的邀约构造器（缺项逐条说明、AI 话术、商品 ID 规范化、超上限不静默收敛）；`agent-orders-task.test.ts`：订单明细档案红线与整表步骤；`agent-software.test.ts`：技能/插件动作与分享包 schema 的边界与拒绝形状）。
- `pnpm.cmd build`：已通过（Electron main/preload/renderer 构建）。
- `pnpm.cmd lint`：通过（0 errors；仓库现有 831 条 `any`/风格 warnings）。
- `pnpm.cmd dist:dir` + `node tools/acceptance/packaged-agent-smoke.js`：目录包 smoke 6/6，设置页 Agent 团队五个子页（组织/模型/记忆/技能与插件/Job）均可切换并渲染。
- `node tools/acceptance/sec-runner.js`：安全能力 44/44（会话包、Cookie、应用锁、代理边界）。
- `node tools/acceptance/m4-runner.js`：完整发布验收 13/13；内含解包版对话链路 19/19、单实例和日志清理、NSIS 静默安装 3/3、覆盖升级 4/4、静默卸载和用户数据保留。
- `node tools/acceptance/agent-memory-resilience-verify.js`：验收专用断电/磁盘满时序（正文重命名前、正文写完、manifest 写完、加密快照重命名前）4/4；文件、加密快照、manifest、SQLite 台账和临时文件均无残留。
- `node tools/acceptance/agent-native-ui-smoke.js`：真实 Windows `SendInput` 聚焦打包窗口、打开设置、进入 Agent 团队并切换组织/模型/记忆/Job 四个子页 7/7。
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
- 智能体可操作软件所有非设置功能：店铺增删改/回收站、任务查看/删除/派单运行/暂停恢复/取消、发票/经营数据/主体采集、下载与书签、备份、记忆写入；关闭删除、运行任务、备份恢复与组织变更必须先确认。全局设置（AI 配置与 Key、平台地址、应用锁、代理、会话导出、更新）永不进入白名单。
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
- 验收抖动修复（可见 CDP 出现过 1 项 FAIL）：自治自动执行下“打开店铺并继续规划”的中间软件计划卡是瞬态的，断言改为同时接受稳定的对话标记“正在打开并继续规划”；功能本身无回归（最终任务计划卡已生成，店铺已自动打开）。
- `AGENT_DEVELOPMENT_SPEC.md` 旧版 §45 的 DESIGNED 状态已更新为本次实际阶段状态，历史描述保留为基线说明。

## 证据与回滚

证据写入 `artifacts/agent/`，仅包含命令、状态、版本、hash 摘要和脱敏错误码，不写入 API Key、Cookie、Token、客户数据或记忆正文。回滚按迁移 down 脚本、数据库备份和工作区 diff 逐项执行；不得重置用户已有无关改动。
