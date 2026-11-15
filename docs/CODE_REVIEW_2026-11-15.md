# ShopPilot 代码审查报告（2026-11-15）

> 审查范围：`1ccfeb1` 及其前 7 个提交（0.9.36 → 0.9.40，罗盘下载器 2.9.0 / 素材库 / 对话生图 / 插件保存目录）
> 审查方式：源码逐段通读 + 四门槛实跑 + 关键分支行为复现（非只读注释）
> 处置：P1 三条、P2 四条、P3-1 全部已修（含 6 项行为单测、3 项接线守卫、4 项素材库纯函数单测）；P3-2 / P3-3 / P3-5 各有明确理由留档

## 一、结论先说

四门槛全绿，实测数据与发布说明一致：

| 门槛 | 结果 |
|---|---|
| `pnpm typecheck` | 0 error |
| `npx eslint .` | **0 error**，1131 warning（`lint:ci` 上限 1145，余量 14） |
| `npx vitest run` | 166 files / **1708 passed**（审查前 1695，本轮新增 6 项行为单测 + 3 项接线守卫 + 4 项素材库单测） |
| `pnpm build` | 通过（renderer 模板编译无误） |
| 素材库真机验收 | `asset-library-cdp-verify.js` **13/13** |
| `git diff --check` | 干净 |

**无 P0（安全/数据丢失）问题。** 三条 P1 全部已修：403/404 无意义重试（复现后修）、榜单签名口径混用（改为两侧只用页面参数比较）、下载进度无兜底（去重 + 静默看门狗）。榜单那条是**本轮最值得记的判断陷阱**：现有「10 行表格 10 个按钮全出现」的证据，恰好等于「只跑通第 1 页」的表现，`page_size` 就是 10。

删除两个功能（图文带货 / AI 生成商品图，共 −9.4k 行）删得比预想干净：`apps/`、`packages/` 下 `graphic-sell` / `image-studio` / `sell-copy` 零残留引用，IPC 契约、preload、`env.d.ts`、路由、验收脚本同步清理，迁移带 `down`。残留只有一处资源目录（P3-1）。

---

## 二、P1（功能缺陷 / 可能已在真机上发生）

### P1-1　`fetchVideo` 对 403/404 仍重试 3 次，与注释和发布说明完全相反　✅ 已修

- 位置：`assets/browser-extensions/luopan-downloader/background.js:52-84`
- 声明（注释 + `docs/RELEASE_NOTES.md` 0.9.40）：「403/404 视为签名过期立即失败，不做无意义重试」
- 实际：非重试分支的 `throw` 写在同一层 `try` 里，**被自己的 `catch` 接住**，于是照走重试与 sleep。
- 复现（把函数原样抽出、注入计数版 `fetch`）：

```
status=403 -> 实际请求次数=3
status=404 -> 实际请求次数=3
status=500 -> 实际请求次数=3
```

- 影响：
  1. 每条签名过期链接多打 2 次 CDN + 多等约 2.7 秒，10 条过期链接就是 27 秒假忙碌；
  2. 这正是 `PAGE_GAP_MS`（450ms 抖动）想避免的"像爬虫"，对着 403 连打三次正好是风控最敏感的模式；
  3. 发布说明在这条上是错的，验收也没抓到（见 P3-4）。
- **已修**：网络异常与状态码判定拆开——`await fetch` 单独包一层 `try`，只有网络异常进重试；状态码在 `try` 外判定，非 5xx/429 直接抛。
- **已补行为单测**：`tests/unit/luopan-fetch-retry.test.ts`（6 项）。把 `background.js` 放进 `vm` 沙箱、注入计数版 `fetch` 与 chrome 桩，直接数请求次数：403→1 次、404→1 次、500→3 次后放弃、429 后 200→2 次、网络异常重试后成功→3 次。旧实现在这套测试下 403 用例必红（实测 3 次）。
- **已升版本**：`manifest.json` 2.9.0 → **2.9.1**。不升版本的话，`AppCenterExtensions` 的 `isNewerVersion` 不会给已装 2.9.0 的人显示「可更新」，修复等于没发出去（这正是本轮审查要防的那类"发布链路静默失效"）。
- 同步更新：`tests/unit/luopan-downloader.test.ts` 的版本断言、`docs/RELEASE_NOTES.md` 标题与条目（并在条目里如实写明 2.9.0 的写法为什么没生效）。

### P1-2　榜单同步用「页面原始签名」对比「合并后签名」，口径不同就永远不相等　✅ 已修（口径统一）

