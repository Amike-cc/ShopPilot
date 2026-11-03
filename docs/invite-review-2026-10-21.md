# 达人邀约功能审查报告

**审查时间**：2026-10-21
**审查范围**：`apps/desktop/src/main/services/invite-*`、`apps/desktop/src/main/ipc/invite-handlers.ts`、`apps/desktop/src/main/tasks/task-step-executor.ts`（邀约相关分支）、`apps/desktop/src/renderer/src/features/invite/**`、`packages/shared/src/invite-*.ts`、迁移 v33/v34/v36
**审查方式**：静态通读 + 跨层调用链核对 + 实跑邀约单测（4 个文件 / 23 用例，全部通过）
**未覆盖**：真机平台行为、打包态冒烟（`tools/acceptance/creator-invite-smoke.js` 需先打包并带 `--remote-debugging-port` 启动）、多店铺并发实测

> 与 `docs/CODE_REVIEW_2026-10-21.md` 的关系：那份是同日的**架构/安全面**全量审查（结论 P0=0，安全项全绿）；本报告只审**达人邀约的业务流程与状态正确性**，两者不重叠。本报告的 P0 不是"代码质量 P0"，而是"业务护栏口径错误"，架构审查按维度扫不到。

---

## 0. 结论

功能主干是成立的：**配置 → 批次 → 任务 → 隐藏后台页执行 → 逐人记账 → 读时推导状态**，业务拒绝与异常分离、PII 快照脱敏、审计留痕、幂等插入都做了。问题不在"能不能跑"，而在**护栏的口径与实际执行不一致**，以及**账本在失败窗口里会漏记**。

最需要先处理的五件事：

1. **日上限护栏对批量流基本失效**：批次 `targetCount` 是"每批人数"，而引擎一轮接一轮跑到平台额度耗尽（最多 20 轮 × 每轮 40 位）。`dailyCap` 只按"每批人数"拦一次，运行中不再校验。
2. **手动/智能体直跑绕过全部护栏**：任务中心的「运行」和智能体的 `runInvite` 都不走 `startInviteCampaign`，没有额度校验、没有同店互斥、没有 7 天/黑名单跳过名单。
3. **"部分发送成功"时账本一条不写**：平台返回"部分邀约发送失败"（同批其余人已发出）时整轮抛错，`recordInviteBatch` 在成功路径才调用 → 真实已发的人没记录、额度少算、下次重复访问详情页。
4. **批次状态会把"等待确认"显示成"失败"，且永远钉在首个 run**：`deriveStatus` 没处理 `waiting_confirmation`；任务重跑后批次仍读旧 run。
5. **跳过/失败计数恒为 0**：`skipped_*` / `failed_*` 从未写入，但批次卡片、抽屉、记录页筛选都在展示这些状态。

严重度统计：**P0 4 条、P1 8 条、P2 9 条**。

---

## 1. 业务流程

### 1.1 端到端链路

```
[独立页 /+ 新建邀约]  CreatorInvitePage.vue
   └─ InvitePanelView（四步向导，仅 v-show 分组）
        └─ submit → useInviteRun.startInvite()
             ├─ 读 7 天台账 nicknames（invite:recentHistory）
             ├─ 读黑名单 nicknames（invite:creators:blacklisted）
             ├─ 合并 → buildInviteTaskPayload()（shared/invite-task）
             └─ IPC invite:campaign:start
                   └─ startInviteCampaign()（invite-campaign-service）
                        ① 店铺存在性（stores.deleted_at IS NULL）
                        ② 同店同平台活动批次锁（campaign JOIN run）
                        ③ 排期窗口（1min ～ 30d）
                        ④ 日额度 checkInviteQuota
                        ⑤ createInviteCampaign（ready | scheduled）
                        ⑥ createTask（kind=creator_invite, campaignId）
                        ⑦ 立即：enqueueRun → attach run
                           定时：attach task，等调度器
                        ⑧ recordInviteEvent（started / scheduled）
                   ↓
          TaskRunner 全局串行队列（task-runner-control.pump）
                   ↓
          后台隐藏页（background-page, purpose=creator_invite，对渲染层不可见）
                   ↓
          loop 步骤
           批量流：筛选 → clickAll 勾 N 位 → 批量邀约 → 抽屉必填 → 发送 → 校验抽屉关闭
           逐人流：导航 → 每轮重新筛选 → 详情 → 邀请带货 → 表单 → 发送
                   ↓
          轮末 recordInviteBatch
            ├─ invite_records（逐人，status=sent）
            ├─ invite_history（双写，旧台账/7 天跳过名单）
            └─ creator_profiles（达人库 upsert、邀约次数 +1）
                   ↓
          终态钩子（task-kinds.onTerminal）
            ├─ recordInviteEvent(run.{status})
            └─ releaseBackgroundPages(store, creator_invite)
                   ↓
          页面每 5s 静默轮询（仅当有活动邀约 run）
```

### 1.2 各段职责

