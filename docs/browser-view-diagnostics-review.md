# 浏览器视图诊断功能代码审查报告

审查时间：2026-10-16　基线：`683cf88`（v0.4.68，HEAD）　工作区状态：被审浮层文件无未提交改动

> 审查对象是店铺浏览器视口内的浮层「浏览器视图诊断」（`data-test="webview-diagnostics"`）：
> 它负责把「店铺页面还没就绪 / 注册失败」如实告诉用户，并提供「重试」。
>
> **审查期间发生的并行改动（已纳入审查）**：11:29 出现提交 `fdb9cee`
> 「视图体检——内存诊断新增 views 视图级探针（loading/挂起/崩溃，带超时防卡死）+ 维护页「视图体检」按钮」，
> 其代码注释把该功能称为 **"视图体检（浏览器视图诊断：每视图 loading/挂起/崩溃）"**——也就是说现在仓库里有**两个**
> 都叫「浏览器视图诊断」的东西：页面浮层（第一~三节）与设置中心「数据与维护 → 视图体检」（第四节）。
> 该提交随后被 `reset`（HEAD 回到 `683cf88`），**但视图体检的代码仍在工作区/暂存区**（`git status`：两个文件 `M`），
> 本报告对它的行号引用按工作区内容给出。该提交只改了视图体检相关文件，没有改动浮层（`DashboardBrowserSurface.vue`
> 最后修改时间仍是 2026-10-15），浮层的全部行号引用在 reset 前后均成立。

---

## 一、审查范围

| 层 | 文件 | 关键位置 |
| --- | --- | --- |
| 渲染层（被审主体） | [DashboardBrowserSurface.vue](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue) | 模板 63-69（浮层）、445-460（诊断计算）、462-527（注册/重试/失败/销毁）、1211-1216（卸载）、1282-1286（样式） |
| 渲染层状态源 | [workspace.ts](apps/desktop/src/renderer/src/stores/workspace.ts) | 208-218（`BROWSER_TAB_UPDATED` → `tabsByStore`，`guestAttached` 的来源） |
| 主进程视图管理 | [window-manager.ts](apps/desktop/src/main/browser/window-manager.ts) | 336-360（`tabSnapshot`/`emitTabs`）、697-750（`registerWebview`）、800-905（`attachGuestWebContents`）、913-929（`detachGuestWebContents`） |
| 主进程 IPC / 安全边界 | [browser-handlers.ts](apps/desktop/src/main/ipc/browser-handlers.ts)、[index.ts](apps/desktop/src/main/index.ts)、[family-handle.ts](apps/desktop/src/main/ipc/family-handle.ts)、[envelope.ts](apps/desktop/src/main/ipc/envelope.ts) | 49-68、95-109、605-618；232-269（`will-attach-webview`） |
| 规范依据 | [FUNCTIONAL_SPEC.md](docs/FUNCTIONAL_SPEC.md)、[DEVELOPMENT_SPEC.md](docs/DEVELOPMENT_SPEC.md) | 75（页面加载失败卡片）、831（`BrowserViewport` 职责） |
| 既有测试 | [webview-embedding-boundary.test.ts](tests/unit/webview-embedding-boundary.test.ts)、[collection-page-isolation.test.ts](tests/unit/collection-page-isolation.test.ts)、[m1-cdp-verify.js](tools/acceptance/m1-cdp-verify.js) | 138 行 / 37-40 / 211-244 |
| 同名第二处（工作区改动，原提交 `fdb9cee`） | [window-manager.ts](apps/desktop/src/main/browser/window-manager.ts)、[UnifiedSettingsPage.vue](apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue) | 1516-1581、1631-1637；141-151、301-327 |

**方法**：通读该浮层及其全部输入（`webviewFailures`、`webviewAttached`、主进程 `guestAttached` 生命周期、`will-attach-webview` 拒绝路径）→ 逐条对照规范要求 → 用 Electron 44.7.2 自带类型定义核对事件契约（`DidFailLoadEvent.isMainFrame`、`did-fail-load` 的"取消"语义）→ 全仓检索测试覆盖与日志出口 → **两轮独立对抗性复核**（要求复核者专门去证伪每条结论）。

复核的净效果：推翻初稿两处过头的措辞（第 1 条的"绝对不可达"、第 7 条的"零断言"），补出第 8 条的第二半（取消型加载、失败清除按 tab 而非按帧），并**证伪了一条候选结论**——"店铺被彻底删除后仍留在 `openStoreIds`，元素重建时被 `will-attach-webview` 拦下 → 永久'正在连接'"：`closeStoreBrowser` 在 `browserStates.delete(storeId)` 之后仍会 `emitTabs(storeId)`（window-manager.ts:505-521），此时发的是 `tabs: []`，渲染层随即把该店铺移出 `openStoreIds`（workspace.ts:215-217），所以这条路径不成立，未写进报告。

**未做的部分（诚实声明）**：本机沙箱禁止 Node 子进程管道，`vitest run` 在加载配置阶段即因 esbuild `spawn EPERM` 失败（属环境限制，不是用例失败），因此**本轮结论全部来自代码路径推导与类型定义核对，没有运行时复现**。未启动应用、未接触真实店铺数据。

---

## 二、结论摘要

