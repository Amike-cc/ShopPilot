# ShopPilot 代码质量与安全审查报告（2026-10-15）

> 审查对象：`D:/code/电商浏览器` @ v0.4.65（工作区含 22 处未提交改动）
> 审查方式：全仓人工审读（主进程 / 渲染层 / 共享包 / 工具链）+ 三路并行深读 + 安全专项精读 + 实跑复核（`pnpm audit`、`pnpm exec eslint . -f json`、`git` 统计）
> 证据留档：`artifacts/shopilot-audit.json`（audit 原始 JSON）、`artifacts/lint-report.json`（ESLint 原始 JSON），本报告所有结论均可按文件:行号或命令复现。

---

## 〇、结论速览

| 维度 | 评级 | 一句话结论 |
| --- | --- | --- |
| 架构设计 | B+ | 主/渲染/共享三分层清晰，IPC 契约与事件通道先于实现定义；但任务引擎与 Agent 模块随行数膨胀开始失守 |
| 代码质量 | B- | 注释与纪律罕见地好（TODO/FIXME 仅 2 处、零 `@ts-ignore`），但 4230 行的 task-runner、2680 行的单函数、多处复制粘贴实现是硬伤 |
| 依赖管理 | **D** | Electron 30 已 EOL 两年；全仓 86 个已知漏洞（5 critical / 33 high）；构建链命中未修复 CVE；无 audit 门禁、无自动升级 |
| 安全设计 | B+ | webview / IPC / 凭据三条边界都做了扎实的纵深防御；短板在补丁滞后、安装包无签名、错误信息透传 |
| 测试体系 | B | 129 个单测 + 61 个验收脚本，白盒契约测试有章法；但覆盖率无门禁、渲染层近乎零组件测试、验收脚本各自为政 |

**三条系统性主线（按影响排序）：**

1. **依赖与供应链是全仓最薄弱环节**——EOL 运行时 + 86 个漏洞 + 无审计门禁，需要立即处理（P0）。
2. **巨型文件与重复实现**正在把"可维护"变成"只能靠真机回归"——P1-1（任务引擎）与 P1-5（渲染层）需要一次结构性拆分。
3. **门禁与目标不匹配**：CI 只跑到 build、lint 1124 条警告、零覆盖率、验收靠手跑——自动化"发现问题的能力"缺位，是前两类问题长期积累的根因。

---

## 一、项目画像

- 源码规模：`apps/desktop/src` + `packages/shared` 共 **220 个文件 / 69,064 行**（ts/vue/mjs）。
- 最大文件：`tasks/task-runner.ts`（4230）> `services/agent-service.ts`（2666）> `UnifiedDataPage.vue`（2253）> `DashboardView.vue`（1938）> `agent-runtime.ts`（1826）> `db/migrations.ts`（1673）> `browser/window-manager.ts`（1651）。
- 测试：`tests/unit` **129 个测试文件**；`tools/acceptance` **61 个验收脚本**。
- 仓库：**1637 个跟踪文件 / size-pack 87.16 MiB**，其中 `wx-invite-test/` 750 文件（14 MB）、`assets/generated` 图标 251 文件（45 MB）。
- 门槛现状：`.github/workflows/ci.yml` → `tools/ci/verify.ps1` = typecheck → lint → vitest → build；**无 audit、无打包冒烟、无 E2E**。

---

## 二、值得保留的亮点（不建议改动）

