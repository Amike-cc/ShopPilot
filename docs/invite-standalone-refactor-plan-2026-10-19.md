# 达人邀约：独立功能与后端运行的重构方案

> 版本：2026-10-19（第三轮，基于已落地的「独立页 + 隐藏窗口执行」）
> 目标读者：后续接手邀约模块的开发/维护者
> 关联文档：`docs/invite-module-redesign-2026-10-19.md`（业务方案与附录 E）

---

## 1. 目标与边界

**功能目标（已达成）**：达人邀约是一个独立功能，页面在主进程隐藏窗口里跑，用户继续正常浏览店铺网页不受影响。

**重构目标（本文档）**：在**不改变现有行为**的前提下，把这一轮为了快速落地而放进通用模块里的「邀约专属逻辑」拆出去，形成可复用、可测试、可持续扩展的边界，为候选预览、平台状态回读、定时/多店排队留出位置。

**边界**：

- 本文档是重构方案，不新增业务能力；P4 的能力补齐单独列，且必须过真机实测门禁。
- 已有验收锚点（`invite-panel` / `invite-start` / `invite-live-log` / `invite-v2-*`）与 IPC 契约**不得改名**；重构只改内部结构。
- 旧数据（`invite_records` / `invite_campaigns` / `creator_profiles` 等）不迁移、不重写。

---

## 2. 现状盘点

### 2.1 已落地且已验证

| 能力 | 实现位置 | 验证 |
|---|---|---|
| 独立页（KPI/批次/记录/达人库/资产/说明） | `apps/desktop/src/renderer/src/features/invite/CreatorInvitePage.vue`（848 行） | 打包冒烟；应用中心卡片进入 |
| 页内就地配置并启动 | 同页 `invite-v2-launcher` + `InvitePanelView.vue`（268 行） | 冒烟「不跳店铺浏览器」 |
| 配置/日志视图复用 | `features/invite/InvitePanelView.vue`，侧栏与独立页共用 | m1/m3 锚点 + 冒烟 |
| 后台隐藏窗口执行 | `window-browser-core.ts` 末尾「达人邀约后台工作页」段（约 160 行） | 冒烟：本地页面 `navigate → waitForText → clickByText(mode:real) → window.open → waitForPage → waitForText`，可见标签页始终 0 |
| 入队即开跑（不要求用户先开店） | `task-runner-control.ts` `enqueueRun` | 冒烟批次 `completed` |
| 终态释放 / 暂停保留 | `task-runner-lifecycle.ts` `transition` | 冒烟 + 源码契约测试 |
| 弹窗转后台子页 | `openInviteWorkerChildTab` | 同上（本地 `/detail` 跟随成功） |
| 领域服务 | `services/invite-{campaigns,records,quota,creators,assets,events,history}.ts` | 单测 + 真实 SQLite 测试 |
| IPC | `ipc/invite-handlers.ts`（338 行） | 冒烟 |

### 2.2 体量与耦合点

| 文件 | 行数 | 问题 |
|---|---:|---|
| `browser/window-browser-core.ts` | 1668 | 浏览器核心知道「达人邀约」；`inviteWorkerTabs`、`invite-worker` 生命周期原因、`openInviteWorkerChildTab` 都在这里 |
| `tasks/task-runner-execute.ts` | 250 | `run.taskKind === 'creator_invite'` 决定执行面 |
| `tasks/task-runner-control.ts` | 271 | 入队/继续/重试三处按 kind 分流 |
| `tasks/task-runner-lifecycle.ts` | 133 | 终态释放按 kind 判断 |
| `tasks/task-step-executor.ts` | 2763 | 选人记账 `recordNames` 与停止原因按 kind 判断 |
| `ipc/invite-handlers.ts` | 338 | 编排（同店锁/额度/建批次/建任务/入队/事件/回滚）与 IPC 解析混在一起 |
| `features/invite/CreatorInvitePage.vue` | 848 | 5 个页签 + 抽屉 + 资产 CRUD 同文件 |
| `features/workbench/use-creator-invite.ts` | 603 | 配置、额度、话术、脚本、运行态、日志、启动全在一个 composable |
| `packages/shared/src/invite-steps.ts` | 977 | 三个平台的流程挤在一个文件 |

