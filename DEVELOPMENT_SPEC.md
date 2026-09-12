# ShopPilot 开发设计文档

> 版本：v0.2（审查修订，审查报告见 [REVIEW.md](./REVIEW.md)）  
> 状态：开发基线  
> 关联设计图：[shopilot-ui-concept-v1.png](./shopilot-ui-concept-v1.png)  
> 关联功能规格：[FUNCTIONAL_SPEC.md](./FUNCTIONAL_SPEC.md)

## 1. 开发目标

ShopPilot 是 Windows 优先的桌面电商浏览器工作台。开发目标是让用户在一个应用中管理多个店铺，每个店铺拥有互相隔离的浏览器会话、标签页、网络配置和本地数据。

第一阶段只做单机应用和人工确认的操作辅助：

- 店铺之间的 Cookie、缓存、LocalStorage、标签页和代理互不串用。
- 用户可以从左侧店铺列表切换工作区。
- 用户可以在中央浏览器中完成真实网页操作。
- 右侧面板提供环境诊断、会话状态和清理入口。
- 自动化只执行读取、导航、截图和草稿填充；提交、发布、付款、删除、发送消息等动作必须由用户确认。

## 2. 技术选型

### 2.1 推荐技术栈

- 桌面壳：Electron，固定一个经过验证的稳定版本。
- 前端：Vue 3、TypeScript、Pinia、Vue Router。
- UI：CSS 变量 + 组件库，优先复用设计图中的深色主题、10px 圆角和蓝色主色。
- 浏览器内核：Electron Chromium；每个店铺使用独立的 persistent session partition。
- 本地数据库：SQLite + better-sqlite3。
- 数据校验：Zod，共享 IPC 输入和输出类型。
- 测试：Vitest、Playwright、Electron E2E。
- 打包：electron-builder，Windows NSIS 安装包。
- 日志：pino，敏感字段统一脱敏。
- 密钥保护：Electron safeStorage（Windows DPAPI），导出文件使用 AES-256-GCM 加密。

选择 Electron 是因为它可以直接管理 Chromium 多会话、持久化分区、下载和页面事件，适合先完成可验证的 Windows MVP。若后续对安装体积和系统资源有更高要求，再评估迁移到 Tauri + WebView2。

### 2.2 系统架构

~~~mermaid
flowchart LR
    UI[Vue Renderer<br/>店铺列表/浏览器/环境面板] --> IPC[安全 IPC 层]
    IPC --> MAIN[Electron Main]
    MAIN --> STORE[Store Manager]
    MAIN --> BROWSER[Browser Session Manager]
    MAIN --> TASK[Task Runner + Scheduler]
    MAIN --> NET[Proxy Manager]
    MAIN --> SEC[SecurityManager]
    MAIN --> DB[(SQLite)]
    MAIN --> FS[Profile/Download/Backup Files]
    BROWSER --> CHROMIUM[Chromium WebContentsView]
    TASK --> BROWSER
    TASK --> ADAPTER[Platform Adapter]
    NET --> BROWSER
    SEC --> DB
    SEC --> FS
~~~

## 3. 代码仓库结构

~~~text
shopilot/
  apps/
    desktop/
      src/
        main/
          index.ts
          ipc/
          browser/
          stores/
          tasks/
          network/
          security/
          backup/
          diagnostics/
        preload/
          index.ts
          channels.ts
        renderer/
          app/
          components/
          features/
            stores/          # 店铺业务域（勿与 Pinia 状态目录混淆）
            browser/
            environment/
            overview/
            tasks/
            settings/
          router/
          state/             # Pinia 全局状态
          styles/
      electron-builder.yml
  packages/
    shared/
      src/
        contracts/
        enums/
        schemas/
        errors/
  data/
    migrations/
  tests/
    unit/
    integration/
    e2e/
  docs/
    FUNCTIONAL_SPEC.md
    DEVELOPMENT_SPEC.md
~~~

## 4. 模块边界

### 4.1 Renderer

只负责界面和用户交互：

- 店铺列表、概览卡片、浏览器工具栏、环境面板。
- 展示任务进度和人工确认条。
- 通过 preload 暴露的白名单 API 调用主进程。
- 不接触文件系统、数据库、代理密码和 Chromium session 对象。

### 4.2 Main

负责所有高权限和可持久化操作：

- 创建和销毁店铺浏览器会话。
- 管理 BrowserWindow、WebContentsView 和标签页。
- 读取/写入 SQLite。
- 配置代理、下载、备份、恢复和日志。
- 校验 IPC 请求，执行权限检查和人工确认门禁。

### 4.3 BrowserSessionManager

每个店铺使用唯一 partition：

    persist:store_<storeId>

要求：

- storeId 只能由主进程生成，禁止 Renderer 自行拼接 partition。
- 一个店铺的所有标签页共享该店铺 session。
- 不同店铺不得复用同一个 partition。
- 代理必须在首次导航前设置。
- 店铺关闭时保存标签页 URL、标题、固定状态和排序。
- Browser 崩溃后只恢复当前店铺，不影响其他店铺。

环境配置采用“稳定、可追踪、一店铺一配置”的策略。MVP 只开放在目标 Chromium 版本上经过验证的字段：User-Agent、语言、时区、屏幕尺寸、颜色深度、硬件并发数和 WebGL 展示信息。配置保存时生成版本号和摘要，启动时校验实际值；无法验证的字段显示为“未验证”，不在界面上伪造健康度。

不允许每次启动随机变更环境，也不允许把操作系统、语言、时区和屏幕参数组合成明显矛盾的值。高级环境字段必须经过独立测试后才能进入产品，不以“绕过平台检测”作为功能承诺。

字段实现机制约定（每个字段必须能落到具体机制，落不到的不进 MVP）：

