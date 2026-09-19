# 任务功能自研 RPA 方案

**版本基线**: 0.4.35
**编写时间**: 2026-09-20

---

## 0. 先说结论与红线

**结论**：任务功能**不需要"引入 RPA"——它本身就是自研 RPA**。执行内核（28 种步骤白名单 + 错误分类 + 断点恢复 + 留痕 + 调度）已经跑通抖店/快手/微信三个平台、邀约与采集四个业务域。本方案要做的不是换内核，而是把内核往"更完整的 RPA 平台"补四块：**跨店并发、跨运行台账、读型定位韧性、录制编排**。

**红线（任何一期都不能破）**：

1. **不开放任意代码执行**。步骤只允许预定义类型，参数走 Zod strict 校验（`packages/shared/src/schemas/task.ts:3` 的既定约束）。录制器与可视化编排都必须产出白名单步骤，绝不能产出脚本。
2. **写型步骤保持"硬失败"**。文案/选择器失配时如实报 `TASK_SELECTOR_CHANGED`，不静默重试、不假装成功（`packages/shared/src/invite-steps.ts:10-12`）。自愈能力**只给读型步骤**。
3. **有副作用的步骤不进恢复重放**。`NON_RESUMABLE_TYPES`（`apps/desktop/src/main/tasks/task-step-schemas.ts:373`）已明确包含 `clickAll` / `clickByText` / `typeText` / `ensureRows*` / `loop`。新增的控制类步骤（并发分桶、台账）必须同样加入。

---

## 1. 现状基线（方案建立在什么之上）

| 能力 | 位置 | 现状 |
|---|---|---|
| 步骤白名单 | `packages/shared/src/schemas/task.ts:6-77` | 28 种，含读/写/断言/控制四类 |
| 执行内核 | `apps/desktop/src/main/tasks/task-runner.ts`（约 2746 行） | `execStep` 大 switch |
| 错误分类 | `task-runner.ts:359` `classifyError` | 映射到 `TASK_` 码（`packages/shared/src/errors/error-codes.ts`） |
| 断点恢复 | `task-runner.ts:38/149/176`，`:291/:301` | `new`/`continue`/`from-failed` 三态，靠 `succeededStepIndexes` 跳过已成功步骤 |
| 调度 | `apps/desktop/src/main/tasks/scheduler.ts` | 秒级 tick，未开店铺保持 `queued` 不静默拉起 |
| 留痕 | `task_step_results`（迁移 v1） | 文本/表格/截图 + sha256 |
| 平台适配 | `packages/shared/src/{invite,business,entity,invoice}-steps.ts` + `constants/*` | 构造器 + 平台档案，渲染层收集配置后调用（`WorkbenchView.vue:2781`） |

**当前是全局串行**：`let current: RunHandle | null = null`（`task-runner.ts:57`），队列 `task-runner.ts:55`，同任务去重 `findActiveRunForTask`（`:63`）。

---

## 2. P0 跨店并发（吞吐，收益最大）

### 2.1 为什么不能简单地改 `current`

`current` 只是表象。真正的约束是**窗口挂载模型**：

- 全进程只有一个 `hostWindow`，`browserStates: Map<storeId, BrowserState>` 持有所有店铺的标签页，但**同一时刻只有一个 view 被挂载**（`window-manager.ts:233` `mountTab`，`displayedStoreId` 决定挂载谁）。
- 非当前页的标签页视口会塌成 0，`getBoundingClientRect` 全为 0（`task-runner.ts:286-289` 的实测注释），定位与点击全部失真。
- 快手等平台的级联弹层靠 rAF 定位，窗口被遮挡时页面 `visibilityState=hidden`、rAF 停摆，弹层停在 `-9999,-9999`（`window-manager.ts:316-327` 的实测注释；现有对策是建 tab 时 `backgroundThrottling: false`，`window-manager.ts:328`）。

所以"多店并发"= **每个并发 run 都要有一块自己能拿到的、且不被完全遮挡的绘制面**。

### 2.2 方案：每并发 run 一个专属窗口

给 `window-manager` 增加"运行窗口"概念，与主窗口并列：