### 2.3 问题清单（按优先级）

| # | 问题 | 影响 | 优先级 |
|---|---|---|---|
| 1 | 浏览器核心承载业务概念（worker 页、window.open 策略） | 新模块要后台页时会复制这段逻辑；`window-browser-core` 继续膨胀 | P0 |
| 2 | 任务引擎在 4 个文件里按 `taskKind` 分流执行面 | 每加一个后台运行的业务都要改引擎；分支容易漏（终态/恢复） | P0 |
| 3 | 批次启动编排在 IPC 层 | 无法脱离 Electron 单测；回滚路径（建批次成功、建任务失败）难复用 | P1 |
| 4 | 页面与 composable 单体 | 改一个页签要回归整页；样式/状态互相影响 | P2 |
| 5 | 平台流程单文件 | 改抖店要翻 977 行；平台间共享步骤难以复用 | P2 |
| 6 | 缺候选预览/状态回读/定时/多店排队 | 业务能力缺口，需真机 DOM 实测 | P4（门禁） |
| 7 | 后台页缺少运行指标（占用、生命周期、失败率） | 长期运行时排查只能翻 `app.log` | P3 |

---

## 3. 目标架构

```
┌──────────────────────────────────────────────────────────────────┐
│ 渲染层（只做展示与用户动作）                                      │
│  CreatorInvitePage（壳）                                          │
│    ├─ InviteCampaignsTab / InviteRecordsTab / InviteCreatorsTab   │
│    ├─ InviteAssetsTab / InviteAboutTab / InviteCampaignDrawer     │
│    └─ InviteConfigPanel（配置 + 实时日志；侧栏与独立页共用）       │
│  composables：useInviteConfig / useInviteQuota / useInviteRun     │
│               useInviteCreators / useInviteAssets                 │
└───────────────────────────┬──────────────────────────────────────┘
                            │ window.shopilot.invite.*
┌───────────────────────────▼──────────────────────────────────────┐
│ IPC 层（薄）：解析参数 → 调用服务 → 统一 envelope                 │
│  invite-campaign-handlers / invite-record-handlers /              │
│  invite-asset-handlers / invite-creator-handlers                  │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│ 领域服务（可脱离 Electron 用真实 SQLite 测试）                    │
│  invite-campaign-service（编排：校验→同店锁→额度→批次→任务→入队） │
│  invite-records / invite-campaigns / invite-quota /               │
│  invite-creators / invite-assets / invite-events / invite-history │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│ 执行运行时（通用）                                                │
│  task-runner（队列/状态机/重试/进度）                              │
│  task-kinds/creator-invite.ts（surface=background + 业务钩子）    │
│  task-kinds/index.ts（注册表）                                    │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│ 浏览器原语（不含业务概念）                                        │
│  background-page.ts：通用隐藏窗口页（purpose/reuseKey/释放）      │
│  window-browser-core：标签页/会话/代理/指纹/用户标签             │
└──────────────────────────────────────────────────────────────────┘
```

**依赖方向（硬规则）**：

1. `browser/*` 不得 import 任何 `invite*`；只能暴露通用 `background-page`。
2. `tasks/*` 不得出现具体业务名，只能通过 `task-kinds` 注册表回调。
3. `ipc/*` 不写业务规则；规则全部在 `services/*`。
4. 渲染层不直接拼任务载荷；`buildInviteTaskPayload` 只在 composable 里调用一次。

---

## 4. 核心重构设计

### 4.1 通用后台页原语（P0）

**新文件**：`apps/desktop/src/main/browser/background-page.ts`

从 `window-browser-core.ts` 原样搬出这 160 行，改成与业务无关的 API：

