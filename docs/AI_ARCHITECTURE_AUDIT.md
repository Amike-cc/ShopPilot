# ShopPilot AI 底层架构审查（只读）

- 日期：2026-09-26
- 方法：按层并行只读审计（模型接入 / 上下文与提示词 / 记忆与学习 / 编排与执行 / 安全与观测），再由主 Agent **逐条复核**高危结论。
- 口径：本报告区分「**已复核**」=我本人读到该行代码；「子代理报告」=审计员给出文件:行但我未逐行复核。未实测的行为（误判率、实际 token 数、内存影响）一律标注「未实测」，不做推断。
- 未改动任何文件（除本报告），未执行 git stash/checkout/reset。

## 一、总评

**骨架完整，治理层不完整。** 分层、契约、失败语义、审计骨架、验收脚本的规模都在一个「能长期演进」的水位上；但**安全/成本/副作用的判定基准存在多份互相矛盾的实现**，属于"看起来有门禁、实际上门禁可绕过或口径打架"的一类问题。按层给判定：

| 层 | 完整度 | 最强的一环 | 最大的缺口 |
|---|---|---|---|
| 模型接入 | 70% | 凭据 safeStorage + fail-closed；fallback 白名单（认证失败不降级）；context_window 单一推断源 | 请求体在 4 处各写一遍；legacy `ai-client` 栈不计量/不受预算/不重试；能力探测结果不参与路由；预算只对 `tokens` 口径生效 |
| 上下文与提示词 | 75% | `agent-context.ts` 是完整的上下文工程模块（窗口来源、CJK 估算、两边保留截断、两遍分配、用量水位） | 系统提示不参与裁剪（小窗口直接硬失败）；岗位层提示词缺失；重启后 `thought` 混入历史 |
| 记忆与学习 | 70% | 写入→人工审核→仅 approved 注入；FTS 可重建；治理（合并/过期/归档）有单测与故障注入验收 | 审核门禁在同一渲染上下文可自审；快照恢复会复活 `approved` 且 digest 不比对；记忆正文明文 |
| 编排与执行 | 75% | Job 状态机（`canTransition` + version CAS + 事件同事务）是全场最扎实的一块 | **副作用边界有 3 份定义且不一致**；确认凭证是渲染层布尔且 Main 会自批；租约 sweep 对 `running` 无条件续租 |
| 安全与观测 | 55% | preload 白名单化彻底；模型输出逐条严格解析；Key 不进 DOM/Job/日志有验收 | 只有 agent 两个 handler 家族做可信渲染层校验；审计关联键断裂 + 技能/插件/配置写入零审计；无 CI |

## 二、已复核的高危结论（我本人读到的代码）

1. **副作用边界三份定义互不一致**（本轮最严重）
   - `packages/shared/src/agent-domain-rules.ts:27-34` 用**文案正则**判风险：`\b(click|write|fill|select|invite|update|create)\b`。
   - `apps/desktop/src/main/tasks/task-step-schemas.ts:426-436` 的 `NON_RESUMABLE_TYPES` 列了 **13 个**副作用步骤：`fillDraft/waitForUserConfirmation/click/clickByText/clickAll/setInput/aiGenerate/clickIfPresent/typeText/ensureRows/ensureRowsById/useTab/loop`。
   - `apps/desktop/src/main/services/agent-planner.ts:26` 的 `SIDE_EFFECT_TYPES` 只有 2 个：`click/clickByText`。
   - 后果：正则对 `"type":"clickByText"`、`setInput`、`typeText`、`aiGenerate`、`ensureRows*`、`useTab`、`loop`、`clickAll`、`clickIfPresent` **都不匹配**（`\bclick\b` 要求 `click` 后是词边界）。于是这类浏览器 Job 被判 `read` → 可派给只读执行者，且不置 `side_effect_started` → `resumeAgentJob`（`agent-runtime.ts:1490-1495`）放行"安全恢复"，而恢复是新 run 从第 0 步重放 → **重复向页面写入/重复发送**。

2. **确认凭证不是用户凭证，且 Main 自批资金类采集 Job**
   - `agent-service.ts:1570` 按资金文案设置 `requiresConfirmation`，紧接着 `:1578-1580` 若 Job 落到 `waiting_confirmation`，Main 用 **Job 自己的 `confirmationId`** 调 `approveAgentJob(approved: true)` 再执行。
   - 软件计划路径同源：渲染层把 `confirmed` 当作布尔自报（`apps/desktop/src/renderer/src/stores/agent.ts:285` 直接传 `normalized.plan.requiresConfirmation`），Main 只校验 `confirmed === true`（`ipc/agent-handlers.ts:185`）。
   - 后果：文档与验收里"资金动作必须人工确认"在这些采集 Job 上并不成立；任何能在渲染层跑通的代码路径（含一次误触发的自动执行）即可放行资金/不可逆动作。**这是产品口径问题，需要你定调**：要么采集 Job 不该带资金确认语义，要么自批必须删掉。

3. **预算只对 `tokens` 口径生效，且无预留**
   - `agent-runtime.ts:652`：`if (amount <= 0 || (currency === 'tokens' && used >= amount)) throw ...`。配 `USD` 预算时该条件恒 false → **永不阻断**（`amount <= 0` 反而会阻断，语义颠倒）。
   - 用量在响应返回后才落库（`:659-676`），单次请求上限可达 `max_tokens` 128000 → 无预留，可越过日上限一次。