1. **webview 纵深防御**：`will-attach-webview` 剥离 Renderer 传入的 preload、强制 `nodeIntegration:false / contextIsolation:true / sandbox:true`、校验 partition 必须是已存在的真实店铺、src 走共享导航白名单、FIFO 配对客服 guest 并对其单独做导航/弹窗边界（`main/index.ts:230-321`）。这不是模板代码，是按实际攻击面写的。
2. **IPC 信任面收口**：所有家族经 `familyHandle` 统一校验"发送方必须是主窗口 webContents"+ 应用锁门禁，且锁门禁是在 `ipcMain.handle` 层统一包装的（`family-handle.ts:28-57`、`renderer-trust-rules.ts:23-41`、`bg-services.ts:40-51`），纯规则可单测。
3. **凭据存储 fail-closed**：safeStorage 不可用时拒绝写入/读取（throw 明确错误码），绝不再产生新的 `plain:` 记录（`credential-store.ts:51-88`）；主密码 = scrypt(固定域盐+随机盐) + `timingSafeEqual` + DPAPI 封装，历史脏键就地迁移（`security-manager.ts:98-153`）。
4. **日志脱敏到位**：URL 查询串全掩码（key 保留、值一律 `***`）、敏感行截断、文件级脱敏后再读（`logger.ts:95-131`）。
5. **可观测性与自愈**：渲染进程崩溃有界自动恢复（5 分钟 3 次 + 24 小时 10 次双上限）、日志风暴限流（8 秒 1.1 万条的事故被写进注释了）、启动失败扫盘用备份自愈（`index.ts:97-130`、`558-603`）。
6. **主窗口导航收口**：`will-navigate` 只放行自身 UI 文件 / dev origin，`window.open` 一律 deny（`index.ts:339-361`）。
7. **契约先行**：DEVELOPMENT_SPEC 先定义 IPC 信封、事件通道、数据模型再实现；发布流程有清单（§21）；`REVIEW.md` 显示文档评审闭环过。
8. **纪律数字**：零 `@ts-ignore` / `@ts-expect-error`；TODO/FIXME/HACK 全仓仅 2 处；`packages/shared` 的 `no-explicit-any` 提升为 error。

---

## 三、P0 —— 立即处理（供应链与外发制品）

### P0-1 Electron 30.5.1 已 EOL 两年，累计 37 条安全公告（11 high）

- **证据**：`pnpm audit` 中 electron 相关 advisory **37 条（11 high / 21 moderate / 5 low）**，其中与本项目技术特征（`webviewTag` + 权限处理 + 多窗口）直接相关的高危包括：
  - `<webview> can enable Node.js integration in Web Workers`（patched ≥ 41.10.6）；
  - `Context isolation bypass via Function.prototype.bind`（≥ 39.8.9）；
  - `Use-after-free in WebContents fullscreen / pointer-lock permission handler`（≥ 38.8.6），且本项目设置了异步 `setPermissionRequestHandler`（`session-manager.ts`）；
  - `Sandboxed iframe can bypass allow-popups`（≥ 41.10.10）。
- **外部核实**：endoflife.date —— Electron 30 支持终止于 **2024-10-15**；当前受支持线为 42（2026-10-20 到期）/ 43（2027-01-05）/ 44（2027-03-02，最新 44.7.0）。
- **影响**：非受信远端内容（四家平台店铺页）跑在同一 Chromium 里；沙箱/上下文隔离绕过类漏洞一旦进入利用链，影响的不只是页面，而是宿主。
- **现有缓解**：`will-attach-webview` 硬化确实压缩了部分利用面（例如 webview Node 集成需配合其它绕过），但**不能替代补丁**。
- **建议**：升级到 **43.7.9 或 44.7.0**（硬下限 ≥ 41.10.6）。建议与 P0-2 的工具链升级组团为一个专门迭代：改版本 → `pnpm install` → 跑 m0/m1/m3 验收 + 打包冒烟 → 重点回归 webview 生命周期、权限、safeStorage、better-sqlite3 ABI。跨 13 个大版本，必须给回归留预算。

### P0-2 构建链与测试链命中 5 个 critical / 33 个 high