- 新增 `openRunWindow(storeId): BrowserWindow` / `closeRunWindow(storeId)`，窗口 `webPreferences` 与 `openStandaloneWindow`（`window-manager.ts:656-693`）同源：同 `partition: persist:store_<storeId>`、`backgroundThrottling: false`。
- `browserStates` 的挂载目标从"唯一 hostWindow"改为"按 storeId 解析宿主窗口"：`mountTab`（`window-manager.ts:233`）增加 `hostOf(storeId)` 解析，主窗口继续服务人机交互，运行窗口服务自动化。
- **运行窗口挂的是"运行标签页"，不是用户正在看的那个 tab**。这正好和现有的 `runTabByStore`（`task-runner.ts:60`）设计吻合：每店已有一个专用的复用运行 tab，把它的 view 挂到该店的运行窗口即可，用户在**主窗口**浏览同一店铺的其他标签页不受影响。这也顺带解决了"一个 WebContentsView 同时只能挂在一个窗口"的冲突——两个窗口各挂各的 view。
- 运行窗口默认**平铺可见、互不重叠**（由窗口管理器分配网格位置），而不是隐藏——因为"完全遮挡"正是 rAF 类平台的致命前提（`window-manager.ts:316-327`）。可见但失焦不影响：失焦不算遮挡。

### 2.3 并发调度改造

- 把 `let current`（`task-runner.ts:57`）换成 `const running = new Map<string, RunHandle>()`，键为 `storeId`。
- 重写 `pump()`（`task-runner.ts:248-263`）：现在它一上来就 `if (current) return`（全局只允许一个），改为按店铺分桶——每个 `storeId` 最多一个 `running`，全局并发上限 `maxConcurrentStores`；取队列时跳过"该店已有 running"和"已达全局上限"的情况。
- 同任务重入保护保留（`findActiveRunForTask`，`:63-73`）——同一任务仍然只有一个未结束 run。跨店并发靠**任务按店铺拆开**（每个店铺一个 task，或用 `storeScope` 批量派发），而不是让一个 run 横跨多店。
- `runTabByStore`（`:60`）语义不变，仍是每店一个复用标签页；`execute()` 里的标签页复用/激活逻辑（`:276-289`）改为针对该店运行窗口的挂载。

### 2.4 数据与设置

- 新增迁移 **v4**：`app_settings` 写入 `task.concurrency = { maxConcurrentStores: number }`（默认 1 = 保持现状；上限 4）。`app_settings` 的读写范式照 `apps/desktop/src/main/ipc/ai-handlers.ts:25`。
- 运行窗口布局不落库（进程内状态）。

### 2.5 验收（真机，不能只跑单测）

1. 设 `maxConcurrentStores=1`，跑一轮抖店批量邀约，行为与改造前逐帧一致（回归基线）。
2. 设 `=2`，两个店铺同时跑**抖店**批量邀约，两边都真实发出，`task_runs` 两条并行的 `started/finished` 时间区间有重叠。
3. 设 `=2`，两个店铺同时跑**快手**邀约（最敏感平台），确认级联弹层正常选中、未被报 `TASK_TARGET_OUT_OF_VIEWPORT`。
4. 关闭窗口/切走焦点后仍在跑（`backgroundThrottling` 生效验证）。
5. 并发下取消其中一个 run，另一个不受影响。

**回退开关**：`maxConcurrentStores` 设回 1 即完全回到今天的行为。

---

## 3. P1 跨运行邀约台账（防重复邀约）

### 3.1 现状缺口

`visitedRows` 只在单次运行内有效（`task-runner.ts:47-52` 注释明说"只活在本次运行内"），键是 `${runId}:${path}` + 行文本（`:1366`、`findTextTarget` 的 `keyOf`，`text-target-finder.ts:109-112`）。进程重启或明天再跑，记录清零，重复邀约只能靠平台自己的 7 天限制兜底。

### 3.2 关键设计：台账不是事实来源

**平台才是事实来源**，台账只用来"少跑冤枉路"。这条定死了才能避免最危险的失败——用模糊的文本键硬跳过，可能把一位**同名的新达人**误判为"已邀约过"而漏掉。