4. **legacy 模型栈完全脱离计量、预算与重试**
   - `apps/desktop/src/main/services/ai-client.ts:75-119`（邀约话术用）读 legacy key、`stream:false`、`temperature:0.7`、`max_tokens` 硬顶 1200，**不返回 usage、不重试、不降级、不受 `assertChatBudget` 约束**；`task-runner.ts:2352` 的 `withTimeout` 只 `Promise.race` 不 abort（超时后请求仍在后台占连接）。
   - 我另外确认：全仓 `temperature/max_tokens` 有 **4 个各自独立的请求体构造点**（`ai-client.ts:89`、`agent-runtime.ts:756`、`:817`、`:963`）→ 换协议/加 provider 必漏改。

5. **小窗口下系统提示不裁剪 → 硬失败**
   - `agent-runtime.ts:737-739`：系统提示**不参与压缩**，只压 user；`maxInputTokens - systemTokens - 128 < 128` 直接抛 `AGENT_CONTEXT_TOO_LARGE`。
   - 预算算式（`packages/shared/src/agent-context.ts:325-351`，我按公式代值核对）：窗口 4096 → `safety = clamp(ceil(4096*0.04)=164, 1024, 8192) = 1024`；`outputTokens = 1200`；`maxInputTokens = max(1024, 4096-1200-1024) = **1872**`。系统提示（工具目录 + 规则）必须 <1744 token 才跑得起来。**实际 token 数未实测**（审计员估算 1800–2000，我未复算），但余量薄到必须以测试锁死；该错误码目前**零测试覆盖**。

6. **可信渲染层校验只覆盖 agent 两个 handler 家族**（P1 补了 AI 家族、P2 铺开到全部业务家族，见第八节）
   - `ipc/agent-handlers.ts:40-52`（9 处调用）与 `ipc/agent-domain-handlers.ts:16/38`（每通道包一层）有校验；`grep assertTrustedRenderer` 在 `ipc/` 下**只命中这两个文件** → `ai-handlers.ts`、store/task/browser 等全部业务通道无校验。
   - 信任锚是 `webContents` 身份而非文档来源，且主窗口没有 `will-navigate`/`setWindowOpenHandler`（全仓只有店铺视图与独立窗口有）→ 主窗口一旦被导航到任意来源，这道校验照样通过。

7. **能力探测结果不参与路由**（P2-A 已修，见第八节）
   - `grep capabilities`：只有 `agent-runtime.ts:144`（DTO 映射）、`:824-828`（探测并写库）两处消费；没有任何路由/降级逻辑读它。

8. **审计写入失败静默吞 + 关键类别零审计**
   - `services/audit-logger.ts:58-60`：失败仅 `console.error`（我本轮已给它加了"店铺不存在则写 NULL"，避免外键导致的整条丢失）。
   - 子代理报告（我未逐条复核）：技能/插件/分享包导入在 `agent-service.ts` 内 `writeAudit` 零处；`ai:config:set`（改模型地址）无审计无日志；`requestId` 多为常量串或错误码，`queryAudit` 无 requestId 过滤。

## 三、子代理报告但**未经我复核**的结论（按严重度）

| # | 结论 | 证据 | 后果 |
|---|---|---|---|
| A | 子 Agent 岗位层提示词缺失：`executeModelJob` 的 system 是写死的"只读分析 Agent" | `agent-runtime.ts:949`；`prompt_version` 只入库（`:163`） | 招聘出的分析师/审核员行为无差别，组织配置对模型行为无影响 |
| B | 租约 sweep 对 `running` 无条件续租 → 活进程内卡死的 worker 永不超时；超时只到 `recovery_required` 不自动重排 | `agent-runtime.ts:1551-1580`、`:1561-1565` | Job 永久挂起需人工 resume |
| C | 记忆审核可在同一渲染上下文自审（write → review(approved) → 下轮注入） | `agent-domain-handlers.ts:118-119`、`preload/index.ts:256` | 记忆投毒：被批准文本成为常驻旁路 |
| D | 快照恢复把 `status` 原样写回（含 `approved`），digest 只回传不比对，`confirmed` 由渲染层自报 | `agent-memory.ts:784-830` | 已驳回/已过期记忆批量复活进模型 |
| E | 失败/部分成功的 run 不写 `agent_job_results`（仅成功路径写） | `agent-runtime.ts:1231` | Job 结果为空，复盘缺证据 |
| F | 派单 `dependencies` 恒为 `[]`；`drainDelegatedQueue` 只补跑 `source=ceo-chat` | `agent-runtime.ts:1410`、`:1521-1525` | 面板创建的 queued Job 不会自动跑；DAG 依赖形同注释 |
| G | 注入防护只有 system 里一句声明，页面/记忆以纯 JSON 字段进入，无分隔符；记忆注入扫描只在写入时做 | `agent-planner.ts:30-41`、`agent-memory.ts:138-141` | 页面文本可影响模型行为（读路径不再扫） |
| H | Job 状态机外的组织自助：Main 可为"执行助手"自动激活并把只读改可写 | `agent-runtime.ts:1444-1448` | 权限自动扩张无用户确认 |
| I | 记忆正文 `.md` 明文、无 SQLCipher；`sensitivity` 只是元数据 | `agent-memory.ts:295-309`、`db/database.ts:34-36` | 本机落盘可读 |
| J | 日志行不含 `jobId`，观测无法把"一次模型请求 ↔ 审计条目 ↔ Job"对齐 | `agent-runtime.ts:985`、`audit-logger.ts:68-97` | 事后追责成本高 |
| K | 无 CI/husky；`no-explicit-any` 仅 warn；main+shared+preload 的 `any` 579 处/90 文件；主进程单文件 1.45MB；`overview-service ⇄ ipc` 成环 | `.eslintrc.cjs:31,35`、`package.json:17` | 质量靠自觉 |

