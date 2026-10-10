# ShopPilot 内存占用审查报告

- **审查对象**：`v0.4.58`（HEAD `faf7bd4` + 工作区未提交改动）
- **审查日期**：2026-10-02
- **方法**：源码静态审查（主进程 / 渲染层 / 打包产物）+ **用户真实日志与数据库取证** + 资源解码量化
- **未能做**：实机内存采样（沙箱内 Electron 起不来，见 §6），故本报告的量化部分标明口径与上限

> **实现更新（2026-10-10）**：P0 店铺页面生命周期已落地。当前店铺保持活动，最近一次显示的上一家作为 1 家温缓存；其它店铺空闲 60 秒后冷休眠并关闭 guest/WebContents，Session、Cookie、标签页数据库记录保留。任务、采集租约、内部采集页、进行中下载、独立窗口和显式服务占用会阻止回收。本文后续“没有任何空闲回收”的描述是实施前基线，不能作为当前行为判断；实机内存下降仍需在普通 Windows 环境复测。

---

## 一、结论摘要（按"能省多少"排序）

| 序 | 原因 | 性质 | 量级 | 位置 |
| --- | --- | --- | --- | --- |
| **1** | **每个"打开的店铺"常驻一个 guest 渲染进程，且没有任何空闲回收** | 结构性（设计使然） | 仓库自测口径 **≈150MB/店铺**；10 个渲染进程 ≈1.5GB | `window-manager.ts:238/334/391`、`DashboardView.vue:128-141`、`DashboardBrowserSurface.vue:349-380` |
| **2** | **图标资源规格失控**：平台 logo 1254×1254、UI 图标 512×512（或 418×627），实际显示尺寸 14–22px | 资源（0.4.58 新引入） | 4 张 logo 解码 6.0MB/张；已打包 154 张图合计解码 **≈79.6MB（上限口径）** | `PlatformIcon.vue:24-27,31`、`assets/platforms/generated/*.png`、`assets/generated/ui-icons/*.png` |
| **3** | **任务引擎 `visitedRows` 无上限 + 每轮全量克隆 + 每条候选全量注入页面** | 随运行时间线性增长 | 无人值守跑千轮级时主进程 + 注入脚本 + 页面三份副本，O(轮数²) 复制 | `task-runner.ts:57/1727/753/1792/2035/2123` |
| **4** | **跨进程数据放大**：整表快照 → 全量 parse/map → IPC → 渲染层长期持有；一次任务事件扇出 4 处全量刷新 | 峰值 + 抖动 | 单条订单快照 ≤2000 行 × 500 字符/格；20 店时快照/指标 IPC 各 1+N 次 | `profile-misc-handlers.ts:217-242`、`task-store.ts:230/217`、`DashboardView.vue:1397`、`UnifiedDataPage.vue:433` |
| **5** | **单次大对象峰值**：先解码后校验、全语料快照、整文件读取 | 瞬时峰值 | 单次可达数十 MB（如 b64 先 `Buffer.from` 再判 24MB） | `ai-handlers.ts:429-434`、`network-observer.ts:339-343`、`agent-memory.ts:955-978`、`logger.ts:116/134` |
| **6** | 渲染层持续抖动：Agent 60 分钟不可取消轮询、状态变化触发 N 次全量 IPC | 抖动（非泄漏） | 每 3s × 每个 Job 拉整份 Job 文档；每次状态变化 1+N 次 IPC | `stores/agent.ts:423-448`、`workspace.ts:236-243` |

**一句话**：内存的"底"由 **1（多店铺 guest 常驻）** 决定，"持续涨"由 **3** 决定，"每次刷新都抖"由 **4/6** 决定，而 **2** 是一次性但可观的常驻解码开销（0.4.58 新增，恰好与安装包 +14.5MB 同步）。

**已经做对、不要重复修的**（避免误判为问题）：

- 0.4.58 的"采完自动关页面"**在真实环境生效**：真实日志里 `后台采集结束，已关闭借用的店铺页面` **66 次**（`window-manager.ts:391-411` + `page-lease.ts`）。
- **每店只保留当前活动标签页的 guest**（`DashboardBrowserSurface.vue:322-331`），历史标签页不线性放大 renderer 内存。
- 失败运行句柄 **FIFO 上限 20**（`task-runner.ts:103-104`）、运行标签页**按店铺复用**（`task-runner.ts:362`）。
- 渲染层长列表多已封顶（订单 `slice(0,30)`、日志 `slice(-80)`），**无 keep-alive**，切页是真卸载。
- `inFlight` / `AbortController` / `setTimeout` 清理路径已核对，未发现累积泄漏。