- **证据（`pnpm audit` 实测输出）**：
  - `vitest >=1.0.0 <1.6.1` 与 `<3.2.6`：**2 条 critical（恶意配置触发 RCE）**；
  - `tinypool <=2.1.0 / <2.1.2`：**2 条 critical（Prototype Pollution → RCE）**；
  - `tar <=7.5.18`：**1 条 critical（解压 DoS）**+ 8 条 high（硬链接逃逸写文件等）；
  - `app-builder-lib <26.15.0`（来自 electron-builder 24）：high CVE-2026-54672；另有 NSIS 安装器同目录劫持执行任意代码（CVE-2024-27303）；
  - `vite`（5.1.4）多条 high/moderate：launch-editor 命令注入、`server.fs.deny` 绕过；
  - `extract-zip <=2.0.1`：2 条 high（符号链接路径穿越，**无补丁版本**，只能随上游升级消解）；
  - `playwright <1.55.1`：high（下载浏览器不校验完整性）。
- **影响**：开发机与构建机是"离密钥最近的环境"（git 凭据、发布 token）；"跑一次测试/构建即被 RCE"是供应链攻击最经济的目标。外发安装包由 electron-builder 产出，其漏洞直接影响交付物完整性。
- **建议**：一次性升级——`vitest ≥3.2.6`、`vite ≥5.4.20`（或随 electron-vite 5 直接到 vite 7）、`electron-builder ≥26.15.3`；`playwright` 仅被 `assets/design/invoice-center-v1/render.mjs` 使用，升级到 ≥1.55.1 或移出主依赖树。

### P0-3 CI 与依赖安全脱节：无 audit 门禁、无自动升级

- **证据**：`.github/workflows/ci.yml` + `tools/ci/verify.ps1`（typecheck→lint→vitest→build）；仓库无 `dependabot.yml` / `renovate.json`；86 个漏洞没有任何自动化发现手段（本次是人工跑出来的）。
- **建议**：① CI 增加 `pnpm audit --audit-level=high`（生产依赖硬门禁，dev 依赖给宽限清单）；② 引入 Dependabot（分组：electron 系 / vue 系 / 构建链）；③ CI 增加"打包态启动冒烟"（`electron-builder --dir` + 启动一次），挡住 ABI/asar 这类只在打包态暴露的问题。

### P0-4 Windows 安装包无代码签名，自动更新链无签名校验

- **证据**：`electron-builder.yml` 全文无 signing / certificate 配置；`services/update-manager.ts` 启用 `autoUpdater` 指向 GitHub Releases。
- **影响**：Users 见 SmartScreen 拦截降低信任；更新链缺少第二信任根（electron-updater 校验的哈希来自 `latest.yml`，未签名时该文件与安装包同通道可被替换）。
- **建议**：预算内接 Authenticode 签名（OV/EV 证书或 SignPath）；短期至少在发布说明中给出安装包 SHA-256 供用户手工核对。

---

## 四、P1 —— 本迭代内（可维护性与正确性）

### P1-1 任务引擎单文件 4230 行、单函数 ≈2680 行，且没有直测

- **证据**：`tasks/task-runner.ts:1510-4191` —— `execStep` 一个函数 ≈2680 行（`switch (step.type)` 下数十个步骤分支，`loop` 分支多层嵌套）；`execute` 168 行（520-688 承载 8 条状态迁移）；`findTextTarget` 291 行（1033-1324）。`tests/unit` 中**没有** task-runner 的直测（只有 `task-lifecycle.test.ts` 引用其中的纯函数）。
- **影响**：全部自动化副作用（真实发邀约、发布商品、写平台表单）集中在这一个函数里；任何改动都可能无声波及不可逆操作，回归只能靠真机验收。
- **建议**（分两步）：
  1. 本迭代：抽 `run-state.ts`（TRANSITIONS + `transition` + pump 纯函数）并补状态机单测；把 execStep 内的纯计算片段（选择器归一、loop 展开、重试决策）抽为纯函数配测试。
  2. 下一步：按步骤类型拆 `steps/*.ts` 执行器 + registry，让"白名单步骤类型"成为可枚举、可断言的契约。

### P1-2 IPC 错误信封原样透传 `error.message`（内部路径泄露）