## 四、测试与验收覆盖（事实）

- 单测 45 文件 / 483 用例；验收脚本 31 个（`tools/acceptance/`）。
- **未进流水线**（`run-acceptance.ps1:25-43` 只跑 dist→vitest→update→m1/m2/m3/sec/m4→custom-local→invite-live-log→manifest）：`agent-cdp-runner.js`(78/78)、`agent-domain-cdp-verify.js`(87/87)、`agent-memory-resilience-verify.js`、`packaged-agent-smoke.js`、`agent-native-ui-smoke.js`——全部要手跑。
- **零覆盖的关键路径**：`AGENT_CONTEXT_TOO_LARGE`；子 Agent 岗位是否进提示词；`trace` 级"记忆注入到提示词"端到端；`ai-client.chatComplete` 全链；USD 预算；5xx 分支；safeStorage 不可用时的 fail-closed；非主窗口 sender 被拒；`IPC_CHANNELS ↔ handler ↔ preload` 三向一致性（152 通道本次人工核对齐全，但**没有任何测试锁死**，纯靠记忆维护）；技能/插件/配置写入的审计存在性；副作用边界三份列表的一致性。

## 五、建议的收尾顺序（待你定调，我不擅自改行为）

- **P0（先做，都是"口径不一致"而非新功能）**
  1. 副作用边界收敛成**一份**（以 `NON_RESUMABLE_TYPES` 为准），`deriveJobRisk` 与 `agent-planner.SIDE_EFFECT_TYPES` 都从它派生，并补"名称型步骤不得判 read / 不得恢复重放"的单测。
  2. 资金采集 Job 的自批二选一：删掉 `:1578-1580` 的自批，或明确采集 Job 不带资金确认语义（并在文档/验收里同步改口径）。
  3. 预算口径修正：USD（或任意货币）预算要么按估算成本阻断，要么在 UI 上明确"预算仅 token 口径生效"；补预留（请求前预扣 max_tokens）。
- **P1**：岗位层进提示词；系统提示超窗时按窗口降级（裁工具目录 / 缩规则 / 明确报错文案）并补测试；`ai-handlers` 补可信校验 + 主窗口加导航守护；审计补技能/插件/配置写入与关联键（`jobId`/`requestId` 贯通）。
- **P2**：两个模型栈合并为一个（统一走 `agent-context` 预算与计量）；`IPC_CHANNELS ↔ handler ↔ preload` 加契约测试；agent 5 个脚本进流水线；CI + 收紧 `any`。

## 六、P0 收敛进展（2026-09-26 修复轮，方案 A）

用户定调：资金类采集 Job 选 **方案 A（采集保持自动执行）**。三条 P0 已全部落地：

### P0-1 副作用边界收敛为单一事实来源 ✅

- 新增 `packages/shared/src/agent-step-effects.ts`：
  - `AGENT_SIDE_EFFECT_STEP_TYPES`（11 项：click / clickByText / clickAll / clickIfPresent / setInput / typeText / ensureRows / ensureRowsById / fillDraft / aiGenerate / loop）
  - `AGENT_NON_RESUMABLE_STEP_TYPES` = 副作用 ∪ `{waitForUserConfirmation, useTab}`（13 项，与原来引擎那份**逐项一致**）
  - `isSideEffectStepType` / `isNonResumableStepType` / `collectStepTypes`（递归进 loop body/steps）/ `hasSideEffectSteps`
- 三个消费方改为同源：`tasks/task-step-schemas.ts` 的 `NON_RESUMABLE_TYPES` 现在**就是**这个集合（集合同一性，不是"内容恰好一样"）；`agent-planner.ts` 的 `SIDE_EFFECT_TYPES` 指向同一集合；`agent-domain-rules.deriveJobRisk` 先看步骤类型再看文案。
- 效果：`clickByText`/`setInput`/`typeText`/`aiGenerate`/`ensureRows*`/`clickAll`/`clickIfPresent`/`loop` 的浏览器 Job 不再被判 `read` → ① 不再派给只读执行者；② `side_effect_started` 会被置位 → `resumeAgentJob` 拒绝"安全恢复"，不再从第 0 步重放重复写入；③ `canUseFallback(..., risk === 'submit')` 与 `probation` 门禁的输入也更准。
- 顺带发现并修掉**第四份**口径：编辑器目录 `custom-task.STEP_CATALOG` 把 `pressKey` 标成 `sideEffect: true, idempotent: false`，与运行时判定相反（只按 Escape 收浮层，不改数据、可安全重放）。已改为 `false/true`，并加契约测试防再漂移。
- 回归测试：`tests/unit/agent-step-effects.test.ts`、`tests/unit/agent-step-catalog.test.ts`。

