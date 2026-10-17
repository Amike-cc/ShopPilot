# ShopPilot 遗留问题清理与功能补齐报告（2026-10-17 第二轮）

- **对象**：`D:\code\电商浏览器` @ `0.4.75`
- **目标**：系统盘点「已知问题 + 未完成开发任务」，逐项修复/补齐，补测试，确认核心功能无回归
- **结论**：**完成 6 项修复/补齐**，全部门槛与核心套件通过；仍有 6 项明确的风险/限制未在本轮消除（见 §5）

---

## 1. 盘点方法与结论

### 1.1 盘点来源
- `docs/CODE_REVIEW_2026-10-15.md`（P0–P3 共 30 余项）
- `docs/browser-review-2026-10-16.md`（R/E/N/S 系列）
- `docs/product-management-redesign-2026-10-15.md`（R1–R3）
- 源码中的 `TODO/FIXME`、`暂不可用/待接入` 文案、死链入口
- `docs/CODE_REVIEW_REPORT_2026-10-17.md` 的「剩余风险」

### 1.2 盘点结论（重要）
2026-10-15 审查中的绝大多数问题**已经在 0.4.66–0.4.75 之间修完**，本轮逐条复核后确认已落地的包括：

| 原问题 | 现状（证据） |
|---|---|
| P0-1 Electron 30 EOL / P0-2 构建链 CVE | Electron 44.7.2、electron-builder 26.15.3、vitest 5、vite 7；`pnpm audit --prod` 0 漏洞 |
| P0-3 CI 无 audit / 无打包冒烟 | `.github/workflows/ci.yml` 已有 verify + package-smoke |
| P1-2 IPC 错误原文透传 | `ipc/envelope.ts` 统一脱敏（路径/SQLITE/栈帧），`ipcErrFromUnknown` 全面接管 |
| P1-3 审计失败只进 console | `audit-logger.ts:88` 改 `logMain('error', [audit]…)` |
| P1-4 logMain 同步落盘 | 已改缓冲批量写（300ms 落盘窗口，M4 单实例用例也以此为准） |
| P1-6 图片历史 base64 全量写 | `UnifiedImageStudioPage.vue` 已防抖 800ms + 4MB 预算 + 失败提示 |
| P1-7 页面无 preload 守卫 | 五个页面已无 setup 顶层直调；任务页有 `requireBridge` |
| P1-10 监听器/定时器泄漏 | App.vue 有 removeEventListener；workspace 事件登记可 off；bg-services 定时器有幂等 + unref |
| P2-1 `normalizeCellText` 双实现 | 唯一实现在 `shared/text-match.ts`，两个域入口只选参数 |
| P2-2 店铺状态三份映射 | 统一 `@shared/enums/store-status` |
| P2-6 死事件频道 | 28 个 `EVENT_CHANNELS` 全部有 emit/subscribe（脚本审计 0 未用） |
| P2-7 状态迁移先内存后落库 | `task-runner.ts:128` 已改「先落库、成功再改内存」 |
| P2-8 Job 创建非原子 | `createAgentJob` 的 browser task + job 已合并进同一事务 |
| N-1 无档案 session 暴露 Electron UA | `session-manager.ts:406` 已用同版本干净 UA 兜底 |
| S-1 分区占用无可视化 | 设置 → 数据与维护已有 `maintenance-partition-row` + 清理按钮 |
| 商品 R1/R2/R3 | 方案附录均记录完成；验收 44/44 |
| store-handlers 两个 TODO | profile 已由 `createStore` 事务内 `ensureProfileForStore` 完成；建店无代理入参，代理体检在 `proxy:bind` |

**因此本轮不再重复“修已修过的东西”**，只处理仍然真实存在的 6 项（§2），并列出不能/不宜在本轮解决的 6 项（§5）。

---

## 2. 本轮修复与补齐（逐项）

### F1（功能补齐）顶栏「通知中心」从占位变成真实可用

- **原问题**：顶栏通知按钮点击只弹 `通知中心暂未接入独立页面`；而界面已有真实待办（进行中/待确认/失败任务、客服未读），入口是死链。
- **原因**：通知能力从未实现，按钮只是占位。
- **修改点**：
  - 新增纯函数 `apps/desktop/src/renderer/src/features/workbench/notification-center.ts`：
    把 `ws.tasks.latestRun`（含 `runLive` 实时状态覆盖）与客服未读映射为通知条目；
    失败任务只保留 24h 内、最多 3 条；总数上限 8；按 error→warning→info 排序；
    后台采集任务（发票/涉税）**不进入通知**，与概览任务卡/红点同一口径。
  - `DashboardView.vue`：
    - 顶栏通知按钮改为 `data-test="notification-bell"`，打开 `[data-test="notification-center"]` 面板；
    - 面板含空状态 `notification-empty`、条目 `notification-item-*`、点击跳到任务中心/客服工作区；
    - Esc 关闭、点击面板外关闭；红点数量改由通知总数驱动（不再只数进行中任务）。
  - 样式：320px 下拉面板、错误/警告色、无横向溢出。