| 层 | 关键文件 | 职责 | 不该做的事（当前是否越界） |
|---|---|---|---|
| 渲染层 | `features/invite/**` | 配置、校验、启动、展示、人工修正 | 不管发送；但 `stopReasonLabel` 自维护了一份文案表（越界且不全） |
| IPC | `ipc/invite-handlers.ts` | 参数透传、错误映射、envelope | 不写业务判断（已做到） |
| 编排 | `services/invite-campaign-service.ts` | 锁、额度、建批次/任务/run、回滚 | 不执行页面动作（已做到） |
| 服务 | `invite-campaigns` / `records` / `creators` / `quota` / `assets` / `events` / `history` | 数据读写与状态推导 | 状态推导与写入两套真相（见 P0-4） |
| 执行 | `tasks/task-step-executor.ts` | loop / clickAll / 记账触发 | 记账时机绑在"整轮成功"（见 P0-3） |
| 契约 | `packages/shared/invite-*.ts` | 类型、步骤构造、停止码文案 | 记录状态机定义了 14 态，只实现 1 态（见 P1-1） |

---

## 2. 关键逻辑

### 2.1 任务构造：单一构造器 + 冻结快照

`buildInviteTaskPayload`（`packages/shared/src/invite-task.ts:225`）是面板与智能体共用的唯一构造器，避免"两处各写一套配置"导致把 A 店联系方式发给 B 店达人。构造前用 `inviteTaskIssues` 做完整性校验（话术、联系人、类目清单、数量区间）。

**关键点**：7 天已邀昵称与黑名单在**创建任务时**合并成一个 `recentlyInvited` 数组，写进 `clickAll.skipTexts`（批量流）或 `clickByText.skipTexts`（逐人流），任务创建后不再更新。这是"快照"而不是"实时查询"，直接影响重试/恢复的正确性（P1-7）。

### 2.2 启动编排：八步，失败要能回滚

`startInviteCampaign`（`invite-campaign-service.ts:62`）的顺序是刻意的：

- 先查店铺，再查锁，再查排期窗口，最后查额度——**任何业务拒绝都不写库**；
- 建批次后建任务，任务建失败 `markInviteCampaignFailed`（避免"有批次永远排队"）；
- 立即启动：`enqueueRun` 之后才 `attachInviteCampaignRun`；`attach` 失败不再把批次标 failed（P1-5 的结论：宁可少一条关联，也不留"批次 failed、任务在跑"）；
- 定时启动：只建任务不入队，`attachInviteCampaignTask`，到点由调度器拉起。

**缺陷**：`attachInviteCampaignRun` 内部 try/catch 吞掉了异常（`invite-campaigns.ts:85-93`），所以外层"attach 失败兜底"的分支在真实代码路径里**永远走不到**；单测靠 mock 注入抛出才覆盖到（`tests/unit/invite-campaign-schedule.test.ts:36-45`）。这属于"测试覆盖了意图、没覆盖实现"。

### 2.3 执行：loop 的三种"停"与两种"跳"

- `stopOn`：命中即**干净收工**（run 仍 succeeded）——额度用尽、勾不满、抽屉没开；
- `onCode.advance`：这位不可邀约/已邀过 → 保留"已访问"记录、重开本轮换下一位；连续 `limit` 位才收工；
- `onCode.restart`：详情页打不开 → **回滚**本轮已访问记录、退避后重试同一位；连续 6 次按故障失败；
- 其它异常：如实失败，`LOOP_ROUND_FAILED` 带轮次与子步骤。

批量流 `maxRounds = BATCH_LOOP_MAX_ROUNDS = 20`（`invite-steps.ts:32`），每轮勾 `need = max(count, minSelect)` 位（`:353`）；逐人流 `maxRounds = maxInvites`（`:985`），每轮 1 位。**这两种流的"上限语义"完全不同**，但对外都叫 `targetCount`。

### 2.4 记账：唯一入口，但只覆盖成功路径

`recordInviteBatch`（`invite-records.ts:50`）是唯一写入口：

- 昵称去空、压缩空白、去重、截断 120；
- `invite_history` 按 `(run_id, nickname)` 去重（旧面板 7 天台账仍可读）；
- `invite_records` 用唯一索引 `(run_id, creator_key, invited_at)` 做幂等（迁移 v33）；
- 只有真正插入成功才 `upsertCreatorFromRecord` 累加邀约次数；
- 写失败只记 error，不打断已发出的邀约。

幂等键里的 `invited_at` 是**本轮开始时刻**（`task-step-executor.ts:1621`），不是"发送时刻"，也不是"运行维度"。这带来两个后果：跨零点的一轮记到昨天（P1-4）；同一 run 重跑 loop 时每轮时间不同，唯一索引拦不住重复（P1-7）。

### 2.5 日额度：三段口径

`getInviteQuota`（`invite-quota.ts:42`）：

```
used     = invite_records 今日 invited_at 且状态属于"已发出"的条数
reserved = 今日创建 + 活动 run 的批次 target_count 之和
limit    = 店铺配置 dailyCap（0/缺省 = 不设上限）
remaining= limit - used - reserved
```

只有配了 `dailyCap` 才硬拦（`checkInviteQuota`），未配置时 `remaining=null`、永远放行，只做展示。检查点只有两处：启动（`invite-campaign-service.ts:116`）、定时到点（`:274`）。**运行过程中没有任何检查**。