```ts
export type BackgroundPagePurpose = 'creator-invite' | (string & {})

export interface BackgroundPageOptions {
  /** 用途：同一店铺可同时存在不同用途的后台页 */
  purpose: BackgroundPagePurpose
  /** 复用键，默认 `${purpose}:${storeId}` */
  reuseKey?: string
  width?: number
  height?: number
  /** 是否允许 window.open 转入后台子页（默认 true） */
  followPopups?: boolean
}

export interface BackgroundPageHandle {
  tabId: string
  webContents: Electron.WebContents
}

/** 取（必要时创建）后台页；不显示、不激活、不广播。 */
export function acquireBackgroundPage(storeId: string, options: BackgroundPageOptions): BackgroundPageHandle

/** 关闭某个用途下的全部后台页（含子页）；重复调用是空操作。 */
export function releaseBackgroundPages(storeId: string, purpose: string): void

/** 查询某用途的根页（诊断/测试用）。 */
export function getBackgroundPageTabId(storeId: string, purpose: string): string | null
```

**内部不变量**（必须保留现有行为）：

- `show:false`、`skipTaskbar:true`、同一个 `persist:store_<id>`、`backgroundThrottling:false`；
- 注册 `Tab { internal:true, worker:true, purpose }`，不落库；
- `emitTabs` / `browser.state` 过滤 worker 页；
- `registerWebview` 拒绝 worker 页；
- `activateTab` 对 internal 空操作；
- `window.open` 由主进程建隐藏子页并登记为同 purpose 的 worker 页；
- `closeTab` 销毁对应 `workerWindow`；
- `storeLifecycleBlockReasons` 用 `getBackgroundPageTabId(storeId, purpose)` 判断占用（reason 名统一为 `background-page:<purpose>`）。

**验收**：

- `grep -r "invite" apps/desktop/src/main/browser/` 结果为空（注释除外）。
- 现有 18 项冒烟全绿，可见标签页仍为 0。

### 4.2 任务类型注册表（P0）

**新文件**：`apps/desktop/src/main/tasks/task-kinds/creator-invite.ts`、`task-kinds/index.ts`

```ts
export interface TaskKindDefinition {
  kind: string
  /** 执行面：可见标签页 / 采集专用页 / 后台隐藏页 */
  surface: 'foreground' | 'collection' | 'background'
  /** 入队前准备（后台页预建、租约）；失败不阻断入队，由 runner 兜底 */
  prepare?(storeId: string): void
  /** 终态释放（成功/失败/取消；paused 不调用） */
  release?(storeId: string): void
  /** 运行终态的业务钩子（审计、通知等） */
  onTerminal?(run: RunHandle, status: string, reason: string): void
  /** 每一轮结束的业务钩子（选人记账、停止原因） */
  onLoopEnd?(run: RunHandle, summary: LoopSummary): void
}
```

改法：

| 现在 | 改成 |
|---|---|
| `execute()` 里 `else if (run.taskKind === 'creator_invite')` | `acquireBackgroundPage(storeId, { purpose: run.taskKind })`，由 `kindDef.surface` 决定 |
| `enqueueRun` / `resumeRun` / `retryRunFromFailed` 按 kind 分流 | 统一调 `kindDef.prepare(storeId)` |
| `transition` 里 `if (run.taskKind === 'creator_invite') releaseInviteWorkerTabs` | `kindDef.release(storeId)` |
| `task-step-executor` 里 `recordNames` / 停止原因 | 通用参数不变；只把「写记录/写终态原因」收进 `creator-invite` 的钩子 |

**验收**：

- `grep -rn "creator_invite" apps/desktop/src/main/tasks/task-runner-*.ts` 为空；只允许出现在 `task-kinds/creator-invite.ts` 与 `task-step-executor` 的通用字段注释里。
- `invite-background-run.test.ts` 改为断言注册表接线，而不是断言字符串分支。

### 4.3 批次启动编排下沉（P1）

**新文件**：`apps/desktop/src/main/services/invite-campaign-service.ts`

把 `INVITE_CAMPAIGN_START` handler 里的 60 行编排搬过来：

```ts
export interface StartInviteCampaignResult {
  campaignId: string
  task: TaskView
  run: TaskRunView
  waitingForStore: boolean
}

export function startInviteCampaign(input: InviteCampaignStartInput): StartInviteCampaignResult
```

职责：