| # | 级别 | 问题 | 位置 |
| --- | --- | --- | --- |
| 1 | **P1 正确性/规范** | 「页面加载失败」无法作为稳定诊断呈现：浮层被 `!webviewAttached` 过滤，而 `did-fail-load` 只会在注册成功（`guestAttached=true`）之后才可能发生；文案只能在重注册/detach 的窗口里随机闪出 | DashboardBrowserSurface.vue:450-460、517-522 |
| 2 | **P1 规范** | 规范要求的「页面错误卡片」（重试 / 检查代理 / 重新登录 / 清理站点数据）**没有实现**，该浮层是浏览器视口内唯一的错误界面 | FUNCTIONAL_SPEC.md:75、DEVELOPMENT_SPEC.md:831 |
| 3 | **P2 可用性** | 无超时看门狗：`did-attach` 不来（如 `will-attach-webview` 被拒）时永久停在「正在连接店铺页面…」，且因为 `failed=false` **连重试按钮都不渲染** —— 非可操作死局 | 450-460；index.ts:259-267 |
| 4 | **P2 正确性** | `retryWebview` 先删失败态再调注册；元素登记丢失时注册函数在 `if (!element) return` 静默返回 —— 重试会把「有原因 + 有按钮」变成「没原因 + 没按钮」 | 506-511、475-479 |
| 5 | **P2 正确性（潜伏竞态）** | `handleWebviewDestroyed` 不做元素身份校验就删登记；同一 key（同店同标签页）快速切走再切回时可先挂载新元素、后收到旧元素 `destroyed`，新元素的 `did-attach` 因此静默不注册（白屏 + 无诊断 + 无重试） | 524-527、462-473 |
| 6 | **P2 可观测性** | **没有人等这个页面时**，注册/加载失败一条日志都不落（`browserError` 不记日志；渲染层现成的 `console` → 主日志桥接没被用上）——诊断包里的 `app.log` 查不到 | browser-handlers.ts:49-68 |
| 7 | **P2 覆盖** | 失败路径零断言：唯一一条相关断言只钉住 `internal` 过滤，失败文案/重试/`isMainFrame`/超时全无覆盖 | collection-page-isolation.test.ts:37-40 |
| 8 | P3 | `did-fail-load` 判据太粗：未过滤 `isMainFrame`（子框架失败记成整页失败），且只豁免 `-3`（"被取消的加载"也会触发该事件） | 517-522、60 |
| 9 | P3 | 可访问性：`role="status"` 里嵌交互按钮；多条诊断的按钮同名「重试」，没有店铺上下文 | 63-68 |
| 10 | P3 | 浮层固定悬在页面左下且不可关闭，会盖住平台页面内容；条目覆盖所有已开店铺（后台店铺的失败显示在当前店铺视口上） | 63-69、1284 |
| 11 | P4 | `webviewRefCallbacks` 只增不减（`webviewEls` 却在卸载时清空），同一件事两种处理 | 407、462-473、1214 |
| 12 | **P2 正确性** | 同名的第二处「视图体检」（`fdb9cee`）里 `responsive:'error'` 不可达：**崩溃被显示成"卡死"**，界面专门为崩溃准备的标签永不出现 | window-manager.ts:1553-1561、UnifiedSettingsPage.vue:305-310 |
| 13 | P3 | 体检的 `stripQuery` 对非 http(s) 地址返回垃圾串（`about:blank`→`nullblank`、`chrome-error://…`→`nullchromewebdata`） | window-manager.ts:1565-1573 |
| 14 | **P2 设计** | 两处"浏览器视图诊断"互为盲区且口径不共享：浮层只看未挂载、体检只探已挂载，没有一张完整的视图状态表 | 第四节 V4 |

---

## 三、缺陷明细

### 1【P1·正确性/规范】「加载失败」无法作为稳定诊断呈现

**位置**：[DashboardBrowserSurface.vue:450-460](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L450-L460)、[:517-522](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L517-L522)

**证据链**（每一步都在代码里）：

1. 浮层只渲染 `.filter(item => !webviewAttached(item))` 的条目（450-453），`webviewAttached` 读的是 `ws.tabsByStore[storeId].guestAttached`（445-448）。
2. 主进程的 `guestAttached` 只在 `attachGuestWebContents` 里置 `true`（window-manager.ts:800-805），而它由 `registerWebview` 调用（:739）——也就是**注册成功的同一步**；`emitTabs` 就在同一个函数里发往渲染层（:888、352-360）。
3. 渲染层只有在 `await registerWebview(...)` 返回 `ok` 之后才真正导航：`element.loadURL(pendingUrl)`（:494-500）。
4. `did-fail-load` 只可能由 guest 的导航产生，因此**触发时 `guestAttached` 必为 `true`**（IPC 先发 tabs 事件再回 invoke 应答；即使顺序反转，`guestAttached` 一旦变真，浮层重算后同样会把这条失败丢掉——最乐观也只是闪一帧）。
5. 唯一让 `guestAttached` 变回 `false` 的路径是 `detachGuestWebContents`（:913-929），它同时销毁 guest；渲染层 `handleWebviewDestroyed`（:524-527）随即把失败清掉。

**结论**：`webviewFailures` 里那句 `加载失败（${errorDescription}）` **不能作为稳定的失败提示出现**：它写入的瞬间就被自己的过滤器排除，正常用户永远看不到；真正会稳定显示出来的只剩注册前的两条（「无法读取页面进程标识」`getWebContentsId()` 抛错、注册返回 `!ok`）。