| 字段 | 实现方式 | 约束 |
| --- | --- | --- |
| User-Agent | `session.setUserAgent` | 必须与 UA-CH Client Hints（`sec-ch-ua*`）成对覆盖，禁止只改 UA 造成自相矛盾 |
| 语言 | `session.setLanguage` / accept-languages | 启动校验时与 `navigator.language` 比对 |
| 时区 | CDP `Emulation` 域（经 `webContents.debugger`） | attach 范围仅限本应用创建的 WebContents |
| 屏幕尺寸 | 窗口尺寸 + CDP 度量覆盖 | 不伪造与真实显示矛盾的 devicePixelRatio 组合 |
| 颜色深度、硬件并发数 | 主世界脚本注入覆盖 `navigator`/`screen` 只读属性 | 注入脚本不暴露任何 Electron/IPC 句柄，与 §10.1 边界一致 |
| WebGL 展示信息 | CDP 或受控注入 | 未经 M0 验证前该字段在界面标记为“未验证” |

CDP attach 与脚本注入属于受控运行时行为：目标仅限本应用创建的 WebContents，不向任意页面开放，不加载第三方扩展。任一字段无法在目标 Chromium 版本稳定实现时，从白名单移除并如实显示“未验证”，不得伪造。

代理认证注入：Chromium 的 `proxyRules` 不接受内嵌 `user:pass` 凭据；代理 407 认证通过监听 `login` 事件在运行时注入，凭据由 Main 从 safeStorage 取出，不回传 Renderer。HTTPS 型代理协议在 Electron 中支持较新，必须在 M0 验证后才对外提供。

### 4.4 TaskRunner

任务只能由预定义步骤组成，不接受来自网页或 Renderer 的任意代码：

- navigate
- waitForPage
- waitForSelector
- readText
- readTable
- screenshot
- fillDraft
- waitForUserConfirmation
- click（按 CSS 选择器点击；禁用态目标报 `TASK_TARGET_DISABLED`，不静默忽略）
- clickByText（按元素自身文本点击；第三方平台页面无稳定选择器时的兜底，取文本最短命中项）
- clickAll（批量点击并**跳过禁用项**，上限 ≤40；用于"勾选可邀约达人"这类平台有限制的批量操作）
- setInput（写输入框/文本域并按受控组件方式派发 `input`/`change` 事件）

后四类对页面有副作用：一律进 `NON_RESUMABLE_TYPES`（不可"从失败恢复"重试，避免重复点击/重复提交），
参数仍是 Zod `.strict()` 白名单（只有选择器与文本，无任何代码入口），实现为**固定注入脚本 + `JSON.stringify` 引用的已校验参数**。
承载"提交"语义的步骤（如点「确认发送」）必须在其前一步放置 `waitForUserConfirmation`：用户拒绝 → run 置 `cancelled` 且**后续步骤一律不执行**。
每一步有超时、重试次数、目标 URL、输入摘要和结果。除上述"人工确认门禁"外，提交类动作不作为无人值守步骤提供。

副作用步骤的 payload 只存摘要（选择器、点击数量、跳过数量、文本长度），**不存写入的原文**（§4.5）。

步骤的结构化结果（读取文本、表格、截图）写入 task_step_results（§5.10）：payload 入 SQLite，截图文件按店铺存放于受控工件目录，数据库只记录路径与 SHA-256。汇总指标（未读消息数、待处理订单数、低库存等）写入 store_snapshots（§5.11）供概览页与店铺卡片聚合。

定时任务由 Main 内的 Scheduler（`main/tasks/`）触发：解析 `tasks.schedule_json`，到点为任务创建 task_run 并进入 queued。调度触发与手动触发共享同一人工确认门禁；调度器本身不接触页面。计划触发时若目标店铺浏览器未运行，任务保持 queued 并提示用户，不静默拉起店铺浏览器。

### 4.5 SecurityManager

- 使用 safeStorage 保护数据库加密密钥。
- 代理密码、导出会话密码引用和主密码校验信息不得明文落盘。
- 日志自动过滤 Cookie、Authorization、Set-Cookie、代理密码和页面表单值。
- 应用锁定时销毁敏感内存引用，恢复前要求重新解锁。

## 5. 数据模型

全局要求：所有库启用 `PRAGMA foreign_keys=ON` 与 WAL；子表外键列（store_id、task_id、run_id、proxy_id、backup 引用）必须声明 REFERENCES 并建立索引；枚举取值统一引用 `packages/shared/enums`，禁止在业务代码里散落字符串。

### 5.1 stores

~~~text
id                  TEXT PRIMARY KEY
name                TEXT NOT NULL
platform            TEXT NOT NULL
admin_url           TEXT NOT NULL
status              TEXT NOT NULL
avatar_color        TEXT NOT NULL
sort_order          INTEGER NOT NULL
group_name          TEXT
external_code       TEXT
owner               TEXT
region              TEXT
tags_json           TEXT NOT NULL
notes               TEXT
last_active_at      INTEGER
created_at          INTEGER NOT NULL
updated_at          INTEGER NOT NULL
deleted_at          INTEGER
~~~

status 取值集合（incomplete/offline/launching/online/needs_login/proxy_error/archived）以 `shared/enums` 为唯一来源。avatar_color 由主进程从固定色板按 storeId 哈希分配，用户可覆盖。sort_order/group_name 支撑拖拽排序与分组；external_code/owner/region 对应向导步骤一的可选字段。

### 5.2 browser_profiles

~~~text
id                  TEXT PRIMARY KEY
store_id            TEXT UNIQUE NOT NULL
name                TEXT NOT NULL
browser_version     TEXT NOT NULL
os_display          TEXT NOT NULL
user_agent          TEXT NOT NULL
ua_client_hints_json TEXT
language            TEXT NOT NULL
timezone            TEXT NOT NULL
screen_width        INTEGER NOT NULL
screen_height       INTEGER NOT NULL
color_depth         INTEGER
hardware_concurrency INTEGER
webgl_vendor        TEXT
webgl_renderer      TEXT
profile_partition   TEXT UNIQUE NOT NULL
config_version      INTEGER NOT NULL
config_digest       TEXT NOT NULL
profile_schema_version INTEGER NOT NULL
locked              INTEGER NOT NULL
created_at          INTEGER NOT NULL
updated_at          INTEGER NOT NULL
~~~

