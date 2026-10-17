# ShopPilot 浏览器扩展（插件）功能设计

- **文档日期**：2026-10-17
- **状态**：MVP 已实施（`IMPLEMENTED / PACKAGED / INTERNAL_BUILD`；真实扩展兼容性与人工桌面验收仍未完成）
- **目标读者**：后续实现者 / 产品评审
- **结论先行**：技术上可实现，但只能做**本地解包扩展的受控加载**；不支持 Chrome 商店、不支持 `.crx`、不保证 Chrome API 全兼容。

> **实现回填（2026-10-17）**：本版已落地 `extension-manager.ts`、`extension-manifest.ts`、扩展 IPC、preload bridge、设置中心第六页签、清单边界单测和 `extensions-cdp-verify.js`。自动门禁覆盖导入校验、权限/host 范围、符号链接/大小限制、按店铺 Session 加载、启停/重载/删除与页面重载；尚未用真实第三方扩展完成兼容性记录，也未完成人工逐项 Windows 桌面验收，不能把“扩展功能已实施”表述为“任意 Chrome 扩展兼容”。

---

## 1. 目标与非目标

### 1.1 目标（MVP）
1. 用户可以从本地文件夹导入一个**已解包**的 Chrome 扩展，应用复制到自己的管理目录并校验。
2. 扩展按**店铺 Session** 独立加载（`persist:store_<id>`），不同店铺互不共享扩展状态。
3. 设置中心可查看扩展列表、启用/停用、重新加载、删除；默认总开关关闭。
4. 扩展加载失败必须如实显示原因，不静默、不影响应用启动。
5. 加载扩展后，现有指纹字段（UA/语言/时区/屏幕/WebGL）仍通过 `profile:verify`。

### 1.2 非目标（明确不做）
- Chrome Web Store 一键安装、`.crx` 安装、扩展自动更新/远程下载。
- `nativeMessaging`、`debugger`、`management`、`proxy`、`privacy`、`cookies` 等可越权/越界的权限。
- 扩展市场、评分、签名分发。
- 保证任意扩展可用：Electron 只实现部分 Chrome Extensions API，兼容性按扩展逐个实测。

---

## 2. Electron 能力边界（Electron 44.7.2 实测/类型定义）

| 事项 | 结论 |
|---|---|
| API | 使用 **`session.extensions.loadExtension(path, { allowFileAccess:false })`**；`session.loadExtension` 已废弃 |
| 加载格式 | 仅**解包目录**，不支持 `.crx` |
| 会话类型 | **只支持持久化 Session**；内存 Session 会抛错。店铺分区 `persist:store_*` 满足 |
| 启动时机 | 必须在 `app.ready` 之后；且**每次启动都要重新 load**（Electron 不再记住上次加载） |
| 查询/卸载 | `session.extensions.getExtension(id)`、`getAllExtensions()`、`removeExtension(id)` |
| API 覆盖 | 不是完整 Chrome API；`chrome.webRequest` 阻断、native messaging、部分 MV3 API 不可用 |
| 返回值 | `Extension { id, manifest, name, path, url, version }`；`id` 由路径派生，**不要持久化**，运行时映射即可 |

> 关键结论：**不能把扩展当成“Chrome 等价物”承诺**。产品文案必须写“实验性、按扩展实测”。

---

## 3. 总体架构

```
Renderer（设置 → 浏览器扩展）
   │  IPC: extensions:list/import/setEnabled/setMaster/remove/reload
   ▼
Main: extension-handlers.ts（familyHandle + zod）
   ▼
Main: extension-manager.ts（唯一实现对目录/清单/会话的读写）
   ├─ 管理目录：app.getPath('userData')/extensions/<slug>/
   ├─ 校验：manifest.json（权限白名单、路径、大小、符号链接）
   ├─ 持久化：app_settings['browser.extensions']（master + enabledIds）
   └─ 会话：session.extensions.loadExtension / removeExtension
             ▲
             │ 在 configureSession() 尾部、首次导航之前调用
        session-manager.ts / shop-session-manager.ts
```

### 3.1 为什么放在 Session 层，而不是 WebContents
- 扩展是 **Session 级**能力；店铺的 webview 使用 `persist:store_<id>`，天然一店一扩展集。
- 主窗口 Session 不加载任何店铺扩展，避免扩展读到应用 UI（`file://`）。

### 3.2 目录与持久化
- 目录：`userData/extensions/<slug>/manifest.json`。`slug` 由主进程生成（`ext_` + 8 位随机），不采用用户目录名，避免路径注入/重名。
- 配置：`app_settings['browser.extensions'] = { master: false, enabledIds: string[] }`。
  - 不新增数据库表：扩展元数据每次从目录清单重算，只有“是否启用”需要持久化。