---

## 二、取证数据（真实环境）

### 2.1 用户真实数据库与分区（只读统计，2026-10-02）

| 项 | 值 |
| --- | --- |
| 店铺数 | 6 |
| `tabs`（保存的标签页） | 127 |
| `sales_metrics_raw` | 4 972 |
| `product_media` / `audit_logs` | 2 974 / 1 947 |
| `task_runs` / `tasks` / `task_steps` | 142 / 118 / 834 |
| 数据库文件 / WAL | 7.48MB / 4MB |
| Chromium 分区（5 个） | **295.7MB** |

→ **数据量本身不是主因**（库 7.5MB）；真正的大头是**进程**与**解码位图**。

### 2.2 用户真实日志（`%APPDATA%\shopilot\logs`，近 3 天）

| 事件 | 次数 | 说明 |
| --- | --- | --- |
| `后台采集结束，已关闭借用的店铺页面` | 66 | 0.4.58 修复生效 |
| `renderer gone reason=crashed exitCode=-1`（主窗口） | 20 | 渲染进程崩溃 |
| `store tab renderer gone ... reason=crashed` | 14 | 店铺页渲染进程崩溃 |
| `child-process-gone ... Network Service / Audio Service crashed` | 多次 | 2026-10-02 11:08 三者同一秒崩溃 |

**仓库自测的渲染进程开销**（`docs/RELEASE_NOTES.md:2144`，0.2.4 专项排查）：
> 「实测运行数小时后有 **10 个渲染进程、合计约 1.5GB**」

即 **≈150MB/渲染进程**。6 家店铺全开 ≈ **0.9GB**，仅这一项就足以解释"占用高"。

### 2.3 资源量化（打包产物 `apps/desktop/out/renderer/assets`）

| 项 | 值 |
| --- | --- |
| 已打包图片 | 154 张 / 13.7MB |
| **全部解码后合计** | **≈79.6MB**（`宽×高×4`，上限口径） |
| 平台 logo（4 张） | **1254×1254 → 6.0MB/张**，`PlatformIcon.vue` 默认 **14px** 显示 |
| UI 图标 | 512×512 或 418×627 → **≈1.0MB/张**，CSS 显示 **15–22px**（`DashboardView.vue:1468-1803`） |
| 源码目录未引用图片 | 125 张 / **36.1MB**（含全部 `*-icon-sheet.png`，**不进包**，只是仓库垃圾） |
| 0.4.58 安装包变化 | 81.7MB → **96.2MB（+14.5MB）**，正是本批图标资源 |

> 口径说明：Chromium 对缩小显示的图片**部分情况**会做缩放解码，故 79.6MB 是上限；但"512²/1254² 出图、16px 处显示"无论是否缩放解码都是资源缺陷（磁盘、解码耗时、GPU 上传都按原尺寸算）。

---

## 三、逐条发现

### P0-1｜每个打开的店铺 = 一个常驻 guest 渲染进程，没有空闲回收

**证据**

```ts
// DashboardView.vue:128-141 —— 只要还有店铺"打开"，宿主就一直挂载，切页只隐藏不销毁
// 销毁会连带销毁 webview 元素（也就是 guest 渲染进程）…
<div v-if="browserHostMounted" :class="['dashboard-browser-host', { active: browserHostActive }]">
  <DashboardBrowserSurface … />
```
```ts
// DashboardBrowserSurface.vue:349-380 —— 每个 openStoreIds 挂 1 个活动页 guest（外加采集专用页）
for (const storeId of ws.openStoreIds) { … entries.push({ key: `${storeId}:${activeTab.id}`, … }) }
for (const tab of tabs) { if (tab.internal !== true || tab.id === activeTab?.id) continue; entries.push({ … internal: true }) }
```
```ts
// window-manager.ts:286-287 —— 页面被"显示过"就永久归用户：采集结束不再自动关
// 后台采集借用的页面一旦被显示过，采集结束后就不再自动关闭…
pageLeases.claimByUser(storeId)
```
```ts
// window-manager.ts:86 —— 后台只节流 CPU，不减内存
const shouldThrottle = !isActiveVisibleTab && !taskAwakeStores.has(tab.storeId)
```