列集合与 §4.3 的 MVP 字段白名单一一对应。配置修改必须递增 config_version 并重算 config_digest，并提示可能需要重新登录。locked=1（“锁定环境”）时，任务、快捷键和 Renderer 一律不得修改该店铺环境配置，只有显式解锁后可改。profile_schema_version 支撑 §20 的 profile 目录迁移。

### 5.3 proxies

~~~text
id                  TEXT PRIMARY KEY
type                TEXT NOT NULL
host                TEXT NOT NULL
port                INTEGER NOT NULL
username_ref        TEXT
password_ref        TEXT
label               TEXT
tags_json           TEXT NOT NULL DEFAULT '[]'
expires_at          INTEGER
status              TEXT NOT NULL
last_ip             TEXT
last_latency_ms     INTEGER
last_checked_at     INTEGER
created_at          INTEGER NOT NULL
updated_at          INTEGER NOT NULL
~~~

username_ref 和 password_ref 只保存 safeStorage 的引用，不保存明文凭据。运行时凭据经 `login` 事件注入（§4.3）。

### 5.3.1 proxy_checks

~~~text
id                  TEXT PRIMARY KEY
proxy_id            TEXT NOT NULL REFERENCES proxies(id)
ok                  INTEGER NOT NULL
http_status         INTEGER
latency_ms          INTEGER
exit_ip             TEXT
geo_country         TEXT
error_code          TEXT
checked_at          INTEGER NOT NULL
~~~

支撑 `proxy:history` 查询与“最近 20 次检查结果”展示：每代理默认保留最近 100 条，超出滚动清理。

### 5.4 store_proxies

~~~text
store_id            TEXT PRIMARY KEY
proxy_id            TEXT
mode                TEXT NOT NULL
updated_at          INTEGER NOT NULL
~~~

mode 为 direct 或 bound。

### 5.5 tabs

~~~text
id                  TEXT PRIMARY KEY
store_id            TEXT NOT NULL
url                 TEXT NOT NULL
title               TEXT
is_pinned           INTEGER NOT NULL
order_index         INTEGER NOT NULL
last_active_at      INTEGER
created_at          INTEGER NOT NULL
updated_at          INTEGER NOT NULL
~~~

### 5.6 tasks、task_steps、task_runs

~~~text
tasks:
  id, name, store_scope, status, schedule_json, created_at, updated_at

task_steps:
  id, task_id, step_index, type, input_json, timeout_ms, retry_limit

task_runs:
  id, task_id, store_id, status, current_step, started_at,
  finished_at, error_code, error_message
~~~

输入 JSON 必须经过 Zod schema 校验。日志中只记录输入摘要，不记录完整表单值和会话数据。

### 5.7 audit_logs、backups、app_settings

~~~text
audit_logs:
  id, actor, store_id, action, result, request_id, created_at

backups:
  id, file_path, sha256, size_bytes, created_at, restore_status

app_settings:
  key PRIMARY KEY, value_json, updated_at
~~~

### 5.8 bookmarks

~~~text
id                  TEXT PRIMARY KEY
store_id            TEXT              -- 空表示全局书签
title               TEXT NOT NULL
url                 TEXT NOT NULL
order_index         INTEGER NOT NULL
source              TEXT NOT NULL     -- manual | entry_route
created_at          INTEGER NOT NULL
~~~

source=entry_route 的行是平台适配器 `getEntryRoutes()` 的缓存展示，不重复入库。

### 5.9 downloads

~~~text
id                  TEXT PRIMARY KEY
store_id            TEXT NOT NULL REFERENCES stores(id)
page_url            TEXT
file_name           TEXT NOT NULL
file_path           TEXT NOT NULL
size_bytes          INTEGER
state               TEXT NOT NULL     -- in_progress|completed|interrupted|cancelled
created_at          INTEGER NOT NULL
completed_at        INTEGER
~~~

file_name 落库时加店铺前缀（重名追加序号），文件写入该店铺隔离下载目录（§27）。“清理下载记录”即按 store_id 清理本表，是否同时删除磁盘文件必须由用户在确认条中选择。

### 5.10 task_step_results

~~~text
id                  TEXT PRIMARY KEY
run_id              TEXT NOT NULL REFERENCES task_runs(id)
step_index          INTEGER NOT NULL
kind                TEXT NOT NULL     -- text|table|screenshot
payload_json        TEXT              -- text/table 的结构化结果；截图为空
artifact_path       TEXT              -- 截图等文件按店铺存放于受控工件目录
artifact_sha256     TEXT
created_at          INTEGER NOT NULL
~~~

日志与诊断包只引用本表 ID 与摘要，不复制 payload 内容。

### 5.11 store_snapshots

~~~text
id                  TEXT PRIMARY KEY
store_id            TEXT NOT NULL REFERENCES stores(id)
metric              TEXT NOT NULL     -- unread_messages|pending_orders|low_stock|...
value_json          TEXT NOT NULL
source_run_id       TEXT
captured_at         INTEGER NOT NULL
~~~

概览页与店铺卡片的指标（未读消息数、待处理任务数、低库存等）由本表与 task_runs 聚合得出；界面必须同时显示 captured_at 推算的新鲜度，指标过期不得显示为当前值。

## 6. IPC 接口

所有调用统一返回：

~~~text
{ ok: true, data: T, requestId: string }
{ ok: false, error: { code, message, details? }, requestId: string }
~~~

### 6.1 店铺

~~~text
store:list
store:get              { storeId }
store:create           { name, platform, adminUrl, tags, notes }
store:update           { storeId, patch }
store:archive          { storeId }
store:restore          { storeId }
store:deletePermanent  { storeId }
store:reorder          { orderedStoreIds }
store:setGroup         { storeId, groupName | null }
~~~

store:create 的 avatar_color 由主进程生成，不在入参中；store:update 的 patch 将店铺资料、分组排序与环境配置字段分开校验（后者走 profile:update）。

### 6.2 浏览器和标签页