- 位置：`content.js:803-828`（`rankBaseParams`）、`content.js:921`（`rankSig = paramsSignature(params)`）、`content.js:1176-1215`（`syncRankSource`）
- 事实：
  - `rankSig` = `paramsSignature(合并参数)`，合并参数 = `DEFAULT_CFG`（5 键）+ 页面总榜参数 + URL 参数 + **强制补齐的 `begin_date` / `end_date`**（`rankBaseParams` 末尾无条件补）。
  - `syncRankSource` 里的 `sig` = `paramsSignature(页面 market_hot_sale 原始参数)`，**不含** `DEFAULT_CFG` 独有的键，也不含补出来的日期。
  - 两者只要差一个键，就**永远不相等**。
- 后果（`tick` 每 1800ms 跑一次 `syncRankSource`）：`loading` 期间每拍都命中 `if (sig !== rankSig)` → `resetRankView()` + `loadRankAll(true)` → 上一轮在下一个 `await` 后的 `if (run !== rankRun) return` 被丢弃 → **永远拉不完第 1 页之后的内容**，同时每 1.8 秒打一次 `page_no=1`（约 2000 次/小时）。
- 关键点：**今天的真机验收证据分辨不出这种情况**。榜单 `page_size` 是 10，验收记录「10 行表格 10 个按钮全部出现」恰好等于"只有第 1 页生效"的表现——按钮出现、能下载、图片名都对，只是永远只有 10 条，`items` 卡在 10 不再增长。
- 自检（不用改代码，2 分钟）：打包态开罗盘短视频榜，间隔 3 秒读两次 `document.documentElement.getAttribute('data-lp-kw')`。正常应看到 `items` 递增到 30/50/… 后稳定；若始终 `items=10` 且 `loading` 翻转，就是本条命中。
- 建议修法：
  1. 只比较同源参数——存 `lastPageSig`（页面参数签名），与 `paramsSignature(页面参数)` 比；合并后的签名不要拿来当基准；
  2. 加连续重启上限（例如 3 次/30 秒），超限落错误提示而不是无限重启；
  3. 顺带清死代码：`rankPendingSig` 三处赋值全是 `''`（`content.js:1191/1199/1889`），`content.js:1197-1206` 整段永不执行，注释「先记下最新签名，等本轮结束再补拉」与实现（同一分支里改成"立即重启"）互相打脸。
- **已修（口径统一）**：新增 `rankPageSig` —— 记录和比较**都只取页面请求原始参数**（`latestFilterParams` → `paramsSignature`），`rankBaseParams()` 的合并结果不再参与比较。删掉旧的 `rankSig`（它同时被写成合并签名和页面签名，是口径混乱的根源）。`startRank` 启动时先把当前页面筛选记成已知签名，避免 boot 期白耗重启预算。
- **保留重启限流**（30 秒内最多 2 次）：口径统一后它不该再被触发，但真·连续换筛选时仍能挡住接口放大。
- 现在这个不改代码的自检变成可选：间隔 3 秒读两次 `data-lp-kw`，`items` 应从 10 递增到 30/50…（改造前若卡在 10 且 `loading` 反复翻转，就是本条）。

### P1-3　下载进度 `dlState` 无超时兜底，丢一条 `LP_JOB` 就永久卡住　✅ 已修

- 位置：`content.js:1767-1812`（`LP_JOB` 处理）
- 事实：`dlState` 只在 `processed >= dlState.total` 时清空；`total` 靠多次提交**累加**，`done/failed` 靠消息**计数**。任一消息丢失（页签导航、扩展重载、主进程卡在同步文件夹弹窗里）都会：按钮永远停在「下载 3/10」→ keepalive 端口不释放 → 下一批把新任务加进同一个计数器 → 进度永久偏差且无法自愈。
- 另有计数幂等缺口：同一条 `LP_JOB` 重复到达会重复累加（现在没有去重集合）。
- **已修**：
  1. `dlState.jobs`（`Set<jobId>`）对终态消息去重，重复投递只回 `ok` 不计数；
  2. `dlState.lastAt` 记录最后一条终态时间；新增 `watchDownloadSilence()` 每 5 秒检查——静默 2 分钟落提示（不中断），静默 10 分钟 `keepAlive(false)` + 停止跟踪，提示写明「仍有 N 个未确认，请到右侧『下载』面板核对」，**不谎报完成**；
  3. 阈值按"无任何终态消息"的静默时长算，不按整批耗时——单个 44MB 文件在慢网下也要几十秒才回一条，避免误杀正常长批次。

---

## 三、P2（隐患，暂不表现为故障）