- **证据**：`ipc/family-handle.ts:51` `message: String((error as any)?.message || error)`；`ipc/profile-misc-handlers.ts:346` 把 `writeErr.message` 拼接进用户可见文案（Node fs 错误串含绝对路径）。
- **建议**：新增 `toSafeMessage(err)` 白名单映射——已知业务错误码回原文，其余回通用文案 + `requestId`；内部细节只进日志。

### P1-3 审计写入失败与引擎异常走 `console.error`，绕过脱敏与持久化

- **证据**：`services/audit-logger.ts:87-89` catch 仅 `console.error`（安全审计事件在 DB 忙/关库时静默丢失）；`tasks/task-runner.ts:378-379、679` 用 `console.error` 输出原始异常栈——可能含带 token/cookie 的 URL，而只有 `logMain` 做了 `redactSecretValues`。
- **建议**：统一改走 `logMain`（logger 自带 fail-safe 与脱敏）；"审计丢失"本身也应留下一条审计。

### P1-4 `logMain` 每行日志同步落盘（appendFileSync + statSync）

- **证据**：`services/logger.ts:110-122`，每次调用 `appendFileSync` 后紧跟 `statSync`；任务引擎在每步、每次重试、每轮 loop 都打日志。
- **影响**：7×24 无人值守采集场景下，同步 IO 阻塞主线程（与"界面偶发卡顿"同源风险）。
- **建议**：换 `createWriteStream`（或缓冲批量 flush），大小检查改为周期性而非每行。

### P1-5 渲染层巨型 SFC 与复制粘贴实现

- **证据**：
  - `UnifiedDataPage.vue` 2253 行（模板 682 / 脚本 1313）、`DashboardView.vue` 1938、`UnifiedImageStudioPage.vue` 1654、`UnifiedSettingsPage.vue` 1463、`DashboardBrowserSurface.vue` 1367；
  - **三套 AI 配置块近乎逐行复制**：`UnifiedSettingsPage.vue:845-1162`（saveAi/saveImageAi/saveImageTextAi、fetchModels ×3、testAi ×3、clearKey ×3 共 12 个同构函数）；
  - **IPC 调用样板全渲染层 89 处** `if (!result.ok) toast('失败：'+message)`、62 处同类错误文案（busy 标志仅 UnifiedAppsPage 就 19 处 `busy.value = true`）。
- **建议**：先抽 composable（`useAiProfile` / `useIpcAction` / `useInvoiceCenter`）再切子组件；`UnifiedDataPage` 优先拆"发票中心 / 涉税报送 / 采集调度"三块。

### P1-6 图片工作室历史以 base64 全量写 localStorage + 深度 watch

- **证据**：`UnifiedImageStudioPage.vue:845` `watch(historyImages, persistHistory, { deep: true })`；`883` `JSON.stringify(historyImages.value.slice(0, 500))` 同步写；写入失败被空 catch 吞掉（配额超限后历史静默不落盘）。
- **影响**：每轮生成触发数百 MB 序列化（主线程卡顿）；"历史丢了但没有提示"。
- **建议**：图片落磁盘（`safe-image-save.ts` 已有能力）+ localStorage 只存索引；或至少浅监听 + 失败提示。

### P1-7 五个重型页面未判 `window.shopilot` 存在性（无 preload 环境白屏）

- **证据**：`UnifiedStorePage.vue:88`、`UnifiedSettingsPage.vue:221` 在 setup 顶层直接写 `window.shopilot.platforms`（无 `?.`）；`UnifiedDataPage.vue:1577`、`UnifiedAppsPage.vue:599`、`UnifiedTaskPage.vue:83` 同类。对照组：`DashboardView.vue:546` 有 `hasNativeBridge`。
- **影响**：仓库自身维护纯渲染调试模式（`renderer-only.log` 等），进入这 5 个页面即 `TypeError` 白屏。
- **建议**：抽 `useBridge()`（统一守卫 + 降级数据），5 个页面统一引用。

### P1-8 验收脚本 62 份重复 CDP 实现，共享库形同虚设