1. 校验店铺存在/未删除；
2. 同店同平台运行锁（查询 `invite_campaigns JOIN task_runs`）；
3. 日额度预检（`checkInviteQuota`）；
4. 创建批次 → 创建任务（`kind/source/campaign_id`）→ 入队；
5. 关联 `run_id`、写 `campaign.started` 事件；
6. 任一步失败：`markInviteCampaignFailed` + 明确错误码，不留「有批次没运行」。

IPC handler 只保留：参数校验 + `try/catch` + `envelope`。

**验收**：新增 `tests/unit/invite-campaign-start.test.ts`（真实 SQLite）：额度不足拒绝、同店并发拒绝、建任务失败回滚批次、成功返回 runId。

### 4.4 渲染层拆分（P2）

**页面壳**：`CreatorInvitePage.vue` ≤ 200 行，只负责店铺筛选、KPI、页签路由、抽屉开关、启动成功后的刷新。

| 新文件 | 职责 | 允许行数 |
|---|---|---:|
| `tabs/InviteCampaignsTab.vue` | 批次列表 + 空态 + 行点击 | ≤ 250 |
| `tabs/InviteRecordsTab.vue` | 记录表 + 状态筛选 + CSV | ≤ 250 |
| `tabs/InviteCreatorsTab.vue` | 达人库搜索/黑名单 | ≤ 250 |
| `tabs/InviteAssetsTab.vue` | 话术库/商品集 CRUD | ≤ 300 |
| `tabs/InviteAboutTab.vue` | 说明与门禁清单 | ≤ 120 |
| `InviteCampaignDrawer.vue` | 批次详情 + 逐人记录 + 人工状态 | ≤ 300 |

**composable 拆分**（`useCreatorInvite` 保留为 facade，返回字段不变，避免一次性改所有调用方）：

| 新文件 | 职责 |
|---|---|
| `useInviteConfig.ts` | 表单状态、保存/自动保存、类目树、话术库选择 |
| `useInviteQuota.ts` | 额度读取、黑名单计数、近 7 天台账 |
| `useInviteRun.ts` | 任务筛选、实时状态映射、日志、停止 |
| `useInviteCreators.ts` | 达人库列表/搜索/黑名单 |
| `useInviteAssets.ts` | 话术/商品集 CRUD |

**配置面板拆分**：

- `InvitePanelView.vue` → 容器；
- `InviteConfigForm.vue`（表单字段，按平台档案分支）；
- `InviteLiveLog.vue`（进度、步骤、日志滚动、停止/刷新）。

样式处理：把 `invite-*` 与面板内通用类抽到 `features/invite/invite-panel.css`，由两个组件 `import`（不再各自复制一份 scoped 样式）。

**验收**：所有 `data-test` 锚点保持不变；m1/m3 的邀约断言 + 18 项冒烟通过；`CreatorInvitePage.vue` 行数 < 200。

### 4.5 平台流程拆分（P2）

`packages/shared/src/invite-steps.ts` → 目录：

```
packages/shared/src/invite-steps/
  index.ts        // buildInviteSteps 门面，按 profile.flow/platform 分派
  common.ts       // 导航、等待、搜索、翻页、发送确认等共享步骤
  douyin.ts      // 批量列表流
  wechat.ts      // 辅助表单流
  kuaishou.ts    // 商品弹窗流
  types.ts       // StepDraft / InviteBuildOptions
```

只搬代码不改行为；`invite-steps.test.ts` / `agent-invite-task.test.ts` 作为回归网。

---

## 5. 数据模型演进（P4，需真机门禁）

| 迁移 | 表 | 用途 | 门禁 |
|---|---|---|---|
| v35 | `invite_candidates` | 候选预览：campaign_id、creator_key、昵称、来源、状态、抓取时间 | 列表行昵称/勾选 DOM 实测通过后才启用 |
| v36 | `invite_status_snapshots` | 平台状态回读：record_id、原文、解析状态、抓取时间 | 「我的邀约」状态页 DOM 实测通过 |
| — | `invite_events` 保留期 | 默认 90 天，按店铺清理 | 可配置、可审计 |

原则不变：**读不到就是 null/unknown，不补 0、不猜状态**。