### 2.6 定时：库驱动，不靠内存计时器

`invite_campaigns.scheduled_at` + 15s 节拍（`invite-scheduler.ts`）。到点规则：同店忙 → 最多让 2 小时；任务被删 → failed；额度不足 → failed；同一任务被手动直跑 → 让位（P1-4 补的）。设计是对的，但**前端已无入口**（见 P2-4）。

### 2.7 状态：读时推导，不双写

批次状态不落库（`status` 列只承载 `ready/scheduled/running/stopped/failed`），展示时由 `task_runs.status` + loop payload 的 `stopReason` 推导（`invite-campaigns.ts:137`）。好处是不会出现"批次说完成、运行其实失败"；代价是**存储状态与推导状态可能互相矛盾**（P0-4、P1-6）。

---

## 3. 状态变化

### 3.1 批次（`InviteCampaignStatus`）

| 状态 | 谁写入 | 触发条件 | 备注 |
|---|---|---|---|
| `ready` | `createInviteCampaign` | 立即启动、attach 之前 | 正常只有毫秒级；attach 失败会长期停留 |
| `scheduled` | `createInviteCampaign` | 传了 `scheduledAt` | 前端已无入口 |
| `running` | `attachInviteCampaignRun` / `setInviteCampaignStatus` | 入队 / 定时到点 | **queued 也显示 running** |
| `paused` | 不落库，纯推导 | run=paused | |
| `completed` | 不落库，纯推导 | run=succeeded 且 stopReason 不属于白名单 | |
| `exhausted` | 不落库，纯推导 | stopReason ∈ {QUOTA, SELECTION_SHORTFALL, DRAWER_NOT_OPEN} | 与"实际是否发够"无关（P2-3） |
| `stopped` | `cancelScheduledInviteCampaign` | 取消排期；run=cancelled 时推导 | |
| `failed` | `markInviteCampaignFailed` / `setInviteCampaignStatus` | 建任务失败、入队失败、到点额度不足、任务被删、等 2h 超时；以及**任何未识别的 run 状态**（含 `waiting_confirmation`） | `markInviteCampaignFailed` 不写 reason |

### 3.2 运行（`TaskRunStatus`，`run-state.ts`）

```
queued ──▶ running ──▶ succeeded
              │  ▲
              ▼  │
        waiting_confirmation
              │
              ▼
            paused ──▶ queued ──▶ running
running/waiting/paused ──▶ failed ──▶ queued（从失败恢复）
running/waiting/paused ──▶ cancelled（终态）
```

进程重启：`queued` → failed（"排队未开始"）、`running/waiting_confirmation/paused` → failed（"运行中断"）。这一步是如实的，但会让批次推导成 failed，用户看到的是"批次失败"而不是"应用重启导致中断"（status_reason 在 run 上，批次页不展示 run.statusReason）。

### 3.3 记录（`InviteRecordStatus`）

契约定义 14 态：`queued → selected → opening → sending → sent → inviting → accepted/rejected/expired`，另有 `skipped_*` / `failed_*` / `unknown`。

**实际**：引擎只在轮末写一次 `status='sent'`（`task-step-executor.ts:1622`）。其余 13 态没有任何写入方；人工修正可选 6 态（`invite-handlers.ts:145`）。因此：

- 记录不是"逐人实时状态"，而是"这一轮勾选名单的事后快照"；
- `skipped`/`failed` 两类计数永远为 0；
- `status_source` 实际只有 `local` 与 `manual`，`platform` 无写入方（平台状态回读未接入，这一点代码里是如实标注的）。

### 3.4 关键不变量（设计意图 vs 实际）

| 不变量 | 设计 | 实际 |
|---|---|---|
| 同一任务同时只有一个活动 run | `enqueueRun` 检查 | ✅ 成立 |
| 同店同平台同时只有一个邀约批次 | `startInviteCampaign` 查 campaign JOIN run | ⚠️ 只覆盖"挂在批次上的 run"（P1-5） |
| 日发送量不超过 `dailyCap` | 启动/到点各查一次 | ❌ 运行中不查，且预留按每批人数算（P0-1） |
| 记录只包含真实发出的人 | 轮末统一写 | ⚠️ 整轮成功才写（P0-3），且批量流昵称不可靠（P1-2） |
| 7 天内不重复邀约 | 台账 + 平台兜底 | ⚠️ 快照、子串匹配、500 条上限（P1-3/P1-7） |
| 状态不双写 | 读时推导 | ⚠️ 存储状态仍是第二真相（P0-4/P1-6） |

---

## 4. 问题清单

### P0（会导致超额发送或账本失真）

#### P0-1 日上限与"每批人数"口径错位，批量流实际可发 20 × count 位

**证据**
- `use-invite-run.ts:149-151`：`targetCount = isBatchProfile ? invite.count : invite.maxInvites`；
- `InvitePanelView.vue:24`：该字段叫「每批邀约数量」；
- `invite-steps.ts:32,663`：批量流 `maxRounds = 20`，每轮勾 `count` 位，直到平台额度/候选耗尽；
- `invite-quota.ts:88-98`：只按 `target` 校验一次；
- 任务名 `invite-task.ts:266` 写「最多 N 位」。