**机制**：`browserStates` 里的每个店铺 = 一组标签页 + 已注册 guest；渲染层为每个打开店铺保留**当前活动页**的 `<webview>`。用户开过的店铺页面**永远不会被自动回收**（这是刻意设计，为了不关掉用户正在登录的页面），也**没有任何"空闲 N 分钟自动关闭"策略**；全库检索 `idle/回收/autoClose` 只命中应用锁空闲锁屏，没有页面回收。因此内存下限随"开过的店铺数"单调上升，只能靠用户手动逐店关闭。

**触发**：打开 3 家店对比数据 → 再开 3 家跑批量采集 → 一整天下来 6 家店常驻 ≈0.9GB，且**永远不会自己降下来**。

**修法（按性价比）**
1. 增加**空闲回收**：`displayedStoreId` 之外的店铺页面，超过 N 分钟（如 10 分钟）无任务借用、无用户交互 → `closeStoreBrowser(storeId)`（保留 DB 中的 tabs，重开按 §4.3 恢复）。语义上与 `page-lease` 完全兼容：加一个"用户接手后仍可空闲回收"的开关即可。
2. 批量采集/Agent 逐店跑完后**主动关掉自己开的页面**（现有 `borrowStorePage` 已具备能力，只需覆盖 Agent 路径：`agent-service.ts:2456 displayStore(step.action.storeId)` 会把页面标成"用户接手"，此后永不回收）。
3. 内存诊断面板里显示"每店 guest 的 `workingSetSize`"，让用户看得见谁在占。

**验证**：开 6 家店 → 读内存快照 → 静置 10 分钟 → 快照应回落；`totals.webContents` 应随之下降。

---

### P0-2｜图标按 512²/1254² 出图、在 14–22px 处显示

**证据**

```vue
<!-- PlatformIcon.vue:24-32 -->
import douyinIcon from '../assets/platforms/generated/douyin.png'   // 1254×1254
…
const props = withDefaults(defineProps<{ name?: string; size?: number }>(), { name: '', size: 14 })
```
```css
/* DashboardView.vue:1468 / 1580-1581 */
.sidebar-rail .rail-btn img { width: 18px; height: 18px; }
.btn-new img { width: 18px; height: 18px; } .store-action img { width: 16px; height: 16px; }
```

**机制**：`import` 只产出 URL（零开销），但 `<img>` 一旦被渲染，Chromium 会为它准备解码位图：`1254×1254×4 = 6.0MB`、`512×512×4 = 1.0MB`。平台 logo 出现在店铺列表每一行（显示 14px），4 张全在屏幕上时仅 logo 就是 **24MB**；仪表盘 + 浏览器面板 + 抽屉一次性渲染的 UI 图标约 50–70 张 → 再 **50–70MB**。

**触发**：打开应用停在经营总览（默认页）即已加载；打开工作台浏览器面板再叠加一批。

**修法**
1. 用构建期/一次性脚本把图标重采样到**实际显示尺寸的 2 倍**（16px 显示 → 32×32，@2x），平台 logo 128×128 足够；预计图标体积与解码内存都降到 **1/16 ~ 1/100**。
2. 若想保留大图做"高清预览"，改为**按需加载**（点击时才 import）或 CSS `image-set()`。
3. 顺手删掉 `assets/generated/ui-icons/*-icon-sheet.png` 等 **36.1MB 零引用**文件（不进包，但污染仓库与检索）。
4. 平台 logo 更适合用现有 SVG（`assets/platforms/*.svg` 已在仓库里）替代 PNG。

**验证**：重采样后跑一次内存快照对比；或对渲染层做一次 `performance.memory`/解码统计对比。

---

### P1-3｜`visitedRows`：无上限 + 每轮全量克隆 + 全量注入页面

**证据**