~~~text
browser:open           { storeId }
browser:close          { storeId }
browser:tab:create     { storeId, url? }
browser:tab:activate   { storeId, tabId }
browser:tab:close      { storeId, tabId }
browser:tab:reorder    { storeId, orderedTabIds }
browser:navigate       { storeId, tabId, url }
browser:tab:setPinned  { storeId, tabId, pinned }
browser:clearData      { storeId, types[], origin? }   # types: cookies|cache|localStorage|downloads
browser:capture        { storeId, tabId, format }
browser:openWindow     { storeId, tabId }              # §14“在独立窗口打开”入口
bookmark:list          { storeId? }
bookmark:create        { storeId?, url, title }
bookmark:delete        { bookmarkId }
download:list          { storeId, limit? }
download:showInFolder  { downloadId }
~~~

### 6.3 网络和会话

~~~text
proxy:test             { proxyDraft }
proxy:create           { draft, username?, password? }   # 凭据由 Main 立即写入 safeStorage，仅存引用
proxy:update           { proxyId, patch }
proxy:delete           { proxyId }
proxy:importBatch      { items[] }
proxy:bind             { storeId, proxyId | null }
proxy:history          { proxyId, limit }                # 数据来自 proxy_checks
session:status         { storeId }
session:export         { storeId, outputPath }
session:import         { storeId, filePath }
~~~

导入/导出必须经过人工确认并写入审计日志。导出/导入密码由主进程托管的密码对话框采集，不经过 Renderer，也不走 IPC 通道。导出包必须携带有效期，过期包一律拒绝导入。

### 6.4 任务

~~~text
task:create            { definition }
task:list              { storeId?, status? }
task:run               { taskId, storeId }
task:pause             { runId }
task:resume            { runId }
task:cancel            { runId }
task:confirm           { runId, stepId, approved }
~~~

### 6.5 备份和锁定

~~~text
backup:create
backup:list
backup:restore         { backupId }
security:lock
security:unlock        { credential }
~~~

### 6.6 环境配置与概览

~~~text
profile:get            { storeId }
profile:update         { storeId, patch }                # 递增 config_version；locked=1 时拒绝
profile:verify         { storeId }                       # 逐字段返回 实际值/期望值/已验证|未验证
profile:lock           { storeId, locked }
profile:copyConfig     { sourceStoreId, targetStoreIds[] }  # 只复制配置，不含会话与代理凭据
overview:stats
task:results           { runId }
~~~

profile:copyConfig 对应店铺右键“复制配置”：只迁移指纹配置结构，绝不迁移 Cookie 或代理凭据引用。

### 6.7 设置、审计与诊断

~~~text
settings:get           { key }
settings:set           { key, value }
audit:query            { filter }                        # 按店铺、动作、时间筛选（FUNCTIONAL §3.9）
audit:export           { filter, outputPath }
diagnostics:export     { outputPath }                    # §22 脱敏诊断包
~~~

## 7. 事件通道

主进程通过 preload 向 Renderer 推送只读事件：

~~~text
store:statusChanged
browser:tabUpdated
browser:loadingChanged
browser:downloadCreated
browser:downloadProgress
browser:crashed
proxy:healthChanged
session:expired
task:progress
task:scheduledFired
task:confirmationRequired
security:locked
backup:completed
~~~

事件必须带 requestId 或 entityId，前端按实体更新状态，避免重复刷新整页。

## 8. 关键流程

### 8.1 新建店铺

1. Renderer 提交店铺资料。
2. Main 校验 URL、平台枚举和名称唯一性。
3. 创建 stores、browser_profiles 记录。
4. 生成唯一 partition、店铺下载目录和 avatar_color。
5. 如果配置代理，先执行连接测试；失败时展示原因，用户只能显式选择“修正代理重试”或“以直连创建”（记录所选模式），不发生默认降级。
6. 测试通过或用户显式选择直连后，创建浏览器会话并打开后台地址。
7. 用户完成登录后点击“已完成登录”。
8. 写入会话状态和审计日志。

### 8.2 切换店铺

1. Renderer 发送 storeId。
2. Main 检查应用未锁定，获取店铺 session。
3. 激活对应 BrowserWindow/WebContentsView。
4. 加载该店铺保存的标签页。
5. 右侧面板刷新代理、Cookie 和配置状态。
6. 更新 last_active_at。

任何页面和标签页操作都必须带 storeId，禁止使用“当前店铺”这一不明确的隐式参数。

### 8.3 代理检测

1. 用户点击检测。
2. Main 使用临时网络请求检查连接、HTTP 状态、延迟和出口 IP。
3. 结果写入 proxies。
4. 通过事件更新右侧面板。
5. 失败时显示明确错误，不自动切换代理。

### 8.4 清理当前店铺数据

1. 用户选择 Cookie、缓存、LocalStorage 或下载记录。
2. Renderer 显示影响范围和确认按钮。
3. Main 再次校验 storeId 和数据类型。
4. 调用对应 session 清理接口。
5. 更新会话状态，记录审计日志。
6. 必要时提示重新登录。

### 8.5 带人工确认的任务

1. TaskRunner 执行导航、等待和读取步骤。
2. 遇到 waitForUserConfirmation 时暂停。
3. Renderer 显示当前店铺、页面地址、即将执行的动作和风险提示。
4. 用户确认后 Main 才继续执行下一步。
5. 用户拒绝则将任务置为 cancelled，不重试该步骤。
6. 每一步写入结果、耗时和错误信息。

## 9. 状态机

### 9.1 店铺状态

~~~text
incomplete -> offline
offline -> launching
launching -> online
launching -> needs_login
online -> needs_login
online -> proxy_error
needs_login -> online
proxy_error -> online
any -> archived
archived -> offline
~~~

### 9.2 任务状态

~~~text
draft -> queued -> running
running -> waiting_confirmation
waiting_confirmation -> running
running -> paused
paused -> running
running -> succeeded
running -> failed
running -> cancelled
waiting_confirmation -> cancelled
queued -> cancelled
paused -> cancelled
failed -> queued        # 整体重新排队执行
failed -> running       # 从失败步骤恢复，跳过已完成步骤
~~~