### P2-1　素材库列表一次返回 1000 条缩略图 base64　✅ 已修

- 位置：`apps/desktop/src/main/services/asset-library.ts:159`（`listAssets`）+ `packages/shared/src/contracts/asset-library.ts` 的 `listLimit: 1000`
- 量级：`makeThumb` 是 480px / JPEG q78，单条约 30–60KB → base64 40–80KB；1000 条约 **40–80MB 字符串**走 IPC 进渲染层，且每次增删改都全量重传。
- 建议：列表分页（60/页）或缩略图降到 240px / q60（≈8–15KB）；详情再读原图（原图路径已经是按需 `readAsset`，这点做对了）。
- **已修**：列表改成 **60 条/页**（`ASSET_LIBRARY_LIMITS.pageSize`，上限 `maxPageSize: 120`），筛选（名称 / 标签 / 来源）下推到主进程 SQL；`total` 改为「符合条件的总条数」（COUNT），新增 `libraryTotal` / `libraryBytes` 供容量提示；标签计数只读 `tags_json` 一列，不再把整表带缩略图捞上来。页面底部「加载更多（还有 N 张）」，筛选变化 250ms 防抖重读第一页。
- **为什么必须把筛选一起下推**：本地筛选 + 分页 = 只能搜到当前页，搜索语义会悄悄坏掉。这条不能只改分页。
- **验收抓到并修掉的并发缺陷（同一类错误的第二个实例）**：第一版 `load()` 用 `if (loading) return` 挡并发 —— 导入刚结束的加载还在飞时，用户敲搜索 → 防抖后的重读被这个卫语句直接丢掉，表现是**搜了没反应**（真机验收「按名称搜索只剩一张」拿到 2 张）。改成**请求代次**（`loadSeq`）：最新请求胜出、旧结果丢弃，并把防抖从 250ms 降到 120ms。这和 P1-2 榜单那个「口径不一致就永远不生效」是同一类问题：**用状态开关代替请求身份**。
- **真机验收**：`node tools/acceptance/asset-library-cdp-verify.js` → **13/13 通过**（含导入、搜索、缩略图真实解码、详情改名/标签、切对话生图、删除、来源筛选、重启后持久化）。

### P2-2　素材库无总量上限，`userData/asset-library` 可无界增长　✅ 已修

- 单张 20MB、无条数/总容量上限、无孤儿清理。DB 回滚或用户换库后，磁盘上的原图没人回收（`removeAsset` 只在正常删除路径 unlink）。
- 建议：加软上限（如 500 条 / 2GB，超限提示清理）+ 启动时按 `file_name` 对账清孤儿（与现有 `ASSET_FILE_MISSING` 报告共用一套查询）。
- **已修**：
  1. 容量软上限 **2000 张 / 2GB**（`ASSET_LIBRARY_LIMITS.maxItems / maxTotalBytes`），超限抛 `ASSET_LIBRARY_FULL` 并带可读原因；导入时遇到上限立即停批、原样显示原因，不混进「N 张无法读取」。
  2. 启动后 5 秒执行 `reconcileAssetLibrary()`：磁盘有、库里没有的**受管命名**文件（`ast_<20 hex>.<png|jpg|webp>`）且 mtime 超过 1 小时 → 删除；库里有、磁盘没有 → 只统计 + 记日志，不删记录（详情页继续如实报「原图丢失」）。用户自己丢进目录的文件一概不动。
  3. 对账判定抽成纯函数 `diffAssetFiles(dbNames, diskNames)`，4 项单测覆盖孤儿/缺失/非受管文件名。

### P2-3　blob 视频"取消窗口"5 分钟过长且静默　✅ 已修

- 位置：`session-manager.ts:684`（`BLOB_VIDEO_CANCEL_WINDOW_MS = 5 * 60 * 1000`）、`session-manager.ts:691`
- 对比：同一文件里图片的取消窗口是 30 秒（`IMAGE_CANCEL_WINDOW_MS`）。视频窗口 5 分钟，期间**任何** blob 视频下载都被 `preventDefault()` 且不回传页面（无弹窗、无提示、无记录）。
- 现版本插件每批必先发 marker（会把窗口清零），所以正常链路打不到；但"兼容旧版插件/直接触发 blob"的兜底路径会落到这里，表现为"点了没反应"。
- 建议：窗口降到 60 秒，且每次丢弃都 `notifyVideoSaveResult(webContents, 'cancel')`，别静默。
- **已修**：`BLOB_VIDEO_CANCEL_WINDOW_MS` 5 分钟 → **60 秒**（正常批次每批先发 marker 会清零，这个窗口只兜旧版插件的路径）；丢弃分支补 `notifyVideoSaveResult(webContents, 'cancel')`，页面能写明"为什么没落盘"。