---

## 6. 分阶段实施

| 阶段 | 内容 | 规模 | 验收门槛 | 回滚 |
|---|---|---|---|---|
| P0 | `background-page.ts` 抽取 + `task-kinds` 注册表 | M（1–2 人日） | typecheck/test/lint/build + 冒烟 18/18；browser 目录无 invite；runner 无 kind 分支 | 纯搬移，按文件回退 |
| P1 | `invite-campaign-service` + IPC 瘦身 | S（0.5–1 人日） | 新增编排单测 4 项；冒烟通过 | 保留旧 handler 函数体，出问题直接切回 |
| P2 | 页面/composable/面板/平台流程拆分 | M（1–2 人日） | 锚点不变；m1/m3 + 冒烟；关键文件行数达标 | 组件逐个替换，保留 facade |
| P3 | 运行指标与诊断（后台页数量、存活时长、失败率、释放延迟） | S | 诊断页可见；日志字段稳定 | 只增观测，无行为变化 |
| P4 | 候选预览 / 状态回读 / 四步向导 / 定时与多店排队 | L（3–5 人日） | 每项单独真机实测；未实测不启用 | 功能开关按项关闭 |

**执行顺序不可颠倒的原因**：P0/P1 先把「执行面」和「编排」变成通用能力，P2 的 UI 拆分才有稳定接口；P4 依赖 P1 的编排服务做排队/定时。

---

## 7. 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 重构改变执行面选择 | 注册表 surface 与旧分支不一致 | P0 保留「旧 kind 映射」兜底；冒烟增加「可见标签页=0」强断言 |
| worker 页被渲染层误挂载 | `emitTabs` 过滤失效 | 已有 `registerWebview` 拒绝 + 冒烟断言；P0 增加单测 |
| 后台页泄漏 | 异常路径未走终态 | `storeLifecycleBlockReasons` 占用 + 诊断页显示后台页数量；终态释放有单测 |
| 平台风控要求窗口可见 | 真机出现可见性判据失败 | 退化为 `offscreen:true` 或最小化显示；绝不塞回用户标签栏 |
| window.open 弹窗丢失 | 子页未登记/未关旧页 | 冒烟已覆盖「真实点击 + target=_blank + waitForPage + waitForText」 |
| UI 拆分造成锚点漂移 | 组件替换时漏 data-test | 锚点清单作为 P2 的验收脚本输入；m1/m3 必跑 |

---

## 8. 验收标准（可量化）

1. `grep -rn "creator_invite" apps/desktop/src/main/browser/` → 0 命中。
2. `grep -rn "taskKind === 'creator_invite'" apps/desktop/src/main/tasks/task-runner-*.ts` → 0 命中。
3. `CreatorInvitePage.vue` < 200 行；每个 tab 组件 < 300 行；`use-creator-invite.ts` < 150 行（facade）。
4. `pnpm typecheck` / `pnpm lint`（0 error）/ `pnpm test` 全绿。
5. `pnpm test:invite-v2-smoke` 18/18，且三项硬断言保持：
   - 独立页就地配置、不跳店铺浏览器；
   - 批次跑到 `completed`；
   - 全程可见标签页数为 0（含 `window.open` 子页场景）。
6. 终态后 2 秒内 `browser.state` 中该店后台页为 0；暂停时保留。

---

## 9. 本方案不做的事

- 不修改平台选择器、不改发送流程、不改「无人工确认门禁」的既定口径。
- 不把邀约页面重新塞回用户标签栏；不为了「看得见」牺牲后台运行。
- 不在没有真机 DOM 证据时启用候选预览或平台状态回读。
- 不重命名现有 IPC channel / data-test 锚点 / 数据库表。

---

## 10. 附：当前可复用的验证资产

| 资产 | 用途 |
|---|---|
| `tools/acceptance/creator-invite-smoke.js` | 18 项端到端：路由、IPC、批次、独立页、后台运行、本地页面真实点击与弹窗跟随 |
| `tests/unit/invite-background-run.test.ts` | 源码契约：执行面、入队预建、终态释放、worker 隐藏与拒绝挂载 |
| `tests/unit/invite-records-service.test.ts` | 记录/汇总/身份的真实 SQLite 测试 |
| `tests/unit/invite-quota.test.ts` | 额度台账纯函数测试 |
| `tests/unit/invite-creators-assets.test.ts` | 达人库/资产/事件测试 |