**影响**
店铺 `dailyCap=200`、每批 40 → 预留 40、放行；实际单批最多可发 800 位（以平台额度为上限）。「计划 40 / 已发 40」与「已发 300」会同时出现在界面，`dailyCap` 形同虚设。面板第 4 步还显示「最多发 maxInvites 位」，而批量流根本不读 `maxInvites`（`invite-task.ts:229-267` 只用 `count`）。

**建议**
- 引入 `totalTarget` 概念：批量流 = `min(count × 20, dailyCap剩余)`（或让用户直接填「本次总共最多 N 位」）；`invite_campaigns.target_count` 存总量，`stats_json` 里另存每批人数；
- loop 增加 `totalCap`：每轮开始前算 `remaining = totalCap - run.sentCount`，`clickAll.max` 取 `min(need, remaining)`，到 0 即 `target_reached` 收工；
- UI 区分「每批」「本次总量」；任务名改成总量，避免"最多 40 位"与实际不符；
- 单测钉住：给定 `count=40`、`dailyCap=200`，构造出的 loop 总上限必须是 200，而不是 40 或 800。

#### P0-2 手动/智能体直跑绕过额度、同店锁与跳过名单

**证据**
- `task-handlers.ts:67-73`：`TASK_RUN` 直接 `enqueueRun`，不区分 kind；
- `UnifiedTaskPage.vue:60`：只过滤发票/涉税采集任务，邀约任务带「运行」按钮；
- `agent-service.ts:2271-2279` + `agent-runtime.ts:1302`：智能体 `runInvite` 只传 `name/storeScope/steps`，`createTask` 不带 `kind/campaignId`（靠名称前缀推断 kind）；
- `readInviteConfigSnapshot`（`agent-service.ts:615`）读的是面板保存的配置，**不含 `recentlyInvited`**（`invite-state.ts:167-176` 的快照里没有该字段）。

**影响**
- 不查日额度、不查同店锁：面板刚起一批，用户/智能体再从任务中心点一次「运行」，两个 run 会争同一个广场页（真机已多次验证的故障模式）；
- 没有 7 天/黑名单 `skipTexts`：重复邀约只能靠平台拦，白耗详情页访问；
- 记录 `campaign_id` 为空（智能体）或挂到旧批次（手动重跑），批次计数被污染；
- 任务被取消排期后仍然可以从任务中心直跑——**"取消排期"并不能阻止发送**。

**建议**
- 在 `enqueueRun` 的 `creator_invite` 分支加统一守卫：额度 + 同店锁 + 必须带 `campaignId`；或让 `TASK_RUN` 对 `kind=creator_invite` 直接转 `startInviteCampaign`（带 `createdBy='manual'`，新建批次）；
- 智能体改走 `startInviteCampaign`（`createdBy='agent'`），并在服务里补 `recentlyInvited`（服务端现查台账 + 黑名单，而不是依赖前端快照）；
- `TaskStore.createTask` 对 `kind=creator_invite && !campaignId` 拒绝，堵住"绕过批次建任务"的口子；
- 单测：`TASK_RUN` 一个 `creator_invite` 任务，在 `dailyCap` 已满 / 同店有活动 run 时必须被拒。

#### P0-3 "部分发送成功"时账本一条不写

**证据**
- `invite-steps.ts:620-650`：平台弹「部分邀约发送失败」时用 `TASK_SEND_PARTIAL` 中止，注释明确写「本批其余人**可能已发出**」；
- `task-step-executor.ts:1606-1624`：`recordInviteBatch` 只在整轮 try 的成功路径调用；
- `stopOn` 不含 `TASK_SEND_PARTIAL`（`invite-steps.ts:671`）。

**影响**
已真实发出的那部分人：`invite_records` 没有 → `used` 少算 → 日额度可以被继续消耗；7 天台账漏人 → 下轮再点详情（平台拦截，浪费时间）；CSV 与平台后台对不上。同类窗口还有：`waitForGone` 超时（快手实测真实发送后抽屉要一分多钟才关）、`postSendConfirm` 点击后异常。

**建议**
- 把记账提前到"发送动作返回后"的最小可判定点：点击发送成功后，先把本轮 `pendingInvitedNames` 以 `status='sent'`（或 `unknown`，取决于平台文案）落库，轮末再补最终状态；
- 或在 loop 的 `catch` 里，对 `pendingInvitedNames` 落 `status='unknown'`、`status_reason='本轮未能确认发送结果'`，并在 `payload` 里标明；
- `TASK_SEND_PARTIAL` 走"先记账、再失败收尾"的分支，不要只抛错；
- 单测：构造 `TASK_SEND_PARTIAL`，断言记录表有 N 条 `unknown`，且 `invite_history` 被写入。

#### P0-4 批次状态推导漏 `waiting_confirmation`，且钉死在首个 run

**证据**
- `invite-campaigns.ts:137-151`：只处理 queued/running/paused/cancelled/failed/succeeded，其余落到 `return 'failed'`；
- `invite-campaigns.ts:198,241`：`row.run_id ? getRun(row.run_id) : task.latestRun`；
- `task-handlers.ts:57`：`TASK_UPDATE` 允许改步骤（仅运行中禁止），`waitForUserConfirmation` 是合法步骤类型（`task-step-executor.ts:645`）。