状态迁移只能由 Main 执行，并在 task_runs 中保留迁移原因。从 failed 恢复（含 §11.2 的“从失败步骤恢复”）必须由用户显式触发并确认，不重复执行已成功步骤；验证码、登录页等副作用步骤不得出现在可恢复的重试范围内。

## 10. 安全实现要求

### 10.1 Electron 安全

- Renderer 开启 contextIsolation、sandbox，关闭 nodeIntegration。
- 只通过 preload 暴露白名单 API。
- 禁止网页内容访问 Electron API。
- 拒绝 file:, javascript:, 未授权 data: 导航。
- 新窗口通过 setWindowOpenHandler 统一拦截并转为受控标签页。
- Renderer 使用严格 CSP，禁止内联脚本。
- IPC 请求校验 sender、参数 schema 和店铺权限。

### 10.2 数据安全

- SQLite 元数据中的敏感字段加密或使用 safeStorage 引用。
- 会话导出包与备份包同等加密：用户在主进程托管对话框中设置密码，经 KDF（scrypt/PBKDF2，参数入包）派生密钥，AES-256-GCM 加密，附带版本号、随机盐、随机 nonce、校验标签和有效期；过期包拒绝导入。
- 跨机恢复边界（必须写进产品提示，不得承诺“备份直接带走登录态”）：Chromium 会话数据由 Windows 用户级加密（DPAPI）保护，异机或异用户无法解密。备份包跨机恢复覆盖店铺资料、浏览器配置、标签页索引和代理配置结构；代理账号密码需在目标机重新录入，登录态需在目标机重新登录、或经会话导出包（密码派生密钥，与 DPAPI 无关）导入。
- 主密码只用于应用锁、备份包与导出包的密钥派生，不参与 Chromium profile 落盘再加密；静态会话加密 = Chromium/DPAPI 用户级保护 + 应用锁，界面与文档按此表述。
- 日志不得出现 Cookie、Token、代理密码、完整订单地址和表单内容。
- 默认备份到本机受 ACL 保护的目录；备份包按上条加密后，才允许用户另存到异地。
- 应用自动锁定后禁止打开店铺和读取会话。
- 永久删除需要二次确认，并清理 profile、下载和相关备份引用。

## 11. 测试计划

### 11.1 单元测试

- 店铺和任务状态机。
- IPC schema 和错误码。
- 代理地址解析、超时和重试策略。
- 配置版本迁移。
- 加密/解密和备份校验。

### 11.2 集成测试

- 创建两个店铺并验证 partition 不同。
- 两个店铺设置不同代理并验证请求配置独立。
- 关闭并重新打开应用，标签页状态可恢复。
- 只清理店铺 A 的 Cookie，店铺 B 会话保持不变。
- 任务失败后从失败步骤恢复。

### 11.3 E2E 测试

使用本地测试站点，不连接真实店铺：

- 新建店铺向导。
- 店铺切换和标签管理。
- 环境面板状态更新。
- 代理错误提示。
- 人工确认条和任务暂停/继续。
- 锁定、解锁、备份、恢复。

### 11.4 安全测试

- Renderer 尝试调用未暴露 IPC。
- 恶意 URL、弹窗和下载拦截。
- 日志敏感信息扫描。
- 错误店铺 ID 越权访问。
- 导出文件密码错误和篡改检测。

## 12. 开发里程碑

里程碑编号 M0–M4 是全仓库唯一的版本序列，其他文档不得再使用 “M1/M2” 指代别的内容。“第一版（MVP）”统一定义为 FUNCTIONAL_SPEC §5 的 9 项功能集，跨 M1–M4 交付，M4 为第一版发布。

### 12.1 MVP 功能 → 里程碑映射

| FUNCTIONAL §5 条目 | 里程碑 |
| --- | --- |
| 1 店铺增删改查、搜索、筛选、回收站 | M1 |
| 2 每店铺独立环境与标签恢复 | M1 |
| 3 代理配置与连通性检查 | M2 |
| 4 会话数据加密保存（DPAPI + 应用锁 + 导出加密） | M2 |
| 5 多标签、恢复、下载归档 | M1 |
| 6 环境面板与基础健康检查 | M2 |
| 7 关键动作人工确认 | M1（页面内确认条）+ M3（任务确认节点） |
| 8 审计日志、备份和恢复 | M2 |
| 9 Windows 安装包、卸载、自动更新、崩溃日志 | M4 |

### M0：技术验证

- Electron 多 session partition。
- 多 WebContentsView 标签页。
- per-session proxy 设置，含 407 认证注入（`login` 事件 + safeStorage）与 HTTPS 型代理协议支持验证。
- CDP/注入方式覆盖时区、WebGL、navigator 字段，并校验 UA 与 UA-CH 成对一致；失败字段退回“未验证”。
- better-sqlite3 针对目标 Electron ABI 的重建与冒烟。
- SQLite 初始化和迁移。
- Windows 启动、关闭和崩溃恢复。

交付：可切换两个空白测试店铺的技术样机。

### M1：工作台核心

- 深色三栏 UI。
- 店铺 CRUD、搜索、筛选和回收站。
- 标签页、地址栏、下载和状态事件；下载记录按店铺归档（含店铺前缀命名与 download:list）。
- 收藏与常用页面快捷入口。
- 店铺数据持久化和重启恢复。

交付：工作台核心版本（第一版功能集的 M1 子集，非发布版）。

### M2：环境和安全

- 代理管理和诊断。
- Cookie/缓存清理。
- safeStorage、锁定、备份和恢复。
- 审计日志和错误诊断。

交付：可在 Windows 10/11 上稳定使用的单机版本。

### M3：任务辅助

- 读取型任务模板。
- 截图、库存/订单页面读取（结果写入 task_step_results，指标聚合进 store_snapshots）。
- 定时调度与提醒（Scheduler 触发，仍受确认门禁约束）。
- 草稿填充。
- 人工确认节点、暂停/继续和步骤级日志。

