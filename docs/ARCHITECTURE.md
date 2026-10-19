# ShopPilot 当前架构（以此为准）

> **状态**：2026-10-19 按仓库实际代码逐项核对（Electron `44.7.2` / v0.4.75 工作区）。
> **权威性**：本文描述**当前实现事实**。凡是与本文冲突的内容——包括
> [`DEVELOPMENT_SPEC.md`](./DEVELOPMENT_SPEC.md) 的历史章节、[`AGENT_DEVELOPMENT_SPEC.md`](./AGENT_DEVELOPMENT_SPEC.md)、
> 各里程碑/验收记录与审查报告——**一律以本文为准**；历史文档原文保留，只为追溯当时的决策过程。
> 相关文档：[ACCEPTANCE_HOOKS.md](./ACCEPTANCE_HOOKS.md)（生产/验收构建的钩子门禁）、
> [RELEASE_SIGNING.md](./RELEASE_SIGNING.md)（代码签名配置）、[INSTALL.md](./INSTALL.md)（受限环境安装）、
> [README.md](../README.md)（上手与验收命令）。

---

## 1. 一句话架构

**Electron 三进程 + 一个"店铺 guest"**：主进程持有全部状态与原生能力（SQLite、Session、代理、任务引擎、
应用锁、更新）；preload 只暴露白名单 IPC；渲染层是一个**单屏 Vue 工作台**（无路由），
店铺页面以**真实的 DOM `<webview>`** 嵌在工作台内部，guest 由主进程按 token 校验后绑定。