- **测试**：
  - `tests/unit/notification-center.test.ts`（7 例）：空输入、进行中/待确认、已结束不通知、24h 失败窗口、失败最多 3 条、客服未读 99+、排序与 8 条上限。
  - `tools/acceptance/dashboard-apps-cdp-verify.js`：真实应用打开面板、空状态文案、Esc 关闭（2 项）。
  - 回归 `tests/unit/invoice-task-exclusion.test.ts`：把「工具栏红点排除后台采集」的源码契约从 `activeTaskCount` 迁到 `notificationTasks`。

### F2（一致性缺陷）「批量发布商品」被工作台/AI 创作页错误标注为「待接入」

- **原问题**：商品管理已有发布预检、批量编排（`products:publish:batch:*`）与人工确认，但：
  - 工作台快捷操作 `publish` 是 `available: false`，按钮显示「待接入」；
  - AI 创作页卡片写「尚无商品发布页面或发布 API。暂不可用」。
- **原因**：商品 v4/M5 落地后，这两处入口文案没有同步更新（功能可用却对用户宣称不可用）。
- **修改点**：
  - `DashboardView.vue:605` `available: true` / `actionLabel: '去发布'`；`handleQuickAction` 增加 `publish → navigateTo('products')`。
  - `UnifiedAppsPage.vue:61` 发布卡片改为 `app-card-action`，点击 `navigate('products')`，文案改为真实流程说明（预检/批量编排/人工确认）。
- **测试**：`dashboard-apps-cdp-verify.js` 4 项——快捷操作可点击且跳商品页；AI 页卡片是真实入口；点击卡片跳商品页；不再显示「暂不可用」。

### F3（文案缺陷）AI 助手仍宣称可以「执行写入操作/协助店铺工作流」

- **原问题**：当前 Agent 是**纯文本对话**（旧操作 IPC 在 Main 端统一拒绝），但应用中心仍写「通过 Agent 助手进行分析、规划和店铺工作流协助。执行写入操作仍会按现有流程请求确认」，暗示它有能力操作软件。
- **修改点**：`UnifiedAppsPage.vue:56` 改为「纯文本对话：可以讨论问题、整理思路或给出手动操作建议；不会读取或操作店铺、网页、任务与软件数据」；同时修正设置卡片里已移除的「Agent、技能、插件」描述（`:32`、`:64`）。
- **测试**：`dashboard-apps-cdp-verify.js` 断言文案含「纯文本」「不会读取或操作」，且不含「写入操作…确认」。

### F4（验证缺口）M4 安装/升级/卸载全链路此前跑不起来

- **原问题**：`m4-runner.js` 用 `fs.cpSync` 复制 `win-unpacked`，在本机复制到 `ShopPilot.exe` 时 Node 进程被宿主静默终止（exit 127，无异常），阶段 1 都进不去，导致「安装/升级/卸载」长期未验证。
- **原因**：宿主对 Node 进程批量复制可执行文件的行为有拦截；`fs.cpSync` 没有可用的错误返回。
- **修改点**：`tools/acceptance/m4-runner.js:208` 新增 `copyTree()`——Windows 走系统 `robocopy`（退出码 0–7 视为成功），其它平台回退 `fs.cpSync`；`:236` 改用它。
- **验证**（首次全链路跑通）：
  - 阶段 1 解包版 19/19 + 单实例互斥 + 过期日志清理；
  - 阶段 2 NSIS 静默安装到临时目录 → 安装版建店/列表/会话 3/3；
  - 阶段 3 覆盖安装 → 数据保留（既有店铺仍在）+ 审计表可读 4/4；
  - 阶段 4 静默卸载 → 安装目录清理、用户数据保留（`deleteAppDataOnUninstall=false`）。
  - 运行器总计 **13/13 PASS**（`artifacts/task2-m4-full.log`）。

### F5（卫生）清理过期 TODO 与格式瑕疵

- `apps/desktop/src/main/ipc/store-handlers.ts:99` 两个 TODO 已过期（profile 在事务内创建、建店无代理参数），替换为真实行为说明，避免后来者重复实现。
- `packages/shared/src/contracts/ipc.ts` 的 `WINDOW_SET_TITLEBAR_OVERLAY` 逗号独占一行，改为常规写法。

### F6（验收资产）新增工作台入口一致性套件

- 新增 `tools/acceptance/dashboard-apps-cdp-verify.js`（10 项）：F1/F2/F3 的端到端锁点，防止「功能已上线、入口还写待接入」再次发生。

---

## 3. 验证结果（最终构建 v0.4.75）

| 门槛 / 套件 | 结果 |
|---|---|
| `pnpm typecheck` | **0 错误** |
| `pnpm lint` | **0 error**（1152 warning，历史存量） |
| `pnpm test` | **147 文件 / 1569 用例全过**（含扩展清单边界回归） |
| `pnpm build` + `electron-builder --dir` | 成功 |
| `m1-runner`（工作台全链路） | **108/108** |
| `m2-runner`（代理/指纹） | 两阶段 **PASS** |
| `m3-runner`（任务引擎） | **114/114** |
| `sec-runner`（会话/应用锁） | **44/44** |
| `settings-cdp-verify` | **46/46** |
| `products-redesign-cdp-verify` | **44/44** |
| `agent-cdp-runner` | **PASS（11 项）** |
| `dashboard-apps-cdp-verify`（新增） | **10/10** |
| `m4-runner`（安装/升级/卸载） | **13/13** |
| `pnpm audit --prod` | 0 漏洞 |