### P0-2 资金采集 Job 自批 → 改为显式"用户发起即确认" ✅

- 删除 `agent-service.ts` 里"先用 Job 自己的 `confirmationId` 自己批准、再执行"的代码；采集派单改为 `requiresConfirmation: false`。
- 资金门禁本身没有放松：`assertAgentCanCreateJob` 的 `if (money && !requiresConfirmation)` 仍在，只多了一个**Main 内部**参数 `moneyConfirmationSatisfied`（由 `delegateAgentTask(raw, { userInitiatedCollect: true })` 传入，采集路径专用）。`agentTaskDelegateSchema` / `agentJobCreateSchema` 都是 `.strict()`，渲染层塞不进这个字段。
- 真出现 `waiting_confirmation` 时不再自我放行，而是如实跳过（`跳过：<店铺>（等待人工确认，请到 Job 看板批准）`）。

### P0-3 预算口径与预留 ✅

- 新增 `packages/shared/src/agent-budget.ts` 纯函数 `evaluateDailyBudget` / `estimateReserveCost`：
  - `tokens`（或留空）→ 按 token 用量 + **本次预留**（max_tokens）比较；
  - 其他货币 → 必须配**同币种**单价，否则报 `AGENT_BUDGET_UNENFORCEABLE`（宁可拒绝执行，也不假装预算生效）；配了则按 `agent_usage.cost_json` 的已用成本 + 预留成本比较；
  - 限额 ≤ 0 → 直接阻断并说明"等于禁止调用"。
- 聊天路径（`assertChatBudget`）与 Job 路径（`executeModelJob` 的 `blocked_budget` 分支）改为调用同一个纯函数；Job 路径把真实原因写进 Job 事件（`budgetScopes`）。
- 回归测试：`tests/unit/agent-budget.test.ts`（13 条，覆盖 tokens/预留/USD 无单价/USD 有单价/币种不一致/大小写/限额 0）。

### 本轮验证（全部实跑）

| 项 | 结果 |
|---|---|
| `pnpm.cmd typecheck` | 通过 |
| `pnpm.cmd test` | **48 文件 / 504 测试通过**（+3 文件 / +21 用例） |
| `pnpm.cmd build` | 通过 |
| `agent-cdp-runner.js` | **78/78**（采集派单改动无回归） |
| `agent-domain-cdp-verify.js` | **87/87**（原先挂着的 4 项确认门禁断言已随“撤出 runInvite/updateSkill”转绿） |
| `dist:dir` + `packaged-agent-smoke.js` | 10/10 |

仍**未闭环**（属 P1/P2，未动）：岗位层提示词缺失、小窗口系统提示超窗、`ai-handlers` 无可信校验、审计关联键与关键类别零审计、能力探测不参与路由、租约 sweep 对 running 无条件续租、记忆自审/快照复活 approved、legacy `ai-client` 栈不计量、单文件打包与无 CI。（其中 P1 五项已在第七节、P2 大部分已在第八节结清。）

## 七、P1 收敛进展（2026-09-26 修复轮二）

四条 P1 已落地（同样先复核 file:line 再改，每条都有单测）：

### P1-1 小窗口系统提示词降级 ✅

- 复核：`requestChatCompletion` 只压用户载荷、系统提示词一字不裁，`maxInputTokens - systemTokens - 128 < 128` 就抛 `AGENT_CONTEXT_TOO_LARGE`；Job 路径（`executeModelJob`）同一写法。4k 窗口下输入预算约 1872 token，主 Agent 提示词（含工具白名单）很容易撞线，用户只看到"上下文过大"。
- 新增 `compactSystemPrompt(system, budgetTokens)`（`@shared/agent-context`）：按段落**从后往前**丢，治理条款写最前 → 优先保留；每次裁剪插入显式标记"〔系统提示词过长：已按当前模型窗口裁剪掉 N 字未展示内容〕"；连第一段都放不下才硬截断。两条链路都用 **输入预算的 50%** 作为系统提示词上限，并在 `logMain('warn')` 留痕。
- 如实上报：`AgentContextUsage.systemPromptDroppedChars`（多轮累计），`describeAgentContextUsage` 在气泡/面板的水位后面追加"· 系统提示词已按窗口裁剪 N 字"，不声不响地降级被明确禁止。
- `AGENT_CONTEXT_TOO_LARGE` 保留为不可恢复情形的兜底，错误信息带上具体 token 数（系统 X / 预算 Y）。

### P1-2 AI 配置通道补可信校验 ✅