**影响**
- 任务带确认步骤（用户编辑任务 / 智能体计划）时，运行停在 `waiting_confirmation`，批次页显示「失败」，而任务实际在等人点确认；
- 批次 `run_id` 固定为首次 run。用户从任务中心重跑后，新 run 的记录仍写进同一 `campaign_id`（`run.campaignId` 继承自 task），但批次状态/时间永远停在旧 run → 「已发 0 / 状态失败」旁边挂着一堆新记录。

**建议**
- `deriveStatus` 增加 `waiting_confirmation → paused`（或新增 `waiting` 状态并同步 UI 文案/色调）；
- 批次优先读 `task.latestRun`；或在批次结束后禁止直跑其任务（与 P0-2 的守卫合并解决）；
- 单测：`deriveStatus(base, 'waiting_confirmation', null) === 'paused'`；task 重跑后批次状态跟随新 run。

### P1（会误导用户、会漏人、跨天/重试口径错）

#### P1-1 `skippedCount` / `failedCount` 恒为 0，记录筛选是死选项

**证据**：`recordInviteBatch` 唯一调用点只传 `status:'sent'`（`task-step-executor.ts:1622`）；`inviteCountsByCampaign` 用 `skipped_*`/`failed_*` 前缀统计（`invite-records.ts:248-263`）；记录页筛选含 `skipped_already_invited`（`InviteRecordsTab.vue:11`）。

**影响**：批次卡片/抽屉/详情都展示「跳过」「失败」，永远是 0；用户会以为"没有跳过/没有失败"，而实际跳过数量只存在于 loop payload 的 `skippedInvited` 里，没有聚合到批次。

**建议**：二选一——(a) 删掉这两列和该死筛选项，只保留「已发/未知」；(b) 在轮末把 `skippedInvited` 等计数写进 `invite_campaigns.stats_json`，批次视图读它（明确"跳过不落逐人记录"）。不要保留"定义了状态却永不写入"的假指标。

#### P1-2 批量流的"昵称"是行文本前 24 字

**证据**：`task-step-executor.ts:1800`：`name: String((row || el).innerText ...).slice(0, 24)`；逐人流有专门的 `nicknameOf`（优先 `.truncate`，120 字，`task-step-dom.ts:560-566`）。

**影响**：抖店/快手记录、达人库、CSV 里的「达人」列是"昵称 + 等级/类目/粉丝数…"的拼接串，超 24 字截断；`creator_key = n:<该串>` → 同一达人换行顺序/数据变化就变成新身份；7 天跳过靠这个串做子串匹配，稳定性差。

**建议**：`clickAll` 增加 `nicknameSelector`（或复用 `nicknameOf` 的取法：优先行内 `.truncate`/首列，其次 `innerText.split(' ')[0]`），长度 120；记录/达人库/CSV 统一用它。

#### P1-3 跳过名单是子串匹配 + 500 条静默截断

**证据**：批量流 `rowText.includes(t)`（`task-step-executor.ts:1765`）；逐人流 `e.key.includes(t)`（`task-step-dom.ts:553`）；`recentInvitedNicknames` `LIMIT 500`（`invite-history.ts:71`）；`normalizeInviteTaskConfig` `.slice(0, 500)`（`invite-task.ts:117,144`）。

**影响**
- 假阳性：昵称「小美」会命中「小美美」→ 少邀一位（静默，不报错）；短昵称/常见词（如「小米」）风险更高。这与 `invite-identity.ts` 里"宁可漏合并，不要错合并"的原则相反；
- 假阴性：昵称空格/emoji 差异、行文本改版 → 跳过失效 → 平台拦截，浪费详情访问；
- 7 天内已邀超过 500 位时，清单被截断且界面无提示，最早那批人会被重复尝试。

**建议**：用"规范化后的相等匹配"（trim/压缩空白/小写）或直接与单元格文本比对；`LIMIT` 改为按时间窗口全量（必要时分页传），超限时在面板显式提示「仅载入最近 500 位，更早的依赖平台拦截」。

#### P1-4 额度跨天口径两处错

**证据**
- `invite-quota.ts:62-69`：`reserved` 只统计 `created_at >= 今日 0 点` 的批次；
- `task-step-executor.ts:1621`：`invited_at = 本轮开始时刻`。

**影响**：昨晚 23:50 起跑、今天继续发的批次，今天 `reserved = 0` → 今天可以再起一整额；跨零点的一轮记到昨天 → 今天 `used` 少算。两者叠加会突破 `dailyCap`。

**建议**：`reserved` 改为"活动 run 且（今日有记录 或 run 仍未结束）"，不按批次创建日；记录增加 `sent_at`（真实发送时刻）与 `round_started_at` 分开存，额度/汇总用 `sent_at`。

#### P1-5 同店锁只覆盖 `campaign.run_id`，`attach` 吞错

**证据**：`invite-campaign-service.ts:79-85`（JOIN `c.run_id`）；`invite-campaigns.ts:85-93`（attach 内部 catch 并 return void）；`fireDue` 已补 `manualRun` 检查（`:256-272`），`startInviteCampaign` 没有。