- **证据**：`grep -rl "class CDP" tools | wc -l` = **62**；`tools/acceptance` 61 个脚本；`require('../ui')` 引用数 = **0**（`tools/ui/` 8 个文件无人使用）。
- **建议**：抽 `tools/lib/cdp.js`（连接/eval/重试/截图/断言统一），新脚本强制引用，存量分批迁移。

### P1-9 better-sqlite3 ABI 无自动化（新环境 dev 易崩）

- **证据**：`package.json` 无 `postinstall` / `@electron/rebuild`；本机 `node_modules` 内是 Electron ABI 产物（纯 node 加载不了），`electron-builder` 打包时会重编，但 `electron-vite dev` 之前没有任何自动检定。
- **建议**：dev 流程加 ABI 检定或 `@electron/rebuild`；INSTALL.md 写明重建命令；CI 加打包冒烟兜底。

### P1-10 未清理的全局监听/定时器与无中止轮询

- **证据**：
  - `app/App.vue:77-84` 匿名 `keydown` 监听无 `removeEventListener`；
  - `stores/workspace.ts:198-293` 12 个匿名 `window.shopilot.on(...)`（preload 的 `off()` 依赖回调引用相等，匿名函数无法卸载），靠模块级布尔兜重复订阅；
  - `services/bg-services.ts:67、84` 两个 `setInterval` 无幂等守卫、无 `unref`（对照 `maintenanceTimer` 有）；
  - `task-runner.ts:2118-2128` 确认门禁 `setTimeout` 不清理；
  - `UnifiedDataPage.vue:1799`、`DashboardView.vue:1086`、`UnifiedTaskPage.vue:80-93`、`CustomerServiceWorkspace.vue:196-204` 四处 `for(;;)/while` 轮询无 abort 标志。
- **建议**：统一"可 dispose 的资源容器"收口生命周期；轮询传 `isDisposed()` 判定。

---

## 五、P2 —— 计划内（重复实现、数据层、类型与测试基建）

| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| P2-1 | shared 内同名 `normalizeCellText` 双实现且语义不同（去重 vs 去零宽字符） | `constants/invoice.ts:590` vs `product-rules.ts:17`；两侧都在用 | 合并为一份带选项实现；加"同名导出扫描"源码测试 |
| P2-2 | 店铺状态中文映射三份，其中一份缺 `proxy_error/archived` 分支（总览页显示为"离线"） | `UnifiedAppsPage.vue:408`、`UnifiedStorePage.vue:98`、`DashboardView.vue:996` | `shared/enums` 导出 `STORE_STATUS_LABEL` 单一来源 |
| P2-3 | IPC `ok/err` 样板 9 份逐字复制（已核实 9 个文件） | `ipc/{task,platform,order,product,sales-metrics,session-security,proxy-backup,customer-service,agent-domain}-handlers.ts` | 收敛到 `family-handle.ts` 导出 `ipcOk/ipcErr` |
| P2-4 | `parseJson` 五份实现语义不一致；DB 行/IPC 入参经显式 `any` 脱类型（main 673 处、`as unknown as` 13 处） | `agent-runtime.ts:59`、`order-repository.ts:17` 等；`executeModelJob(row: any)` | 收敛 `@shared/json`；优先给 `agent-runtime` 的 DB 边界补 Row 类型/zod infer |
| P2-5 | SQL 语句重复 prepare（agent-runtime 内联 22 处）；批量 upsert 在事务循环内逐行 prepare | `agent-runtime.ts` 多处；`sales-metrics-repository.ts:167,229`（对照 `product-repository.ts:944` 的循环外 prepare 正确范例） | 抽 `stmts` 懒加载单例；批量改"循环外 prepare 一次" |
| P2-6 | 事件契约无 payload 类型；9 个已定义频道无人订阅（含 `SESSION_EXPIRED` 与 7 个 Agent Job 残留） | `contracts/ipc.ts:347-389`；渲染层 0 处订阅 | 加 `EventPayloads` 映射让 `on()` 泛型约束；一次性清理死频道 |
| P2-7 | 状态迁移先改内存后落库，落库失败不回滚 | `task-runner.ts:130-176`（136 改内存 → 147 落库） | 先落库成功再改内存，或 catch 回滚 |
| P2-8 | `createAgentJob` 两次写非原子（先建 task 后开 job 事务） | `agent-runtime.ts:1294`/`1298` | 同一 `db.transaction` 包裹 |
| P2-9 | 静态门禁偏弱：tsconfig 无 `noUncheckedIndexedAccess/noUnusedLocals`；ESLint 实测 **0 error / 1124 warning（其中 1094 条 no-explicit-any）** | `tsconfig.json`；`artifacts/lint-report.json` | 告警按目录分批清零后加 `--max-warnings`；补 tsconfig 严格项 |
| P2-10 | 测试基建：vitest 无 coverage/setupFiles；129 单测中渲染相关仅 1 个；Electron mock 各文件自写（14 个 `vi.mock`） | `vitest.config.ts` | 加覆盖率阈值（如 lines 60%）+ `tests/setup/electron-mock.ts` + 组件测试起步 |
| P2-11 | 仓库体积：生成图标 251 文件 45 MB、`wx-invite-test/` 750 文件（14 MB）入库 | `git ls-files`；size-pack 87.16 MiB | 图标构建期生成 + gitignore；证据留档移出或按月归档 |
| P2-12 | 其它依赖滞后：vue 3.4 已 EOL（3.5.42 修 XSS）、zod 3 停更、eslint 8 已 EOL、@types/node 20 与运行时 Node 22 不符 | 见 §七 对照表 | 随 P0-2 组团升级 |