交付：可控的任务辅助版本。

### M4：发布

- 安装、卸载、升级和数据迁移。
- 崩溃日志和诊断导出。
- Windows 10/11 安装验收。
- 发布说明、回滚包和版本校验。

## 13. 发布验收

- 安装包在 Windows 10/11 全新环境中可安装和启动。
- 升级后店铺、配置、标签页和备份仍可读取。
- 两个店铺之间没有 Cookie、缓存、LocalStorage、代理或下载串用。
- 浏览器崩溃只影响当前店铺，重启后可以恢复。
- 所有高风险操作都有人工确认记录。
- 代理不可用时不发生静默切换。
- 数据清理、会话导入导出和永久删除均有审计记录。
- 备份包在第二台 Windows 电脑上通过密码恢复，店铺资料、配置与标签页索引一致；登录态按 §10.2 声明的路径（重新登录或导出包导入）验证。
- 不输出明文会话和敏感字段到日志。
- 没有验收记录的构建标记为 INTERNAL_BUILD，不能标记为 RELEASE。

## 14. 当前风险和处理方式

- Chromium 多会话的资源占用可能随店铺数量增长：MVP 默认限制同时运行的店铺数量，并显示内存占用。
- 某些电商页面会阻止嵌入式浏览器或弹窗：保留“在独立窗口打开”入口。
- 页面结构变化会影响读取任务：所有选择器放在平台适配层，并为任务记录版本。
- 会话导入存在泄露风险：默认关闭自动同步，导出文件强制加密且必须设置有效期，过期即失效。
- 平台规则和账号权限不同：自动化只做用户授权范围内的读取和草稿辅助，提交动作由用户完成。

## 15. 开发完成定义

一个版本只有同时满足以下条件才算完成：

1. 功能规格中标记为该版本的功能已经实现。
2. 单元、集成和 E2E 测试通过。
3. Windows 安装、升级、卸载和数据迁移验证通过。
4. 关键安全测试通过，日志无敏感信息泄露。
5. 关键店铺隔离验收通过。
6. 发布包、校验值、变更说明和回滚方式齐全。

## 16. 平台适配层

平台页面结构不能直接写进通用 TaskRunner。每个平台实现独立适配器，通用任务只调用适配器能力。

~~~text
interface PlatformAdapter {
  id: string
  displayName: string
  matches(url: string): boolean
  getEntryRoutes(): EntryRoute[]
  readStoreSummary(ctx: PageContext): Promise<StoreSummary>
  readProducts(ctx: PageContext): Promise<ProductSummary[]>
  readOrders(ctx: PageContext): Promise<OrderSummary[]>
  getSelectorVersion(): string
}
~~~

要求：

- 适配器只处理用户已登录页面中的读取和草稿辅助。
- 选择器、页面入口和字段映射按版本管理，页面变化时可单独升级适配器。
- 未识别的平台使用通用浏览器能力，不显示平台专属数据卡片。
- 适配器失败必须返回可诊断错误和页面地址，不静默提交表单。

## 17. UI 实现规范

### 17.1 组件划分

- `AppShell`：窗口布局、全局通知、锁定状态。
- `StoreSidebar`：店铺搜索、筛选、分组、店铺卡片和回收站。
- `WorkspaceHeader`：模块导航、当前店铺、窗口操作。
- `BrowserToolbar`：前进、后退、刷新、地址栏、收藏和下载。
- `BrowserTabs`：标签创建、关闭、固定、排序和加载状态。
- `BrowserViewport`：WebContentsView 容器和页面错误卡片。
- `EnvironmentPanel`：环境、代理、Cookie、健康度和操作按钮。
- `StoreOverview`：概览指标卡、异常汇总与最近活动时间线。
- `TaskConfirmationBar`：高风险步骤的人工作确认。

### 17.2 布局和状态

- 默认布局为左侧 304px、中央自适应、右侧 328px；窗口宽度不足时右侧面板折叠为抽屉。
- 所有页面必须实现加载、空数据、错误、锁定和无权限状态。
- 当前店铺使用蓝色边框和店铺色标双重提示，避免只依赖颜色识别。
- 统一使用设计图中的深色背景、蓝色主按钮、绿色正常状态和红色错误状态。
- 键盘快捷键：Ctrl+K 搜索店铺，Ctrl+L 聚焦地址栏，Ctrl+T 新标签，Ctrl+W 关闭标签，Ctrl+Tab 切换标签，Ctrl+Shift+L 锁定应用。
- 关键按钮必须支持键盘访问、焦点可见和至少 4.5:1 的文字对比度。

## 18. 错误码和诊断

错误对象统一包含 `code`、`message`、`retryable`、`requestId` 和可选 `details`。用户界面显示可理解的中文提示，日志保留技术细节。

~~~text
STORE_NOT_FOUND              店铺不存在或已删除
STORE_LOCKED                 店铺正在被其他操作占用
PROFILE_NOT_READY            浏览器环境尚未初始化
PROFILE_IN_USE               店铺浏览器正在运行
PROXY_INVALID                代理格式不正确
PROXY_AUTH_FAILED            代理认证失败
PROXY_UNREACHABLE            代理无法连接
SESSION_EXPIRED              登录会话已过期
SESSION_IMPORT_INVALID       会话包格式、密码或校验值错误
TASK_CONFIRMATION_REQUIRED   任务等待人工确认
TASK_TIMEOUT                 任务步骤超时
TASK_SELECTOR_CHANGED        页面结构已变化
NAVIGATION_BLOCKED           导航目标不被允许
BACKUP_CHECKSUM_FAILED       备份文件校验失败
APP_LOCKED                   应用已锁定
INTERNAL_ERROR               未分类内部错误
~~~

每个错误码都要有：触发条件、用户动作、是否可重试、是否写审计日志和对应测试用例。

## 19. 性能和资源治理

以 Windows 11、16GB 内存、5 个店铺为基准环境，设定以下目标：

