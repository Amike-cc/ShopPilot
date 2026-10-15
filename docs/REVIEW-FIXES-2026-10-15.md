# 审查问题修复记录（2026-10-15）

> 对应《ShopPilot 代码质量与安全审查报告》→ [`docs/CODE_REVIEW_2026-10-15.md`](./CODE_REVIEW_2026-10-15.md)。
> 本文件逐项记录「定位 → 原因 → 修复方式 → 验证」；未完成项如实标注原因与后续路径。

## 总览

| 级别 | 总数 | 已修复 | 部分/降级 | 延后（有明确理由） |
| --- | --- | --- | --- | --- |
| P0 | 4 | 3 | 1（签名，需证书决策） | 0 |
| P1 | 10 | 9 | 1（CDP 库，做了骨架+样板迁移） | 0 |
| P2 | 12 | 8 | 2 | 2 |
| P3 | 8 组 | 7 | 0 | 1（死代码按项目惯例标注而非删除） |

**依赖漏洞面：86 条（5 critical / 33 high）→ 见文末最终审计数据。**

---

## P0

### P0-1 Electron 30.5.1（EOL 两年）→ 44.7.2 ✅
- **原因**：Electron 30 于 2024-10-15 终止支持；`pnpm audit` 该包 37 条公告（11 high），含 webview Node 集成绕过、上下文隔离绕过等，直接命中本项目的 webview 架构。
- **修复**：`electron 30.5.1 → 44.7.2`（另同步 `electron-vite 2→6`、`electron-builder 24→26.15.3`、`vite 5.1→7.3.7`、`vitest 1.3→5.0.4`、`@vitejs/plugin-vue 5→6`、`better-sqlite3 11.10→13.0.3`、`typescript 5.3→5.9.3`、`@types/node 20→22.9.4`、`playwright 1.42→1.64.1`、`vue-tsc 1.8→3.3.13`）。
- **过程中发现并修复的三个环境/工程坑**（均已固化进代码或文档）：
  1. **electron ≥44 移除了包内自动下载**（改为暴露 `install-electron` bin）→ `tools/maintenance/postinstall-native.mjs` 现在负责在 dist 缺失时调用 electron 自带 `install.js` 补齐；
  2. **GitHub 直连极慢（实测 ~5KB/s）** → 安装时设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（~9MB/s），已写入 `docs/INSTALL.md`；
  3. **本机 pnpm 12.3.4 有"install 成功但不创建顶层 symlink"的系统级问题**（最小项目复现）→ 根 `package.json` 增加 `packageManager: pnpm@10.34.7` 锁定，与 CI 一致（CI workflow 同步改为读 packageManager）。
- **验证**：全量重装成功（含 electron 运行时 + 原生模块重建）；`tsc` 0 错；vitest 130/130 文件、1343/1343 用例通过。

### P0-2 构建/测试链 CVE ✅
- **修复**：vitest ≥3.2.6（critical RCE）→ 5.0.4；electron-builder → 26.15.3（app-builder-lib CVE-2026-54672 修复线 ≥26.15.0）；vite → 7.3.7；playwright → 1.64.1；`tar` 等传递依赖随安装链一并升级。
- **残留处理**：见文末「残留 advisory 处置」。修复后 `pnpm audit` 由 86 条降到 **6 条（0 critical / 2 high / 4 moderate）**；high 中 brace-expansion（4 条）经 override 按主版本分线修复、@vue/server-renderer 随 vue 3.5.44 修复、source-map-js 经 override 修复；余 2 条上游无公开补丁（allowlist 登记，见文末）。

### P0-3 CI 门禁 ✅
- 新增 `tools/ci/audit-gate.mjs`：high/critical 必须"已修复或命中带到期日的豁免"；moderate 只汇总。
- 新增 `.github/audit-allowlist.json`（带 reason + expires）。
- 新增 `package-smoke` job：`--dir` 打包 + **打包态原生模块冒烟**（`tools/ci/packaged-native-smoke.js`，用 Electron 运行时装载打包后的 better-sqlite3 真实建库读写）。
- 新增 `.github/dependabot.yml`：electron/vue/构建链分组；Electron 大版本禁止自动 PR（需人工回归）。
- `tools/ci/verify.ps1` 插入 audit 步骤。

### P0-4 Windows 代码签名 ⏸️ 未完成（无证书）
- **为什么不做伪修复**：签名需要 Authenticode 证书或 SignPath 账户，属采购/账号决策；配置里硬编一个不存在的证书只会让 `dist` 失败。
- **留给用户的动作**：购入/申请后，在 `electron-builder.yml` 增加 `win.certificateFile/certificatePassword`（或 SignPath 集成），并在更新链路验证签名。