- 复核：`assertTrustedRenderer` 原先只在 `ipc/agent-handlers.ts` 与 `ipc/agent-domain-handlers.ts` 各写一份（措辞/错误码不同），`ipc/ai-handlers.ts` 的 6 个通道（含 `ai:keySet` / `ai:config:set`）完全没有——能执行脚本的渲染层可以直接改 AI 配置、写/清 API Key。
- 新增 `services/renderer-trust.ts`（electron 侧取值/抛错）+ `services/renderer-trust-rules.ts`（纯判定，可单测）；三处旧实现收敛到这一份。AI 家族新增错误码 `AI_FORBIDDEN`（`APP_LOCKED` 复用既有码），并已进 `@shared/errors/error-codes` 目录。
- 6 个 AI 通道全部校验，失败如实回 `AI_FORBIDDEN` / `APP_LOCKED`，不再被各自的 `AI_CONFIG_FAILED` 之类错误码掩盖。

### P1-3 子 Agent 岗位层提示词 ✅

- 复核：`executeModelJob` 的 system 是写死的一句"你是 ShopPilot 的只读分析 Agent…"，`prompt_version` 只入库不参与提示词 → 招聘出的"数据分析"与"客服质检"拿到同一段提示，组织配置只影响"谁执行"，不影响"怎么做"。
- 新增 `buildAgentJobSystemPrompt()`（`@shared/agent-job-prompt`）：治理条款排第一行（裁剪时最不易丢），随后是名称/岗位/职责/成功标准，再按岗位追加条款（审核岗强调证据、数据分析岗强调口径），最后是 Job 形态规则与 `extraRules`。岗位中文名与界面下拉、Main 的 `ROLE_TEMPLATES` 统一为一份 `AGENT_ROLE_LABELS`（商品运营/数据分析/审核 Agent/内容文案/客服质检）。
- 取不到执行者记录时退化成通用执行者提示，不让提示词构建失败阻断 Job。

### P1-4 legacy AI 栈纳入计量与预算 ✅

- 复核：`ai-client.chatComplete`（设置里「测试连接」+ 达人邀约话术生成）不写 `agent_usage`、不看日预算，同一把 Key 的消耗一半进账一半看不见。
- 新增 `services/model-governance.ts`（只依赖 db + shared，避免与 agent-runtime 成环）：`resolveMeteringTarget()`（主 Agent 绑定的 Profile → 预算/单价/输出上限）、`dailyUsageSnapshot()`、`assertMeteredBudget()`、`recordModelUsage()`。`agent-runtime` 的 `recordChatUsage` 与当日用量快照也改为复用它——**用量与记账只有一份实现**。
- `chatComplete` 请求前按"本次 max_tokens"做预留校验（超限如实回 `AGENT_BUDGET_BLOCKED`），成功/失败都写用量记录，并开始读取服务商 `usage`；解析不到计量目标时记一条 warn 说明"本次未计量"，不假装已计量。

### 本轮验证（全部实跑）

| 项 | 结果 |
|---|---|
| `pnpm.cmd typecheck` | 通过 |
| `pnpm.cmd test` | **51 文件 / 526 测试通过**（+3 文件 / +22 用例） |
| `pnpm.cmd build` | 通过 |
| `agent-cdp-runner.js` | 78/78 |
| `agent-domain-cdp-verify.js` | **87/87**（撤出 runInvite/updateSkill 后，长期挂账的 4 项确认门禁断言转绿） |
| `dist:dir` + `packaged-agent-smoke.js` | 10/10 |

### 附：确认名单与风险等级解耦（同轮用户定调）

`runInvite`（达人邀约，用户在对话里发起、额度用尽自动停止）与 `updateSkill`（技能改名/启停，可逆的本地定义变更）已从 `AGENT_CONFIRM_REQUIRED_ACTIONS` 撤出（29 项）。撤出**不等于降级**：新增 `AGENT_SIDE_EFFECT_SOFTWARE_ACTIONS` + `softwareActionHasSideEffect()`，`agent-service.planFromActions` 改为「risk 看副作用集合、requiresConfirmation 看确认集合」，因此这两个动作仍是 `risk=write`、只读执行者仍不能接、`side_effect_started` 照置位（不可"安全恢复"重放），也仍在技能禁入清单里。此前两者共用一个集合，任何一次"少要一次确认"的调整都会顺手把风险降成 `read` —— 与 P0-1 是同一类问题。

仍**未闭环**（P2 及后续）：记忆审核自审路径的口径（C，见第八节复核结论：现为按权限模型的设计）、快照 `confirmed` 仍是渲染层布尔、审计关联键与关键类别零审计、`temperature/max_tokens` 4 处独立请求体构造点、主进程单文件 1.45MB、`any` 579 处/90 文件、`overview-service ⇄ ipc` 成环。已在本轮复核结清的见第八节；**其中六条已在第九节（P3）收敛或记为技术债**，只剩"快照 `confirmed` 仍由渲染层自报"这一条以量化理由保留。

## 八、P2 复核与收敛（2026-09-26）

先复核每一条声明是不是真问题（`file:line` 逐个读），再决定改还是记误报——**不为改而改**。

