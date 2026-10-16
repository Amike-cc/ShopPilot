# 浏览器功能实现审查（2026-10-16）

> 范围：店铺浏览器（webview / 独立窗口 / 客服隐藏窗）、会话与 Cookie、指纹注入、
> 网络请求、本地存储。方法：全量读码 + 危险开关扫描 + 关键路径证据定位，
> 所有结论锚定文件与行号；严重级 P2（应修） / P3（建议） / info（确认现状正确）。

## 总体结论

浏览器域是全仓**加固最充分**的部分：Electron 官方安全清单上的关键项（contextIsolation、
sandbox、webview 收口、导航/弹窗白名单、权限成对收口、Cookie 加密落盘）全部落地且有
日志可查。本轮未发现 P1 级问题；3 条 P2 改进、若干 P3 收尾项，均不影响当前使用。

---

## 一、页面渲染

**已到位（证据）**
- 主窗口 `webPreferences`：`contextIsolation: true / nodeIntegration: false / sandbox: true`
  （`main/index.ts:215-221`）；全仓扫描 `webSecurity:false`、`nodeIntegrationInSubFrames`、
  `enableBlinkFeatures` 均为零。
- **webview 三重收口**：`will-attach-webview` 删除渲染层提供的 preload、固定 guest 安全选项、
  分区必须匹配真实店铺（`persist:store_<id>` 且 `getStore` 可查）、src 过白名单，
  不过即 `preventDefault` 并落日志（`main/index.ts:232-266`）。
- **客服 guest 二次收口**：`did-attach-webview` 后对 guest 的导航/重定向/弹窗全部走
  平台白名单，弹窗改页内导航（保留扫码/OAuth 流程不产生未受控窗口，`main/index.ts:296-330`）。
- 主窗口自身 `will-navigate` 只放行本地 UI（打包态精确到 index.html 本身+hash/query）、
  `window.open` 一律 deny（`main/index.ts:336-363`）——bridge 不会被导航投递给远程内容。

**发现**
- **R-1（P3）**：主窗口 `webviewTag: true` 全局开启，而全仓仅 3 个 Vue 组件使用 `<webview>`。
  当前 attach 收口严格、风险受控；长期方向是迁 `WebContentsView`（渲染层零标签注入）。
- **R-2（info）**：客服页面显式关闭 `backgroundThrottling` 保实时接待，经营页面保持节流
  （`main/index.ts:243-246`）——分场景处理正确。

## 二、事件处理

**已到位**
- 89 处 `executeJavaScript` 注入全部模块化（`element-anchor-js` / `element-probe` /
  `fingerprint-injector`），主世界注入不暴露任何 Electron/IPC 句柄（`fingerprint-injector.ts:90`）。
- 指纹注入的 debugger attach **仅限本应用创建的 WebContents**；任一字段注入失败如实标记
  "未验证"，不伪造（文件头注释与实现一致）。
- 后台采集借用页面有**租约账本**（`page-lease.ts`，纯状态机可单测）：三判据（我们开的 /
  引用归零 / 用户未接手）全满足才关页——2026-10-02「采集完不关页」问题的正确解法。

**发现**
- **E-1（P3）**：`(mainWindow.webContents as any).on('did-attach-webview')` 与
  `(sess as any).__chHooked` 两处 `any` 断言绕过类型检查（`main/index.ts:278`、
  `session-manager.ts:69`）。建议收窄为 WeakSet/具名类型，防未来重构踩空。

## 三、网络请求

**已到位**
- **图片下载三层 SSRF 防护**（`product-media-service.ts:73-121`）：手动跟重定向且**逐跳**
  重新校验 scheme 与私网地址、magic bytes 嗅探、10MB 上限、SVG 明确拒绝（可内嵌脚本）。
- **UA-CH 成对改写**：改 UA 必同步 `sec-ch-ua*` 三个头，且仅作用于该店铺 session
  （`session-manager.ts:37-72`）——杜绝"只改 UA 自相矛盾"。
- **权限收口成对实现**（request + check，Electron 文档明确要求成对才完整），设备权限
  （HID/串口/USB）直接拒绝、屏幕共享**故意不设 handler**（Electron 未设即拒绝，安全默认），
  默认 session 也补同一套（`session-manager.ts:55-129`）。
- **证书错误**：未设 `setCertificateErrorHandler` → Chromium 默认拒绝无效证书——这是正确
  现状，防止未来有人"顺手"加忽略逻辑。

**发现**
- **N-1（P2）**：无指纹档案的店铺 session 会保留默认 UA（含 `ShopPilot/x Electron/44`
  痕迹）。新建店铺由 `ensureProfileForStore` 自动播种干净 Chrome UA
  （`profile-manager.ts:87-110`，UA 与 Chromium 版本对齐）已覆盖主路径，但**存量/档案被删**
  的店铺在 `configureSession` 的 `if (profile?.user_agent)` 处直接跳过（`session-manager.ts:341`）。
  建议：无档案时兜底 `setUserAgent`（用 `process.versions.chrome` 拼同版干净 UA），一行改动
  关闭痕迹口子。
- **N-2（P3）**：UA-CH 的 `onBeforeSendHeaders` 作用于 session 全量请求（含 `session.fetch`
  的图片下载）。当前只改 3 个 `sec-ch-ua*` 头、语义无害；未来往 handler 里加逻辑时需
  意识到影响面是"该 session 的所有请求"。

## 四、本地存储