```ts
// task-runner.ts:57       每次命中"未访问行"就 +1，运行内无任何上限
visitedRows: Set<string>
// :1792
if (unvisited && hit.rowKey) run.visitedRows.add(hit.rowKey)
// :1727  每次点击都把整个集合塞进注入脚本
? { roundIdx, visited: unvisited ? Array.from(run.visitedRows) : [], dedupNs }
// :753   页面侧再建一个 Set（主进程 Set + 脚本文本 + 页面 Set 三份）
const visited = new Set(${JSON.stringify((pick && pick.visited) || [])});
// :2035 / :2123  循环每轮整体克隆两次（回滚用）
const visitedSnapshot = new Set(run.visitedRows)   … run.visitedRows = new Set(visitedSnapshot)
```
```ts
// :103-104  失败句柄保留 20 个，每个都持完整 visitedRows 与 steps
const FAILED_HANDLE_KEEP = 20
```

**机制**：达人邀约/批量点击类任务每处理一条达人 +1 键；集合随运行时间线性增长，且**每次点击都把全量集合序列化进页面脚本**、每轮再整体克隆两次 → 复制量随轮数呈 O(n²)。无人值守跑几百上千轮时，主进程、注入脚本文本、页面 Set 各持一份。最多 20 个失败句柄还会各留一份。

**修法**：① 注入脚本改**增量**协议（只传新增键）；② 去重集落 SQLite（`run_id + row_key` 唯一索引）或按轮分片；③ 失败句柄只保留紧凑编码（如 `rowKey` 的哈希数组）。

---

### P1-4｜跨进程数据放大与事件扇出

**证据**

```ts
// profile-misc-handlers.ts:217-230,265 —— 每店取整表快照 value_json → JSON.parse → 全量 map → IPC
if (snapshot?.value_json) { try { raw = JSON.parse(snapshot.value_json) } catch { raw = null } }
const mapped = profile && Array.isArray(raw) ? mapOrdersRows(profile.columns, raw) : []
… return success({ generatedAt: Date.now(), stores: rows }, requestId)
```
```ts
// task-store.ts:230 —— 列表 = 先取全部 id，再逐个 getTask（每个再查全部 steps）
return (db.prepare('SELECT id FROM tasks ORDER BY created_at DESC').all()).map(r => getTask(r.id)!)
```
```ts
// DashboardView.vue:1397 —— 店铺状态一变就 1+N 次 IPC（每店一次，limit 60 / pageSize 120）
stopStoreWatch = watch(() => ws.stores.map(s => `${s.id}:${s.status}`).join('|'), () => { void loadSnapshots(); void loadCollectedMetrics() })
```
```ts
// UnifiedDataPage.vue:433 —— 一次任务结束事件 → load() = 数据中心 + 订单 + 发票 三个全量 IPC
```
数据源侧：`task-runner.ts:1318` `.slice(0, 2000)` + `:1347` 把整表写进 `store_snapshots`。

**机制**：主进程 parse 一份整表 → map 出新对象数组 → IPC 结构化克隆再复制一份 → 渲染层长期持有 = **2–3 倍放大**；配合"每次状态变化重建"与"一次事件扇出 4 处全量刷新"，形成持续抖动与大对象驻留。

**修法**：`mapOrdersRows` 加 `rowLimit + hasMore` 分页；`TASK_LIST` 与 Agent 上下文改用 `listTaskSummaries(limit)` 单条 SQL；事件订阅合并/防抖（同一 tick 内多次状态变化只刷新一次）。

---

### P2-5｜单次大对象峰值

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `ai-handlers.ts:429-434` | 先把 b64 解成 Buffer，再判 24MB | 先判 `b64.length` 再解码 |
| `network-observer.ts:339-343` | CDP 返回的整段正文先 base64 解码成字符串，`maxBodyBytes` 截断发生在之后 | 解码前按字符串长度拦截 |
| `agent-memory.ts:955-978` | 全语料 `SELECT` → `JSON.stringify` → 加密 → `toString('base64')`（×1.33）全在内存 | 分批流式加密落盘 |
| `logger.ts:116/134` | 轮转与诊断整文件读入（5MB 文件 → ~10MB UTF-16 字符串）再切片 | 按 fd + 偏移读尾部 |
| `agent-memory.ts:218-229` | 每次写记忆都把整份 manifest 读出、带缩进全量重写 | 增量追加 / 去缩进 |

### P2-6｜渲染层持续抖动（非泄漏，但影响观感与 GC）