所以分两层：

- **软跳过（排序）**：台账里近期出现过的行，在候选排序中靠后。
- **硬事实（平台判定）**：`TASK_DAREN_ALREADY_INVITED` / `disabledCode`（`invite-steps.ts:426`）与 `TASK_SEND_PARTIAL`（`:330`）——平台说不行才跳过。

### 3.3 身份键：先探针，别猜

行文本（`row.innerText` 截 200 字）不是稳定身份。落地前必须**先做一次探针脚本**，枚举各平台广场行上真正可读到的身份列（类似发票那次先枚举再登记的做法，`tools/acceptance/` 下已有 `douyin-invite-local-verify.js` 的先例）。

- 若某平台行上有稳定的达人 ID / 昵称 + ID 组合 → 用它做键。
- 若只有昵称 → 键 = `平台 + 规范化昵称`，且**只用于排序**，绝不做唯一性判定。
- 快手在发送失败文案里能读到 `达人ID`（`invite-steps.ts:320-325` 的实测样例），可作为**回填**身份的来源。

### 3.4 步骤侧改动

- `clickAll` 的 payload 已有 `samples: string[]`（`task-runner.ts:2026`，最多 8 条被点行的名字，`:2059` 落库）。**扩成结构化样本**：`{ name, key, at }[]`，数量上限提到 40（与 `max` 对齐）。这是台账的主要数据来源。
- 新增步骤参数 `ledger: { namespace: string }`（Zod strict），把样本写入台账表。
- `pick.nth:'unvisited'` 的 `visited` 集合来源扩展：运行内 `visitedRows` ∪ 台账近期记录（仅用于排序/软跳过，见 3.2）。
- `NON_RESUMABLE_TYPES`：`clickAll` 已在其中，无需改；台账写入是读型副作用，可随步骤重放（幂等 upsert）。

### 3.5 数据模型（迁移 v5）

```sql
CREATE TABLE invite_ledger (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  store_id TEXT NOT NULL,
  daren_key TEXT NOT NULL,        -- 见 3.3 的分级口径
  daren_name TEXT,
  daren_id TEXT,                   -- 能读到才填，读不到留空
  key_quality TEXT NOT NULL,       -- 'id' | 'name' | 'rowtext'：键的强度，查询时按强度过滤
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  invite_count INTEGER NOT NULL DEFAULT 1,
  last_run_id TEXT,
  FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
)
CREATE UNIQUE INDEX idx_invite_ledger_key ON invite_ledger(platform, store_id, daren_key);
CREATE INDEX idx_invite_ledger_seen ON invite_ledger(store_id, last_seen_at DESC);
```

`key_quality` 这列是安全阀：只有 `key_quality='id'` 的记录才允许参与硬性判定；`name`/`rowtext` 一律降级为排序提示。

### 3.6 验收

1. 跑一轮微信逐个邀约 5 位 → `invite_ledger` 落 5 条，`key_quality` 如实反映读到的身份强度。
2. 立刻再跑同一任务：广场排在前面的应是"没邀过"的人（软跳过生效），且**不出现"一位都没邀却报成功"**。
3. 构造一位刚刚被邀过的达人，确认它仍被平台拦下并报 `TASK_DAREN_ALREADY_INVITED`（硬事实优先于台账）。
4. 同名不同人的两条记录不得被合并（用 `key_quality='name'` 的样本验证只影响排序、不影响邀约）。

---

## 4. P2 读型定位韧性与失败取证（降维护成本）

### 4.1 现状

定位是"档案选择器 + 文案锚点"单一层（`text-target-finder.ts` 两级匹配：自有文本精确 → 规范化 innerText）。平台改版即硬失败。这对写型步骤是**正确**的，对读型步骤则过于昂贵——采集经营指标/发票时一次改版就要人工改常量。

### 4.2 方案