- 导入：主进程弹目录选择框，校验通过后**复制**到管理目录（不引用原路径，防止用户移动/删除后失效）。
- 删除：先从所有活动 Session `removeExtension`，再删目录；删除前 UI 二次确认（不是凭据级操作，不需要原生对话框）。

---

## 4. 清单校验（安全边界）

实现建议：`apps/desktop/src/main/services/extension-manifest.ts`（纯函数，便于单测）。

### 4.1 结构校验
- 目录内必须有 `manifest.json`，文件 ≤ 1 MB。
- `manifest_version` ∈ {2, 3}；MV3 标注“部分兼容”。
- `name`：1–64 字符，去掉控制字符；`version`：`/^\d+(\.\d+){0,3}$/`。
- 目录文件数 ≤ 2000，总大小 ≤ 20 MB；拒绝符号链接（`lstat` 逐项检查）。
- 拒绝路径穿越（复制时只接受源目录内的常规文件/目录）。

### 4.2 权限白名单
**硬阻断**（出现即拒绝导入）：
`nativeMessaging`、`debugger`、`management`、`proxy`、`privacy`、`cookies`、`history`、`bookmarks`、`downloads`、`identity`、`enterprise.*`、`chrome://*` 相关。

**允许**（页面内能力，MVP）：
`storage`、`unlimitedStorage`、`activeTab`、`tabs`、`scripting`、`contextMenus`、`notifications`、`alarms`、`idle`、`webRequest`、`declarativeNetRequest`（按 Electron 支持情况降级）。

### 4.3 注入范围
- `content_scripts[].matches` / `host_permissions` 只允许 `http:` / `https:`；显式 `file://` 拒绝。
- `<all_urls>` 允许，但 `loadExtension` 固定 `allowFileAccess:false`，因此不会注入应用自身的 `file://` UI。
- MVP **拒绝 `world: "MAIN"`** 的内容脚本：主世界脚本会与指纹注入互相覆盖，先不开口子；后续如确需，单独评审“主世界脚本优先级”。

### 4.4 失败语义
| 场景 | 错误码 | 界面 |
|---|---|---|
| 无 manifest / JSON 损坏 | `EXTENSION_INVALID` | 导入失败，显示具体字段 |
| 权限被阻断 | `EXTENSION_PERMISSION_BLOCKED` | 指出被拒权限 |
| 文件/大小超限 | `EXTENSION_TOO_LARGE` | 指出上限 |
| 加载时 Electron 抛错 | `EXTENSION_LOAD_FAILED` | 列表状态 `load_failed` + 原因（脱敏） |
| 目录已被删除 | `EXTENSION_NOT_FOUND` | 列表项标记 `missing`，可移除 |

> 错误文案统一走 `ipc/envelope.ts` 的脱敏；内部路径只进 `logMain`，不回渲染层。

---

## 5. 加载生命周期

### 5.1 启动/开店
`session-manager.ts` 的 `configureSession(session, storeId)` 已是异步且在首次导航前被等待；在其尾部（UA/UA-CH/代理配置之后）调用：

```ts
await extensionManager.applyToSession(storeId, session)
```

规则：
- 只有 `browser.extensions.master === true` 且扩展在 `enabledIds` 中才加载。
- 已加载的 `slug → electronId` 记在内存；同一 Session 不重复加载。
- `loadExtension` 抛错 → 记录 `load_failed`，不影响店铺打开。
- 客服共享 Session（同一店铺的客服页）同样应用，保证店面与客服页行为一致；若产品决定不一致，改为 `applyToSession(storeId, session, { scope:'store' })` 参数控制。

### 5.2 启用/停用
- 停用：从该店铺所有活动 Session `removeExtension(electronId)`；对已打开的标签页执行 `reload()`（扩展卸载后必须重载页面才彻底生效）。
- 启用：`applyToSession` 后同样重载已打开标签页。
- 重载：`removeExtension` + `loadExtension` + 重载标签页（用于扩展代码更新）。
- 店铺浏览器未打开：只改配置，下次打开时生效。

### 5.3 多店隔离
- 每个 `persist:store_<id>` 独立加载，扩展的 `chrome.storage.local` 也按 Session 隔离。
- 不做“全局默认 Session 加载”，否则扩展会跨店共享状态。

---

## 6. IPC 契约（草案）

新增频道（`packages/shared/src/contracts/ipc.ts`）：