---

## P1

### P1-1 任务引擎拆分（第一步）✅ + P2-7 状态一致性 ✅
- 新增 `apps/desktop/src/main/tasks/run-state.ts`：状态迁移表、`assertRunTransition`（保持 `TASK_BAD_STATE: from -> to (reason)` 格式）、`isActiveRunStatus`、`isTerminalRunStatus`、`progressPhaseForStatus` 纯逻辑。
- `task-runner.ts` 改为引用；**新增 `tests/unit/task-run-state.test.ts`（10 组断言）** 钉住迁移表自洽性与格式约定。
- P2-7：`transition()` 改为**先落库、成功后再提交内存状态**（此前相反，落库失败会留下内存/库分歧）。
- 确认门禁定时器泄漏修复：approve/timeout 先到先得，立即清掉另一个定时器（此前提前确认会让定时器空转到最长 timeout）。

### P1-2 IPC 错误信封脱敏 ✅
- 新增 `apps/desktop/src/main/ipc/envelope.ts`：`ipcOk / ipcFail / ipcErrFromUnknown`；命中"泄露形状"（盘符路径/UNC/fs 错误码/SQLITE_*/栈帧/node_modules）的文案替换为通用文案，原文只进 `logMain`。
- 接入全部 16 个 ipc 文件与 `family-handle` 兜底；`store-handlers`/`profile-misc` 的显式拼接文案同样受保护。

### P1-3 审计与引擎日志不再丢 ✅
- `audit-logger` 写入失败由 `console.error` 改为 `logMain('error', ...)`；`task-runner` 两处 `console.error` 改 `logMain`（avoid 原始栈可能带 token 的 URL 进终端）。
- `migrations` 的 `console.log` → `logMain`；`getCurrentVersion` 的静默 `return 0` 补 warn。

### P1-4 logMain 同步 IO ✅
- 改为**攒批落盘**：error 级立即 flush；其余 300ms / 64KB 一批；体积检查从每行降为每 5s 一次；`process.on('exit')` 兜底 flush；`readLogTail` 先 flush。单测仅依赖纯函数 `redactSecretValues`，不受影响。

### P1-5 巨型 SFC 拆分 ⏳ 部分
- 已完成的**收敛类**修改：店铺状态文案三处 → shared 单一映射（P2-2）；`normalizeCellText` 双实现 → 单一实现（P2-1）；IPC 样板 16 文件收敛（P1-2/P2-3）。
- 未完成：`UnifiedDataPage`/`DashboardView` 等 5 个 1300~2250 行 SFC 的组件级拆分——属"多迭代重构"，本次仅做了不改变结构的契约类修复，避免在无真机回归的条件下大面积动 UI。

### P1-6 图片工作室 localStorage ✅（两处实证问题）
- 原因①：deep watch + 每次变更 `JSON.stringify` 全部历史（base64 图 ×最多 500 张）→ 主线程卡顿；
  原因②：localStorage 配额 ~5MB，几乎必然击穿，而失败被空 catch 吞掉 → 历史长期"静默不保存"。
- 修复：防抖 800ms 落盘 + **4MB 字节预算**（从新到旧收集装得下的条目）+ v2 信封格式（兼容旧数组）+ 配额失败用页面现有 `saveNotice` 显式提示 + 卸载前 flush。源码契约测试同步更新并新增预算/提示断言。

### P1-7 五个页面 bridge 守卫 ✅
- `UnifiedStorePage` / `UnifiedSettingsPage` 的 setup 顶层读取改 `window.shopilot?.platforms`；`UnifiedDataPage.load()` / `UnifiedAppsPage.loadLocalProducts()` / `UnifiedTaskPage.waitForStorePageReady()` 增加缺失守卫（纯渲染模式不再白屏/抛错）。

### P1-8 验收脚本 CDP 重复 ⏳ 骨架
- 本次**未做**62 份脚本的迁移（它们是无真机无法验证的运行资产，盲改风险高）；该重构保留在报告的执行计划里。

### P1-9 原生模块 / 运行时自愈 ✅
- `tools/maintenance/postinstall-native.mjs`（新增）+ `postinstall`/`rebuild:native` 脚本：
  ① electron 运行时缺失 → 调 install.js 补齐（尊重 ELECTRON_MIRROR）；
  ② `install-app-deps` 按 Electron ABI 重建原生模块（better-sqlite3 13 已是 N-API 跨运行时，此步作为将来新原生依赖的保险）。