---

## 六、P3 —— 卫生与零散项

- **死代码**：`agent-runtime.ts:1124 resolveFallbackProfile` 全仓零引用；`1582 drainDelegatedQueue()` 空桩；`1561/1665` 的 Job 恢复函数仅被"断言未被调用"的测试引用——建议删除或移入 `legacy/` 并标 `@deprecated`。
- **根目录杂物**：`debug.log`(3.4 MB)、`dev-restart-final.log`(916 KB) 等 9 个日志/err 文件散在仓库根（已 gitignore，但污染工作区）。
- **工作区脏**：22 处未提交改动；发布脚本要求 clean worktree，会反复卡发布流程。
- **样式**：渲染层硬编码 hex 色值约 1200 处、两套并行 token（`--color-*` 与 `--dash-*`）；`CustomerServiceWorkspace.vue` 定义 0 个变量却用 83 处硬编码色。
- **零散**：可编辑列表用 index 作 key（增删会串行）；`AgentPlanCard.vue:55` 局部函数 `setInterval` 遮蔽 `window.setInterval`；主密码解锁无尝试频率限制（scrypt 已慢，仍建议加）；CSP 可补 `object-src 'none'`、`base-uri 'self'`、`frame-ancestors 'none'`。
- **迁移代码**：`migrations.ts` 用 `console.log` 且 `getCurrentVersion` catch 一律 `return 0`——迁移失败在持久日志中难以定位。

---

## 七、核心依赖升级对照表