```ts
EXTENSION_LIST: 'extensions:list',
EXTENSION_IMPORT: 'extensions:import',
EXTENSION_SET_ENABLED: 'extensions:setEnabled',
EXTENSION_SET_MASTER: 'extensions:setMaster',
EXTENSION_REMOVE: 'extensions:remove',
EXTENSION_RELOAD: 'extensions:reload'
```

入参/出参（zod，`familyHandle('浏览器扩展')`）：

```ts
// list → { master: boolean, items: ExtensionItem[] }
interface ExtensionItem {
  id: string            // 我们的 slug
  name: string
  version: string
  manifestVersion: 2 | 3
  enabled: boolean
  status: 'loaded' | 'disabled' | 'invalid' | 'load_failed' | 'missing'
  permissions: string[]
  sizeBytes: number
  updatedAt: number
  loadError?: string    // 已脱敏
}

// import → { canceled: boolean, item?: ExtensionItem }
// 主进程弹 showOpenDialog({ properties:['openDirectory'] })，渲染层不传路径

// setEnabled { id, enabled } / remove { id } / reload { id }
// setMaster { enabled } → 关闭 master 时卸载所有活动 Session 的扩展
```

安全约束：
- 渲染层**永远不传路径**；导入路径只来自主进程对话框。
- `id` 必须是 `^ext_[a-z0-9]{8}$`，主进程按管理目录解析，拒绝 `..`/绝对路径。
- 所有操作写审计：`extension.import/remove/enable/disable/master/reload`。
- 应用锁期间拒绝（`familyHandle` 默认行为）。

---

## 7. 设置中心 UI

推荐新增第 6 个页签 **「浏览器扩展」**（`settings-tab-extensions`），位置在「安全」与「数据与维护」之间。

> 这会改动现有 5 页签契约：`settings-cdp-verify.js` / `m1-cdp-verify.js` 里的 tab 文本、数量、无横溢断言都要同步更新。如果不想动契约，可先落在「数据与维护」的一个分组里，功能不变、发现性差一些。

页面结构：
1. 顶部风险提示（常驻）：
   “实验性功能：扩展可以读取和修改店铺页面内容；请只导入可信来源。不支持 Chrome 商店与 .crx。”
2. 总开关 `extensions-master`（默认关）：关闭时立即卸载所有扩展并重载已开店铺页。
3. 列表 `extensions-row-<id>`：名称、版本、MV2/MV3、状态徽标、权限摘要、启用 switch、重载、删除。
4. 空状态 `extensions-empty`：说明只支持本地解包目录 + 「导入扩展文件夹」按钮。
5. 失败态：`extensions-error` 显示错误码与可读文案（不含路径）。

---

## 8. 指纹与扩展的交互（最高风险点）

1. **隔离世界**：普通 MV2/MV3 content script 默认运行在 isolated world，页面主世界的 `navigator` 补丁不受影响；MVP 拒绝 `world:"MAIN"`，先规避主要冲突。
2. **请求头冲突**：扩展若用 `chrome.webRequest.onBeforeSendHeaders` 改写 UA，会覆盖 `session.setUserAgent` 的结果。MVP 不拦截，但必须：
   - 在扩展详情里显示它声明了 `webRequest`；
   - `profile:verify` 若发现 UA 与档案不一致，按现有红线“如实报未验证”，不伪装通过；
   - 文档写明“声明 webRequest 的扩展可能与指纹档案冲突”。
3. **加载顺序**：Session UA/UA-CH/代理先配置，再加载扩展；页面导航时 CDP document-start 注入与扩展 content script 的先后顺序不做承诺。
4. **验收必须包含**：加载 fixture 扩展后跑 `profile:verify`，UA/语言/时区/屏幕仍为 `verified`；若扩展改写 UA，必须显示“未验证”，而不是假通过。

---

## 9. 威胁模型与缓解

| 威胁 | 缓解 |
|---|---|
| 用户导入恶意扩展，窃取店铺页面数据 | 默认关闭 + 明确风险提示 + 只从本地导入 + 权限硬阻断 + 审计 |
| 扩展通过 `nativeMessaging`/`debugger` 逃逸 | 权限硬阻断 |
| 扩展读取 Cookie | 阻断 `cookies` 权限；HttpOnly Cookie 仍不可读；但页面内 `document.cookie` 仍可能被 content script 读取——这是扩展的固有风险，必须在 UI 明示 |
| 扩展改写请求头破坏指纹 | 显示 `webRequest` 标记；验真失败如实呈现；不自动修复 |
| 扩展导致渲染进程崩溃 | 捕获 `loadExtension` 异常与 `render-process-gone`；只标记该店扩展 `load_failed`，不阻塞应用 |
| 扩展目录被替换/篡改 | 导入时记录清单哈希（可选 P1）；每次启动重新校验 manifest 与权限；不自动更新 |