### P2-4　marker 等待 120 秒超时后仍继续提交任务　✅ 已修

- 位置：`content.js` 的 `triggerVideoFolderMarker`（`deadline = Date.now() + 120000`）与 `ensureVideoFolder`（只有 `'cancel'` 才中止）
- 场景：用户把同步文件夹弹窗晾了 2 分钟以上 → 页面超时后照常解析链接、提交任务 → 用户随后取消 → 页面先显示「已提交 N 个」再改口「已取消保存位置」，中间还夹着一次错误的成功语义。
- 建议：`timeout` 也中止本批（`flash(btn, '保存位置未确认，已取消')`），或把等待上限提到 10 分钟并把主进程弹窗改成非阻塞。
- **已修**：`ensureVideoFolder` 把 `'timeout'` 与 `'cancel'` 同等处理，提示「保存位置 120 秒未确认，本批视频不会下载」；不再出现"先报已提交、再改口已取消"。

---

## 四、P3（清理项 / 可维护性）

### P3-1　删除功能的资源残留：`assets/ui/graphic-sell/` 656KB　✅ 已清

4 张 `effect-bed-*.jpg`，源码零引用，唯一消费者是 `tools/acceptance/asset-library-cdp-verify.js:22`（拿其中一张当上传夹具）。下一个人按"死资源"删掉就会断掉素材库验收。
**已处置**：把要用的那张复制成 `tools/acceptance/fixtures/asset-second.jpg`，验收脚本改指新路径（显示名 `粉色床品.jpg` 不变，断言用的是改名的 `粉色床品-验收`，不受影响）；`assets/ui/graphic-sell/` 整个删除。复核：`graphic-sell|effect-bed` 在 `apps/ packages/ tools/` 下只剩 `renderer-entries-cdp-verify.js:189` 的**负向断言**（"这个入口不该存在"），保留正确。

### P3-2　调试属性常驻生产 DOM

- `content.js:889`：每页把 `data-lp-raw`（响应顶层结构 + 700 字符样本）写进 `documentElement`；`content.js:1225`：每 1.5 秒写一次 `data-lp-kw`（含前 3 个商品名 + 图 key）。
- 这是给验收用的，但没开关、一直在跑，且把接口返回片段暴露给页面脚本。
- 建议：加 `data-lp-debug` 或 `location.search.includes('lpdebug=1')` 开关，默认不写；验收脚本显式打开。

### P3-3　`buildName` 里的"文件夹"被后台吞掉

`content.js:486` 生成 `罗盘带货视频/xxx.mp4`，`background.js:133` 用 `split(/[\\/]/).pop()` 只留文件名 → 用户选的目录里是扁平文件，`:folder` 语义丢失。要么按 folder 建子目录（主进程 `saveBlobVideo` 已经 `mkdirSync`，加一层即可），要么别在名字里拼。

### P3-4　罗盘单测是"源码字符串守卫"，行为错了也能绿

`tests/unit/luopan-downloader.test.ts` 8 项全是 `toContain` 文本断言（全文件 27 处 `toContain`）。P1-1 就是活证据：`expect(background).toContain('attempt >= 2')` 通过了，而 403 实际重试了 3 次。改个变量名就红、行为错了却绿，是这类测试的典型失效模式。
**建议**：把 `fetchVideo` / `paramsSignature` / `parseRank` 提到可注入依赖的独立模块（现在都在 IIFE 里，所以只能扫文本），至少这两条补行为测试；文本守卫保留做接线检查。

### P3-5　`assetPath` 是"删斜杠"而不是白名单

`asset-library.ts:42-46`：`replace(/[\\/]/g, '')` 能挡住路径分隔符，但挡不住 `..`。当前 `file_name` 全部由主进程用 `ast_<uuid>.<ext>` 生成，不可达；但防御深度上直接换成白名单 `^ast_[a-z0-9]{20}\.(png|jpg|webp)$` 更省心。

---

## 五、做对的地方（别在下一轮改坏）