**一句话总结：功能已经能跑在后台；这份方案解决的是「后台运行这件事现在只有邀约能用、而且写在了通用模块里」。P0/P1 把它变成通用能力，P2 把界面拆小，P4 再谈能力扩展——每一步都有可执行的验收和可回滚的边界。**

---

## 11. 实施进度（2026-10-19 晚）

### 已完成

| 阶段 | 内容 | 证据 |
|---|---|---|
| P0 | 通用后台页 `browser/background-page.ts`：按 `purpose` 复用、隐藏窗口、window.open 子页、释放与生命周期钩子 | `window-browser-core.ts` 已无 `invite` 字样；`invite-background-run.test.ts` 11 项 |
| P0 | 任务类型注册表 `tasks/task-kinds.ts`：`surface/prepare/release/onTerminal/successReason` | execute/control/lifecycle 不再写 `creator_invite` 分支；同测试 |
| P1 | 批次启动编排下沉 `services/invite-campaign-service.ts`；IPC handler 只做 envelope | `invite-campaign-start.test.ts` 6 项（店铺不存在/同店锁/额度/成功链路/已开店/建任务失败回滚） |
| 完善 | 独立页启动面板加「店铺」下拉，可就地切换店铺 | 冒烟「配置面板可指定店铺」 |
| 优化 | 批次页运行中每 5 秒静默刷新（已发/跳过/失败计数），结束自动停 | `CreatorInvitePage.vue` 的 `liveInviteRunning` + `syncInvitePolling` |

### 验证

- `pnpm typecheck` ✓
- `pnpm test`：170 files / **1902 tests** ✓
- `pnpm lint`：0 error ✓（1150 warnings，均为存量）
- `pnpm build` ✓；`electron-builder --dir` ✓
- `pnpm test:invite-v2-smoke`：**19/19** ✓（含隐藏窗口真实布局/点击、window.open 子页跟随、可见标签页 0）

### 追加完成（P3 + 真实验收）

| 项 | 内容 | 证据 |
|---|---|---|
| P3 | 后台页诊断：`memoryDiagnostics.backgroundPages` 返回用途/存活时长/脱敏 URL；终态应为 0 | `background-page.ts` 的 `getBackgroundPageSnapshots`；冒烟新增断言 |
| 真实验收 | 打包产物跑通完整邀约链路：独立页配置、隐藏窗口执行、真实页面布局点击、window.open 子页跟随、可见标签页 0、后台页释放为 0 | `creator-invite-smoke.js` **20/20** |

### 仍未做（按原计划）

- **P2 UI 拆分**：`CreatorInvitePage.vue` 仍是 850 行左右的单体（5 个页签 + 抽屉）；`useCreatorInvite.ts` 仍是 600 行。行为已稳定，拆分属于可维护性改造，建议单独一轮做，避免与本次执行面重构混在一起回归。
- **P4 能力**：候选预览、平台状态回读、四步向导、定时邀约。均需真机 DOM 实测或新增调度语义，未实测不启用。多店排队当前是**可用但串行**的队列，不是并行发送。

### 验收环境说明（重要）

- `creator-invite-smoke.js` 20/20 是**当前构建**的真实 Electron 验收（独立 userData、打包产物、本地 HTTP 页面）。
- `m1-runner` / `m3-runner` 在“右栏窄轨点任务图标（rail-tasks）”和“任务面板页签”处失败：这两个 UI 已在 2026-10 的「AI 任务中心移除」中被删除，验收脚本未同步，属于**存量测试债**，不是本次执行面重构引入的回归。本次未修改这两个脚本，避免用改测试的方式掩盖问题。

### P2 进展（2026-10-20 上午）