| # | 原声明 | 复核结论 | 处置与证据 |
|---|---|---|---|
| B | 租约 sweep 对 `running` 无条件续租 | **属实**（`agent-runtime.ts:1673-1674`：只要有 owner 就推 `lease_expires_at`，于是"进程还活着"顶替了"worker 还在干活"，过期分支再也进不去） | 新增纯规则 `packages/shared/src/agent-lease.ts`（`evaluateLeaseSweep`）：**只有活着的执行者（模型 controller 在飞 / TaskRunner 运行仍在跑）或刚启动的宽限窗口才续租**；另加最长运行时限 `agent.jobs.maxRunMs`（默认 30 分钟）→ 一律 `recovery_required` 交人工（不自动重排：可能已有副作用）。8 条单测锁死，含"没有活执行者就不再续租"这条关键回归 |
| A | 能力探测结果不参与路由 | **属实**（`capabilities_json` 只在 DTO 映射与探测写库两处被读） | 新增 `modelCapabilityVerdict()`（shared）：`chat:false` → 拦下并给可操作原因（聊天链路抛 `AGENT_MODEL_INCAPABLE`，Job 链路转 `blocked_permission` 并写事件）；**`json:false` 只 warn 不拦**——这条口径是被真机验收校准的：离线 fixture 与部分真实 Profile 的探测结果就是 `json:false` 但能跑通 Job，一律拦会让 domain 套件 8 项转红 |
| C | 记忆审核可在同一渲染上下文自审 | **误报**（口径问题） | `reviewMemory`（`agent-memory.ts:417-447`）要求 reviewer 是 root-ceo 或**持有 `review_job` 工具权限**，另加范围校验（`canAccessMemoryRecord`）、正文 hash 校验、凭据敏感扫描，并写审计。"同一渲染上下文"说的是"面板与 CEO 共用 IPC"，而判定基于**哪个 Agent 在审**（`reviewerAgentId`）而不是"哪个渲染进程"，不构成权限旁路；该 `review_job` 权限本身就是文档里的审核岗定义 |
| D | 快照恢复复活 `approved`、digest 不比对、`confirmed` 由渲染层自报 | **大部分误报** | 快照是 **AES-256-GCM**（`agent-memory.ts:768-775`，篡改/损坏会在解密时失败，`tag` 即完整性认证），恢复时逐条走 `redactMemoryContent`（命中凭据直接抛 `AGENT_MEMORY_SENSITIVE`）+ 注入扫描置 `quarantined` + 正文上限 + 重新计算 hash，且要求 root-ceo 且 `confirmed`，还写审计。**保留按原状态恢复是灾难恢复的应有语义**（否则恢复后 approved 全丢）。残留真实缺口：`confirmed` 是渲染层布尔（面板弹窗），与"确认凭证应由 Main 持有"是同一类问题——已记入未闭环清单 |
| E | 失败/部分成功的 run 不写 `agent_job_results` | **误报（且是契约）** | 验收脚本 **5 处**明确断言失败/阻塞/取消/恢复类 Job 的结果必须为空：`agent-domain-cdp-verify.js:304`（permission 变更后 `results.length === 0`）、`:354`（取消不留陈旧结果）、`:383`（认证失败 `results.length === 0` 且证据在 `lastEvent.evidence.code`）、`:388`（预算阻断）、`:529`（**"without fabricating a result"**）。结果行是**工作产物**，失败不能伪造产物；失败证据在 `agent_job_events`，`followUpAgentJob` 已把 `events.at(-1).reason` 带进续办上下文（`agent-service.ts:1108`） |
| F | 派单 `dependencies` 恒为 `[]`；`drainDelegatedQueue` 只补跑 `source=ceo-chat` | **误报（部分属实但合理）** | DAG 依赖是**可达**的：`agent:job:create`（`ipc/agent-domain-handlers.ts:78`）走 `agentJobCreateSchema.dependencies`（`schemas/agent-domain.ts:161`，最多 12 个）→ `validateJobDependencies`（去重 + 跨 Job 成环检测）→ run 前 `dependencyState` 门禁 → 队列补跑前再查一次。只有**聊天派单**恒 `[]`——CEO 派单时未来 Job 的 id 还不存在，本就无从指定。`drainDelegatedQueue` 只补 ceo-chat 是注释明写的设计（`:1585`"不触碰任务面板/手工创建的排队项"） |
| G | 无 CI；主进程单文件 1.45MB；`any` 579 处 | **属实（部分处置）** | 新增 `tools/ci/verify.ps1`（typecheck → 单测 → build，本地已实跑）与 `.github/workflows/ci.yml`（windows-latest 调它；**未在真实 CI 上跑过**，仓库此前无 CI）；把 Agent 四套脚本补进 `run-acceptance.ps1`（原先"未进流水线"）。单文件产物与 `any` 数量属技术债，未动（拆分构建产物风险高于收益，记入未闭环） |

### IPC 可信校验铺开（原 P2-C / 结论 6）

原状：只有 Agent 两个家族 + AI 家族（P1 补）有校验，其余 **8 个家族共 92 个通道**是裸 `ipcMain.handle`。