**精确边界（免被误读为"绝对不可达"）**：只有在"标签页被 detach、`guestAttached` 已变 `false`、而该 key 上那条旧失败还没被清掉"的窗口里，文案才会短暂露出——例如 `registerWebview` 重注册路径 `detachGuestWebContents → await waitForSessionReady → attachGuestWebContents`（window-manager.ts:726-739）之间。但 `handleWebviewDestroyed`（元素卸载）与 `clearWebviewError`（`did-finish-load`）都会清掉这条记录，所以它既不稳定、也不及时，**顺序完全随机**。用户遇到 DNS 失败、代理失败、平台 5xx 时的稳定体验是**空白页 + 一无所有**——与「如实呈现失败」的项目口径相反。

**影响**：P1 —— 这是用户最常见的故障（网络/代理），却恰好是被掩盖的那一类；同时这是规范里「页面加载失败显示可操作的诊断卡片」缺口的直接原因（见第 2 条）。

**建议**：把「连接中」和「失败」拆成两份互不相同的门控——失败态**不**受 `webviewAttached` 约束：

```ts
// 仍叫 webviewDiagnostics，模板只多用一个 storeName（无障碍标签要用）
const webviewDiagnostics = computed(() => openWebviews.value
  .filter(item => !item.internal)
  .map(item => ({
    key: item.key,
    storeName: item.storeName,
    failure: webviewFailures[item.key] as string | undefined,
    attached: webviewAttached(item)
  }))
  .filter(row => !!row.failure || !row.attached)   // 关键：失败与「未就绪」是两个条件
  .map(row => ({
    key: row.key,
    storeName: row.storeName,
    failed: !!row.failure,
    text: row.failure
      ? `${row.storeName}：页面加载失败——${row.failure}`
      : `${row.storeName}：正在连接店铺页面…`
  })))
```

---

### 2【P1·规范】规范要求的「页面错误卡片」缺失

**位置**：浮层 [63-69](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L63-L69)；规范 [FUNCTIONAL_SPEC.md:75](docs/FUNCTIONAL_SPEC.md)、[DEVELOPMENT_SPEC.md:831](docs/DEVELOPMENT_SPEC.md)

- §3.3：「页面加载失败显示可操作的**诊断卡片：重试、检查代理、重新登录、清理当前站点数据**」。
- §17.1：`BrowserViewport` 的职责是「DOM `<webview>` 宿主容器、**页面错误卡片**与未注册诊断」——两件事，本实现只有后一件。

现状：视口内唯一的错误界面就是本浮层，且只有一句文案 + 一个「重试」。四个动作里只有 1 个存在，其余 3 个（检查代理 / 重新登录 / 清理站点数据）在别处也找不到浏览器页面级的入口（清理入口在右侧「环境」面板里，且是店铺级 Cookie 清理，不是「当前站点数据」）。

**建议**：与第 1 条一并做——失败卡片按规范给 4 个动作，其中「清理当前站点数据」复用已存在的 `window.shopilot.browser.clearData(storeId, types, origin)`（preload/index.ts:63），「检查代理」切到右侧环境页签（`panel = 'env'`），「重新登录」跳到店铺首页（`homeUrl`，已有 `goHome`）。

---

### 3【P2·可用性】没有超时看门狗，「正在连接…」可以是永久态且没有按钮