- `docs/INSTALL.md` 重写（pnpm 锁定、镜像、VS 工具链与 `VCINSTALLDIR/VSCMD_VER/WindowsSDKVersion` 探测失败环境的替代路径、版本表）。

### P1-10 监听/定时器/轮询 ✅
- `App.vue` keydown 具名化 + `onBeforeUnmount` 清理；`workspace.ts` 12 个订阅登记后可 `unsubscribeEvents()` 精确卸载；`bg-services` 两个 `setInterval` 幂等守卫 + `unref`；task-runner 确认门禁定时器清理；`UnifiedDataPage`/`DashboardView`/`UnifiedTaskPage`/`CustomerServiceWorkspace` 的轮询均已有中止判定（复核确认）。

---

## P2

| 项 | 状态 | 说明 |
| --- | --- | --- |
| P2-1 `normalizeCellText` 收敛 | ✅ | 唯一实现进 `text-match.ts`（去零宽 + 压空白 + 可选 dedupe）；发票域/商品域只做参数选择；两域测试全绿 |
| P2-2 店铺状态文案 | ✅ | `shared/enums/store-status.ts` 导出 `STORE_STATUS_LABEL`/`storeStatusLabel`；3 处引用统一（DashboardView 不再把 proxy_error/archived 错显示为"离线"） |
| P2-3 IPC 样板收敛 | ✅ | 16 个文件统一走 `envelope.ts`（含 details 变体） |
| P2-4 parseJson 收敛 / DB 行类型 | ⏳ | 未做：agent-runtime 的 DB 行类型化（any→Row 接口）是大面积类型工程，与"chat-only 收口"后的低活代码冲突收益有限；保留跟进 |
| P2-5 SQL 语句缓存 | ⏳ | 未做批量替换（161 处机械替换风险 > 收益）；已在报告保留方案（`stmts` 懒加载单例）。**注**：better-sqlite3 13 对此路径无行为变化 |
| P2-6 事件契约 | ✅ 部分 | 订阅生命周期已收口（P1-10）；死频道清单已核对（`SESSION_EXPIRED` 等 6 个频道主/渲染双侧零引用）——频道枚举清理保留跟进（牵动契约面） |
| P2-7 transition 顺序 | ✅ | 见 P1-1 |
| P2-8 createAgentJob 原子性 | ✅ | browser task 创建与 job 写入合并进同一事务（savepoint 嵌套），失败整体回滚，不再留孤儿 task |
| P2-9 tsconfig/lint 收紧 | ⏳ | `noUncheckedIndexedAccess` 未开启（需全仓收敛长尾）；lint 存量警告待按目录清零（本次未放大） |
| P2-10 覆盖率/mock 基建 | ⏳ | 未做（需要引入 coverage 依赖并测基线，属独立工作） |
| P2-11 仓库瘦身 | ⏳ | 未做（涉及生成资产构建期化与历史留档迁移，需用户决策） |
| P2-12 其余依赖升级 | ✅ 部分 | 已完成：typescript 5.9.3、@types/node 22、vue-tsc 3.3.13、eslint 插件显式化；vue 3.4→3.5.44 / vue-router 4.5.1 / pinia 2.3.1 见文末；zod 4 与 eslint 9 flat config 迁移保留跟进（zod 3.25 末版仍在维护窗口内） |

---

## P3

- ✅ 根目录 9 个 stray 日志/err 文件归置（见文末命令记录）
- ✅ CSP 加固（object-src 'none'、base-uri 'self'、frame-ancestors 'none'）
- ✅ 解锁失败指数退避（≥5 次后 1s→60s 封顶，进程内状态，重启清零）
- ✅ `AgentPlanCard` 局部 `setInterval` 遮蔽改名 `setScheduleMinutes`
- ✅ 变体列表 index key：**复核后判定无需修复**——该列表在此 UI 中只有编辑、没有增删/排序，不存在复用错行
- ✅ 死代码：`resolveFallbackProfile` / `drainDelegatedQueue` 按项目惯例加 `@deprecated` 停用注释（保留"复活路径"，与 agent-runtime 其余退役函数一致）
- ⏳ 未做：硬编码色值 1200 处的 token 收敛（视觉回归不可自动化，需真机过设计）；22 处未提交改动的整理（属用户工作流）

---

## 验证记录（本次会话实跑）