- **给读型步骤加多策略回退**：`{ selector → 文案锚点 → 结构相似度 }`，仅在 `readText`/`readTable`/`readLabelValue` 生效，并在 payload 里如实记录 `via: 'selector' | 'text' | 'structure'`，让"用了弱策略"这件事在日志里可见。
- **写型步骤维持硬失败**，但补**取证**：定位失败时额外落一份 DOM 片段工件（现有 `screenshot` 已落图，再加候选清单），把"为什么失配"直接留给修档案的人。参考 `task-runner.ts:2050` 那条失败信息已经把 `skippedInvisible`/`skippedDisabled`/`rounds` 写进错误——把同样的思路扩到定位失败。
- **档案常量的体检脚本**：仿 `tools/acceptance/invoice-license-local-verify.js`，新增 `invite-profile-probe.js`，一键输出各平台档案里每个选择器/文案锚点当前是否命中，把"平台改版后哪几个常量失效"变成一次可跑的命令。

### 4.3 验收

1. 人工把某个读型步骤的选择器改错 → 任务仍能通过文案锚点取到值，payload 的 `via` 显示 `text`。
2. 人工把写型步骤的文案改错 → 任务**如实失败**，报 `TASK_SELECTOR_CHANGED` 且带候选清单工件，绝不"降级成功"。
3. `invite-profile-probe.js` 在三平台各跑一次，全绿。

---

## 5. P3 录制器与可视化编排（让运营自助，工作量最大）

### 5.1 最小可用形态

- 在运行标签页注入**只读监听**（click / input / change），产出候选步骤草稿，**由人确认后才生成 `StepDraft`**。
- 生成的锚点优先用**文案**而不是选择器——与本仓库既有判断一致：平台类名普遍带构建哈希，文案才是平台对外的稳定表达（`task-runner.ts` 中 `readLabelValue` 的设计理由）。
- 产出物是 `packages/shared/src/constants/<平台>.ts` 的档案骨架 + 构造器草稿，仍是白名单步骤。

### 5.2 边界（必须写进实现）

- 录制**不产出脚本**，只产出白名单步骤 JSON（红线 1）。
- 录制期间不执行任何写操作，避免"录一遍就真发一遍"。
- 生成的写型步骤默认带 `waitForUserConfirmation` 门禁，人工摘除才生效。

### 5.3 验收

录制一段"进广场 → 筛选 → 勾 3 位"的操作，得到可执行的步骤序列，在真机复跑成功；且录出的步骤里**没有任何**新步骤类型。

---

## 6. 优先级与工期建议

| 期 | 内容 | 价值 | 风险 | 建议 |
|---|---|---|---|---|
| P0 | 跨店并发 | 吞吐直接翻倍 | 中（窗口模型改动，需真机验证快手） | 先做，先上 2 并发 |
| P1 | 邀约台账 | 直接防重复邀约事故 | 低 | 紧随 P0，先做探针 |
| P2 | 读型韧性 + 体检脚本 | 降维护成本 | 低 | 可与 P1 并行 |
| P3 | 录制器/编排 | 运营自助 | 高（红线密集） | 最后做，或按需做 |

**不做的事**（明确排除，避免跑偏）：

- 不引入外部 RPA 工具（影刀/UiPath/按键精灵）。理由见 `docs/invite-optimization-report.md` 的合规判断，以及本方案 §2.1：外部工具拿不到本应用的 `webContents` 与店铺登录态，且屏幕级定位做不出本仓库赖以立足的断言（`TASK_SEND_PARTIAL` / `TASK_PRODUCT_NOT_SELECTED`）。
- 不做像素级坐标主路线。坐标能力保留为最后手段，只用于 DOM 完全不可用的平台。
- 不开放任意脚本步骤。

---

## 7. 过程纪律（与仓库既有约定一致）

- **每期完成必须真机实测**，单测/仿真不算验收（`tests/unit` 只做回归，`tools/acceptance` 才是验收脚本）。
- **每期完成后发版**：`pnpm release:full`（不自动改版本号，需手动 bump `package.json`）。
- **迁移只前进**：手写迁移数组（`apps/desktop/src/main/db/migrations.ts`），当前最新 v3，本方案新增 v4（并发设置）、v5（邀约台账）。
- **单测要 `vitest run`**，不要用 watch 模式。