1. **blob 视频不走 `preventDefault + downloadURL` 重发**，改同步 `setSavePath` 后原样落盘 —— 这是本版最关键的一个判断，blob URL 离开页面上下文必失效，之前的"丢文件"根因就是这个。
2. **marker 选目录 → 整批生效**的模型与图片下载器共用同一套语义（选定/取消都回传页面），两处代码形态一致，后续不会各写一套。
3. **素材库的安全边界干净**：渲染层只传 data URL / id，原图由主进程按 `ast_*` 命名写入受管目录，`read/remove/reveal` 都不接受路径参数；插入失败会回滚已写文件；sha256 去重。
4. **删功能删到位**：源码、IPC 契约、preload、`env.d.ts`、路由、负向测试（"不该再存在"）、验收脚本同批更新，迁移带 `down`。
5. **插件升级链路是通的**：`AppCenterExtensions.vue` 已有 `isNewerVersion` + 「可更新 v2.8.x → v2.9.0」徽标 + 覆盖安装，2.9.0 能触达老用户，不需要用户自己猜。

---

## 六、修复顺序与当前状态

| 项 | 价值 | 状态 |
|---|---|---|
| P1-1 403/404 重试语义 | 高（可复现缺陷 + 发布说明失实） | ✅ 已修 + 6 项行为单测 + 扩展版本升 2.9.1 |
| P1-2 榜单签名口径 | 高（可能已静默只跑第 1 页） | ✅ 已修（只比页面参数签名；保留重启限流兜底） |
| P1-3 `dlState` 无兜底 | 中高（进度永久卡住） | ✅ 已修（jobId 去重 + 2 分钟提示 / 10 分钟停止跟踪，不谎报完成） |
| P2-1 素材库列表体积 | 中（IPC 40–80MB、全量重传） | ✅ 已修（60 条/页 + 筛选下推 SQL + 加载更多） |
| P2-2 素材库容量与孤儿 | 中（磁盘无界） | ✅ 已修（2000 张 / 2GB 软上限 + 启动对账清孤儿） |
| P2-3 取消窗口 5 分钟 | 中 | ✅ 已修（60 秒 + 每次丢弃回传 cancel） |
| P2-4 marker 超时仍提交 | 中 | ✅ 已修（timeout 等同取消，本批不下载） |
| P3-1 死资源 | 低（但会断验收） | ✅ 已清 |
| P3-2 调试属性常驻 DOM | 低 | ⏸ 未动：验收脚本（`asset-library-cdp-verify.js`、`luopan-copy-cdp-verify.js`）就靠 `data-lp-kw` / `data-lp-raw` 读状态，改开关必须同批改验收工具，否则断验收 |
| P3-3 `buildName` 文件夹被吞 | 低 | ⏸ 未动：改成子目录会改变用户看到的落盘结构（现在扁平文件在用户自选目录里），属于产品选择 |
| P3-4 单测是字符串守卫 | 中（质量） | 🔶 部分：新增 6 项行为测试；`parseRank` / `paramsSignature` 仍在 IIFE 内，要拆模块才能测 |
| P3-5 `assetPath` 删斜杠式清洗 | 低 | ⏸ 未动：`file_name` 全由主进程按 `ast_<uuid>` 生成，当前不可达；改白名单属防御纵深 |

本轮改动文件：
- `assets/browser-extensions/luopan-downloader/background.js`（重试语义）
- `assets/browser-extensions/luopan-downloader/content.js`（终止消息去重 + 静默看门狗 + 榜单签名口径统一为 `rankPageSig` + 删除 `rankPendingSig` 死代码 + timeout 等同取消）
- `assets/browser-extensions/luopan-downloader/manifest.json`（2.9.0 → 2.9.1）
- `apps/desktop/src/main/browser/session-manager.ts`（取消窗口 5 分钟 → 60 秒；静默丢弃改为回传 cancel）
- `packages/shared/src/contracts/asset-library.ts`（分页/容量常量、`AssetLibraryListInput`、`normalizeAssetListInput`、`assetLikePattern`、`isAssetFileName`、`diffAssetFiles`；删除内存筛选 `filterAssetLibraryItems`）
- `apps/desktop/src/main/services/asset-library.ts`（`listAssets` 分页 + SQL 筛选、容量软上限、`reconcileAssetLibrary`）
- `apps/desktop/src/main/ipc/asset-library-handlers.ts`（`assets:list` 接收筛选/分页入参）
- `apps/desktop/src/preload/index.ts`、`apps/desktop/src/renderer/src/env.d.ts`（`assets.list(input?)`）
- `apps/desktop/src/main/index.ts`（启动后 5 秒触发素材库对账）
- `apps/desktop/src/renderer/src/features/workbench/UnifiedAssetLibraryPage.vue`（服务端筛选 + 加载更多 + 容量提示 + 库满提示）
- `tests/unit/luopan-fetch-retry.test.ts`（新增，6 项行为测试）
- `tests/unit/luopan-downloader.test.ts`（版本断言 + 3 项新接线守卫）
- `tests/unit/asset-library.test.ts`（改为 4 项纯函数测试 + 分页/容量/对账接线守卫）
- `docs/RELEASE_NOTES.md`（标题/条目同步 2.9.1 + 素材库分页与容量说明）
- `tools/acceptance/asset-library-cdp-verify.js`（夹具路径）
- 删除 `apps/desktop/src/renderer/src/assets/ui/graphic-sell/`（4 张，656KB）