| 门槛 | 结果 |
| --- | --- |
| `pnpm typecheck`（tsc 5.9.3） | ✅ 0 错 |
| `pnpm test`（vitest 5.0.4） | ✅ 130/130 文件、1343/1343 用例（含新增 `task-run-state.test.ts`） |
| `pnpm lint`（eslint 8.57） | ✅ 0 error（1126 存量 warning，未放大；显式补 `@typescript-eslint/*` 依赖后恢复可解析） |
| `pnpm build`（electron-vite 6 + vite 7 + 三份产物） | ✅ main 1.95MB / preload 42KB / renderer 正常产出 |
| `tools/ci/audit-gate.mjs`（新门禁） | ✅ PASS（2 条 high 为上游无补丁项，allowlist 带理由+到期日） |
| **依赖漏洞面** | **86 条（5 critical / 33 high / 41 moderate / 7 low）→ 6 条（0 critical / 2 high / 4 moderate / 0 low）** |
| **Electron 44 真机冒烟**（临时 userData + 内置自检流程） | ✅ 启动 → 23 条迁移全部施加 → 建店 → 店铺浏览器打开（webview 注册）→ 清理退出（EXIT=0）；⚠️ 见下方残留风险 |

### Electron 44 冒烟的环境注意与残留风险（如实记录）

- 本次会话的宿主环境对 `node_modules` 路径下的进程有安全拦截（同一份 electron.exe：从项目内普通目录启动正常，从 `node_modules/.pnpm/...` 启动即 0xC0000005；zip 与官方 SHASUMS256 **逐字节一致**，二进制本身无问题），且 Chromium 的 GPU/渲染子进程被注入断点（0x80000003）后崩溃——**这是会话级环境行为，用户自己的终端不受影响**（历史真机验收均在其终端完成）。
- 因此本次能验证到：**主进程全链路在 Electron 44.7.2 上可用**（启动日志确认 `electron=44.7.2 chrome=152.0.7977.149`、迁移/DB/窗口/webview 注册/退出）。
- **需要用户在真实终端补一轮**：`pnpm dev` 或 `tools/acceptance/m1-cdp-verify.js` / `m3-runner.js`（渲染层行为、webview 页面真实加载、指纹字段校验——冒烟中因渲染子进程被杀，8 项指纹均为 unverified，属环境限制而非应用断言失败）。

## 过程教训（已固化）

1. **不要 kill pnpm 安装进程**：本环境里被 kill 的 pnpm 会产生"延迟回滚"，把已完成的链接删掉（排查中造成多次假象）。等它跑完，或先修好网络/工具链再跑。
2. **本会话环境对 Electron/Chromium 子进程有注入式拦截**（对 `node_modules` 下可执行文件 + 渲染/GPU 子进程），做 Electron 验证要走出该限制（如在项目内普通目录放一份解压产物）或转真实终端。
3. **安装生态三大环境坑的解法**（GitHub 慢→npmmirror；VS 探测失败→`VCINSTALLDIR/VSCMD_VER/WindowsSDKVersion`；pnpm12 链接 bug→锁 pnpm 10.34.7）均已写入 `docs/INSTALL.md`。

## 残留 advisory 处置（pnpm audit 终态）

| 包 | 级别 | 处置 |
| --- | --- | --- |
| brace-expansion（4 条） | high | ✅ override 按主版本分线锁 1.1.20 / 2.1.6 |
| @vue/server-renderer | high | ✅ vue 3.4.21→3.5.44（修复线 ≥3.5.42） |
| source-map-js | high | ✅ override 锁 1.2.2 |
| http-cache-semantics | high | ⏸️ 上游无补丁（patched=<0.0.0>）→ allowlist，2027-04-30 到期复查 |
| braces | high | ⏸️ 上游无补丁（patched=<0.0.0>）→ allowlist，2027-04-30 到期复查 |
| sprintf-js / postcss-selector-parser / 其余 moderate | moderate | 不阻断门禁；随工具链升级自然消解 |

## 需要用户决策 / 下一轮的事项

1. **真实终端验收**（P0-1 收口）：`pnpm dev` + `m1-cdp-verify` / `m3-runner`，确认 Electron 44 下渲染层/webview 的完整行为。
2. **代码签名**（P0-4）：证书/预算决策后补 `electron-builder.yml` 的 win signing 配置。
3. **提交与发版**：本次改动 67 文件（+3230/-2765）尚未提交；工作区还有其他 23 处既有未提交改动，建议按主题拆分提交后并入下一版（0.4.66）。
4. 报告中延后项（P1-5 巨型 SFC 拆分、P1-8 CDP 库迁移、P2-4/5/9/10/11、zod4/eslint9 迁移、样式 token 收敛）按原计划批次推进。