- **页面拆分完成**：5 个页签 → `features/invite/tabs/InviteCampaignsTab.vue`、`InviteRecordsTab.vue`、`InviteCreatorsTab.vue`、`InviteAssetsTab.vue`、`InviteAboutTab.vue`；批次详情抽屉 → `InviteCampaignDrawer.vue`。
- **共享状态**：新增 `invite-page-context.ts`，页面 `provide` 原始 ref/函数，页签 `inject` 后顶层解构，模板仍自动解包并保持响应性。
- **样式**：从页面 scoped 样式迁出为 `invite-page.css`，全部规则挂在 `.invite-page` 下，页面壳/页签/抽屉共用一份，不污染其它区域。
- **结果**：`CreatorInvitePage.vue` 从约 850 行降到 **578 行**（模板约 100 行，其余是页面状态与动作）；说明页文案同步为「页内配置 + 后端隐藏窗口执行」。
- **验收**：`creator-invite-smoke` 扩到 **22/22**，新增“任务页签打开详情抽屉并可关闭”“说明页/记录页（拆分组件）渲染”。

**仍未做**：`useCreatorInvite.ts` 仍未拆成 config/quota/run/creators/assets 五个 composable；P4 平台 DOM 能力（候选预览、状态回读）与定时邀约仍未启用。

---

## 12. 收尾落地（2026-10-20）

用户要求「完成尚未完成的所有任务，逐项确认状态」。本节逐项对应上一节列出的剩余项。

### 12.1 P2 第二半：composable 拆分（已完成）

`useCreatorInvite.ts` 从 603 行降到 **65 行**（只剩接线与返回结构），领域逻辑落到
`features/invite/composables/`：

| 文件 | 行数 | 职责 |
|---|---|---|
| `invite-state.ts` | 227 | 表单状态、类目选项、校验结果、快照序列化（无 IPC） |
| `use-invite-config.ts` | 118 | 配置读写（串行号 + 切店保护）、AI Key 状态、500ms 自动保存 |
| `use-invite-quota.ts` | 30 | 额度与黑名单人数（只读，失败降级） |
| `use-invite-assets.ts` | 26 | 话术库列表与套用 |
| `use-invite-navigation.ts` | 115 | 广场地址、三级类目缓存、平台入口、打开广场并回读筛选 |
| `use-invite-run.ts` | 194 | 任务进度映射、启动（含定时参数）、停止 |

拆分原则：state 不 import 任何 composable；额度/话术/黑名单通过 **ports 注入** config，
config 的 `loadInviteConfig` 通过 port 注入 navigation，避免环形依赖。
返回结构保持不变——侧栏与独立页的取值方式、验收锚点都不受影响。

### 12.2 定时邀约（已完成）

| 层 | 改动 |
|---|---|
| 迁移 | **v36 `invite_campaign_schedule`**：`invite_campaigns` 增 `scheduled_at`、`status_reason`，加 `(status, scheduled_at)` 索引 |
| 契约 | `INVITE_CAMPAIGN_STATUSES` 增 `scheduled`；`InviteCampaignView` 增 `scheduledAt/statusReason`；启动输入增 `scheduleAt` |
| 编排 | `startInviteCampaign` 校验窗口（≥1 分钟、≤30 天）；排期批次**只建批次+任务，不入队**，写 `campaign.scheduled` 事件 |
| 调度 | 新增 `services/invite-scheduler.ts`：每 15 秒扫 `status='scheduled' AND scheduled_at<=now`；启动即跑一次；真正拉起在 `fireDueInviteCampaigns` |
| 到点复核 | 同店有运行中批次 → 本次延后（超过 2 小时标失败）；任务被删 → 标失败写原因；日额度重新校验（跨天/改配置后可能已不足） |
| 取消 | IPC `invite:campaign:cancel`；只对 `scheduled` 生效，返回 false 时不覆盖 running/failed |
| UI | 配置面板「定时启动」`datetime-local`（`invite-schedule-at`，含 1 分钟下限提示）；批次列表显示「已排期 / 计划启动时间」与「取消排期」；抽屉显示 `statusReason` |

### 12.3 四步向导（已完成）