```
┌───────────────────────────── 主进程（apps/desktop/src/main）─────────────────────────────┐
│ index.ts 启动：单实例互斥 → 建库/迁移 → 注册 IPC → createWindow → 任务调度/更新检查        │
│  browser/    窗口与标签、webview 注册/校验、Session 与代理、指纹、拾取、右键菜单、CDP       │
│  stores/     店铺 CRUD、分组、回收站           tasks/   任务引擎（串行）+ 调度 + 步骤执行   │
│  services/   日志/审计/应用锁/safeStorage/备份/诊断/密码框/验收门禁/记忆/AI/客服监控        │
│  ipc/        20 个 handler 模块，按域注册 ipcMain.handle                                    │
│  db/         database.ts（WAL/外键/连接）+ migrations.ts（版本化迁移）                      │
│  platform-adapters/ products/ sales-metrics/ orders/  平台档案与业务域                      │
└───────────┬──────────────────────────────────────────────────────────┬────────────────────┘
            │ ipcMain.handle / webContents.send                        │ 同一 Session（partition）
┌───────────▼───────────────────┐                       ┌──────────────▼────────────────────┐
│ preload（contextIsolation+    │                       │ 店铺 guest：主窗口 DOM <webview>   │
│ sandbox）：window.shopilot.*  │                       │ partition=persist:store_<id>       │
│ 25 个命名空间，白名单通道      │                       │ nodeIntegration=false，无 preload  │
└───────────┬───────────────────┘                       │ 远程平台页面（拼多多/抖店/…）      │
┌───────────▼───────────────────────────────────────────┴───────────────────────────────────┐
│ 渲染层：单屏工作台 App.vue（Vue 3 + Pinia；无 vue-router、无组件库）                        │
│  workbench / tasks / products / invite / customer-service / agent / stores               │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 技术栈实况（含"明确未采用"）

| 关注点 | 实际实现 | 说明 |
|---|---|---|
| 桌面壳 | Electron **44.7.2**（ABI 149） | 升级历史见 `docs/INSTALL.md`；本机 `node_modules/electron/dist` 直接复用（`electronDist`） |
| 前端 | Vue **3.5.44** + TypeScript **5.9.3** + Pinia | 状态集中在 `renderer/src/app`、`features/*/` 的 store 与组合式函数 |
| 路由 | **无 vue-router** | 单工作台屏幕：左侧栏切换 = Pinia 状态 + `v-if`（见 `renderer/src/main.ts` 顶部注释） |
| UI 组件库 | **无**（Element/AntD 等一律未采用） | 手写 CSS + CSS 变量主题；图标是 PNG 资源（`assets/generated/ui-icons`，2026-10-19 清理后保留 107 个 / 7.18 MB，删掉 137 个零引用文件、释放 36.05 MB） |
| 本地库 | better-sqlite3 **13.0.3**（N-API prebuilds，WAL + `foreign_keys=ON`） | 单库多表；迁移自研，不依赖外部迁移工具 |
| 校验 | Zod（IPC 入参、部分域 schema） | 契约集中在 `packages/shared/src/{contracts,enums,errors,schemas}` |
| 构建 | electron-vite **6.0.0** → electron-builder **26.15.3** | 见 §7 |
| 更新 | electron-updater **6.8.9** → GitHub Releases | stable/beta 双通道 |
| 单测 | Vitest（`tests/unit`、`tests/fixtures`） | 2026-10-19 最终实测 164 文件 / 1782 用例全绿（随测试门禁工作推进会变动，以当次输出为准） |
| 端到端 | **自研 CDP 驱动验收脚本**（`tools/acceptance/**`，Node + WebSocket 直连 CDP） | 打包产物优先，`SHOPILOT_ACCEPTANCE_SOURCE=1` 可切源码 Electron |
| Playwright | **仅用于设计/截图脚本**（`design/**`、`tools/ui/**` 的 `playwright` 截图用例） | **不参与**验收套件，也不进 CI/发布门槛 |
| 日志 | 自研 `main/services/logger`（按天文件、14 天保留、统一脱敏） | **未使用 pino** |
| 密钥 | Electron `safeStorage`（Windows DPAPI）；导出包 scrypt + AES-256-GCM | API Key、代理认证口令等 |

> 未采用的还有：Tauri + WebView2（评估结论是继续用 Electron，见 `DEVELOPMENT_SPEC.md` §2.1 末尾）、
> 组件库主题方案、`WebContentsView` 原生嵌入（见 §3.4）。

---

## 3. 进程与窗口模型

### 3.1 主进程（`apps/desktop/src/main`）

启动顺序（`index.ts`）：单实例锁 → 初始化 DB 与迁移 → 注册 IPC → `createWindow()` →
恢复窗口/应用锁状态 → 任务调度与更新检查 → 注册退出清理。

职责边界：**所有特权操作只在主进程**——文件系统、SQLite、Session/代理、指纹注入、受信任输入、
任务引擎、备份/诊断/审计、更新。渲染层拿不到 Node 能力。

### 3.2 preload（`apps/desktop/src/preload/index.ts`）

- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`（主窗口 `webPreferences`）。
- 只经 `contextBridge.exposeInMainWorld('shopilot', api)` 暴露白名单方法，**25 个命名空间**：
  `store / browser / bookmark / download / profile / overview / settings / audit / diagnostics /
  maintenance / extensions / proxy / session / products / salesMetrics / security / backup /
  invite / task / agent / snapshot / customerService / windowChrome / update / ai`。
- 通道字符串与请求/响应形状来自 `@shared/contracts/ipc`（类型化 `invoke`，见 §4）。

### 3.3 渲染层（`apps/desktop/src/renderer`）

- 入口 `src/main.ts`：`createApp(App)` + Pinia，**不做路由跳转**。
- `src/app/App.vue`：应用壳（三栏布局、应用锁覆盖层、标题栏 overlay 同步）。
- `src/features/`：`workbench`（仪表盘/店铺/数据/设置/任务/图像工作室等页面）、
  `tasks`（自定义任务编辑器）、`products`、`invite`、`customer-service`、`agent`（抽屉/浮球/消息）、
  `stores`（`store-group.ts` 分组纯逻辑）。
- CSP（`src/renderer/index.html`）：`default-src 'self'`，`script-src 'self'`，
  `img-src 'self' data: blob: shopilot-media:`，`object-src 'none'`，`base-uri 'self'`。

### 3.4 店铺页面 = 主窗口 DOM 里的真实 `<webview>`

**这是本仓库最重要的一条架构事实**（2026-09-28 / v0.4.50 起，详见 `docs/STATUS_REPORT.md` 与
`tests/unit/webview-embedding-boundary.test.ts`）：

- 旧实现把店铺页画在主窗口 `BrowserWindow.contentView` 的原生 `WebContentsView` 上，渲染层只有一块
  透明占位 div。后果：HTML 弹层/抽屉/右键菜单**永远盖不住**店铺页，只能靠摘挂原生视图"避让"，
  页面尺寸/圆角/`overflow` 也不受 DOM 约束。
- 现实现：每个 store/tab 一个 `<webview>` 元素，`partition="persist:store_<storeId>"`，
  初始 `src=about:blank`；`did-attach` 后渲染层调 `browser:registerWebview`，主进程校验并绑定 guest，
  再用返回的 `pendingUrl` 做首次导航（此时 Session/代理/指纹已就绪）。
- 主进程的 `Tab` 句柄 = **已注册的 guest WebContents**；`getTabWebContents` / `captureTab` /
  `pickElement` / 导航控制 / Agent 可读性 / 任务引擎全部走 guest。
- 可见性由渲染层 CSS 控制：隐藏用 `opacity:0 + pointer-events:none`，
  **不用** `display:none` / `visibility:hidden`（后者会让 guest 自认不可见，微应用与后台页面停止渲染）。

**guest 安全收口**（`main/index.ts` 的 `will-attach-webview`，`test/unit` 有边界断言）：

| 项 | 处置 |
|---|---|
| `preload` | 无论校验是否通过，逐次 `delete params.preload / webPreferences.preload`（远程页拿不到工作台 bridge） |
| `nodeIntegration` | 强制 `false` |
| `contextIsolation` | 强制 `true` |
| `sandbox` | 强制 `true` |
| `webviewTag` | guest 内强制 `false`（不允许嵌套 webview） |
| `backgroundThrottling` | 默认 `true`；仅客服页面显式 `false`（切回工作台仍要收平台消息） |
| partition | 只放行真实店铺自己的 `persist:store_<id>`（且店铺必须存在） |
| 初始地址 | 只放行非 `file:` / `javascript:` 的合法地址；非法附件 `preventDefault()` 并写脱敏日志 |

**就绪语义**：新增 `BROWSER_NOT_READY`（标签还在、guest 未注册/正在重载）——页面工具等待或如实失败，
不假装成功。

**弹层与拾取**：HTML 弹层现在靠 CSS 层级盖在 webview 上即可（不再摘挂页面）；
「拾取元素」期间对话框切到 picker 布局（弹窗右移、遮罩透明且 `pointer-events:none`），
把左侧视口让给真实页面，吞点击的透明遮罩与提示语注入 guest 页面内部
（见 `main/browser/element-picker.ts`）。

---

## 4. IPC 契约

- **单一事实来源**：`packages/shared/src/contracts/ipc.ts`（约 36 KB；`IPC_CHANNELS` / `EVENT_CHANNELS`
  + `IpcContract` 请求/响应类型 + `createIpcInvoker`；域:动作 形通道字面量约 291 个）。
- **消费方式**：main 侧 `ipc/*-handlers.ts`（20 个模块）用 `ipcMain.handle` 注册；preload 侧
  `invoke()` 走契约类型；渲染层 `window.shopilot.<域>.<方法>`。
- **统一信封**：`IPCResult`（`{ ok: true, data }` / `{ ok: false, error }`）+ 错误码表
  （`packages/shared/src/errors`），渲染层不解析原生异常。
- **Zod 校验**：入参在主进程 handler 内 `safeParse`，非法输入直接拒绝，不进入业务逻辑。
- **事件**：主 → 渲染的推送走 `EVENT_CHANNELS`（如 `browser:display-changed`、`session:expired`、
  `security:locked`）。
- **门禁**：应用锁生效时 IPC 层拒绝特权通道；所有特权动作写审计日志。

> **workspace / `@shared` 消费方式（2026-10-19 实测）**：`packages/shared/src` 下的文件被主/预加载/渲染
> **三端同源消费**，走的是 `@shared` 别名指向源码（`electron.vite.config.ts` 三份 alias + `tsconfig.json` paths）。
> 注意 `packages/shared/` **确实有** `package.json`（`@shopilot/shared`，0.1.0），但：
> ① 根 `package.json` **没有依赖它**，安装后 `node_modules/@shopilot` 不存在（无 workspace 链接）；
> ② 全仓库 **0 处**按包名 `@shopilot/shared` 导入；③ `apps/*` 下没有任何 `package.json`。
> 因此本仓库实际按**单包**工作：`pnpm-workspace.yaml` 的 `packages:` 当前不产生链接，其用途只剩
> `allowBuilds` 与 `publicHoistPattern`。新增依赖/脚本请改根 `package.json`，
> 详见 `pnpm-workspace.yaml` 顶部的单包形态说明。

---

## 5. 数据层（SQLite）

- 单库 `%APPDATA%\shopilot\shopilot.db`（WAL）；数据目录还有 `stores/`（Session 存储）、`backups/`、`logs/`。
- 迁移：`apps/desktop/src/main/db/migrations.ts`，自研版本化迁移（`schema_migrations` 表）。
  **实测**：本机库已应用 **34** 个迁移版本；源码声明 **63 张表**（62 张普通表 + 1 张 FTS5 虚拟表
  `agent_memory_fts`），FTS5 另有 5 张影子表，故 `sqlite_master` 实际 68 行。
  分组概览：店铺/浏览器（`stores`、`tabs`、`browser_profiles`、`bookmarks`、`downloads`、`store_snapshots`）、
  网络（`proxies`、`proxy_checks`、`store_proxies`）、任务（`tasks`、`task_steps`、`task_runs`、`task_step_results`）、
  商品（`products`、`product_*`）、订单/售后、销售数据、发票/涉税、达人邀约（`invite_*`、`creator_profiles`）、
  客服（`customer_message_checks`）、Agent（`agent_*`）、平台治理（`app_settings`、`audit_logs`、`backups`）。
- 备份：Online Backup API + 校验 + 失败回滚；会话导出包为 scrypt + AES-256-GCM。

---

## 6. 目录结构（实际）

```
├── apps/desktop/
│   ├── src/main/          # 主进程：browser/ db/ ipc/ stores/ tasks/ services/ products/
│   │                      #   sales-metrics/ orders/ platform-adapters/
│   ├── src/preload/       # 白名单 API（contextIsolation + sandbox）
│   ├── src/renderer/      # 单屏 Vue 工作台：app/ components/ features/ assets/
│   ├── resources/         # 随包资源（窗口图标、pw-dialog preload 等）
│   └── out/               # electron-vite 产物：main/ preload/ renderer/（不入 git）
├── packages/shared/src/   # IPC 契约、枚举、错误码、Zod schema、平台档案与步骤常量（三端同源）
├── tests/                 # unit/ 纯逻辑单测（vitest）+ fixtures/
├── tools/
│   ├── acceptance/        # CDP/真机验收脚本 + build-acceptance.mjs + run-acceptance.ps1
│   ├── release/           # release-manifest.js、publish-release.js、update-runner.js、after-pack.js
│   ├── ci/                # 打包态原生模块 smoke 等 CI 检查
│   ├── ui/                # UI/窗口/几何探针与截图（Playwright 只在这里用）
│   ├── maintenance/       # make-icon.js、postinstall-native.mjs 等维护脚本
│   └── research/          # 页面锚点/结构探针（只读研究用）
├── wx-invite-test/        # 平台真机探针与静态实测留档
├── docs/                  # 规范、状态、验收与审查文档（本文件为架构基准）
├── assets/design/         # 设计稿与设计期捕获脚本
├── build/                 # electron-builder 构建资源（icon.ico 等）
├── logs/ artifacts/ release/   # 本地日志、临时产物、打包产物（均不入 git）
└── package.json           # 唯一的真实包（见 pnpm-workspace.yaml 单包说明）
```

---

## 7. 构建链

| 命令 | 作用 | 产物 |
|---|---|---|
| `pnpm dev` | electron-vite 开发态（HMR） | 内存 + `apps/desktop/out` |
| `pnpm build` | `electron-vite build` | `apps/desktop/out/{main,preload,renderer}` |
| `pnpm dist` | 生产构建：`electron-vite build` + `electron-builder --win --x64` | `release/`（NSIS + latest.yml） |
| `pnpm run dist:acceptance` | **验收构建**（构建期 `SHOPILOT_BUILD_ACCEPTANCE=1`） | 同上，但保留测试钩子 |
| `node tools/acceptance/build-acceptance.mjs --dir` | 快速验收构建，只出 `release/win-unpacked` | 供 CDP 套件使用 |

`electron.vite.config.ts` 三份配置（main / preload / renderer）：`@shared` → `packages/shared/src`，
renderer 额外 `@` → `renderer/src`；`webview` 声明为自定义元素（否则 Vue 会把它当未注册组件）；
main 侧对 `electron-updater` 例外内联（pnpm 扁平化会漏它的叶子依赖，asar 内会 `MODULE_NOT_FOUND`）。

`electron-builder.yml` 要点：`asar: true`、`electronDist: node_modules/electron/dist`（离线构建）、
`extraResources` 放窗口图标、`asarUnpack` 声明解出原生模块（实测只有 better-sqlite3 会落到
`app.asar.unpacked`；`bindings` / `file-uri-to-path` 两条规则保留，但当前依赖树里并不存在这两个包）、
`win.target = nsis(x64)`、`nsis` 按用户安装/可选目录/桌面与开始菜单快捷方式、`publish = github`。
构建期瘦身项：`electronLanguages`（只留 zh-CN/en-US）、`compression: maximum`、
`files` 排除 better-sqlite3 的 `deps/**` 与非 win32-x64 的 prebuilds、`afterPack: tools/release/after-pack.js`
（删 `LICENSES.chromium.html`）、`win.forceCodeSigning: false`（未配置证书时明确声明，不静默失败）。

**2026-10-19 实测（`pnpm build` + `electron-builder --win --x64 --dir`，生产口径）**：

| 指标 | 瘦身前 | 瘦身后 | 变化 |
|---|---|---|---|
| `release/win-unpacked` 总量 | 413.77 MB / 152 文件 | **321.64 MB / 81 文件** | **−92.13 MB（−22.3%）** |
| `locales/` | 55 文件 / 48.3 MB | 2 文件 / 1.12 MB（zh-CN.pak、en-US.pak） | −47.17 MB |
| `LICENSES.chromium.html` | 19.53 MB | 不存在（afterPack 删除） | −19.53 MB |
| better-sqlite3 非 win32-x64 prebuilds | 7 个 / 14.22 MB | 不存在 | −14.22 MB |
| better-sqlite3 `deps/`（含 sqlite3.c 9.08 MB） | 9.78 MB | 不存在 | −9.78 MB |
| `resources/app.asar.unpacked` | 76 文件 / 26.1 MB | 59 文件 / 2.06 MB | −24.04 MB |
| `resources/app.asar` | 20.1 MB | 18.65 MB | −1.45 MB（随源码变化） |

保留并验证：`prebuilds/win32-x64.node` 仍在 `app.asar.unpacked` 内，
`ELECTRON_RUN_AS_NODE=1 electron.exe tools/ci/packaged-native-smoke.js release/win-unpacked`
输出"打包态 better-sqlite3 装载成功（ABI=149），SQL 读写正常"、exit 0。
未配置证书时 `ShopPilot.exe` 为 `NotSigned`（`forceCodeSigning: false`，符合 `INTERNAL_BUILD` 预期）。
NSIS 安装包实测（2026-10-19，`electron-builder --win --x64` 输出到临时目录，未覆盖 `release/`）：
**109.89 MB**（瘦身前 0.4.75 基线 135.24 MB，−25.35 MB / −18.7%）；该数字与 `compression: maximum`、
locale/原生模块裁剪共同生效，`--dir` 目录体积见上表。

---

## 8. 生产构建 vs 验收构建（必读）

| 命令 | 产物 | 测试钩子 | 用途 |
|---|---|---|---|
| `pnpm dist` | `release/`（NSIS + latest.yml） | **关闭**（打包态下运行期环境变量无效） | 发布给用户 / 自动更新 |
| `pnpm run dist:acceptance` | `release/`（NSIS + latest.yml） | 保留，运行期仍需显式 `SHOPILOT_ACCEPTANCE=1` | 全部验收套件 |
| `node tools/acceptance/build-acceptance.mjs --dir` | 仅 `release/win-unpacked/` | 保留 | 只跑 CDP 套件的快速构建 |

- 门禁由构建期常量 `__SHOPILOT_ACCEPTANCE_BUILD__`（`electron.vite.config.ts` define）+
  运行期 `SHOPILOT_ACCEPTANCE=1` 共同决定，纯规则在 `packages/shared/src/acceptance-gate.ts`。
- **验收构建带测试钩子，只允许本机验收使用，禁止外发或作为发布资产上传。**
- 未配置代码签名证书时产物为 `INTERNAL_BUILD`；签名配置就绪说明见
  [RELEASE_SIGNING.md](./RELEASE_SIGNING.md)，钩子门禁细节见 [ACCEPTANCE_HOOKS.md](./ACCEPTANCE_HOOKS.md)。

---

## 9. 测试与验收链

```powershell
pnpm.cmd exec vitest run      # 单测（2026-10-19 最终实测 164 文件 / 1782 用例全绿）
pnpm.cmd exec tsc --noEmit    # 类型门禁（另有 vue-tsc 与 eslint）
pnpm.cmd run test:custom-local        # 自定义任务本地 CDP 验收（合成事件）
pnpm.cmd run test:custom-realclick    # 真机 SendInput 验收（真实桌面输入）
node tools/acceptance/m1-runner.js    # 工作台（标签/隔离/弹层/webview 注册）
node tools/acceptance/m2-runner.js stage1|stage2   # 代理备份 / 指纹注入
node tools/acceptance/m3-runner.js    # 任务引擎
node tools/acceptance/sec-runner.js   # 安全能力
node tools/acceptance/*-cdp-verify.js # 设置中心/扩展/标签批量关闭/渲染入口/商品等
node tools/acceptance/m4-runner.js    # 发布工程（含 NSIS 安装/升级/卸载）
pwsh -File tools/acceptance/run-acceptance.ps1     # 串行跑全套 + 打包 + 清单
```

约定：各套件使用独立临时 `userData` 与 CDP 端口（脚本内 `*_PORT` / `SHOPILOT_*_PORT` 常量，
可用环境变量覆盖）；跑前退出运行中的实例；CDP 套件默认针对 `release/win-unpacked`
（`SHOPILOT_ACCEPTANCE_SOURCE=1` 切源码 Electron）。真实平台登录与真实副作用仍靠真机人工验收，
验收脚本不替代它。

---

## 10. 发布链

1. `pnpm release:full` = `typecheck` → `lint` → `test` → `dist` → `release-manifest` → `publish-release`；
2. `tools/release/release-manifest.js` 生成 `release/release.json`（版本 + 各产物 SHA-256）；
3. `tools/release/publish-release.js` 幂等创建/复用 GitHub Release（`Amike-cc/ShopPilot`），上传
   安装包 + blockmap + `latest.yml`/`beta.yml`；
4. 客户端 `electron-updater` 双通道（正式版/预发布版）检查更新 → 下载 → SHA-512 校验 → 重启安装；
   检查/下载/安装均写审计日志，启动自动检查默认关闭。

`release/` 与安装包**不入 git**：GitHub 单文件 100 MB 上限 + 二进制会让仓库历史永久膨胀；
每个版本的 EXE 以 Release 资产形式长期可下载。

---

## 11. 不变量（改动前务必确认）

- 店铺隔离：一店一 `persist:store_<id>`，跨店 Cookie/localStorage/缓存/下载互不可见；guest 无 Node、无 preload。
- 页面可见性：隐藏只用 `opacity` + `pointer-events`，**不要**用 `display:none`。
- 自动化边界：钓鱼式副作用（提交/发布/付款/删除/发送）必须有人工确认门禁；不可用时不自动降级。
- 任务引擎全局串行（并发 = 1）；副作用步骤失败不可自动重试。
- 打包阈值：安装包接近 100 MB 时必须先做体积治理（本次已做，见 §7 瘦身项）。
- 生产构建不得带验收钩子（发布前按 `ACCEPTANCE_HOOKS.md` §4 自检）。