---

## 10. 文件改动清单（预估）

### 新增
- `apps/desktop/src/main/services/extension-manager.ts`：目录扫描、导入复制、启用表、Session 加载/卸载、重载。
- `apps/desktop/src/main/services/extension-manifest.ts`：纯函数校验（结构/权限/注入范围/大小/符号链接）。
- `apps/desktop/src/main/ipc/extension-handlers.ts`：6 个 IPC + 审计。
- `tests/unit/extension-manifest.test.ts`：校验矩阵。
- `tests/unit/extension-scope.test.ts`：master/enabled/会话映射。
- `tools/acceptance/extensions-cdp-verify.js`：fixture 扩展端到端。
- `tests/fixtures/extensions/dom-marker/`：`manifest.json` + `content.js`（写 `data-shopilot-fixture`）。

### 修改
- `packages/shared/src/contracts/ipc.ts`：6 个频道 + `ExtensionItem` 类型。
- `apps/desktop/src/preload/index.ts` + `env.d.ts`：`window.shopilot.extensions.*`。
- `apps/desktop/src/main/browser/session-manager.ts`：`configureSession` 尾部应用扩展。
- `apps/desktop/src/main/browser/window-manager.ts`：启用/停用/重载后重载已打开标签页（复用现有 `reload`）。
- `apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue`：新页签 + 列表 UI。
- `tools/acceptance/settings-cdp-verify.js`、`m1-cdp-verify.js`：6 页签契约与无横溢断言。
- `docs/DEVELOPMENT_SPEC.md` / `docs/RELEASE_NOTES.md`：能力边界说明。

---

## 11. 验收计划

### 11.1 单测
1. 合法 MV2/MV3 清单通过；缺 name/version 拒绝。
2. `nativeMessaging/debugger/cookies` 权限拒绝，错误码正确。
3. `file://` matches 拒绝；`<all_urls>` 接受（allowFileAccess=false）。
4. 符号链接/超过 20MB/超过 2000 文件拒绝。
5. master 关闭时 `enabledIds` 不生效；启用列表只影响目标 Session。

### 11.2 真机（CDP）
前置：把 fixture 扩展预复制到临时 `userData/extensions/fixture/`（避免为测试开后门 IPC）。

1. 启动应用 → 打开本地测试店铺 → 页面出现 `data-shopilot-fixture="1"`。
2. `profile:verify` 的 UA/语言/时区/屏幕仍为 `verified`。
3. 设置里关闭该扩展 → 已开标签页自动重载 → 标记消失；`session.extensions.getAllExtensions()` 为空。
4. 重新启用 → 重载 → 标记恢复。
5. 导入一个含 `nativeMessaging` 的清单 → 被拒，错误码 `EXTENSION_PERMISSION_BLOCKED`，目录未落盘。
6. 删除扩展 → 管理目录不存在，列表回到空状态。
7. 总开关关闭 → 所有店铺重载后均无标记。

### 11.3 回归
- `m1-runner`（浏览器/布局/会话）、`sec-runner`（会话包/应用锁）、`settings-cdp-verify`（页签契约）必须全绿。
- 至少用 1 个真实扩展（如广告拦截 MV3）做人工兼容性记录，不纳入自动断言。

---

## 12. 分期与工作量

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | manifest 校验 + 管理目录 + Session 加载/卸载 + IPC + 单测 | 1 天 |
| P1 | 设置页新页签 + 列表/开关/删除 + fixture 真机验收 | 0.5–1 天 |
| P2 | 真实扩展兼容性记录、webRequest 冲突提示、清单哈希/完整性 | 1 天 |

风险缓冲：Electron 扩展 API 的行为差异（尤其 MV3 service worker）需要按目标扩展实测，不能只靠单测。

---

## 13. 待产品确认的问题

1. **目标扩展是什么**：广告拦截 / 翻译 / 比价 / ERP 插件？不同目标决定 MV3 兼容性和 `webRequest` 是否必须。
2. **作用域**：全局启用，还是“每店可选”？本文按全局 + 总开关设计，每店作用域留作 P2。
3. **客服页面是否也加载**：本文按“是”（同一店铺 Session），若担心客服页被扩展干扰可关闭。
4. **是否接受 `world:"MAIN"`**：本文 MVP 拒绝；若目标扩展必须主世界，需要单独设计指纹优先级与冲突检测。
5. **是否要做清单哈希/签名**：本文 P2 可选项；不做则信任边界=“用户导入的本地代码”。