改动后四门槛复核：`tsc --noEmit` 0 error；`eslint .` 0 error / 1131 warning（上限 1145）；`vitest run` 166 files **1708 passed**；`pnpm build` 通过；`git diff --check` 干净。

> 四门槛复核口径：均已 `unset NODE_OPTIONS ELECTRON_RUN_AS_NODE` 后执行。

---

## 七、追加修复：用户实报「彻底删除店铺 显示位置不正确」（同日 22:06）

### 现象与根因

侧栏回收站浮层里点「彻底删除」→ 确认框打开但**被回收站的遮罩整块压住**：用户看到的是背景又暗了一层/糊了一下，确认框的文案读不到、按钮点不动，被描述成"显示位置不正确"。

根因是**浮层层级靠 DOM 顺序**：

- 侧栏回收站（`data-test="trash-dialog"`）和通用确认框（`data-test="confirm-dialog"`）都是 `.ui-overlay` —— `position: fixed; inset: 0; z-index: var(--z-overlay)`（900）；
- 确认框在模板里排在回收站**之前**（`DashboardView.vue:386` vs `:435`）；
- 同 z-index 下后渲染者胜 → 回收站盖住确认框。

实测（打包态，CDP 量出来的）：

```
修复前：confirmZ=900  trashZ=900  confirmCard=(474,381,452x139)  centerOffset=(0,0)
        elementFromPoint(确认框中心) → trash-dialog      ← 确认框被盖住
修复后：confirmZ=910  trashZ=900  centerOffset=(0,0)
        elementFromPoint(确认框中心) → confirm-dialog    ← 正确
```

注意：确认框的**居中本身没问题**（偏差 0px）；所以「位置不对」是用户对"被盖住"的合理描述，不是 CSS 定位算错。

### 修复

- `styles/components.css` 新增 `.ui-overlay--stacked { z-index: calc(var(--z-overlay) + 10) }`，写明"浮层里再开浮层用它，别赌 DOM 顺序"；
- `DashboardView.vue` 的通用确认框改用 `ui-overlay ui-overlay--stacked`。确认框是"最后一层"，任何时候都该在最上面，不区分入口。
- 其余四个浮层（重命名 / 复制配置 / 新建店铺 / 回收站）之间不存在互相叠开，未加。

### 回归守卫

新增 `tools/acceptance/store-purge-cdp-verify.js`（`pnpm run test:store-purge`，7 项，打包态）：

1. 建店并移入回收站 → 2. 侧栏回收站能看到 → 3. 点彻底删除弹出确认框 → 4. **确认框中心命中的是 confirm-dialog 自己**（这条在修复前是红的，命中 `trash-dialog`）→ 5. 居中偏差 ≤2px → 6. 确认后从回收站与店铺列表同时消失 → 7. 回收站浮层只剩空态。

修复后实跑：**7/7 通过**；截图 `artifacts/store-purge/confirm-stacked.png`（确认框清晰压在半透明回收站之上）。

### 该记住的模式

「同一 z-index + 依赖 DOM 顺序」是浮层叠浮层的必踩项。凡是"在浮层里再开浮层"，要么显式给上层更高 z-index（本次做法），要么改 DOM 顺序（脆弱，下次插入新浮层又坏）。测试要断言**命中测试**（`elementFromPoint`），只断言"元素存在"抓不到这类问题——第一版确认框"存在且居中"两条都是绿的。

---

## 八、追加修复：用户实报「网址栏不能复制粘贴」（同日 22:18）

### 先排除误判

真机复现（打包态 + 临时 profile + CDP 真实按键/鼠标事件）逐项测过：

| 检查 | 结果 |
|---|---|
| 鼠标点地址栏能否聚焦 | ✅ 聚焦，且自动全选（20 字符） |
| `input.readOnly` / `disabled` / `user-select` | false / false / text（没有只读或禁选） |
| Ctrl+V 粘贴 | ✅ 生效（值变成剪贴板内容），`paste` 事件 `defaultPrevented=false` |
| Ctrl+C 复制 | ✅ 生效（清空后再粘贴能取回原文），`copy` 事件未被拦 |
| **右键** | ❌ `contextmenu` 事件到了，但 **`menuNodes: 0`**，什么都没弹 |