**影响**：手动 run、智能体 run、以及 attach 失败导致 `run_id` 为空的批次都不在锁内 → 同店并发争页面；`fireDue` 里 `setInviteCampaignStatus('running')` 后才 attach，若 attach 吞错，`run_id` 缺失，后续同店排期查不到这个"忙"。

**建议**：抽一个 `storeBusy(storeId, platform)`，同时查：`invite_campaigns JOIN task_runs`、`tasks.kind='creator_invite' AND store_scope=?` 下的活动 run；`start`/`fire` 共用。`attach*` 改成返回 boolean 或抛错，让调用方写 `status_reason`，不要用 mock 注入异常来"证明"防御有效。

#### P1-6 删除任务留下"永远执行中"的僵尸批次

**证据**：`task-handlers.ts:139` 删除任务会级联删 runs；`invite_campaigns` 行保留 `status='running'` + 已失效 `run_id`；`deriveStatus` 在 run 为 null 时返回 base（`invite-campaigns.ts:138-141`）。

**影响**：批次永久显示「执行中」，`campaign.runId` 为空 → 「停止」按钮不显示 → 无法从界面收尾；额度 `reserved` 里也查不到它（run 没了）。

**建议**：`TASK_DELETE` 时把关联批次置 `stopped` 并写 `status_reason='任务已被删除'`；或在 `mapCampaign` 对「base=running 且 task/run 均不存在」降级为 `stopped` 并标注原因。

#### P1-7 重试/恢复会重复记账、重复尝试同一批人

**证据**：`retryRunFromFailed` 从 loop 第一步重跑，runId 不变（`task-runner-control.ts:100-124`）；`invitedAt` 每轮不同（`task-step-executor.ts:1621`）；唯一索引含 `invited_at`（迁移 v33:1734）；`skipTexts` 是创建时快照（`invite-task.ts:260,288`）。

**影响**：同一 run 重跑后，同一位达人可产生多条记录（唯一索引拦不住）；跳过名单不更新 → 又去点已邀过的人；`pendingInvitedNames` 在轮开始时清空，失败轮的勾选记录丢失（与 P0-3 同源）。

**建议**：幂等键改成 `(run_id, creator_key)`（去掉 `invited_at`）；重试前由主进程现查 7 天名单重建 `skipTexts`（或让引擎在每轮开始读 DB）；重试视为"同一批次继续"，不要新建批次也不要复用旧 `invited_at`。

#### P1-8 日上限保存有 500ms 防抖，启动可能读到旧值

**证据**：`use-invite-config.ts:110-116`（改动 500ms 后落盘）；`startInvite` 直接 `startCampaign`（`use-invite-run.ts:152`），不 flush；`checkInviteQuota` 读 `app_settings`（`invite-quota.ts:30-40`）。

**影响**：用户改完「日上限」立刻点「开始邀约」（<500ms），新上限尚未落库 → 本次按旧值（可能是 0=不限）放行。UI 上写着"设置后同一天累计到此数会拒绝启动"，实际可能没生效。

**建议**：`startInvite` 在调用 `startCampaign` 前显式 `await settings.set(invite.config.store.<id>, snapshot)`（或把 `dailyCap` 直接作为 `campaign.dailyCap` 传入，服务端以请求值为准并回写配置）。

### P2（一致性、可观测性、性能）

#### P2-1 `queued` 也显示「执行中」，后台页起不来会长期挂起

`deriveStatus` 把 queued 映射成 running（`invite-campaigns.ts:142`），批次页无法区分"排队等页面"与"真的在发"。若 `acquireBackgroundPage` 失败（`task-kinds.ts:53-59` 只记日志不拦），run 会一直 queued，`pump` 只在店铺被打开时才放行，没有任何超时。建议新增 `queued` 展示态（或 `waiting_page`），并在 run 上写 `status_reason`。

#### P2-2 停止原因文案表不全，且重复维护

`CreatorInvitePage.vue:267-276` 只映射 5 个码；`TASK_DAREN_ALREADY_INVITED` / `TASK_DAREN_NOT_INVITABLE` / `TASK_PAGE_EXHAUSTED` / `TASK_SEND_PARTIAL` 会原样显示错误码。`shared/invite-notices.ts:17` 已有 `inviteStopReasonLabel`（9 个码），直接复用即可，删本地副本。

#### P2-3 `completed` / `exhausted` 判定与实际发送量无关

逐人流连续 20 位不可邀约 → `stopReason=TASK_DAREN_NOT_INVITABLE`（`invite-steps.ts:1020-1040`）→ 不在 `deriveStatus` 的白名单 → 批次显示「已完成」，而实际可能只发了 2/10。建议按 `sentCount >= targetCount` 判定 completed，否则 exhausted，并把所有"非达成型"停止码统一映射。

#### P2-4 定时链路处于"半移除"状态