- 冷启动进入主界面不超过 5 秒。
- 已初始化店铺切换到可交互状态不超过 1.5 秒。
- 1000 个店铺的搜索和筛选响应不超过 100ms：列表虚拟滚动、SQLite 索引（必要时 FTS5），测试数据为 1000 店铺 × 平均 5 标签页。
- 冷启动与切换指标在 NVMe SSD、8 代 i5 及以上机型测量并记录，不得以单店铺、预热后的结果充当基线。
- 非当前店铺默认挂起页面定时器和任务，避免后台持续消耗资源。
- 默认最多同时运行 5 个店铺浏览器，可在设置中调整并显示预计内存占用。
- 单店铺崩溃、无响应或高内存时，只隔离和重启该店铺。

性能测试必须记录设备配置、店铺数量、标签页数量和代理状态，避免只报告单店铺结果。

## 20. 数据迁移、升级和回滚

- SQLite 使用递增迁移文件和 `schema_migrations` 表，应用启动时先完成迁移再打开工作区。
- 每次大版本升级前自动创建元数据和 profile 索引备份。
- 迁移失败时恢复元数据备份，保留失败日志，不删除原 profile 数据。
- BrowserProfile 增加 `profile_schema_version`，需要转换时先复制目录再执行迁移。
- 应用更新失败自动回退到上一版本；回退不覆盖用户数据。
- 旧版本无法读取新版本备份时，提示版本差异和可用恢复方式。

## 21. 构建和发布流水线

CI 至少包含：

1. TypeScript 类型检查、ESLint、单元测试、依赖漏洞扫描，以及 better-sqlite3 等原生模块针对当前 Electron ABI 的重建与冒烟。
2. Windows x64 构建和安装包安装/卸载冒烟测试。
3. 两店铺隔离、代理错误、锁定、备份恢复的 E2E 测试。
4. 生成安装包 SHA-256、版本清单和变更说明。
5. 发布包签名；没有有效签名或验收记录的包只能标记为 `INTERNAL_BUILD`。

建议保留 `stable` 和 `beta` 两个更新通道。自动更新在下载完成后校验签名和哈希，安装失败时保留旧版本可回滚。

## 22. 诊断和可观测性

- 日志按 `requestId`、`storeId`、`taskRunId` 串联，默认保留 14 天。
- 日志分为 info、warn、error；页面内容、Cookie、代理密码和完整表单值永不写入。
- 提供“导出诊断包”，包含版本、系统信息、脱敏日志、数据库迁移版本和代理检查摘要，不包含 profile 会话。
- 崩溃报告默认关闭，用户主动开启后只上传错误堆栈和设备信息。
- 不把店铺名称、订单信息和页面内容发送到第三方分析服务。

## 23. 威胁模型

重点防护对象：恶意网页脚本、恶意下载文件、错误店铺操作、本机其他用户、泄露的导出会话包和被劫持的代理。

- 网页只能访问标准浏览器能力，不能访问 Node、IPC、数据库或本地文件。
- 下载默认保存到按店铺隔离的目录，并在打开可执行文件前提示用户。
- 所有跨店铺操作带明确店铺 ID，主进程再次校验，不信任 Renderer 的当前选择。
- 会话导出使用用户设置的导出密码和有效期（密码经主进程托管对话框输入，不经过 Renderer）；导出包过期或被篡改一律拒绝导入；导出完成后立即写审计日志。
- 代理凭据只进入安全存储；日志、错误提示和诊断包全部脱敏。
- 应用锁定、退出和永久删除时清理敏感引用和临时文件。

## 24. 开发前必须确定的决策

- 是否需要同时运行超过 5 个店铺，以及可接受的内存上限。
- 首个要做深度适配的平台；其他平台先使用通用浏览器能力。
- 是否允许团队共享电脑；如果允许，先实现 Windows 用户级数据目录和自动锁定。
- 是否需要官方平台 API；只有完成权限、令牌存储和审计设计后再接入。
- 是否提供云端同步；默认不上传明文会话，云同步必须单独设计端到端加密。

以上决策的最迟确定时点：首个深度适配平台不晚于 M1 结束（M3 读取任务依赖其结论）；并发店铺上限与内存预算不晚于 M2 开始；团队共享电脑、官方 API、云同步三项不晚于 M4 发布评审。逾期未决的项按“不做”处理并从里程碑移除。

## 25. 需求追踪矩阵

每项需求使用稳定编号，提交代码、测试用例和验收记录都引用同一编号。矩阵必须覆盖 FUNCTIONAL §5 的全部 MVP 条目；行只增不改义，作废行标记 deprecated。

~~~text
编号            需求                          组件              IPC                     数据                        里程碑
F-STORE-001    店铺新增/编辑/搜索/筛选        StoreSidebar      store:list/create/…     stores                      M1
F-STORE-002    分组、拖拽排序                StoreSidebar      store:reorder/setGroup  stores.sort_order/group     M1
F-STORE-003    新建店铺向导                  StoreWizard       store:create+profile:*   stores+browser_profiles     M1-M2
F-STORE-004    回收站/归档/永久删除           StoreSidebar      store:archive/restore/…  stores.deleted_at           M2
F-BROWSER-001  标签页/固定/排序/状态恢复      BrowserTabs       browser:tab:*            tabs                        M1
F-BROWSER-002  下载按店铺归档与记录          BrowserToolbar    download:*               downloads                   M1
F-BROWSER-003  收藏与常用页面快捷入口         BrowserToolbar    bookmark:*               bookmarks                   M1
F-BROWSER-004  独立窗口打开                  BrowserViewport   browser:openWindow       —                           M2
F-ENV-001      环境配置、校验与健康诊断       EnvironmentPanel  profile:*                browser_profiles            M2
F-ENV-002      代理管理、检查与历史           ProxyManager      proxy:*                  proxies/proxy_checks        M2
F-ENV-003      锁定环境                      EnvironmentPanel  profile:lock             browser_profiles.locked     M2
F-SESSION-001  会话清理与加密导入导出         EnvironmentPanel  session:*/clearData      profile/导出包              M2
F-OVW-001      店铺概览指标与活动             StoreOverview     overview:stats           store_snapshots             M3
F-TASK-001     可暂停任务与人工确认           TaskRunner        task:*                   tasks/task_runs/结果表      M3
F-TASK-002     定时调度与提醒                Scheduler         task:scheduledFired      tasks.schedule_json         M3
F-SEC-001      锁定、审计、备份恢复           Settings          security:/backup:/audit:* audit_logs/backups          M2
F-RELEASE-001  Windows 安装/升级/回滚         Installer         updater                  release artifacts           M4
~~~