结论：键盘复制粘贴一直是好的；坏的是**右键菜单根本不存在**。

### 根因

Electron **默认不提供右键菜单**。项目里 `store-context-menu.ts` 只给店铺页面（`<webview>` 的 guest webContents）挂了菜单（`window-browser-core.ts:841`/`:1566`），**主窗口自己的渲染层从来没挂过**。于是所有壳层输入框——网址栏、店铺搜索、新建店铺表单、任务表单、设置项——右键一律无反应，习惯"右键→粘贴"的人就得到"不能粘贴"。

### 修复

新增 `apps/desktop/src/main/browser/shell-context-menu.ts`（纯函数三层，与 `store-context-menu` 同构）：

- `toShellMenuInput(params)`：把 `isEditable` / `selectionText` / `editFlags` 收敛成输入，缺字段一律当"不可用"；
- `buildShellContextMenu(input)`：编辑区 → 撤销/重做/剪切/复制/粘贴/全选（按 flags 置灰）；非编辑区有选中 → 只给「复制」；两者都不是 → **返回空数组**，调用方不弹空壳；
- `runShellMenuAction(id, wc)`：纯分派到 `wc.undo/redo/cut/copy/paste/selectAll`；
- `toShellMenuTemplate`：`enabled !== false`（写 `!!enabled` 会把没写 enabled 的项全灰，store 菜单踩过同一个坑）。

`main/index.ts` 在主窗口创建后挂 `context-menu`，空菜单直接 return；验收模式（`SHOPILOT_ACCEPTANCE=1`）额外打一行 `[shell-menu] popup items=N editable=…`——原生菜单截不进 CDP 截图，只能靠日志证明事件到了、菜单组出来了。

### 验证

- 单测 `tests/unit/shell-context-menu.test.ts` **10 项**：六项顺序与置灰、非编辑区只给复制、空白处空菜单、缺字段兜底、动作分派、模板 enabled 契约、主窗口接线文本守卫。
- 打包态真机：地址栏右键 → 日志 `[shell-menu] popup items=8 editable=true selection=20`（6 个菜单项 + 2 条分隔线），菜单实际弹出。
- 四门槛：`tsc` 0 error、`eslint .` 0 error、`vitest` 166+ files 全绿、`pnpm build` 通过、`git diff --check` 干净。

### 该记住的模式

"某个输入框不能粘贴"先分三路查：**键盘事件是否被 preventDefault** / **输入框是否只读或被遮罩抢焦点** / **有没有右键菜单**。这次前两路都是干净的，第三路是 Electron 的默认缺省——凡是"Electron 里某个原生浏览器行为没有"，先确认它是 Electron 压根不提供，而不是我们的代码拦掉了。

---

## 九、需求实现：对话生图把「模型 / 比例 / 张数」显示在对话里（同日 22:39）

### 做法

参数**记在助手消息上**（`ChatImageMessage.params`），不是记在用户消息，也不是只在页面顶部露一次：

- 每条生成消息顶部一行「模型 · 比例 · 张数」，失败的消息也写（能一眼看出"是 2 张都没出来，还是比例选错"）；
- 输入框上方再常驻一条 `模型 / 比例 / 张数` 摘要，敲字时不用抬头看右上角的选择器；
- 比例文案统一走 `chatImageRatioLabel`（与下拉框同一份 `CHAT_IMAGE_RATIO_OPTIONS`），避免"选择器写 `1 : 1 方图`、消息里写 `1:1`"这种两处对不上；
- `model` 取**接口回报**的模型，取不到才退回配置值——记录要和真正执行的一致，不能拿配置冒充事实。

顺手去掉了一处重复：底部提示原来写「每轮按「1:1 · 1 张」生成」，与新的参数条重复，已删掉这半句。

### 验证

- 单测：`chatImageRatioLabel`（已知/未知/空值）+ 2 项行为测试（假 `window.shopilot.ai` 跑 `send()`：成功轮记接口回报模型，失败轮也记参数）。
- 真机（`chat-image-cdp-verify.js`，本机 mock 生图接口，不烧额度）新增 3 项断言，**13/13**：
  `助手消息里显示「模型 · 比例 · 张数」` / `输入框上方常驻参数条与选择器一致` / `每条生成消息各带一份参数`。
  截图 `artifacts/chat-image/chat-image-result.png`：消息头一行 `mock-image · 1 : 1 方图 · 1 张`，输入框上方 `模型 mock-image / 比例 1 : 1 方图 / 张数 1 张`。