`InvitePanelView.vue:276` 注明定时输入已按用户要求移除（2026-10-21 用户明确不需要），但：四步向导第 4 步仍写「额度 · 定时 · 启动」（`CreatorInvitePage.vue:66`）；批次列表保留「取消排期」按钮与 scheduled 文案；`startInvite({scheduleAt})` 没有调用方；冒烟只能通过 IPC 直调验证（`creator-invite-smoke.js:314`）。既然用户已明确不要这个入口，**推荐把前端残留彻底下线**（向导文案改「额度 · 启动」、批次列表的取消排期按钮仅在存在 scheduled 批次时出现或直接移除），服务层与调度器保留作为内部能力；不要留"界面承诺了但做不到"的半成品。

#### P2-5 服务层出错返回 `[]`/`null`，故障伪装成"没有数据"

`listInviteCampaigns`（`invite-campaigns.ts:201-204`）、`listInviteRecords`（`invite-records.ts:206-209`）、`listCreators`（`invite-creators.ts:148-151`）都在 catch 里返回空。DB 故障时前端渲染"还没有邀约批次"，IPC 仍是 `ok:true`。建议返回 `{ ok:false }` 或抛出，由 IPC 层映射错误；至少带 `degraded:true` 让 UI 显示"读取失败"。

#### P2-6 性能与规模

- `listCreators` 每次都调 `backfillCreators`（`invite-creators.ts:131`），后者是带相关子查询的全表扫描；不传 storeId 时全库扫；记录到 10 万级后每次进「达人库」都要跑一遍；
- `listInviteCampaigns` 每行 3~4 次查询（`getTask`/`getRun`/`inviteCountsByCampaign`/`readStopReason`），50 行 ≈ 200 次 SQL；
- `getInviteCampaignDetail` 只取 500 条记录（`invite-campaigns.ts:242`），`summaryFromRecords` 用这 500 条算 `todaySent/accepted` → 大批次少算。

建议：`backfillCreators` 改为一次性迁移或带 `backfilled_at` 标记；列表批量查 run；detail 的 summary 用 SQL 聚合（给 `inviteRecordSummary` 加 `campaignId` 参数）。

#### P2-7 资产保存的跨店 id 报错误文案；手动改状态直接影响额度

`saveInviteScript` 用别的店的 id 时 `exists` 查不到 → 走 INSERT → 主键冲突 → catch 返回 null → IPC 映射成「话术名称与内容不能为空」（`invite-handlers.ts:231`）。应显式校验 id 归属并返回「无权修改」。

`updateInviteRecordStatus` 允许把任意记录改成 `sent`，而 `used` 只按状态统计 → 一次误修正会直接占掉额度。建议校验状态迁移（至少禁止 `accepted/rejected → sent`），或额度只认不可变的 `invited_at` + 首次写入状态。

#### P2-8 其他一致性/保留期

- `invite_events`、`invite_records` 无保留期/清理策略，长期运行会无界增长；
- `getInviteQuota.used` 不按 platform 过滤（店铺平台变更后口径漂移）；
- `startInviteCampaign` 不校验 `task.storeScope === campaign.storeId`，不一致时静默以 `campaign.storeId` 覆盖；
- `markInviteCampaignFailed` 不写 `status_reason`，批次列表只显示「失败」不说原因。

#### P2-9 定时排期的边界

- `listDueInviteCampaigns` `ORDER BY scheduled_at LIMIT 10`（`invite-campaigns.ts:290-298`）：前 10 条一直 defer 时，第 11 条永远轮不到（最多饿 2 小时后前 10 条转 failed 才轮到）；
- 同一店铺可以建多条排期批次（创建时不看 scheduled 状态），到点只有一条能跑，其余在 2 小时后 failed；
- `scheduled` 批次不计入 `reserved`，多条排期可以同时通过额度校验；
- 排期批次的 `skipTexts` 是"排期时刻"的快照，到点执行时可能已过期。

---

## 5. 边界与异常场景

| 场景 | 当前行为 | 风险/期望 |
|---|---|---|
| 23:59 起跑，跨零点继续发 | 记录 `invited_at` = 轮开始（昨天）；`reserved` 只算今天创建的批次 | 今日额度被低估（P1-4） |
| 两位达人同名 / 昵称是另一位的前缀 | 7 天跳过用子串匹配 → 误跳过 | 静默少邀（P1-3） |
| 达人改名 | `creator_key` 变 → 达人库出现两条 | 台账重复、邀约次数分散 |
| 7 天内已邀 > 500 位 | 名单截断，无提示 | 老记录被重复尝试 |
| 手动在平台邀过（不经本工具） | 台账没有，靠平台 7 天拦截 | 浪费详情页访问；记录里没有 |
| 平台"部分发送失败" | 整轮抛错，零记录 | 真实已发的人丢失（P0-3） |
| 平台弹"这个达人已邀过" | `advance` 跳过并计数；连续 20 位收工 | 批次显示「已完成」而非「候选用尽」（P2-3） |
| 任务被删除（批次已跑过） | 批次留 `running`，run 已级联删除 | 永远执行中、无法停止（P1-6） |
| 应用崩溃在"建批次后、建任务前" | 批次 `ready`、无 task | 空批次；只能手工清理 |
| 应用崩溃在"enqueue 后、attach 前" | run 已建（queued），批次 `ready`/`scheduled` | 启动时 run 被标 failed；排期批次可能再拉一次（首次未执行，通常无害） |
| 运行中店铺被移入回收站 | 后台页/分区仍在跑；`invite:quota` 报"店铺不存在" | 记录仍写、批次列表店名为 null；无一致性保护 |
| 用户改完日上限立刻点开始 | 500ms 防抖未落盘 | 本次按旧上限放行（P1-8） |
| 取消排期后从任务中心直跑该任务 | 真实发送，记录写进 `stopped` 批次 | "取消"没有阻止发送（P0-2） |
| 智能体与面板同时发起同一店铺 | 两个 run 串行但争同一广场页 | 筛选/弹窗互相切走、额度失真（P0-2） |
| 11 条以上排期同时到点 | 前 10 条占满窗口 | 后面的饿到 2 小时后 failed（P2-9） |