Pull Request 必须至少包含：影响的需求编号、实现模块、测试编号、数据迁移说明和回滚方式。需求未映射到测试时不能进入发布候选版本。

## 26. IPC 和数据契约版本

- 共享契约包使用语义化版本，主进程和 Renderer 在启动时检查契约版本。
- IPC 请求带 `apiVersion`，当前为 `1`；新增字段必须向后兼容，删除字段只能在主版本升级中进行。
- 错误码、事件名称和状态枚举不得复用旧含义。
- 数据库迁移版本与应用版本分离，支持一个应用版本执行多个数据库迁移。
- 破坏性契约变更必须提供迁移脚本、旧版本读取策略和回滚测试。

## 27. 浏览器运行时和权限边界

BrowserSessionManager 还需要处理 Chromium 运行时事件：

- 新窗口、弹窗和外部协议统一进入受控标签页或明确提示。
- 下载按店铺分目录，覆盖同名文件前要求确认。
- 地理位置、通知、摄像头、麦克风和剪贴板权限默认拒绝，用户按域名和店铺单独授权。
- TLS 证书错误不能被静默忽略；显示域名、证书错误和继续访问风险。
- 页面崩溃、无响应和渲染进程退出分别记录，恢复时不重复提交表单。
- 代理切换、网络断开和系统休眠恢复后重新检查连接，再决定是否重载页面；代理认证在 407 触发时经 `login` 事件注入（凭据取自 safeStorage），proxyRules 不内嵌凭据（§4.3）。
- MVP 不加载未知浏览器扩展；扩展系统单独设计权限和签名机制。

## 28. 备份和恢复演练

备份不只验证文件存在，还必须定期执行恢复演练：

1. 生成加密备份并计算 SHA-256。
2. 在临时目录恢复元数据、店铺配置、标签页索引和必要的 profile 索引。
3. 校验店铺数量、配置版本、标签页数量和备份清单一致。
4. 使用测试店铺启动浏览器，确认 Cookie、LocalStorage 和代理配置可读取。
5. 销毁临时恢复目录，保留恢复日志和结果。

默认保留最近 7 个日备份和最近 4 个周备份。每季度至少在第二台 Windows 测试机上执行一次跨机恢复演练，验证密码派生密钥路径与 §10.2 声明的恢复边界（元数据可恢复、DPAPI 会话需重登或导出包导入）。任何恢复失败都不能覆盖当前可用数据，必须先创建当前状态快照。

## 29. 测试夹具和本地测试环境

为了避免测试真实店铺，仓库提供本地测试站点和固定数据：

- `tests/fixtures/store-a`、`tests/fixtures/store-b`：两个独立的登录态、商品页、订单页和需要确认的表单页。
- `tests/fixtures/proxy`：可模拟直连、认证失败、超时、IP 变化和 DNS 错误。
- `tests/fixtures/platform-adapters`：固定页面结构和选择器版本，覆盖结构变化场景。
- E2E 测试每次使用临时数据目录，测试结束后清理，不读取开发者真实浏览器目录。
- 本地测试站点通过 `http://127.0.0.1` 动态端口提供服务，不使用 file:// 协议，与 §10.1 的导航拒绝策略保持一致。
- 测试报告保存截图、页面 URL、需求编号和失败步骤，但不得保存真实会话数据。

## 30. 使用边界和运营支持

- 产品只服务于用户拥有或被授权管理的店铺和页面。
- 不提供验证码识别、二次验证代操作、隐式发布、自动付款或修改收款信息的能力。
- 平台适配器的读取字段、请求频率和页面权限写入版本说明，页面变化时通过适配器版本升级处理。
- 支持人员只接收脱敏诊断包；除非用户主动导出并加密提供，否则不收集 profile、Cookie 或订单原文。
- 每个版本发布时附带已知问题、支持的 Chromium 版本、数据库迁移版本、回滚包和诊断方法。

## 31. 发布签字清单

发布负责人需要在发布记录中确认：

- 需求追踪矩阵中所有本版本条目都有实现和测试证据。
- 两店铺隔离、会话清理、代理故障、人工确认和备份恢复演练通过。
- Windows 10/11 安装、升级、卸载和回滚通过。
- 安装包签名、SHA-256、版本号和更新通道正确。
- 诊断包不含明文会话、代理密码、订单原文和完整表单值。
- 已知问题、兼容性限制和回滚方式已写入发布说明。

## 32. 修订记录

| 版本 | 说明 |
| --- | --- |
| v0.1 | 开发基线初稿。 |
| v0.2 | 按 REVIEW.md 审查结论修订：修复任务状态机缺少失败恢复迁移（A1）；统一里程碑编号并新增 §12.1 MVP 映射（A2）；明确备份/导出加密与跨机恢复边界、主密码职责（A3）；补齐 proxy CRUD、proxy_checks、bookmarks、downloads、task_step_results、store_snapshots 及对应 IPC（B1–B4）；新增 Scheduler 设计（B5）；对齐 §4.3 字段与 browser_profiles 表并新增 profile:* IPC、锁定环境、复制配置（B6）；补 stores 分组排序与向导字段、tab 固定接口（B7）；补 settings/audit/diagnostics/openWindow IPC 并扩展追踪矩阵（B8）；新增环境字段实现机制与代理 407 注入约定、M0/CI 验证项、E2E 本地站点协议约束（C1–C3）；重命名 Pinia 目录、统一 SecurityManager 命名（D1–D4）。 |