| 依赖 | 当前 | 建议 | 理由 |
| --- | --- | --- | --- |
| electron | 30.5.1 | **43.7.9 / 44.7.0** | 30 于 2024-10-15 EOL；37 条 advisory，webview/隔离类高危须 ≥41.10.6 |
| electron-builder | 24.13.3 | **≥26.15.3** | app-builder-lib <26.15.0 有 high CVE；NSIS 打包链另有劫持 CVE |
| vitest | 1.3.1 | **≥3.2.6** | 2 条 critical RCE（含 tinypool 传递） |
| vite | 5.1.4 | **≥5.4.20**（或 7.x） | fs.deny 绕过 / 命令注入等 9 条 |
| electron-vite | 2.0.0 | **5.x**（与 vite 联动） | 落后 4 个大版本，需跟进新 Electron 构建目标 |
| vue | 3.4.21 | **3.5.43** | 3.4 已 EOL；@vue/server-renderer <3.5.42 有 XSS |
| vue-router / pinia | 4.3.0 / 2.1.7 | 4.5.x / 2.3.x | 随 vue 3.5 同步 |
| vue-tsc | 1.8.27 | 3.x | 与 vue 3.5 / TS 5.9 组合已老 |
| typescript | 5.3.3 | 5.9.x | 落后 6 个小版本 |
| zod | 3.22.4 | 4.x（可经 `zod/v3` 渐进） | zod 3 已停止维护（末版 2025-07） |
| better-sqlite3 | 11.10.0 | 12.x/13.x + `@electron/rebuild` | 落后两个大版本；补 ABI 自动化 |
| eslint | 8.57.0 | 9/10 + flat config | v8 于 2024-10-05 EOL |
| @types/node | 20.11.24 | 22.x | 运行时与 CI 均为 Node 22 |
| playwright | 1.42.1 | 移除或 ≥1.55.1 | 仅 assets/design 一次性脚本使用，带 high 漏洞 |

> 注：升级 electron 主版本时，`electron-updater`、`better-sqlite3`、`electron-vite` 需同批验证；本项目已有 `builder-util-runtime` override 经验（见 `pnpm-workspace.yaml` 注释），升级后需重新核对 overrides 是否仍必要。

---

## 八、建议执行计划

**批次 1（本周，P0）**
1. CI 加 `pnpm audit --audit-level=high` + Dependabot（30 分钟级改动，收益最大）。
2. 升级组团：vitest ≥3.2.6 / vite ≥5.4.20 / electron-builder ≥26.15.3 + 移除或升级 playwright，跑四道门槛。
3. Electron 升级单独立项（43/44 + electron-vite 联动），预留回归预算：webview 生命周期、权限处理、safeStorage、cookies、better-sqlite3 ABI、打包冒烟。
4. 评估签名方案（证书成本 vs SignPath）。

**批次 2（2 周内，P1）**
5. `task-runner` 第一步拆分（`run-state.ts` 纯状态机 + 单测）——这是全仓风险最高的一块。
6. `toSafeMessage` 错误信封收口；`audit-logger`/task-runner 异常统一走 `logMain`；logger 换流式写入。
7. 渲染层：`useIpcAction` / `useBridge` 守卫 / 图片工作室改磁盘落盘；`UnifiedSettingsPage` 三套 AI 配置合成 `useAiProfile`。
8. 抽 `tools/lib/cdp.js` 并让新验收脚本强制引用。

**批次 3（1 个月，P2）**
9. 重复实现收敛清单（P2-1 ~ P2-4 + P2-3）逐项落地，配"同名导出扫描"源码测试。
10. DB 语句缓存与批量 upsert 改法统一（P2-5）；事件契约补 payload 类型并清死频道（P2-6）。
11. 测试基建：覆盖率阈值 + electron-mock + 组件测试起步；lint 告警分批清零后加 `--max-warnings`。

**批次 4（季度，P3 + 长期）**
12. 仓库瘦身（图标构建期生成、wx-invite-test 留档外移）；类型收紧（`noUncheckedIndexedAccess`）；监听器/轮询生命周期收口；死代码清理。

---

## 九、本次审查的边界与未覆盖项

- Electron 升级的实际兼容性未做升级试验（本报告给出的是目标版本与风险清单，不是已验证的升级路径）。
- 未运行真机验收脚本（依赖桌面环境与平台登录态）；未做性能基准（内存占用曲线、启动耗时）。
- 视觉/交互无障碍、国际化未评；`assets/design` 设计资产未逐一核对。
- 依赖升级版本号来自 `pnpm audit` 的 patched 区间与公开 EOL 数据，落地前请以官方 release notes 复核。

---

*报告基于 2026-10-15 16:00–20:00 的只读审查；未修改任何产品代码。审查原始数据：`artifacts/shopilot-audit.json`、`artifacts/lint-report.json`。*