- `stores/agent.ts:423-448`：派发多店任务后 `while (pending.size && Date.now() < deadline)` + 3s 轮询，**deadline 是 60 分钟**，无 AbortSignal、无并发互斥（`:238`/`:292` 两个入口都可触发）；每轮对每个 Job 拉整份 Job 文档。
- `DashboardView.vue:1397` + `workspace.ts:236-243`：每次 `STORE_STATUS_CHANGED` 改写 `stores[index]` → 正好点火上面的 watch。
- `UnifiedImageStudioPage.vue:189/204/358`：base64 `dataUrl` 存在**深响应式 ref** 里（无 `shallowRef`/`markRaw`），同一张图被渲染 3 次并进入 CSS `background-image`。

---

## 四、修复优先级与预期收益

| 优先级 | 动作 | 预期收益 | 风险 |
| --- | --- | --- | --- |
| **P0** | 空闲店铺页面回收（N 分钟无借用/无交互即关，重开按 DB 恢复） | 单机常驻内存从"店铺数×150MB"降到"活跃店铺数×150MB"；6 店场景可省 **0.5–0.9GB** | 中：必须严格复用 `page-lease` 判据，别关用户正在登录的页面 |
| **P0** | 图标重采样到 2× 显示尺寸 + 平台 logo 换 SVG | 解码常驻 **79.6MB → <5MB**；安装包 −14MB | 低 |
| **P1** | `visitedRows` 增量化 / 落库 / 失败句柄瘦身 | 无人值守长跑不再线性增长 | 中：需保持去重语义（有单测钉住） |
| **P1** | `overview:orders` 与 `TASK_LIST` 分页；事件刷新合并防抖 | 峰值与抖动显著下降 | 低 |
| **P2** | base64/大对象"先判后解码"、流式加密、日志尾部读取 | 消除数十 MB 瞬时峰值 | 低 |
| **P2** | Agent 轮询加 AbortSignal 与 jobIds 去重 | 减少 3s×N 的持续 IPC 与 Job 文档克隆 | 低 |

---

## 五、怎么自己拿到数字

1. **应用内（零成本）**：工作台 → 浏览器面板 → 「备份与诊断」→ **读取内存快照**（`data-test="btn-memory-diag"`），
   会显示 `内存 RSS · 店铺 · 标签 · guest · WebContents`，并且 `pageLeases` 快照会说明"页面为什么还开着"。
2. **逐店量化（本报告附带的探针）**：
   ```powershell
   node tools/acceptance/memory-occupancy-probe.js
   # 打包版：set SHOPILOT_MEM_APP_EXE=D:\code\电商浏览器\release\win-unpacked\ShopPilot.exe
   # 店铺数：set SHOPILOT_MEM_STORES=8
   ```
   它用隔离 `--user-data-dir` 启动应用，逐店调用只读 IPC `browser:memoryDiagnostics`，输出"空载基线 → 每开一店 → 全部关闭后"的表格与 JSON，**不碰真实数据**。

---

## 六、方法与边界（未验证项）

- **未做实机采样**：本会话的沙箱禁止 Chromium 创建命名管道（`platform_pipe/platform_channel.cc: Check failed: 拒绝访问 (0x5)`），Electron 无法在其中启动；同时宿主环境带有 `ELECTRON_RUN_AS_NODE=1`，直接 spawn 会把 Electron 当纯 Node 跑（探针已剥离该变量）。要拿实机数字请在**普通终端**跑 §5.2 的脚本。
- **"每店 ≈150MB"来自仓库自测**（`RELEASE_NOTES.md:2144`，10 个渲染进程 ≈1.5GB），未在本机复测；不同平台页面差异大（抖店/快手/拼多多后台都是重 SPA）。
- **图标解码 79.6MB 是上限口径**：Chromium 在部分缩小显示场景会做缩放解码，实际可能低于此值；但资源规格缺陷成立。
- **渲染进程崩溃（20 次）与内存的因果未证实**：日志只有 `reason=crashed exitCode=-1`，Crashpad 目录无 `.dmp` 可分析；2026-10-02 11:08 出现 Network Service + Audio Service + 店铺页渲染进程同秒崩溃，更像是**整进程树级事件**，不能直接归因于内存不足，建议保留崩溃转储后再判定。
- 本报告未覆盖：主进程 `session-manager` / `shop-session-manager` 的分区缓存策略、`agent-runtime` 的 Job 队列内存画像（该路审计未在本轮返回），如需可再补一轮。