- 新增 `apps/desktop/src/main/ipc/family-handle.ts`：`familyHandle(feature, opts)` 生成带校验的注册函数；8 个文件全部改为 `handle(...)` 注册（92/92）。
- 规则：发送方必须是**应用主窗口**（`IPC_FORBIDDEN`，新错误码）；**应用锁定时拒绝**，只有会话/安全家族显式 `allowWhenLocked: true`（解锁、锁状态、设置/移除主密码——否则用户永远解不开锁）。
- 复核过风险面：业务 preload 只在主窗口注入（store 视图无 preload、密码弹窗用自己的最小 preload 且走 `pw-dialog:done` 监听而非业务通道），所以这条主要是**防未来漂移**（新增 preload/视图类型时不再静默多出一批可达通道）。
- `tests/unit/ipc-trust-guard.test.ts` 把"统一入口"变成契约：裸 `ipcMain.handle` 只允许出现在 `family-handle.ts` 或"断言数 ≥ 通道数"的家族文件里；每个家族必须有校验来源；`allowWhenLocked` 只许出现在会话/安全家族。

### 本轮验证（全部实跑）

| 项 | 结果 |
|---|---|
| `pnpm.cmd typecheck` | 通过 |
| `pnpm.cmd test` | **54 文件 / 546 测试通过**（+3 文件 / +20 用例：`agent-lease.test.ts`、`agent-model-routing.test.ts`、`ipc-trust-guard.test.ts`，另扩 `renderer-trust.test.ts`） |
| `tools/ci/verify.ps1` | **CI_ALL_PASSED**（typecheck/vitest/build 三步全 0；新脚本已实跑，不只是写出来） |
| `pnpm.cmd build` | 通过 |
| `agent-cdp-runner.js` | 78/78 |
| `agent-domain-cdp-verify.js` | **87/87**（一次"先红后绿"很有价值：能力探测最初把 `json:false` 也当不可用 → 8 项转红 → 按真机口径改成只拦 `chat:false` 后全绿） |
| `agent-memory-resilience-verify.js` | 4/4（本轮补进 `run-acceptance.ps1`） |
| `dist:dir` + `packaged-agent-smoke.js` | 10/10 |
| `run-acceptance.ps1` | 已把 Agent 四套脚本并入流水线（原先只能手跑） |

## 九、P3 复核与收敛（第八节列出的未闭环项）

同样先复核再动手；收益低于风险的如实记为"接受的技术债"，并给出量化理由。

| # | 原声明 | 复核结论 | 处置与证据 |
|---|---|---|---|
| 1 | 审计关联键多为常量串、关键类别零审计 | **属实**（`agent-handlers.ts` 8 处 `requestId: 'agent.observe'` 这类常量；`agent-service.ts` 里技能/插件/分享包 **零** `writeAudit`；`ai:config:set` 改模型地址既无审计也无日志；`queryAudit` 没有 requestId 过滤；`audit:query` 的 filter 是 `any` 直通 SQL） | 新增 `auditRequestId(id, detail)` 约定（每次调用真实 id + `#说明`，失败带错误码、成功带最小上下文）；`queryAudit` 支持 `requestId` 精确/前缀过滤（`%`/`_` 当字面量，带 ESCAPE）；`auditQueryFilterSchema` strict 化（多余键、字符串 limit/负数时间戳一律拒绝）；补 `ai.config`（成功含变更字段、失败含错误码）与 `agent.skill.create/update/delete/run`、`agent.plugin.create/update/delete`、`agent.pack.import/export` 审计，落在各自动作的**唯一漏斗**上（技能 upsert / update / delete；插件改删；包导入导出），模型自选建的技能 `actor=root-ceo`、用户手建 `user`；对话里的 `deleteSkill`/`updateSkill` 改为复用带审计的函数（原先直接 DELETE 不留痕） |
| 2 | `overview-service ⇄ ipc` 成环 | **属实**（`services/overview-service.ts:24` ←→ `ipc/profile-misc-handlers.ts:24`，此前靠"两边顶层只有函数声明会被提升"说明安全） | 把 `collectInvoiceRows`/`collectEntities` 搬进 `services/overview-service.ts`，方向变单向 `ipc → services`（`overview:invoiceExport` 仍用同一份取数，没有第二处实现）；新增 `tests/unit/main-layer-direction.test.ts` 把"services/stores/tasks/browser 不得 import ipc"变成契约 |
| 3 | `temperature/max_tokens` 有 4 处独立请求体构造点 | **属实且已出现漂移**（`ai-client.ts` 与 `agent-runtime.ts` 三处手写请求体；Job 路径少了 `stream:false`、头部大小写也不同） | 新增 `services/model-request.ts`：`buildChatRequestBody`（字段名与取值口径）/`buildChatRequestHeaders`/`clampMaxOutputTokens`（默认上限 128000），五个调用点（legacy 对话、Agent 对话、Job、健康检查）全部改走它；`tests/unit/model-request.test.ts` 10 条用例 + **源码级守卫**（除本文件外不得再出现 `max_tokens:` 请求体）。整理过程中测试抓到 2 个真实缺陷：`Number(null) === 0` 会让"没传温度"变成"温度 0"（现按 nullish 回退 0.7）；`Infinity` 的收敛口径写明为"取 min（少要不多要）" |
| 4 | 快照恢复 `confirmed` 渲染层自报、digest 只回传不比对 | **属实（部分）** | 新增 `packages/shared/src/memory-snapshot.ts:verifySnapshotDigest` + `agentMemorySnapshotRestoreSchema`（strict）：面板把**自己展示过的 sha256** 回传，Main 与文件实际摘要不一致（含长度/字符非法）一律拒绝；审计 `agent.memory.restore` 记录快照摘要与"是否比对过摘要"。8 条单测。**残留（接受）**：`confirmed` 仍是渲染层布尔——彻底消除需改 Main 侧原生确认窗（`session-exporter` 的 `askConfirm` 已有先例，但验收脚本要注入 `SHOPILOT_TEST_AUTOCONFIRM`，而 `agent-domain-cdp-verify.js` 是用户未提交在途文件）；风险面也已收敛：存储视图/弹窗没有业务 preload、该通道现由窗口身份 + 应用锁门禁保护 |
| 5 | `any` 579 处 / 90 文件 | **数字不准**：实测 `@typescript-eslint/no-explicit-any` 是 **941 处 / 70 文件**（main 597、renderer 202、tests 105、preload 22、shared 15） | **加棘轮而不是一次性全改**：`packages/shared/**` 把显式 `any` 从 warn 升为 **error**（两个进程共用的纯规则与契约，这里的 any 会同时污染两侧判断）；先清干净这 15 处——`douyin-category-tree.ts` 12 处改成 `unknown` + 显式收窄（`asRecord`/`Array.isArray`/`typeof`）并补 9 条边界用例（含"没有子项的根类目会被丢弃"这一容易误判的契约），`contracts/ipc.ts` 的 `details` 收紧为 `unknown`、信封默认泛型保留 `any` 并在文件内 `eslint-disable` + 写明理由。已用探针验证棘轮真的会报错（在 shared 里塞一个 `any` → 1 error）。其余四层仍是 warn 的存量债 |
| 6 | 主进程单文件 1.45MB、无 CI | **属实**（本轮实测 main `1,429.43 kB`、renderer `1,020.08 kB`；CI 已在 P2 补上） | **接受**：Electron 主进程必须单入口，产物大小对已安装的桌面应用没有用户可见成本；唯一现成杠杆是给 main 开 `build.minify`（esbuild），但那会毁掉主进程的堆栈信息——本项目恰恰靠它定位 Job/模型失败原因（日志与打包 smoke 都会读错误文案）。CI 侧 P2 已加 `tools/ci/verify.ps1` + workflow |