**已到位**
- 分区策略：`persist:store_<storeId>` 持久化；仅彻底删除店铺时 `persist:false` 清空
  （`shop-session-manager.ts:300-331`），登录态与数据的生命周期清晰。
- **Cookie 快照安全**：经 `safeStorage` 加密落盘；**加密能力暂不可用时拒绝明文落盘且保留
  旧快照**（`session-persistence.ts:55-66`）——"一次短暂不可用就永久删掉可恢复登录态"
  的坑被明确防住。
- **下载文件名净化**：basename 防穿越、Windows 非法字符/控制字符、保留设备名
  （CON/NUL/COM1）、结尾点空格（`session-manager.ts:113-130`）；下载完成用
  `shell.showItemInFolder` 展示而非自动打开执行（`download-manager.ts:121`）。
- 快照写入有 per-(store,scope) 队列与代数控制（`session-persistence.ts:104-113`），并发
  快照不会互相覆盖。

**发现**
- **S-1（P2）**：各店 partition 的磁盘占用（HTTP 缓存 + localStorage + IndexedDB）随使用
  增长，目前**无占用可视化**——`clearStorageData` 按店/按 origin 的能力已在
  （`session-manager.ts:642`、`browser-handlers.ts:537`），建议在「数据与维护」或内存快照
  面板加"各店分区占用 + 一键清理"。
- **S-2（info）**：HTTP 缓存未设显式配额（Chromium 动态管理，单 session 默认上限内），
  当前规模可接受。

## 五、兼容性

- Electron 44.7.2（`release.json`）：webview tag、`session.fetch`、safeStorage 均为主干
  能力；`webviewTag` 在 44 仍受支持但属"建议迁移"路线（同 R-1）。
- 平台 URL 形态多样已被实测证实（拼多多登录页 `redirectUrl=…index.html` 曾干扰 CDP
  判定），webview src 白名单（`isAllowedWebviewSource`）与客服域边界是**持续维护点**，
  新平台/新入口需登记后放行——机制在，规则靠维护。
- CI 层出现 Node 20 弃用警告（actions 目标版本），属工具链而非产品；建议升级
  `actions/checkout` / `setup-node` / `pnpm/action-setup` 的目标 Node 版本（P3）。

## 六、改进建议汇总（按优先级）

| # | 级别 | 建议 | 位置 |
| --- | --- | --- | --- |
| 1 | P2 | 无指纹档案的 session 兜底设置干净 UA（消除 Electron 痕迹口子） | `session-manager.ts:341` |
| 2 | P2 | 分区磁盘占用可视化 + 一键清理入口（数据与维护页） | `browser-handlers.ts:537` 已有底座 |
| 3 | P3 | `any` 断言收窄（did-attach-webview / `__chHooked`） | `index.ts:278`、`session-manager.ts:69` |
| 4 | P3 | 长期：webview tag → WebContentsView 迁移评估 | `index.ts:221` |
| 5 | P3 | CI actions 目标 Node 升级，消弃用警告 | `.github/workflows` |

## 七、确认正确的"不作为"（防未来误改）

1. 未设证书错误忽略 handler——Chromium 默认拒绝，正确。
2. 屏幕共享未设权限 handler——Electron 未设即拒绝，设错反而放行，故留空。
3. Cookie 快照加密不可用时**不覆盖**旧快照——宁可保留旧登录态也不明文落盘。
4. 弹窗统一 deny 并页内加载——不产生未受控原生窗口。

---

## 修复记录（2026-10-16 上午，全部完成）

| # | 建议 | 状态 | 提交 |
| --- | --- | --- | --- |
| 1 | P2-1 无档案 session 兜底干净 UA | ✅ `ua-fallback.ts` 纯函数 + `configureSession` 无条件 setUserAgent（UA-CH 幂等改用 WeakSet） | `bc83d80` |
| 2 | P2-2 分区占用可视化 + 清理 | ✅ `partition-usage.ts` + IPC `BROWSER_PARTITION_USAGE/_CLEAN` + 设置中心维护页「店铺分区存储」组（每店占用 + 保登录态清理 + 审计 `browser.partition.clean`） | `bc83d80` |
| 3 | P3-3 any 断言收窄 | ✅ did-attach-webview 直接删 as any（类型本就存在）；`__chHooked` → WeakSet | `bc83d80` |
| 4 | P3-4 webview → WebContentsView | ⏸ **决策：暂缓**——涉及 3 组件 + window-manager 重构，当前 attach 收口严格、风险受控；列入技术债清单 | — |
| 5 | P3-5 CI actions Node 升级 | ✅ checkout/setup-node v4→v5（pnpm/action-setup v4 暂无 node24 版） | `bc83d80` |
| — | 附加 | 编辑器条码字段 + CSV 导入模板下载（§3.3/§4.6 规格收尾） | `5e8964d` |

**修复过程中测试抓到的两个真问题**：
1. `statSync` 会跟随符号链接（`isSymbolicLink` 恒 false）——分区统计在 Linux CI 上把链接指向的
   字节计入（377→477）。改用 `lstatSync(…, { throwIfNoEntry: false })` 判定，链接不计。
2. 兜底 UA 初版写了 `if (userAgent !== sess.getUserAgent())` 才挂 UA-CH 钩子——`setUserAgent`
   之后两者必然相等，钩子永远不会挂。改为无条件挂（幂等由 WeakSet 保证）。

验证：本地全量 138 文件 1393 用例绿 + CI 全绿（`eabc416`）；应用已用含修复的包重启。