---

## 6. 修复路线

### 阶段一：护栏与账本（P0）

1. 统一"本次总量"口径：`totalTarget` 落 `target_count`，loop 增加 `totalCap`，每轮按剩余量取人；UI/任务名同步。
2. 抽 `storeBusy()` + `checkInviteQuota` 到统一入口，`startInviteCampaign`、`fireDueInviteCampaigns`、`TASK_RUN`、智能体四条路都过它；`creator_invite && !campaignId` 的任务拒绝入队。
3. 记账前移：发送成功后先落记录（`sent` 或 `unknown`），轮末补状态；`TASK_SEND_PARTIAL` / `waitForGone` 超时走"记账 + 失败"。
4. `deriveStatus` 补 `waiting_confirmation`；批次优先读 `task.latestRun`。

**验收**：新增 4 组单测（总量口径、TASK_RUN 守卫、部分成功记账、waiting_confirmation），并补一条冒烟：面板起批后从任务中心再点运行必须被拒。

### 阶段二：数据质量与跨天（P1）

5. `clickAll` 昵称选择器 + 相等匹配跳过；7 天名单改为服务端现查、去掉 500 截断或显式提示。
6. 记录增加 `sent_at`；`reserved` 改按活动 run 统计。
7. 幂等键改 `(run_id, creator_key)`；重试前重建跳过名单。
8. `startInvite` 启动前 flush 配置（或把 `dailyCap` 随请求传入）。
9. 删任务时收尾关联批次。

### 阶段三：状态与体验（P2）

10. 补 `queued/waiting` 展示态；停止码文案复用 `inviteStopReasonLabel`；`completed/exhausted` 按实际发送量判定。
11. 定时链路：按用户决定下线前端残留（向导第 4 步文案、取消排期入口），服务层与调度器保留；若将来重启该能力，先补 P2-9 的排期池与额度预留。
12. 列表/detail 查询批量化与 SQL 聚合；`backfillCreators` 加标记；服务层错误不再伪装空态。

### 建议补的单测（按性价比排序）

- `totalTarget` 与 `dailyCap` 的关系（P0-1）；
- `TASK_RUN` 对 `creator_invite` 的额度/锁守卫（P0-2）；
- `TASK_SEND_PARTIAL` 场景下记录落库（P0-3）；
- `deriveStatus('waiting_confirmation')`（P0-4）；
- 跨天 `reserved`/`used`（P1-4）；
- 昵称「小美」vs「小美美」的跳过匹配（P1-3）；
- 删除任务后批次不留 `running`（P1-6）。

---

## 7. 已做对的部分

- **业务拒绝与异常分离**：`startInviteCampaign` 返回 `{ok:false,code,message}`，异常才上抛；IPC 只做映射（`invite-handlers.ts:71-87`）。
- **失败不再谎报**：run 已入队后，后续步骤失败不把批次标 failed（P1-5 的修复方向正确，只是 attach 吞错让实现与意图有偏差）。
- **PII 收敛**：批次 filters 递归剔除 contact/wechat/phone（`invite-campaigns.ts:49-59`），脚本/商品快照限长；审计 payload 只记布尔与数量。
- **记录幂等与如实标注**：唯一索引 + `status_source` 三态；平台状态没回读就写 `local/unknown`，不推断"已接受/已过期"（`invite-records.ts:9-13`）。
- **执行面隔离**：后台隐藏页 `internal+worker`，不占标签栏、不进 `browser.state` 渲染层（`background-page.ts`），终态释放，冒烟已验证 `visibleTabs=0`。
- **排期持久化**：状态存库、15s 节拍、重启可恢复（`invite-scheduler.ts`），不是内存计时器。
- **单测可脱离 Electron**：编排/quota/记录/排期都用真实 SQLite + mock 引擎，23 个用例本轮全部通过。

---

## 附录：本轮验证记录

```
npx vitest run tests/unit/invite-quota.test.ts \
  tests/unit/invite-campaign-start.test.ts \
  tests/unit/invite-campaign-schedule.test.ts \
  tests/unit/invite-records-service.test.ts
→ Test Files 4 passed (4)，Tests 23 passed (23)
```

> 未执行：`pnpm build` + `electron-builder --dir` + `tools/acceptance/creator-invite-smoke.js`（需打包态与 CDP 端口）。本报告涉及的界面结论均来自源码与冒烟脚本断言，不含真机平台行为结论。