- 独立页启动面板新增 `invite-v2-steps`：目标 → 受众 → 话术 → 确认，可按步点击或「下一步」。
- `InvitePanelView` 新增可选 `step` prop，用 **v-show** 分组：切步不丢已填内容、锚点不消失；
  不传 `step` 时侧栏仍是原来的单页长表单（侧栏只有 320px，分步反而更难用）。
- 第 3 步在无话术框的平台显示 `invite-step3-noop` 说明，不假装有输入项。

### 12.4 验收脚本与已移除 UI 对齐（已完成）

`m1` / `m3` 之前失败在「右栏任务页签 / 任务卡片 / 任务→达人邀约二级页签 / 新建任务对话框」——
这些 UI 在 2026-10 的「AI 任务中心移除」中已删除，脚本没同步。

| 脚本 | 改动 |
|---|---|
| `m1-cdp-verify.js` | 窄轨 `rail-tasks` → `rail-invite`，断言活动页签「达人邀约」；店铺广场用例直接点顶层「达人邀约」页签 |
| `m3-cdp-verify.js` | 用「页签结构 = 收藏/下载/环境/达人邀约、无任务页签/二级页签/任务卡片」替代旧任务面板断言；新增「右栏不再提供已下线的任务创建入口」；9b 改走 `rail-invite` 与顶层页签 |

**覆盖变化（如实说明）**：旧的「新建任务对话框布局」三项断言随 UI 一起下线，改为断言入口不存在；
任务创建/运行/确认/取消链路仍由 m3 的 IPC 用例与引擎断言覆盖，未减少引擎侧覆盖。

### 12.5 仍未完成（阻塞项，非本轮可本地闭环）

1. **候选预览 / 目标名单**：需要真实登录态的抖店/微信/快手达人广场列表 DOM（行内昵称与勾选控件）。
   当前仓库红线是「未实测不写选择器」，因此不启用；现有降级是「按已保存筛选直接邀约」。
2. **平台状态回读**（我的邀约→已接受/已拒绝）：同上，需要真实登录态页面；当前用人工状态修正兜底，
   并明确标 `status_source=manual`。
3. **多店铺并行发送**：任务队列仍是全局串行（一次一个 run）。改成并行要先解决同进程 runner 的单泵模型
   与页面资源竞争，属于独立设计，不在本轮范围内；当前同店有运行锁、跨店按提交顺序排队。

### 12.6 本轮验收

- `pnpm typecheck` ✓
- `pnpm test`：173 files / **1919 tests** ✓（新增 `invite-campaign-schedule.test.ts` 8 项）
- `pnpm lint`：0 error ✓
- `pnpm build` ✓；`electron-builder --dir` ✓
- `creator-invite-smoke`：**26/26** ✓（新增四步向导、定时排期/取消/过去时间拒绝）
- `m1-runner`：**108/108** ✓
- `m3-runner`：**110/110** ✓

**其余套件（同一打包产物，独立 userData）**

| 套件 | 结果 |
|---|---|
| `m2-runner`（指纹/代理/备份） | 30/30 ✓ |
| `m4-runner`（复制/迁移） | 13/13 ✓ |
| `settings-cdp-verify`（设置中心 6 页签） | 47/47 ✓ |
| `tabs-batch-close-cdp-verify`（标签批量关闭/内部页清理） | 42/42 ✓ |
| `invoice-license-local-verify`（发票/授权） | 51/51 ✓ |
| `agent-cdp-runner`（纯对话 Agent） | PASS ✓ |

**环境受限的三项（与本轮改动无关，非功能回归）**

- `sec-cdp-verify`：前 20+ 项通过后，`session.export` 在 45s 内未返回而超时（Cookie/会话导出，属磁盘/IO 路径）。
- `extensions-cdp-verify`：12 项通过后，`extensions.import()` 需要原生文件选择对话框，无法在无人值守下完成。
- `products-redesign-cdp-verify`：该脚本是**驱动器**，前置要求应用已用 `--remote-debugging-port=9250` 启动；
  单独运行只会报「未找到满足条件的页面 target」，不构成失败结论。
- 另外本会话沙箱拦截了 `reg.exe`（Program Blacklist），任何依赖注册表的步骤都无法执行。