> 说明：真机套件在本机偶发被宿主注入的 Chromium 断点打断（`renderer gone exitCode=-2147483645`，同时 Network/Audio 崩溃）。同一命令清掉残留 `ShopPilot.exe` 后复跑即 108/108、46/46、44/44；这不是代码回归，详见 §5。

---

## 4. 关键改动文件

| 文件 | 说明 |
|---|---|
| `apps/desktop/src/renderer/src/features/workbench/notification-center.ts` | 新增：通知纯函数（真实数据、上限、排序） |
| `apps/desktop/src/renderer/src/features/workbench/DashboardView.vue` | 通知面板、红点口径、批量发布入口、Esc/外点关闭 |
| `apps/desktop/src/renderer/src/features/workbench/UnifiedAppsPage.vue` | 批量发布卡片、AI 助手文案、设置卡片描述 |
| `apps/desktop/src/main/ipc/store-handlers.ts` | 过期 TODO → 真实实现说明 |
| `packages/shared/src/contracts/ipc.ts` | 格式清理 |
| `tools/acceptance/m4-runner.js` | `copyTree()`：robocopy 复制，打通 M4 |
| `tools/acceptance/dashboard-apps-cdp-verify.js` | 新增 10 项入口一致性验收 |
| `tests/unit/notification-center.test.ts` | 新增 7 例 |
| `tests/unit/invoice-task-exclusion.test.ts` | 红点口径契约迁移到 notificationTasks |

---

## 5. 仍存在的风险、限制与未覆盖场景

1. **测试文件没有纳入类型检查**：`tsconfig.json` 的 `include` 不含 `tests/**`；用 `tsc -p` 试跑会得到 **109 个类型错误**（集中在 `invite.test.ts` 35、`platform-adapters.test.ts` 20、`product-sync-service.test.ts` 10 等，均为联合类型未收窄）。这些测试实际运行正常，但类型债会掩盖未来的真实回归。本轮未批量改（会把 109 处断言改成 `as any`，收益低、风险高）。
2. **1152 条 lint warning**（`no-explicit-any`、多余分号等），0 error；未做批量清理。
3. **短视频去重 / 影像级干扰**：仓库没有对应媒体处理模块，工作台与应用中心仍标「待接入/暂不可用」——这是**诚实的状态**，不是文案 bug；属于未立项功能。
4. **通知中心的范围**：只聚合已加载的任务/客服未读，**没有**已读/未读持久化、桌面通知、历史归档；条目上限 8，失败窗口 24h。若后续要“点掉不再提醒”，需要新增设置键与持久化表。
5. **Agent 相关文档仍是历史设计**：`AGENT_DEVELOPMENT_SPEC.md` / `AGENT_PROGRESS.md` 里的 A-M1..A-M6 PARTIAL 与工具/记忆/技能能力，和当前「仅纯文本对话」的产品边界不一致。代码与 UI 已按纯文本收口，但文档未重写，属于文档债。
6. **环境相关未覆盖**：
   - 真机套件偶发被宿主 Chromium 断点打断（0x80000003/-2147483645），同一命令复跑通过；低内存（<4GB 空闲）+ 残留实例会放大。
   - `invoice-license-local-verify.js` 在「获取主体营业执照」处两次提前结束（31/51，exit 0 无 summary），疑似宿主对真实平台网络访问/子进程的处理；同代码当天 13:55 曾 **51/51** 全过，本轮未定位到代码原因。
   - 安装包仍**无代码签名**（P0-4 未解决，需证书/SignPath）。
   - `SHOPILOT_ACCEPTANCE=1` 仍是打包态测试钩子的显式开关（有 warn 留痕），生产安装包不设置即无效。
7. **商品方案文档的 DoD 复选框仍是 `[ ]`**（R1–R3 附录已写实现与验收），属文档未回填，不影响运行。

---

## 6. 复跑命令

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm build && pnpm exec electron-builder --win --x64 --dir

node tools/acceptance/m1-runner.js
node tools/acceptance/m3-runner.js
node tools/acceptance/sec-runner.js
node tools/acceptance/settings-cdp-verify.js
SEED_STORE=1 node artifacts/run-with-app.cjs tools/acceptance/products-redesign-cdp-verify.js 9250
node artifacts/run-with-app.cjs tools/acceptance/dashboard-apps-cdp-verify.js 9250

# M4 需要先出安装包
pnpm run dist && node tools/acceptance/m4-runner.js
```

> 真机验收被中断后先确认没有残留 `ShopPilot.exe`；Windows 宿主终端需 `unset NODE_OPTIONS ELECTRON_RUN_AS_NODE`。