- 四门槛：`tsc` 0 error、`eslint .` 0 error、`vitest` 167 files **1721 passed**、`pnpm build` 通过、`git diff --check` 干净。

### 一个取舍

消息头的「模型」与图片下方小字的「模型 · 耗时」会重复一次。保留是因为后者是**逐张**的（接口理论上可以每张回报不同模型 + 单张耗时），前者是**整轮**的；把逐张模型藏掉会丢掉"这一张到底谁生成的"。

---

## 十、重构：对话生图对话框（2026-11-16 00:05）

需求原话是"优化对话生图功能，重构对话生图对话框的所有功能"。这里记的是**改了什么、为什么这么改**，以及**故意没动的部分**。

### 结构性改动（不是换皮）

1. **`send()` 拆成 `submit(text, options)` + `retry(id)`**
   旧实现把「读输入框 / 读选择器 / 清引用 / 发请求」全揉在一个函数里，所以两件事做不到：拿不回"当时用的提示词和参数"、无法按原参数重发。现在文本与参数都从入参来，`send()` 只是读当前选择器的一个薄包装。这是后面所有能力的**前提**——重试、参数回放都建立在它上面。
   - 助手消息新增 `prompt` 与 `reference`：失败重试要能原样还原，包括那张参考图。
2. **失败重试**：`retry(id)` 用 `message.params` + `message.prompt` 重发，并 `replaceMessageId` **原位替换**失败消息。不重复追加用户消息（否则对话里会出现两遍一样的话），也不被当前选择器带跑。
   没有 `prompt` 的历史记录如实提示"无法重试"，不猜一条去发。
3. **控制条并入输入区**：比例/张数的 `<select>` 从顶栏搬到输入框上方，与模型名合成一条可直接改的控制条。之前是"顶栏有选择器 + 输入框上方有只读摘要"的两份重复——现在只有一份，且是能操作的。
4. **粘贴截图即参考图**：`@paste` 里只挑 `kind === 'file'` 且 `image/*` 的项，命中才 `preventDefault`；普通文本粘贴不受影响。上传与粘贴共用 `applyReferenceFile`，校验（PNG/JPEG、5MB）只有一处，提示里标明来源。
5. **结果图放大**：Teleport 到 body 的灯箱（不受气泡 overflow 裁剪），Esc / 点图 / 点关闭都能退出；守卫用 `onBeforeUnmount` 移除监听（吸取之前 HMR 叠加监听的教训）。
6. **滚动不抢镜头**：`nearBottom()`（140px 阈值）+ `scrollToBottom(force)`。新消息、图片 `@load` 一律不强制；只有"我自己刚发一条"才 `force=true`。
   顺带修掉 `@load="scrollToBottom"` 这个坑：模板会把 Event 当第一个参数传进去，`force` 恒为真——改成显式 `scrollToBottom(false)`。

### 顺带修掉的真 bug

页面里 `say()` **从未定义也从未从 composable 取**：「存入素材库」成功后调 `say(...)` 抛 `ReferenceError`，被 `catch` 接住后又调一次 `say`，最终用户什么提示都看不到（图片其实已经存进去了）。
旧验收没发现，是因为它只查了"素材库里有没有这张图"，没查提示文案。现在 `say` 从 composable 取出，并加断言：`存入素材库后有成功提示`。

### 故意没做的

- **生成中取消**：要主进程 abort 语义（fetch 中断 + 额度已消耗的事实），属跨进程改动，不塞进这次重构。
- **多张参考图**：接口 `sourceImages` 是数组，但产品语义（"基于这张改"）是单张；扩成多张要重新定义 UI 与提示词策略。
- **消息虚拟化**：大量生成后 base64 图片常驻内存，属性能话题，需要单独测内测量级。
- **复制提示词按钮**：壳层右键菜单（本次上午补的）已经能复制选中文本，不重复造一个按钮。

### 验证

- 单测 `tests/unit/chat-image.test.ts` **15 项**：新增重试两例（替换 + 原参数、无 prompt 不给重试）、控制条搬家守卫、滚动策略守卫。
- 真机 `chat-image-cdp-verify.js`（本机 mock，不烧额度）**19/19**：控制条在输入框上方 / 结果图放大 + Esc 关闭 / 失败出现重试按钮 / 重试替换且不重复追加 / 重试沿用原参数 / 粘贴截图成为参考图 / 存入素材库有成功提示。
- 四门槛：`tsc` 0 error、`eslint .` 0 error / 1131 warning、`vitest` 167 files **1725 passed**、`pnpm build` 通过。