**位置**：[450-460](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L450-L460)；拒绝路径 [index.ts:259-267](apps/desktop/src/main/index.ts#L259-L267)

`will-attach-webview` 在分区非法 / 初始地址非法时 `event.preventDefault()`（index.ts:259-267，只写一条主进程 warn）。此时 Electron **不会创建 guest**，元素的 `did-attach` **永不触发** → `handleWebviewAttach` 一次都不跑 → `webviewFailures` 为空 → 浮层文案停在「正在连接店铺页面…」，而重试按钮的渲染条件是 `diagnostic.failed`（:67），因此**按钮不存在**。

即：唯一「元素在、但页面永远不来」的状态，恰好是这个浮层唯一帮不上忙的状态。项目里对同类问题已有教训（"把'诊断没输出'当成'没有更多信息'是错的——它更可能是诊断坏了"，docs/product-profiles.md:1154）。

对照：主进程侧对"等页面就绪"**已经有**明确的时间口径——`waitForTabWebContents` 超时 15s 后如实抛 `BROWSER_NOT_READY: 店铺标签页 guest 在 15000ms 内未注册`（[window-manager.ts:753-776](apps/desktop/src/main/browser/window-manager.ts#L753-L776)），任务会拿到一个诚实失败；只有界面这一侧是"无限等待且不告诉用户"。同一件事两套时间语义，建议对齐（界面 30s 略长于主进程的 15s，避免把"马上就绪"误报成失败）。

**建议**：元素挂载后起一个看门狗计时器（建议 30s，成功注册 / 卸载 / 销毁时清除），到点把 `webviewFailures[key]` 写成「超过 30 秒仍未就绪（可能被安全策略拦下）」，状态自然变成 `failed=true`，重试按钮随之出现；同时把「重新打开店铺」列为该状态的备选动作。

---

### 4【P2·正确性】重试会「先拆掉自己的按钮」

**位置**：[506-511](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L506-L511)、[:475-479](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L475-L479)

```ts
function retryWebview(key: string): void {
  const item = openWebviews.value.find(entry => entry.key === key)
  if (!item) return
  delete webviewFailures[key]          // 先把原因与按钮一起抹掉
  void handleWebviewAttach(item)       // 再去做可能根本做不了的事
}
```

`handleWebviewAttach` 的第一道门是 `const element = webviewEls.get(key); if (!element) return`（:478-479）——**静默返回，不写失败**。于是只要元素登记不在（典型来源是第 5 条的竞态：旧元素的 `destroyed` 把新登记删了），点一次「重试」的结果就是：诊断从「页面未就绪——<原因> + 重试」变成「正在连接店铺页面…」且**再无按钮**——本可以自救的入口被这一个点击关掉了。

**建议**：把「先删后做」改成「先判后做」，并且**任何提前返回都要留下可见状态**：

```ts
function retryWebview(key: string): void {
  const item = openWebviews.value.find(entry => entry.key === key)
  if (!item) return
  if (!webviewEls.get(key)) {
    webviewFailures[key] = '视图元素已卸载，请切换标签页或重新打开店铺'
    return                              // 保留 failed=true → 按钮还在
  }
  delete webviewFailures[key]
  void handleWebviewAttach(item)
}
```

同时把 `handleWebviewAttach` 的 `if (!element) return` 改为写入 `webviewFailures[key] = '视图元素缺失，未能注册页面'`。

---

### 5【P2·正确性·潜伏竞态】`destroyed` 不校验元素身份，可能删掉刚挂载的新登记

**位置**：[462-473](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L462-L473)、[:524-527](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L524-L527)、[:49-50](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L49-L50)

`v-for` 的 key 是 `${storeId}:${tabId}`（:48、:421），所以「切走再切回同一个标签页」会**复用同一个 key**。Vue 在 patch 时同步调用 ref 回调（新元素写入 `webviewEls[key]`），而旧元素的 `destroyed` 是 Electron 在 guest 真正销毁后异步派发的；`handleWebviewDestroyed` 只拿到 `item`，**不校验这个事件属于哪个元素**就直接 `webviewEls.delete(item.key)`。若旧事件后到，它会删掉新元素的登记；随后新元素的 `did-attach` → `handleWebviewAttach` → `if (!element) return` 静默不注册。

后果：标签页永远白屏，**既没有诊断也没有重试按钮**（`failed=false`）——与 2026-09-29 修过的「点了没反应，现场只剩一个空白页」是同一类现象。

说明：`webviewEls` 是纯渲染层登记，主进程 `guestAttached` 仍是权威；两者不一致时本浮层会**说反话**（主进程认为该页就在，浮层却说"正在连接"）。渲染层对「元素登记」的维护依赖 Vue 的 ref 回调（卸载时会以 `null` 调用），这条路径是可靠的；多余的那次 `delete` 才是风险源。

**建议**：`destroyed` 只管失败态与看门狗，**不再管登记**：

```ts
function handleWebviewDestroyed(item: OpenWebviewEntry): void {
  delete webviewFailures[item.key]
  clearAttachWatchdog(item.key)
  // 不再 webviewEls.delete(item.key)：同一 key 的新元素可能已经挂上，
  // 登记的增删统一交给 Vue 的 ref 回调（挂载给元素 / 卸载给 null）
}
```

---

### 6【P2·可观测性】「没有人等这个页面」时，注册/加载失败一条日志都不落

**位置**：[browser-handlers.ts:49-68](apps/desktop/src/main/ipc/browser-handlers.ts#L49-L68)、[window-manager.ts:697-750](apps/desktop/src/main/browser/window-manager.ts#L697-L750)

- `browserError` 只映射错误码与文案，**不写日志**；`registerWebview` 的抛错路径也没有 `logMain`（只有"guest 被重新注册"这一条 warn，:733）。
- `ipcErrFromUnknown` / `ipcFail` 仅在文案命中「内部细节形状」时才记一条 warn（envelope.ts:56-67、73-89）；`BROWSER_NOT_READY: 店铺标签页 guest 在 15000ms 内未注册` 属于**干净文案**，直接透出、不记日志。
- 该组件不写任何 `console.*`：渲染层的 `console.warn/error` **是**有桥接到主日志的（main/index.ts:397-399，`level >= 2` 才记，前缀 `renderer: `），但这条现成通道没被用上，于是 `webviewFailures` 只活在这一次渲染进程的内存里。

**准确范围**：不是"全链路无痕"。会主动等页面的链路留下了痕迹——`product-sync-service.ts:162` 的 warn + :166 的 `PAGE_NOT_READY`、`sales-metrics-collection-service.ts:318/:322` 同理。真正的盲区是**没人等的时候**：用户只是点开一家店铺、看到白屏或"正在连接…"，此时诊断包里导出的 `app.log` 查不到「哪个店铺、哪个标签页、因为什么没就绪」，现场只剩界面上一行字，重启即消失。

**建议**：① `registerWebview` 失败分支写 `logMain('warn', '[webview] register failed store=… tab=… reason=…')`（沿用既有脱敏口径）；② 渲染层失败态同时 `console.warn('[webview-diagnostics] …')`，直接用上已有的桥接；③ 在 `attachGuestWebContents` 里补一个主进程侧 `did-fail-load` 监听（只记主框架、非取消），让"页面加载失败"在日志与诊断包里也有痕迹——目前店铺页在主进程**没有**这个监听（只有 `customer-message-monitor.ts:173`、`password-dialog.ts:82` 有）。

---

### 7【P2·覆盖】失败路径零断言（唯一一条断言只钉住了 `internal` 过滤）

全仓检索 `webview-diagnostics` / `webviewDiagnostics` / `webviewFailures`，测试侧**只命中一处**：
[collection-page-isolation.test.ts:37-40](tests/unit/collection-page-isolation.test.ts#L37-L40) 用
`expect(SURFACE).toContain('.filter(item => !item.internal)')` 钉住了"采集专用页不进诊断"这一条——
也就是说这条**排除规则**被保护着，而被排除之外的一切（失败文案的渲染条件、重试语义、`isMainFrame`、超时）都没有断言。

- [webview-embedding-boundary.test.ts](tests/unit/webview-embedding-boundary.test.ts) 是这套嵌入架构的源码级回归网（14 条断言），覆盖 `did-attach`、`pendingUrl`、`loadURL`、`opacity` 隐藏……**唯独没碰诊断浮层**（`vitest.config.ts:12` 的 `include: ['tests/unit/**/*.test.ts']` 保证它确实在跑，所以加断言即生效）。
- [m1-cdp-verify.js:211-244](tools/acceptance/m1-cdp-verify.js#L211-L244) 已经会等 webview 元素并读 `guestAttached`，是最自然的落点，但也没断言过 `[data-test="webview-diagnostics"]`。

这正是本报告第 1、3、4、5 条能长期存活的原因：**没有任何一条断言会因为诊断坏掉而变红**（而"诊断坏了"恰恰是本仓库自己记录过的教训）。

**建议**（改完必须同时补，否则等于没改）：
- 源码级：`expect(SURFACE).toContain('isMainFrame')`、`expect(SURFACE).toContain('ATTACH_TIMEOUT')`、`expect(SURFACE).not.toMatch(/handleWebviewDestroyed[\s\S]{0,200}webviewEls\.delete/)`、失败态不得再被 `!webviewAttached` 过滤。
- 验收级：在 m1 里制造一次可复现的失败（注册前把元素摘掉 / 指向不可达地址），断言浮层出现失败文案且**存在**重试按钮。

---

### 8【P3】`did-fail-load` 的判据太粗：子框架失败与"被取消的加载"都会记成整页失败

**位置**：[:517-522](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L517-L522)、[:60](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L60)、[:513-515](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L513-L515)

- **未过滤子框架**：Electron 44.7.2 的类型定义里 `DidFailLoadEvent` 明确带 `isMainFrame: boolean`（`electron.d.ts`），而处理器只读 `errorCode` / `errorDescription`。修好第 1 条之后，被广告/统计/第三方登录 iframe 失败污染的「整页加载失败」就会真的显示给用户。
- **只豁免 `-3` 不够**：Electron 对 `did-fail-load` 的定义是"fired when the load failed **or was cancelled**, e.g. `window.stop()` is invoked"（`electron.d.ts:20088-20091`）。页面自己调用 `window.stop()`、重定向打断的临时加载等取消型事件也会进来，只挡 `ERR_ABORTED(-3)` 会把"用户按了停止/被重定向"记成加载失败。建议按 `isMainFrame === false` + 取消型错误码（`-3`、`ERR_ABORTED` 家族）一起过滤。
- **失败态的清除也是按 tab 而非按帧**：`clearWebviewError` 绑在 `did-finish-load`（:60）上，key 是 `storeId:tabId`；主框架加载完成会顺手清掉一条子框架失败记录，反之亦然。

目前这些都被第 1 条掩盖着，属于「修 A 必须同时修 B」的连带项——否则第 1 条一改，浮层就会开始报假警。

---

### 9【P3】可访问性

**位置**：[:63-68](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L63-L68)

- `role="status"` 是 live region（隐式 `aria-atomic="true"`），里面却放了可交互的 `<button>`；每次任意店铺状态变化都会把整段内容（含按钮）重新播报。建议：live region 只包文本，按钮移出 region，或显式 `aria-atomic="false"`。
- 多条诊断时每个按钮的可访问名都是「重试」，没有店铺上下文；建议 `:aria-label="`重试连接 ${diagnostic.storeName}`"`。
- 焦点可见性：`.mini-btn:focus-visible` 只改边框色 + `outline: none`（:1341），在浮层的浅黄底上偏弱；规范 §17.2 要求"关键按钮必须支持键盘访问、焦点可见"。
- 文字对比度实测**合格**：`#92400e` on `#fff8ec` ≈ 6.7:1，标题 `#7a3d0a` ≈ 8.0:1，均高于 AA 4.5:1（此处不是问题，只为免去后来者重复核算）。

### 10【P3】浮层的空间与作用域

**位置**：[:63-69](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L63-L69)、[:1284](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L1284)

- 固定在视口左下（z-index 3，高于活动 webview 的 z-index 1），**遮住页面内容且无法关闭/收起**；平台后台左下角常见有客服/悬浮控件。建议失败态保留、连接中态可折叠或改为顶部细条。
- 条目来自 `openWebviews`（:412-443，遍历所有 `ws.openStoreIds`），所以**后台店铺**的连接中/失败也会画在当前店铺的视口上。文案带店铺名（:458），不算歧义，但"给一个看不见的视图显示重试按钮"值得再确认是否符合预期（对照：采集专用页已按"用户没让它出现就不该闪"的理由排除，:451-452）。

### 11【P4】`webviewRefCallbacks` 只增不减

**位置**：[:407](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L407)、[:462-473](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L462-L473)、[:1211-1216](apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue#L1211-L1216)

`webviewEls` 在卸载时清空、在 `destroyed` 时删除，`webviewRefCallbacks` 却没有任何清理点：一次会话里开过的每个 `storeId:tabId` 都会永久留下一个闭包（跨店铺关闭、标签页关闭都不回收）。绝对量很小，但同一件事（元素登记）两套生命周期，属于第 5 条同类问题的温床。建议封装成一个 `attachElement(key, element)` 并在 `null` 时同时清两个 Map。

---

## 四、「视图体检」（工作区改动，原提交 `fdb9cee`）——同名的第二处"浏览器视图诊断"

**位置**：[window-manager.ts:1516-1581](apps/desktop/src/main/browser/window-manager.ts#L1516-L1581)（`ViewProbe` / `probeView` / `stripQuery` / `withTimeout`）、[:1631-1637](apps/desktop/src/main/browser/window-manager.ts#L1631-L1637)（并发探针）、[UnifiedSettingsPage.vue:141-151](apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue#L141-L151)、[:301-327](apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue#L301-L327)

它做对的部分值得先说清楚：URL 去查询串（不泄漏 token/redirect 参数）、`file:` 地址不回显、探针带 3s 超时（挂起的 renderer 不会卡住诊断本身）、并发探测不短路、探针只读（`executeJavaScript('1')`）。

### V1【P2·正确性】`responsive: 'error'` 不可达 —— **崩溃会被报成"卡死"**

```ts
let responsive: ViewProbe['responsive'] = 'error'      // 1553：被 1558 覆盖，永不生效
try {
  responsive = await withTimeout(wc.executeJavaScript('1', true), VIEW_PROBE_TIMEOUT_MS)
    .then(() => 'ok' as const, () => 'hung' as const)   // 1558：两条分支都被转成"成功"，await 永不抛
} catch { responsive = 'error' }                        // 1559-1561：死代码
```

`.then(onFulfilled, onRejected)` 把**超时、销毁、求值异常**全部归成 `'hung'`，所以外层 `catch` 永远不执行；类型注释（1526-1532）写的 `'error' = 求值抛异常（含已崩溃进程）` 与实现不符。唯一能产出 `'error'` 的是 1540-1542 的"探测前就已销毁"分支。

后果在界面侧放大：[UnifiedSettingsPage.vue:305-310](apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue#L305-L310) 里 `'error'` 对应「❌ 崩溃/异常」，`'hung'` 对应「⏱ 卡死」。于是**renderer 崩溃（`executeJavaScript` 会 reject）、探针执行期间页面被销毁，都会显示成"卡死"，而专门为崩溃准备的那一档永远不出现**——该功能宣称能区分"loading/挂起/崩溃"，实际只能区分"loading/非 loading 且不响应"。

**建议**：把"超时"与"其他拒绝"分开，并让后者带上可读原因（可以在 `ViewProbe` 上加一个可选 `reason`）：

```ts
let responsive: ViewProbe['responsive']
let reason = ''
try {
  await withTimeout(wc.executeJavaScript('1', true), VIEW_PROBE_TIMEOUT_MS)
  responsive = 'ok'
} catch (error) {
  const message = String((error as Error)?.message || error)
  if (message === 'timeout') {
    responsive = 'hung'                 // 渲染主线程超时未响应
  } else {
    responsive = 'error'                // 进程消失 / 求值失败（含已崩溃、探针期间被销毁）
    reason = message.slice(0, 120)
  }
}
```

### V2【P3】`stripQuery` 对非 http(s) 地址返回垃圾字符串

`stripQuery`（1565-1573）只特判了 `file:`，其余一律 `origin + pathname`。实测（Node 24）：

| 输入 | 输出 |
| --- | --- |
| `about:blank` | `nullblank` |
| `chrome-error://chromewebdata/` | `nullchromewebdata` |
| `https://fxg.jinritemai.com/ffa/mshop/homepage/index?token=abc` | `https://fxg.jinritemai.com/ffa/mshop/homepage/index` ✓ |

前两行恰好是**最需要看清的场景**：刚挂上还没导航（about:blank）、以及加载失败落到 Chromium 错误页。界面会把这两个字符串直接显示给用户。建议对非 `http(s):` 协议单独给可读文案（`about:blank` → 「空白页」、`chrome-error:` → 「加载失败页（Chromium 错误页）」）。

### V3【P3】超时不取消底层求值；`title` 原样带出

- `withTimeout`（1576-1581）只是让外层先失败，底层 `executeJavaScript` 的 promise 仍挂着（真挂死的 renderer 上每次点击都留一个 pending promise）。量级很小，但"超时"并不等于"停止"。
- `title` 未做处理（1549），而页面标题可能带订单号/买家昵称；`url` 已经去查询串（做对了）。内存/体检面板是应用内只读、不落盘也不进诊断包，风险低，但建议在注释里写明这条口径，避免后来者把它接进导出链路。

### V4【P2·设计】两处"浏览器视图诊断"互为盲区，且口径不共享

- 浮层只在 **`guestAttached === false`** 时说话（第 1 条），一旦挂上就再不报告任何问题；
- 体检只探 **已挂载** 的 guest（1631-1637 的 `tab.guestAttached && …` 过滤），未挂载的视图**连一行都不显示**；若当前没有已挂载视图，界面给的是 `当前没有已挂载的店铺视图` 的 toast（UnifiedSettingsPage.vue:319）——用户刚在浮层看到"正在连接店铺页面…"，转头体检得到的结论读起来像"一切正常"。

也就是说：**浮层覆盖"没挂上"，体检覆盖"挂上了但不响应"，两者的盲区正好互为对方的领地，却没有任何一处地方把它们拼成一张完整的视图状态表。**

**建议**：抽一份共享的「视图状态」定义（未挂载/连接中 · 已挂载-加载中 · 已挂载-正常 · 已挂载-卡死 · 已挂载-崩溃 · 加载失败），浮层与体检都从它渲染；体检对"未挂载"的视图也要成行输出（`destroyed: true` 已有这条语义，正好复用）。

### V5【P2·覆盖】新功能同样零断言

`fdb9cee` 只改了实现与界面，没有加任何测试；全仓检索 `ViewProbe` / `probeView` / `responsive` 在测试目录无命中（`tools/acceptance/memory-occupancy-probe.js` 是既有内存探针验收脚本，是最自然的落点）。V1 那个"崩溃报成卡死"的分支如果有断言，本可以在提交时就挡住。

---

## 五、修复顺序建议

| 顺序 | 内容 | 理由 |
| --- | --- | --- |
| 1 | 第 1 + 2 + 8 条一起做：失败卡片与「连接中」分门控、补 4 个规范动作、区分 `isMainFrame` 与取消型错误码 | 改的是同一个计算属性与同一个事件处理器，分开改会互相打架（只修第 1 条会让浮层开始报假警） |
| 2 | 第 4 + 5 条：重试语义与元素登记（`destroyed` 不再删登记） | 决定"白屏时用户还能不能自救"，且互相咬合 |
| 3 | 第 3 条：看门狗超时 | 补上唯一"没有失败也没有成功"的死角 |
| 4 | V1（崩溃 vs 卡死）+ V2（URL 文案）+ V4（统一视图状态模型） | 体检刚落地，趁口径还没扩散；V4 决定 1-3 条改完后的最终形态 | 
| 5 | 第 6 + 7 + V5 条：主进程/渲染层日志 + 源码级/验收级断言 | 让前面所有修复以后退不回去（仓库既有做法：`tests/unit/webview-embedding-boundary.test.ts` + `tools/acceptance/m1-cdp-verify.js` + `tools/acceptance/memory-occupancy-probe.js`） |
| 6 | 第 9、10、11 条：可访问性、浮层位置、登记清理、`withTimeout` 不取消底层 promise | 体验与整洁度，可独立提交 |

---

## 六、复核要点（给验收者）

改完后，下面 5 个场景应当各自有明确的界面与日志表现，缺一个都说明诊断仍在"说谎"：

1. 店铺页面对一个不可达域名导航 → 视口出现失败卡片（含原因）+ 重试，日志有 `did-fail-load` 记录；
2. 让 `will-attach-webview` 拒绝一次（非法分区/地址）→ 30 秒内从"正在连接"变为失败卡片，而不是永久等待；
3. 快速 A→B→A 切标签页 20 次 → 每次都能正常注册（不出现"白屏且无诊断"）；
4. 导出诊断包 → `app.log` 里能查到上述失败的店铺/标签页/原因，且不含凭据（沿用既有脱敏口径）；
5. 「视图体检」：① 在店铺页面控制台执行长阻塞脚本（`while(true){}` 级）后体检 → 显示「卡死」；② 用 `wc.forcefullyCrashRenderer()` 制造崩溃后体检 → 必须显示「崩溃/异常」而不是「卡死」；③ 刚打开还没导航的店铺 → 显示「空白页」而不是 `nullblank`。

---

## 七、修复记录（2026-10-16）

**分工说明**：修复期间有另一个会话在按本报告顺序并行改（提交 `fdb9cee`，随后被 reset，代码留在工作区）。它先落地了第 1、2、3、4、5 条、第 6 条的主进程侧、第 8 条的 `isMainFrame`、第 9 条的 aria-label；本次在此基础上补齐第 4 组（V1/V2/V4）与第 6/8/9/10/11 条的剩余部分，并在验收该批次时修掉 3 处缺陷（见下）。

| 条目 | 状态 | 落点 |
| --- | --- | --- |
| 1 失败态不受 `guestAttached` 约束 | ✅ | `DashboardBrowserSurface.vue` 的 `webviewDiagnostics`（三段式：map → filter → map） |
| 2 规范要求的 4 个动作 | ✅ | 失败卡片：重试 / 检查代理 / 重新登录 / 清理站点数据（`focusDiagnosedStore` / `openProxyPanel` / `reopenHome` / `clearSiteData`） |
| 3 attach 看门狗 | ✅ | `ATTACH_TIMEOUT_MS = 30_000` + `startAttachWatchdog` / `clearAttachWatchdog` |
| 4 重试先判后做 | ✅ | `retryWebview` 元素缺失时保留失败态；`handleWebviewAttach` 元素缺失不再静默返回 |
| 5 `destroyed` 不删元素登记 | ✅ | `handleWebviewDestroyed` 只管失败态与看门狗，登记交给 Vue ref 回调 |
| 6 失败落日志 | ✅ | 主进程：`[webview] load failed` + `[webview] register failed`；渲染层：`console.warn('[webview-diagnostics] …')`（走既有 `console-message` 桥接） |
| 7 / V5 回归断言 | ✅ | 新增 [browser-view-diagnostics.test.ts](tests/unit/browser-view-diagnostics.test.ts)（24 例：真值表 + 接线）；并行会话在 `webview-embedding-boundary.test.ts` 另加 7 条 |
| 8 子框架 + 取消型加载 | ✅ | 判据收敛到 `@shared/view-state.classifyLoadFailure`，主进程与渲染层同源（内联的 `code === -3` / `isMainFrame === false` 两份实现已删除） |
| 9 可访问性 | ✅ | live region 只包文本、按钮移出；每个按钮带店铺名 `aria-label`；`focus-visible` 显式描边 |
| 10 浮层盖页面 | ✅（部分） | 可收起 + 标题栏显示失败条数；条目仍覆盖所有已打开店铺（带店铺名），未改成"只显示当前店铺" |
| 11 `webviewRefCallbacks` 回收 | ✅ | `watch(openWebviews)` 回收已消失的 key；`onBeforeUnmount` 清空闭包与全部看门狗 |
| V1 崩溃 ≠ 卡死 | ✅ | `probeResponsiveness` 按 `classifyProbeFailure` 分流（超时 → `hung`，进程消失/求值失败 → `crashed` + `reason`）；删掉让 `error` 不可达的 `.then(ok, hung)` |
| V2 地址可读 | ✅ | `formatViewUrl` 取代 `stripQuery`：`about:blank` → 空白页、`chrome-error:` → 加载失败页、非 http(s) 走协议兜底（不再有 `nullblank` / `nullchromewebdata`） |
| V3 超时不取消底层求值 | ✅（注释） | `withTimeout` 写明"超时≠取消"，只保证诊断自身不卡住 |
| V4 统一视图状态口径 | ✅ | 新增 [view-state.ts](packages/shared/src/view-state.ts)：状态词表 + `classifyLoadFailure` + `formatViewUrl` + `classifyProbeState`；体检**含未挂载视图**（`attached` 字段），设置页用 `BROWSER_VIEW_STATE_LABEL[v.state]` 渲染 |

### 验收该批次时发现并修掉的 3 处缺陷

1. **「清理站点数据」永远失败**：并行批次传的是 `['localstorage','indexdb','cachestorage','serviceworkers','filesystem']`，而 `packages/shared/src/schemas/browser.ts` 的白名单只有 `['cookies','cache','localStorage','downloads']`（大小写敏感、最多 4 项）→ 每次点击都返回"数据清理参数不合法"。改为 `['localStorage','cache']`（main 侧 `localStorage` 一项即覆盖 localstorage + indexeddb，且不动 Cookie）。
2. **「重新登录」会导航错店铺**：原实现用 `ws.navigate(url)`，而该 action 走 `displayedStoreId`——诊断条目可能属于后台店铺，等于把**另一家店**的页面导航走（正是 §3.3 明令要防的跨店误操作）。改为先 `focusDiagnosedStore(storeId)`，再用 `browser.navigate(storeId, tabId, url)` 落到被诊断的那个店铺/标签页。
3. **设置页 `storeMap` 未定义**（`vue-tsc: Cannot find name 'storeMap'`）：`viewStoreName()` 引用了不存在的变量，会在渲染体检结果时抛错。改为从 `ws.stores` 查名字，取不到退回 id 前缀。

### 验证基线（本次实测）

- `tsc --noEmit`：**exit 0**。
- `vue-tsc --noEmit`：8 处错误，**全部是 HEAD 既有**（`ProductEditorDrawer.vue` 6 处 + `DashboardBrowserSurface.vue:308` 2 处，后者在 HEAD 里就是邀请实时日志那行）；本次改动新增 0 处、并修掉并行批次引入的 1 处。
- `eslint`（全部改动文件）：**0 error**，39 warning（全是既有 `no-explicit-any`）。
- `vitest run`（全量）：**139 个文件 / 1424 个用例全部通过，exit 0**。其间出现过一次 `sales-metrics-scheduler.test.ts` 收尾竞态导致的 exit 1（用例本身全过，与本报告范围无关，本仓库既有记录见 [invoice-module-review.md](docs/invoice-module-review.md)），复跑即 exit 0。

### 仍未做（需要真机/打包态）

- 第六节那 5 个场景需要启动应用（真实店铺页、代理、诊断包导出）才能验收；本机沙箱只跑到"静态 + 单测"这一层。
- 第 10 条的"只显示当前店铺"取舍、以及把 `tools/acceptance/m1-cdp-verify.js` 扩一条 `[data-test="webview-diagnostics"]` 断言，留待下一次。
- 另一个会话仍在同一工作区活动（其改动与本次改动同在暂存/未暂存区），提交前建议由一个人统一 `git add` 一次，避免把两份半成品混进同一提交。