### 顺带修掉的一个回归（复核 P2 时发现）

P2 那轮把 8 个 IPC 家族统一加了"应用锁定时拒绝"的门禁，但 `App.vue:44-50` 会在 `appLocked`
变化时调用 `window:setTitlebarOverlay` 把标题栏刷成锁屏底色（#101218）——统一门禁会把这个
**纯装饰**通道也拒掉，锁屏期间标题栏停在旧色。现在 `familyHandle` 支持按通道放行
（`handle(channel, fn, { allowWhenLocked: true })`），只有这一个装饰通道例外；
`tests/unit/ipc-trust-guard.test.ts` 断言"锁定态放行只允许会话/安全家族 + 标题栏底色通道"且该文件里例外仅此一处。

### 本轮验证（全部实跑）

| 项 | 结果 |
|---|---|
| `pnpm.cmd typecheck` | 通过 |
| `pnpm.cmd test` | **58 文件 / 589 测试通过**（+4 文件 / +43 用例：`audit-logger`、`main-layer-direction`、`model-request`、`memory-snapshot-digest`，`douyin-category-tree` 1→10） |
| `pnpm.cmd lint` | **0 errors / 935 warnings**（共享层棘轮生效后 any 警告 950 → 935；顺带清掉 12 个"搬移后遗留的未使用 import"错误） |
| `pnpm.cmd build` | 通过（main 1,429.43 kB） |
| `agent-cdp-runner.js` | 78/78 |
| `agent-domain-cdp-verify.js` | **87/87** |
| `agent-memory-resilience-verify.js` | 4/4 |
| `dist:dir` + `packaged-agent-smoke.js` | 10/10 |
| `tools/ci/verify.ps1` | **CI_ALL_PASSED** |

## 十、复查方式

```powershell
# 结论 1（副作用三份定义）
Select-String -Path packages\shared\src\agent-domain-rules.ts -Pattern 'click\|write\|fill'
Select-String -Path apps\desktop\src\main\tasks\task-step-schemas.ts -Pattern 'NON_RESUMABLE_TYPES'
# 结论 2（Main 自批）
Select-String -Path apps\desktop\src\main\services\agent-service.ts -Pattern 'approveAgentJob'
# 结论 3（预算口径）
Select-String -Path apps\desktop\src\main\services\agent-runtime.ts -Pattern "currency === 'tokens'"
# 结论 6（可信校验覆盖：现在应只剩 family-handle 里有裸 ipcMain.handle）
Select-String -Path apps\desktop\src\main\ipc\*.ts -Pattern 'ipcMain\.handle\('
Select-String -Path apps\desktop\src\main\ipc\*.ts -Pattern 'familyHandle\('
# P2-B（租约不再无条件续租）
Select-String -Path apps\desktop\src\main\services\agent-runtime.ts -Pattern 'evaluateLeaseSweep'
# P2-A（能力探测参与路由）
Select-String -Path apps\desktop\src\main\services\agent-runtime.ts -Pattern 'modelCapabilityVerdict'
# 一键快检（typecheck + 单测 + build）
powershell -ExecutionPolicy Bypass -File tools\ci\verify.ps1
```
