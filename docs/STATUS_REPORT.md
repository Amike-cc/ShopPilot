# ShopPilot 开发状态报告

**报告时间**: 2026-09-26
**开发阶段**: M0 ✅ + M1 工作台核心 ✅ + M2 环境·代理·备份 ✅ + M3 任务辅助 ✅ + M4 发布工程 ✅ + 自动更新（§21）✅
**当前状态**: `v0.4.48` 已完成内部发版：本轮 `pnpm.cmd typecheck`、`pnpm.cmd test -- --run`（58 文件/589 测试）、`pnpm.cmd build`、`pnpm.cmd lint`（0 errors）和 Windows x64 NSIS 打包均通过；GitHub Release `v0.4.48` 已更新安装包、blockmap 与 `latest.yml`。构建标签仍为 `INTERNAL_BUILD`（未做代码签名）；真实店铺、完整人工桌面和跨设备验收仍按边界保留。

**店铺页面改为真正的 DOM `<webview>` 嵌入（2026-09-28，`v0.4.50`，已发布）**: 用户实报"浏览器没有真正嵌入"——根因是旧实现把店铺页面画在主窗口 `BrowserWindow.contentView` 的原生 `WebContentsView` 上，Renderer 里只有一块透明占位 div：HTML 弹层/抽屉/右键菜单**永远盖不住**店铺页（只能靠 `removeChildView` 摘挂原生视图来"避让"），页面尺寸/圆角/`overflow` 也不受 DOM 约束。本轮改为**主窗口 Renderer DOM 里真实的 Electron `<webview>`**：每个 store/tab 一个元素、`partition="persist:store_<storeId>"`、初始 `src=about:blank`，`did-attach` 后调 `browser:registerWebview` 由主进程校验并绑定 guest（校验 sender 是主窗口渲染层、guest 宿主是主窗口、`guest.session` 与店铺分区同实例、无重复占用），再用主进程返回的 `pendingUrl` 做首次导航（此时 session/代理/指纹已就绪）。主进程 `Tab` 句柄从 `WebContentsView` 改为**已注册的 guest WebContents**，`getTabWebContents`/`captureTab`/`pickElement`/导航控制/Agent 可读性/任务引擎全部改走 guest；`displayStore`/`activateTab` 只更新元数据，可见性由渲染层 CSS 控制（隐藏用 `opacity:0 + pointer-events:none`，**不**用 `display:none`/`visibility:hidden`——后者会让 guest 自认不可见，微应用/后台首页会停止渲染，这是本仓库踩过的坑）。安全边界：主窗口 `webviewTag:true` 且注册 `will-attach-webview`，逐次剥掉 Renderer 传来的 `preload`、强制 `nodeIntegration:false`/`contextIsolation:true`/`sandbox:true`/`webviewTag:false`/`backgroundThrottling:false`，只放行真实店铺自己的 `persist:store_<id>` 分区与非 `file:/javascript:` 初始地址，非法附件 `preventDefault()` 并写脱敏日志（远程店铺页拿不到主窗口 preload bridge）。就绪语义：新增 `BROWSER_NOT_READY`（标签页还在、guest 未注册/正在重载——等一会儿就能继续）与既有 `BROWSER_CLOSED`（确实关闭）分开，任务引擎启动前 `waitForTabWebContents`、采集/订单/登录检测入口改用 `waitForStoreWebContents`（等页面可用再判 `PAGE_NOT_READY`）、`captureTab` 不带 rect 截"页面可见区"、Agent 观察先等 5s 再报未就绪。渲染层：`DashboardBrowserSurface` 渲染真元素并显示未注册/加载失败诊断（可重试），`DashboardView` 让 guest 宿主在有店铺打开时常驻（切页只隐藏不销毁，页面状态与登录中间步骤不丢），拾取与任务启动改为"等 guest 注册 + 两帧稳定"而不是固定 650ms/160ms，`UnifiedTaskPage` 去掉 `setViewsObscured`/`setViewport` 的旧原生摘挂逻辑。**真机验证（生产构建 + CDP 驱动真实界面）**：`typecheck` 通过；`vitest run` **67 文件/730 用例通过**（新增 `webview-embedding-boundary` 10 例焊住"退回旧架构/隐藏方式用错/漏校验"三类退化）；`lint` 0 errors；`pnpm build` 通过；**M1 115/115**（含新增判据：DOM 里存在 `WEBVIEW` 元素、分区正确、`getWebContentsId()` 有效且主进程 `guestAttached=true`、guest 页面 `innerWidth/innerHeight` = 元素尺寸、渲染层重载后每标签恰好一个元素且重新注册、菜单层级 220 > webview 层级 1 且页面未被摘除、左右栏折叠时页面真的跟着变宽）；**M3 114/114**；**安全 44/44**（弹层遮挡判据改为"弹窗层级确实压住 webview + 页面未被重建"）；**Agent 78/78**；**自定义任务本地 54/54**（含真跑仿真页：读值 42、页面收到 1 次真实点击、截图工件哈希一致、失败码 `TASK_TEXT_PRESENT` 如实落库，以及拾取遮罩/悬停高亮/自动填选择器/Esc 取消）。验收脚本同步：CDP 目标类型放宽为 `page|webview`（DOM guest 在目标列表里的 type 是 `webview`）、渲染层重载后重新解析店铺 target（元素重建会换调试端点）、左右栏宽度改比 `<webview>` 元素内容盒（容器有 1px 边框，旧断言拿 border-box 比会误报 2px）。**已知边界（本轮未闭环，如实声明）**：① `M2` 阶段1 有两条断言仍按旧的 `session:status` 契约取 `partition`/`tabCount`/`lastProxyAuth`，而当前实现**故意不把这些交给 Renderer**（防分区/凭据外泄）——属于既有断言与加固后契约不一致，与本次改动无关，需要另派一轮把这两条改写成按行为/日志断言；同一原因下环境面板的"已注入代理凭据"一行读不到该字段（既有缺口）。② 窗口被操作系统遮挡时 Chromium 停帧导致平台 rAF 弹层停在屏外的问题照旧（`TASK_TARGET_OUT_OF_VIEWPORT` 如实报出，不是本次引入）。③ 版本发布见本报告末条「v0.4.50 发版记录」。

**UI 界面按设计稿复刻（2026-09-28 起，2026-09-29 收口，`v0.4.50` 同批，用户提供目标图要求 100% 复刻）**: 设计稿是**深色左栏 + 浅色内容区 + 一块深色「销售概览」hero 卡**。左栏深色（#0b1120）、内容区浅色（#f5f7fb），这两块第一版就对；**收官这一轮补上了三处此前漏掉的**：① 「销售概览」卡本身要**深色**（首版做成了白卡）——做法是在 `.ov-card-dark` 上就地重定义 `--dash-*` 与 `--color-text-*` 令牌，卡内的标题/KPI/页签/图表/图例/悬浮卡整体反色，不需要逐个选择器改色；注意**标题色是从外层继承下来的已解析值**（`.dashboard-shell`/`body` 的 `color` 已经算成近黑），卡内改 `--dash-text` 影响不到它，所以标题要单独覆盖一次 `.ov-card-dark h2 { color: var(--dash-text) }`（首版漏了这行，「销售概览」在深底上是深字）。② 图表按图补**竖向网格线**、深色下更亮的折线/数据点（`#9b7cff` / `#4d9bff`）与加深的面积渐变（0.38 → 0）。③ 图例居中、悬浮卡改深色描边卡。**页头按要求整体去掉**（用户指着截图说「图片中的不要显示了」：`SHOPPILOT / OVERVIEW` eyebrow、`经营总览` 大标题、`跨平台经营动态，一目了然` 副标题一起移除，页面直接从卡片开始；当前页位置仍由顶栏面包屑 `工作台 / 经营总览` 标明），**「刷新数据」按钮从页头右端移到「销售概览」标题后面**（同一行紧随标题、卡片内部，随卡片一起反色），`.ov-head`/`.ov-sub`/`.ov-head h1` 三条样式与其在 900px 媒体查询里的引用一并删除。**左栏按图删繁**：去掉店铺搜索框与收起箭头、「订单管理」「设置中心」不再占导航位（设置移到左栏底部一行、订单明细从 Ctrl+K 与数据分析进入）、删掉「本地数据」行，底部改为「Pro 卡 + 设置 + 回收站图标按钮」；品牌 mark 由「商」字改成设计稿里的白描包袋图标。**周期页签**按图补「昨日」（`YESTERDAY`，图注与趋势窗口同步按单日处理）。**快捷操作**确认在 1392px 窗口下就是设计稿的**四列**（此前 2 列是构建产物未刷新造成的误判）。**数据仍是真实值**：KPI 取自自动采集（缺失回落任务快照并标注），「投放花费」「净成交ROI」我们没有任何可信来源 → 如实显示「—」并在 tooltip 说明口径；访客数/转化率同理。图表**以 0 为基线**（min-max 拉伸会把两天的正常波动画成断崖）。**其它页面同步浅色化**：店铺工作台（地址栏/标签/面板/输入全转浅色，webview 内嵌不变）、数据中心、店铺管理、设置、任务、图片、应用、监控卡、任务编辑器、Agent 面板按统一规则处理（背景保色相混白 92%、浅色状态文字按色相压深到语义色，文字色不被误改）。验收脚本同步：主题断言从 `#1a1a1a` 改为 `#f5f7fb`，左栏宽度断言 304/44 → 248/60、变宽阈值 250 → 180；底栏回收站按钮改成图标按钮后，M1 徽标断言与安全套件弹层断言改用 `[data-test="trash-open"]` 定位（**断言意图不变**，只是不能再靠按钮文字找它）。验证：`typecheck` / `lint`（0 errors）/ `build` 通过；`vitest run` **70 文件/747 用例通过**；**M1 全链路验收 115/115**、**M3 套件 PASS**、**安全套件 PASS**、**Agent 78/78**、**自定义任务本地 54/54**（全部真实构建 + CDP 驱动界面）；真机截图逐块与设计稿核对（侧栏配色 `rgb(11,17,32)`、内容区 `rgb(245,247,251)`、KPI 六列、图例 `justify-content:center`、快捷操作四列并列、悬浮卡 `rgb(27,39,64)`）。**已如实声明的差异**：① KPI 数字是真实采集值（设计稿是示例数），投放花费/ROI 显示「—」；② 待办任务标签用真实状态（待确认/较紧急/进行中）而非示例的「今天/明天」；③ 左栏底部**保留回收站图标按钮**（设计稿只画了设置，但回收站是既有功能入口，去掉只能靠改代码访问）；④ 图表数据点取决于已采集天数（当前 2 天），随运行天数自然长成曲线；⑤ 通知铃铛红点只在真有进行中任务时出现（设计稿是常亮）。

**「点了周期但没生效」导致口径错标（2026-09-28，`v0.4.50` 同批，自查发现并修复）**: 逐店核对采集结果时发现微信小店的 `LAST_7_DAYS` 行在 22:13 被写成 `¥0.00 / 0 单`，而同一窗口在 16:52 与 17:03 都是 `¥108.90 / 11 单`。现场核对页面（受信任点击 + 读卡片原文）证实：**默认「今天」视图是 `成交金额 ￥0 昨日￥29.7`，点「近7天」后才变成 `成交金额 ￥108.9 较上周期450.00%`** —— 也就是说 22:13 那次点击没生效，页面还停在默认周期，采集就把「今天」的 0 当成「近7天」写了库。根因：旧实现只验证"点到了控件"（`clickText` 返回 true 仅表示"在元素上派发了点击"），没验证"周期已生效"。修法：点周期前先记下首个指标的原文，点完后轮询直到①值发生变化，或②档案声明的 `periodAppliedText`（微信实测「较上周期」）出现；两条都不成立就报 `PERIOD_NOT_APPLIED` 并且**一个字段都不写**（把默认周期的数字标成目标周期比没有数字更糟）。快手的 `periodAppliedText` 故意不声明——实测它在默认视图与近7日视图都显示「较上周期-」，声明了反而会让判据恒真；它靠判据①（昨日 ¥0 → 近7日 ¥9.80）。**真机复验（店铺全程关闭、后台冷启动，即出事的那条路径）**：微信 `SUCCEEDED` 且写回**正确值** `¥108.90 / 11 单`、快手 `SUCCEEDED` `¥9.80 / 2 单`；新单测补 2 例（点击未生效 → `PERIOD_NOT_APPLIED` 且零字段；值恰好相同但有文案标记 → 判定成功），并让假页面按真机行为区分"点击前/点击后"的数值表。`vitest run` **70 文件/747 用例通过**，typecheck / lint（0 errors）/ build 通过。

**拼多多经营数据接入（2026-09-28，`v0.4.50` 同批，用户"拼多多登录了"）**: 拼多多的经营指标长期是 `DATA_SOURCE_NOT_VERIFIED` —— 表面像"这个平台没数据"，真实原因是它的采集走"网络观察 + JSON 抽取器"路线，而那条路线的注册表在生产里**是空的**（从未拿到可核对的响应结构），于是每次采集都在读页面之前就返回"未验证"（实测 18ms 返回，说明压根没碰过页面）。用户登录后重新实测：商家后台首页（`mms.pinduoduo.com/home/`）的「经营数据」卡片是**纯文本可读**（成交金额 204.93 / 昨日 361.01、成交订单数 7 / 昨日 13），而数据中心页（`sycm/stores_data`、`sycm/evaluation`）的数字是**反抓取字体**（私有区码位渲染，取文本得到乱码）。因此登记 `BUSINESS_PROFILES['拼多多']`（实测日 2026-09-28）：页面=首页、口径=**TODAY**（实测点「7日/30日」页签只切趋势图、卡片数值不变，卡片是"今日实时 + 昨日对照"）、锚点两项（成交金额→`grossSalesAmountMinor`、成交订单数→`paidOrderCount`，字段与单位显式声明、不按中文文案推断），并让 `PddAdapter` 改为继承 `SalesMetricsDomAdapter`（DOM 采集 + 档案驱动的证据自检）；订单能力仍走网络观察；`productSalesMetrics` 由 true 改 false（没有任何已验证的商品级来源，声明 true 是自我夸大）。旧的"自实现 collectSalesMetrics + 恒失败的证据自检"已移除，采集器文件保留但标注为**非生产路径**（将来有可核对 JSON 来源时再注册抽取器并补实测日期）。总览侧修一处优先级：某平台已采到数据时"最近同步"显示真实时间，不再被历史状态"数据源未验证"盖住。**真机验证（真实 profile）**：手动采集 `SUCCEEDED / SALES_METRICS_READ_FROM_PAGE`、`inserted=1`、证据字段 `grossSalesAmountMinor`+`paidOrderCount` 均 present；落库 `TODAY gmv=¥234.92 成交订单=8，source=DOM，adapter=pdd-sales-v2`。单测新增 `pdd-sales-metrics-profile` 5 例（档案登记与口径、锚点字段映射、卡片文本只认主值、「昨日 361.01 / --」不得被当成数值、旧网络路径不得回归），`vitest run` **69 文件/741 用例通过**，typecheck / lint（0 errors）/ build 通过。**已知边界**：① 拼多多目前只有首页这两项可读，销量/退款金额/退款订单数在首页与优惠券文案同名或不可读 → 保持 null、界面显示"未采集"；② 数据中心页的字体反爬**不破解**（破解等于把某次字体映射当契约，页面一改就会静默产出错数字）；③ 它的口径是"今日实时"，与微信/快手的"近 7 天滚动"不同口径 —— 界面按口径分开标注，不混加。

**经营数据没有进到软件里（2026-09-28，`v0.4.50` 同批，用户实报"数据还是没有正常更新到软件"）**: 两个独立缺陷叠在一起。① **展示侧断链**：经营总览的卡片与"销售趋势"只读 `store_snapshots`（该表由「带 metric 的任务步骤」与手动录入写入），而每 10 分钟的自动采集写的是 `sales_metrics` —— 两条链路谁也没接谁，所以采集跑得再勤，页面上的数字也不动（实测卡片显示的 `¥1,469.41 / 15` 是 **9/13** 的旧快照，近 7 天窗口里一个数据点都没有 → "暂无可用趋势数据"）。② **采集侧拿不到页面**：调度器每 10 分钟一轮，但没人给采集开店，用户没开着那家店时页面句柄就是空的 → 每轮都如实报 `PAGE_NOT_READY`（实测 20:47 那一轮四个平台全部折在这里）。修法：总览改为**优先读自动采集**（`salesMetrics.plans()` 取每店采集状态、`salesMetrics.list()` 取所选口径的按天序列）—— 卡片与趋势汇总只在**同一口径**内相加（今日累计 / 近 7 天滚动 / 近 30 天滚动不混算）、只有跨日数据才显示涨跌（同一天多次采集之间比会得到无意义的 0%）、每张卡标注来源（"自动采集" / "任务快照"）与覆盖度（"2/4 家 · 刚刚 · 部分字段"）、访客数与支付转化率如实写"平台未提供该字段"、来源未验证的平台直接标"数据源未验证"而不是拿旧快照日期冒充"最近同步"；并在 `salesMetrics:runFinished` 事件与 5 分钟定时器上刷新，停在总览页就能看到数字自己更新。采集侧：`SalesMetricsCollectionService` 在页面不可用时先 `openStoreBrowser(storeId, { display:false })`（后台把页面挂起来、不抢用户当前页）再等 guest 注册（上限 25s），仍拿不到才报 `PAGE_NOT_READY` —— DOM `<webview>` 模型下"后台开着的店铺页面照样渲染"，这正是能无人值守采集的前提。**真机验证（真实 profile + CDP 驱动，四个店铺全程关闭）**：微信小店、快手小店 `SUCCEEDED / SALES_METRICS_READ_FROM_PAGE`（各 `updated=1`）；抖店首轮冷启动 `NAVIGATION_ERR_LOAD_TIMEOUT`、第二轮 `SUCCEEDED`（页面热身即可，调度器下一轮自愈）；拼多多 `DATA_SOURCE_NOT_VERIFIED`（如实）。总览随后自动刷新为「订单数据 13 / 销售额 ¥118.70 · 自动采集 · 2/4 家 · 刚刚」，趋势说明为「近 7 天滚动 · 自动采集 2/4 家 · 刚刚 · 拼多多数据源未验证」。单测新增 2 例（采集自己开店后成功；开店后仍无页面则如实报 PAGE_NOT_READY），`vitest run` **68 文件/736 用例通过**，`typecheck` / `lint`（0 errors）/ `build` 通过。**已知边界**：① 拼多多的"来源未验证"需要真人核对页面字段后才能接入（当前如实标注，不编数字）；② 访客数/支付转化率四个平台的经营数据页都没提供，界面如实留空；③ 首轮冷启动可能因页面加载超时失败一次，下一轮（10 分钟后）或"立即采集"即成功。

**右上角原生窗口按钮压住工具栏（2026-09-28，`v0.4.50` 同批，用户实报"右上角位置有问题"）**: 统一工作台的 `.dashboard-toolbar` 没有为 `titleBarOverlay` 保留的原生窗口按钮（WCO，约 140×38，画在页面之上）留白，头像/「ShopPilot Pro」/VIP 徽标正好被压在按钮下面；同时工具栏里还留着一组**纯装饰的假窗口按钮**（`<span>− □ ×</span>`，来自早期视觉稿），与真按钮重叠；overlay 底色（`#1a1a1a`/`#242424`）与仪表盘底色不一致，于是在右上角显示成一块多余色块。修法：删掉假按钮；`.dashboard-toolbar` 右侧留白 148px（并去掉窄屏媒体查询里把它改回 12px 的覆盖，WCO 在窄窗口照样在）；工具栏给固定底色 `#0c1220`，`App.vue` 的 `titlebarOverlayColor()` 返回同一色值（跨文件耦合，两边注释互相指路）。新增 `titlebar-toolbar-boundary` 4 例钉住这四条（不得有假按钮、右侧留白 ≥138px、窄屏不得取消留白、两处色值必须相等）。真机核对（临时 profile + CDP）：工具栏 `padding-right=148px`、底色 `rgb(12,18,32)`，最右内容边缘 1252 而 WCO 起点 1262（clear 10px），`window-controls` 元素数 0。测试：`vitest run` **68 文件/734 用例通过**；`lint` 0 errors；`build` 通过；启动日志确认运行的是 `version=0.4.50` 且重启后无 renderer 报错。

**四平台经营数据自动采集（2026-09-28，未提交）**: 把「每店铺每 10 分钟自动采集经营数据」从"只有调度骨架"补成完整链路，并在真实登录态上跑通 **3/4 个平台**。契约与规则：统一状态机扩到 20 态（`TIMEOUT`/`NETWORK_ERROR`/`PAGE_CHANGED`/`PERMISSION_DENIED`/`CIRCUIT_OPEN`/`INTERRUPTED` 不再塌缩成 `ERROR`）、数据状态 14 态（区分真实 0 / 未采集 / 来源未验证 / 部分成功 / 数据过期）、新鲜度阈值与业务口径集中到 `@shared/sales-metrics-rules`（纯函数，Main 与前端读同一份）。数据库：v17 `sales_metrics_traceability` 补来源可追溯列（`source_type`/`adapter_version`/`metric_definition_version`/`data_status`/`run_id`）、运行台账扩展（`safe_message`/`metrics_json`/`inserted`/`updated`）与保留策略索引，新增 `salesRunKeepDays=90`/`salesRawKeepDays=30`。调度：退避改为 `max(正常周期, 退避窗口)`（旧实现固定 `now+周期`，60 分钟退避被 10 分钟周期吃掉）、连续失败 5 次熔断、需要用户处理的状态停机不重试、启动重锚不补发积压、退出与强杀两条路径都不留 `RUNNING`、按 storeId 稳定派生 10～60 秒抖动。IPC/事件：新增 `plan:list/get/update/pause/resume/runNow`、`runs:list`、`health` 八个通道（Zod strict + `familyHandle`）与四个实时事件（三个店铺级事件严格九字段，`healthChanged` 是匿名聚合）。前端：数据中心新增自动采集监控卡（状态 / 新鲜度 / 来源 / Adapter 版本 / 连续失败 / 退避 / 24 小时趋势 / 运行记录抽屉 / 暂停恢复立即采集），`null` 一律显示 `—` 而不是 0。平台：三个"锚点已实测"的平台共用新的 DOM 采集基类，字段映射由档案显式声明（不按中文文案推断）。**真机实测（真实登录态，三次复现一致）**：微信小店 `¥108.90 / 成交订单 11 / 退款 ¥0.00`、快手小店 `¥9.80 / 成交订单 2 / 销量 2 / 退款 ¥0.00 / 退款订单 0`、抖店 `¥0.00`（页面确实是 0，其余字段 null）；拼多多无已验证来源 → `DATA_SOURCE_NOT_VERIFIED`。此前多轮真实失败**全部源于一个仓库已知坑**：窗口不在前台时 micro-app / 后台首页的内容区不渲染（外壳正文 106～109 字 vs 完整 2584 字）——验收脚本因此内置前台保持，Adapter 增加 `PAGE_NOT_RENDERED`（可重试）与 `PAGE_CHANGED`（停机）的分流。真机还修掉三个真实缺陷：值取成"多出来的整段文本"（带出对比行 → "页面写着 0 却报没有数值"）、定位文案对整页上万元素逐个 `innerText`/`getBoundingClientRect`（脚本跑不完 → "页面上有「近7天」却报点不到"）、`period_end` 取采集时刻导致唯一键失效（每 10 分钟插一行，改为自然日边界后 `duplicateGroups=0`）。验证：`typecheck` 通过；`vitest run` **66 文件/719 用例通过**（本功能新增 72）；`lint` 0 errors；`dist:dir` 后打包版 Electron/CDP 验收 **39/39**（开发版同为 39/39）；真实平台探测 3 成功 / 1 未验证；压缩档连续运行 8/8。**状态：`IMPLEMENTED / PARTIAL` + `PACKAGED / INTERNAL_BUILD`——拼多多真实来源与 12×10 分钟/24 小时/72 小时连续运行未完成，不得标记 `VERIFIED` 或发正式版。**

**AI 架构审计 P3 收敛轮（2026-09-26，未提交）**: 承接 `docs/AI_ARCHITECTURE_AUDIT.md` 第八节列出的六项未闭环，逐条先复核再改。① 审计关联键：新增 `auditRequestId(id, detail)` 约定（每次调用真实 id + `#说明`），8 处常量 `requestId` 全部替换；`queryAudit` 支持 `requestId` 精确/前缀过滤（通配符按字面量 + ESCAPE）、`audit:query` filter 改 strict schema；补 `ai.config` 与 `agent.skill.*`/`agent.plugin.*`/`agent.pack.*` 审计（落在各动作唯一漏斗上，区分模型自选与用户手建）。② 拆掉 `overview-service ⇄ ipc` 环：发票/主体取数搬进 `services/overview-service.ts`，新增层级守卫测试锁定 `ipc → services` 单向。③ 模型请求体收敛到唯一构造点 `services/model-request.ts`（请求体/请求头/输出上限，默认上限 128000），五个调用点全改走它并有源码级守卫；整理时测试抓出两个真实缺陷（`Number(null)===0` 让"没传温度"变温度 0、`Infinity` 收敛口径）。④ 记忆快照恢复：新增 `@shared/memory-snapshot.verifySnapshotDigest` + strict `agentMemorySnapshotRestoreSchema`，面板把自己展示过的 sha256 回传、Main 与文件实际摘要不一致即拒绝（残留：`confirmed` 仍是渲染层布尔，彻底消除需 Main 侧原生确认窗，已记录理由）。⑤ `any` 旧数字 579/90 实测为 **941/70**，本轮加棘轮：`packages/shared/**` 的显式 `any` 升为 error（先清干净 15 处：动态 JSON 解析器改 `unknown` 收窄 + 9 条边界用例，IPC 信封默认泛型保留 `any` 并写明理由），其余四层仍为 warn 存量债。⑥ 主进程单文件 1.43MB **接受**（Electron 主进程必须单入口；唯一杠杆 `build.minify` 会毁掉定位 Job/模型失败所依赖的堆栈信息）。另修掉复核中发现的回归：应用锁定时标题栏底色通道被误拒（`familyHandle` 现支持按通道 `allowWhenLocked`，仅此一处）。验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` **58 文件/589 测试通过**；`pnpm.cmd lint` **0 errors/935 warnings**；`tools/ci/verify.ps1` → `CI_ALL_PASSED`；`pnpm.cmd build` 通过；`agent-cdp-runner.js` 78/78；`agent-domain-cdp-verify.js` 87/87；`agent-memory-resilience-verify.js` 4/4；`dist:dir` + 打包 smoke 10/10。

**AI 架构审计 P0/P1/P2 收敛轮（2026-09-26，未提交）**: 按 `docs/AI_ARCHITECTURE_AUDIT.md` 的三批清单逐条复核后收敛。P0：副作用边界收敛为 `@shared/agent-step-effects` 单一来源（`deriveJobRisk`/规划器/任务步骤 schema 共用）、Job 预算按币种口径预留（`@shared/agent-budget`）、采集类 Job 保持自动执行（撤掉 Main 自批，聊天发起即视为确认）。P1：小窗口系统提示词改为**按窗口裁剪并如实上报**（`compactSystemPrompt` + `systemPromptDroppedChars`）而不是抛 `AGENT_CONTEXT_TOO_LARGE`；`ipc/ai-handlers.ts` 6 个通道补可信渲染层校验（新 `AI_FORBIDDEN`）；子 Agent 执行 Job 注入岗位/职责/成功标准（`@shared/agent-job-prompt`，岗位名与界面/模板同源）；legacy `ai-client` 栈纳入用量与预算计量（`services/model-governance.ts`：`resolveMeteringTarget`/`dailyUsageSnapshot`/`assertMeteredBudget`/`recordModelUsage`）。P2：**租约 sweep 不再无条件续租**（`@shared/agent-lease`：只有活着的执行者才续租，另加 `agent.jobs.maxRunMs` 最长运行时限 → `recovery_required` 交人工）；**能力探测参与路由**（`modelCapabilityVerdict`：`chat:false` 拦、`json:false` 只警告——该口径由真机验收校准，最初把 `json:false` 也拦会让 domain 套件 8 项转红）；**其余 8 个 IPC 家族 92 个通道铺开可信校验**（`ipc/family-handle.ts` + 新错误码 `IPC_FORBIDDEN`，应用锁家族显式 `allowWhenLocked`）；确认名单与风险等级解耦（`runInvite`/`updateSkill` 撤出确认但仍是副作用动作）；失败运行不写 `agent_job_results`、`dependencies` 恒空、记忆自审与快照恢复均为**误报**（附 `file:line` 与验收断言证据）。工程：新增 `tools/ci/verify.ps1` 与 `.github/workflows/ci.yml`（后者未在真实 CI 上跑过），把 Agent 四套验收脚本补进 `run-acceptance.ps1`。验证：`pnpm.cmd typecheck` 通过；`pnpm.cmd test` **54 文件/546 测试通过**；`tools/ci/verify.ps1` → `CI_ALL_PASSED`；`pnpm.cmd build` 通过；`agent-cdp-runner.js` 78/78；`agent-domain-cdp-verify.js` 87/87；`agent-memory-resilience-verify.js` 4/4；`dist:dir` + 打包 smoke 10/10。

**自动学习型记忆轮（2026-09-26，未提交）**: 新增 v10 记忆治理迁移与自动学习链路：对话中的明确持久化语义、成功 Job 的脱敏证据、Job 结果/审核纠正会生成 `pending-review` 候选；`sourceRef` 做会话/Job/反馈幂等去重，`origin` 标记来源；审核、命中和评分会更新采纳/拒绝/置信度并参与排序；过期、连续拒绝和长期 stale 自动降级/归档；FTS5 额外写入中文 bigram，快照保留来源与反馈统计；Agent 团队记忆页显示来源、命中、采纳和拒绝计数。已执行 `git diff --check`（仅 CRLF 提示）；本轮未重跑 typecheck、单测、构建、打包或真实模型/桌面验收，仍保持 `PARTIAL/UNTESTED` 边界。

**Agent 扩展（2026-09-24）**: A-M0 已落库；A-M1～A-M4 为 `PARTIAL`，A-M5 为 `PARTIAL`，A-M6 达到 `PACKAGED/PARTIAL`。新增 v5→v7 Agent 迁移、root-ceo/HR/probation、模型 Profile/safeStorage、Job → Task → TaskRun → evidence、租约 owner 防旧 Worker 写回、权限快照变更阻塞、备用 Profile 环校验、结果审核、反馈指标、本地记忆、损坏正文恢复为 conflict 版本、重启后记忆检索、正文和加密快照原子 I/O 故障回滚、CEO 周期复盘摘要和设置页 Agent 团队。`pnpm.cmd test -- --run` 为 33 个文件/369 个测试；Agent Electron/CDP 54/54（含自治运营：非资金写操作免审批、资金 Job 必须确认；子 Agent 未绑定模型继承 default-main、设置页 AI 配置同步与继承、解绑恢复继承、CEO 无可用子 Agent 时拒绝执行、root-ceo 禁止作为执行者、CEO 派单经子 Agent 执行并落 TaskRunner 证据、HTTP 429 只重试一次、能力探测落库、503 后 fallback 路由与 fallbackUsed、401 不降级、日预算阻断、配置单价后的成本估算与未配置价格的“未估算”、进程中断 recovery_required 与安全重新排队、暂停 Agent 拒绝新 Job 并可恢复、FTS 索引重建 hash 保持、损坏正文 quarantine/恢复、同一 userData 重启恢复、备用 Profile 环和停用校验、无 Key 阻塞、safeStorage Key 下本地模型 Job 结果和 evidence、CEO 复盘摘要）；可见智能体真实 Electron/CDP 52/52（多店任务逐店派单；对话记忆：回合带最近对话 + 已审核记忆；思考可见 + 最多 3 轮；非资金自动派发/自动执行、资金与例外清单动作保留确认；模型 429 自动重试、不开店铺也能对话、自己打开店铺并续规划、团队/Job 感知问答、对话创建/激活子 Agent、打开面板、Job 完成自动复盘、计划经 job:delegate 派给 active 子 Agent）；记忆断电/磁盘满时序 4/4；安全套件 44/44；M4 完整安装生命周期 13/13（内含打包对话链路 19/19、安装 3/3、升级 4/4、卸载）；M1 inner CDP 108/108；打包目录 smoke 6/6（设置页 Agent 团队四个子页均可切换并渲染）；真实 Windows SendInput Agent 设置 smoke 7/7；隔离安装器降级/恢复 11/11；NSIS x64 构建通过；lint 0 errors。真实付费模型、真实店铺高风险写操作、完整人工桌面逐项验收、OS 级跨设备恢复未执行，详见 `docs/AGENT_PROGRESS.md` 与 `artifacts/agent/acceptance-manifest.json`。

**Agent 扩展（2026-09-25，未提交）**: 新增 v8 迁移（`agent_skills`/`agent_plugins`）、工具目录 `packages/shared/src/agent-tools.ts`（提示词白名单由目录生成）、技能（AI 用现有工具制作声明式工作流：`createSkill` 自动执行、`runSkill` 逐步执行并回传真实结果、技能只能包含自动执行类工具且禁止嵌套技能管理）、插件（`createPlugin` 打包、`listPlugins`）与技能/插件 JSON 分享包导入导出（`shopilot-agent-pack` v1，设置 → Agent 团队 → 技能与插件，需用户确认、整体校验、同名更新、不含凭据）；技能进入软件上下文与 Agent 抽屉。**真机实测轮**：用真实数据副本（不动原库）按用户路径实测 11 项（对话/工具/技能/插件/记忆/审批/经营数据派单/面板导入导出/v8 迁移/崩溃恢复），发现并修复 5 个真实问题：复合指令被快捷路由劫持、只读指标（退款金额）误触发资金门禁、派单跳过原因被吞、采集 Job 因店铺未打开永久卡 running（TaskRunner 排队泵只启动已打开店铺 → 浏览器 Job 自动开店 + 租约巡检兜底）、采集幂等键跨版本冲突/复用终态 Job 计为已派发（分钟桶幂等键 + 如实标注 + 未实测平台提示）。验证：`pnpm.cmd exec vitest run` 34 个文件/381 个测试；`pnpm.cmd typecheck` 通过；`pnpm.cmd lint` 0 errors（810 warnings）；Agent 域 Electron/CDP 69/69；可见智能体真实 Electron/CDP 61/61；M3 任务引擎 113/113 随本轮改动复跑通过；`pnpm.cmd build` 与 `pnpm.cmd dist:dir` 通过、打包目录 smoke 6/6（Agent 团队五个子页均可切换渲染）。安全 44/44 等不涉及本次改动，未重跑。

**Agent 审查轮（2026-09-25，未提交）**: 对智能体与 Agent 域做功能审查：静态契约比对（45 个软件动作 × 执行分支/标签/目录/提示词白名单一致；页面规划步骤闭合白名单且无写入类步骤）+ 关键链路走查。修复 8 项：①只读范围（`storeScope.readOnly`）从未参与 Job 门禁 → 带 browserTask 的写/提交 Job 拒绝只读 Agent、派单只选非只读执行者（共享选择器 + 单测）、执行助手按需恢复可写并审计、设置面板加「只读范围」开关；②聊天/回合不记模型用量（违反 §7.3）→ 每次调用写 `agent_usage`；③聊天无备用 Profile 降级 → 按白名单降级一次；④Job 轮询超时静默 → 明确提示；⑤采集类 Job 名提取回退到「· 店铺名」；⑥规格要求的 `AGENT_STATUS_CHANGED`/`AGENT_USAGE_UPDATED` 事件从未发出 → 现在发出且抽屉监听刷新；⑦12 个错误码补登记；⑧Workbench 事件监听改用 `EVENT_CHANNELS` 常量。验证：typecheck、单测 34 文件/382、lint 0 errors、Agent 域 CDP 70/70、可见智能体 CDP 61/61、M3 113/113、dist:dir + 打包 smoke 6/6。

**Agent 能力扩展轮（2026-09-25，未提交）**: ①聊天/回合日预算硬阻断（与 Job 同口径，`AGENT_BUDGET_BLOCKED`）；②达人邀约发送接入智能体（`runInvite`，面板与 Main 共用 `@shared/invite-task` 构造器，缺项/未实测如实报错，发送类不进技能）；③逐条订单明细采集（`collectOrders` + `@shared/orders-steps`，实测档案红线 + 设置 `orders.profiles` 即时登记 + 整表逐行落库）；④连带修复：Job 载荷清洗嵌套上限 6→16 层且超限如实报错（旧实现把邀约 loop 载荷第 6 层静默替换成字符串 → `TASK_INVALID_STEP`）、凭据不可解密不再让应用启动失败、显式指定店铺全部无效时如实说明。验证：typecheck、单测 34 文件/391、lint 0 errors（831 warnings）、Agent 域 CDP 78/78、可见智能体 CDP 61/61、M3 113/113、dist:dir + 打包 smoke 6/6。

**Agent 完善轮（2026-09-25/26，未提交）**: ①数据中心新增「订单明细」区块（`overview:orders`：表头文案匹配映射统一列、多余列进 extras、无表头退回列序；一键采集复用面板/智能体同一步骤构造器；可展开全部行）；②智能体新增只读工具 `getOrderDetails`（读最近一次快照、最多 20 条、买家列不进上下文），意图路由区分「采集/查看」；③技能生命周期 `updateSkill`（改名/描述/启用停用 + `agent:skill:update` + 设置面板按钮，停用后 runSkill 如实拒绝）；④对话自动滚动到最新消息（用户报告）：根因是消息 40 条上限后 push 触发 shift、长度恒定而旧实现只 watch length → 改签名式 watcher + 双帧贴底；⑤上翻阅读不打断：新内容只显示「有新消息 ↓」按钮（点击回到最新并恢复跟随），自己发消息仍跟到底，补滚的下一帧回调只在仍跟随时执行；⑥删除截图功能并把原位置改为「待办事件（消息通知）」：待确认计划/等待确认的 Job/未完成 Job/结果待审核/记忆待审核，Job 条目点击直达 Job 看板、记忆条目打开 Agent 团队面板；⑦Job 结束后自动续办（用户：“我提出问题，智能体想办法执行或者解决问题”）：结果回报后把目标+结果交回智能体回合判断下一步（达成给结论、未达成换办法或说明需要配合），只读动作立即执行、需确认动作仍走计划卡，同一批只续办一次、用户发新消息则跳过。验证：typecheck、单测 34 文件/392、lint 0 errors（845 warnings）、Agent 域 CDP 82/82、可见智能体 CDP 67/67、M1 108/108、M3 113/113、dist:dir + 打包 smoke 6/6。

---

## 验收摘要

| 套件 | 结果 | 方式 |
|---|---|---|
| M0：Electron ABI + better-sqlite3 读写 | ✅ `SQLITE_OK abi=123` | `m0-sqlite-check.js`（Electron RUN_AS_NODE） |
| M0：迁移 / 17 表 / WAL / foreign_keys | ✅ 全部落库 | `m0-db-verify.js` |
| M1+：工作台全链路（108 项断言，含设置四页签、达人广场地址覆盖驱动邀约任务、右栏/左栏收起、店铺右键菜单、国内四平台目录与平台入口） | ✅ **108/108** | `tools/acceptance/m1-runner.js` + `m1-cdp-verify.js`（CDP 驱动真实应用） |
| M2：代理/407/备份（30 项） | ✅ **30/30** | `tools/acceptance/m2-runner.js` 阶段1（本地带认证代理 + 备份演练） |
| M2：环境指纹实测注入（8 字段） | ✅ **全部 verified** | `tools/acceptance/m2-runner.js` 阶段2（进程内自检，含时区 CDP） |
| M3：任务引擎（113 项断言） | ✅ **113/113** | `tools/acceptance/m3-runner.js` + `m3-cdp-verify.js`（内置本地测试站点，UI 按钮级驱动） |
| 安全能力：会话包 / Cookie / 应用锁 / 代理巡检 / 弹层遮挡（44 项） | ✅ **44/44** | `tools/acceptance/sec-runner.js` + `sec-cdp-verify.js` |
| 单元测试：会话包格式与加解密（9 项） | ✅ **9/9** | `pnpm test`（vitest，`tests/unit/session-package.test.ts`） |
| M4：发布工程（打包/安装/升级/卸载/诊断包/日志/单实例） | ✅ **13/13 阶段检查**（内含打包态对话链路 19/19、单实例互斥、安装版 3/3、升级 4/4） | `tools/acceptance/m4-runner.js` + `m4-cdp-verify.js`（win-unpacked 解包版 + NSIS 静默安装/升级/卸载） |
| 自动更新：本地 feed 驱动真实安装包（16 项） | ✅ **16/16** | `tools/release/update-runner.js`（打包态 + `SHOPPILOT_UPDATE_FEED` 本地 feed：检查/SHA-512 下载校验/pending 落盘/审计/双通道/故障路径/重启自动检查） |
| 本地功能回归：店铺拖动 / 抖店邀约 / 发票主体 | ✅ **10/10 + 36/36 + 26/26** | `store-drag-local-verify.js`、`douyin-invite-local-verify.js`、`invoice-license-local-verify.js` |
| 审查修复轮（2026-09-22，v0.4.41→0.4.43） | ✅ **单测 322/322、本地 CDP 54/54、真机 SendInput 37/37** | 导航白名单/调度锚定/对账分工/BAD_STATE 友好化/拾取原因码全覆盖；注入脚本收敛；restoreTabs 旧 id 映射；共享 deadline；轮询销毁检查；原生视图遮挡对话框修复（task-layout 切换时显式上报视口）；低优先级收尾（reorder/closeTab 落库、节拍泄漏、转义、SVG、IPC 错误映射、fire 通道契约化、validate 警告、number 类型、PICK_NAVIGATED）；run-acceptance 接入 custom-local |

## 技术选型结论（M0 实测）

- **Electron 28.2.3 → 30.5.1**：28 的 `contentView`/`WebContentsView` API 不稳定；30.5.1（ABI 123）可用。
- **better-sqlite3 9.4.3 → 11.10.0**：electron-v123 预编译，免 Visual Studio。
- SQLite：`journal_mode=WAL` / `foreign_keys=ON` 须在迁移事务外执行。
- 无管理员安装路线：npmmirror + `--ignore-scripts` + 手动 `prebuild-install`（见 INSTALL.md）。

## M1 能力（工作台核心）

- **内嵌浏览器**：主窗口唯一宿主；店铺标签页 = WebContentsView 挂 contentView，`.viewport` 经 ResizeObserver 上报 bounds；一店一 `persist:store_<id>` partition（跨店 localStorage/Cookie 实测互不可见）；标签新建/切换/关闭/固定/重排/独立窗口；关闭重开按 tabs 表恢复；`file:`/`javascript:` 导航拒绝；window.open 拦截转标签页。
- **下载与截图**：will-download → 店铺隔离目录 + `店铺名_文件` 前缀 + 落库流转；`browser:capture` base64 PNG。
- **工作台 UI（§17 深色三栏）**：左栏搜索/筛选/分组卡片/回收站/新建；中栏标签条+地址栏+视口；右栏收藏/下载/环境；Toast、回收站抽屉、严格 CSP。
- **右栏可收起（用户要求"右侧边栏可以收起"）**：右栏收起为 **44px 窄轨**（图标=各面板，点一下即展开并回到该面板；另有 `‹` 展开按钮），展开态页签右侧有 `›` 收起按钮，`Ctrl+Shift+B` 随时切换；状态写入 `app_settings.ui.rightPanelCollapsed` 并在启动时恢复。收起后中栏（`.viewport`）宽度 760→1036px，**原生 `WebContentsView` 同步变宽**（以店铺页 `window.innerWidth` 实测为 760→1036 为证）。两条不变量：① **有待处理的人工确认时拒绝收起**（弹提示"处理完再收起"），避免门禁被藏起来后任务"看不见地等待"；② 收起状态下若来了新的确认请求，自动临时展开并提示（不改用户偏好）。两条都已固化为断言：M1 8 项（含店铺页 `innerWidth` 实测）+ M3 3 项（收起守卫、自动展开、无确认时可正常收起）。
  - 开发过程中这套断言当场抓到自己的一个错：`ws.confirmations` 是 `Record<runId, item>` 对象而非数组，写成 `.length` 恒为 `undefined`，导致两条守卫**静默失效**（点收起照样收起、来确认也不展开）。改为 `computed(() => Object.keys(...).length)` 后复测通过；M3 也因此顺带发现原先 3 条门禁断言是被这个错误连带弄挂的。
- **左栏可收起（用户要求"左侧边栏可以收起和展开"）**：与右栏同一套约定——左栏收起为 **44px 窄轨**（保留 新建 `+` / 回收站 `🗑`（带待办徽标）/ 更新 `↻` / 展开 `›` 四个入口，收起后不成为死胡同），展开态品牌行右侧有 `‹` 收起按钮，`Ctrl+Shift+E` 随时切换；状态写入 `app_settings.ui.leftSidebarCollapsed` 并在启动时恢复。收起后中栏（`.viewport`）宽度 776→1036px，**原生 `WebContentsView` 同步变宽**（以店铺页 `window.innerWidth` 实测 776→1036 为证）。与右栏的差别：左栏收起**不设门禁**——人工确认门禁在右栏，收起左栏不会把它藏起来。已固化 M1 断言 7 项（基线宽度、收起后 HTML 与原生视图双变宽、设置写回、窄轨展开、快捷键切换、窄轨入口完整性）。
- **修复：回收站徽标计数不同步**：`ws.trashStores` 原先只在点开回收站抽屉时才拉取，`moveToTrash` 后不刷新，于是刚移入回收站的店铺不进计数——底部「🗑 回收站」徽标不亮，左栏收起后的窄轨角标同样不亮；`init()` 也不加载，启动时库里已有回收站店铺同样看不到。现 `init()` 与 `moveToTrash` 都刷新 `trashStores`。已固化 M1 断言 3 条（界面新建 → 右键移入回收站 → 底部徽标立刻显示 1 → 收起左栏后窄轨角标同步出现），并做了**反向验证**：把修复还原后这两条如实失败（`after:""` / `railBadge:false`），确认断言不是空转。
- **修复：验收运行器在 Windows 上残留渲染进程**：m1/m2/m3/sec 原先只 `kill('SIGTERM')` 主进程，渲染进程会变僵尸（实测残留 84MB renderer，还会占着调试端口干扰下一次运行）；现统一走 `taskkill /PID <pid> /T /F`（非 Windows 回退 SIGKILL）。m1-runner 另有一处误导日志：正常收尾被杀也无条件打印「!!! 应用提前退出」，现仅在收尾前自行退出时才报。
- **修复：`ui-shot.js` 会在真实数据上做破坏性操作**：该探针原先不传 `--user-data-dir`，直接沿用真实数据目录，而它的 `ctx` 模式会**重命名真实店铺、把一家真实店铺的环境指纹复制到另一家**——跑一次就改了用户的真实数据。现默认使用 `os.tmpdir()` 下的临时库，并在空库时自播种 3 家探针店铺（后台地址指向脚本自起的本地站点，保证离线可跑、页面真能加载），`ctx` 模式的破坏性操作只作用在临时库上；确需复现"用户看到的样子"时显式加 `--real`（`--real` 下不播种、不自起站点，但破坏性操作仍作用在真实库，脚本会先打印警告）。另加 `killTree` 收尾与启动时剪除上次遗留临时库（被强杀时收尾钩子不会执行）。**验证**：连跑 `ctx`（最危险）与 `env` 两次，真实库 248 个文件的大小/mtime 指纹与运行前**完全一致**；同时借本地站点修掉了 `ctx` 探针"菜单落在左栏时可见性"的误报——原先店铺后台地址是外网 URL，页面加载失败/多 target 导致探针取错 target 报 hidden，实为探针失真而非产品问题（改后为 visible，与 M1 断言一致）。
- **修复：依赖链唯一一条「随安装包发布」的漏洞（builder-util-runtime 跨域重定向泄露凭据）**：`electron-updater` 6.6.2 把 `builder-util-runtime` 精确锁在 9.3.1，9.3.1 < 9.7.0 落在 CVE-2026-54673（跨域重定向会泄露 `PRIVATE-TOKEN` 与大小写变体 `Authorization`）范围内。先升 `electron-updater` 6.6.2 → 6.8.9（同为 6.x，它声明依赖 9.7.0），但**升级本身不够**：electron-builder 24 打包时是按 `node_modules` 文件系统扁平化收集生产依赖的，实测即使 `pnpm-lock.yaml` 已全树解析为 9.7.0，它仍从根目录那份来自 devDependencies 的实体目录抄走了 **9.2.4**，导致运行时加载到旧的漏洞版本。故在 `pnpm-workspace.yaml`（pnpm ≥10.6 起不再读 package.json 的 `pnpm` 字段）加 `overrides: builder-util-runtime: 9.7.0` + `publicHoistPattern: [builder-util-runtime]`，让 pnpm 自己把正确版本公开提升到根目录并保持同步。**验证以安装包为准**：解包 `release/win-unpacked/resources/app.asar` 实测 `electron-updater 6.8.9` + `builder-util-runtime 9.7.0`，且只有一份、无冲突；`update-runner` 16/16 通过（检查→下载 80MB→SHA-512 校验→双通道→feed 故障如实报错→重启自动检查），证明该版本组合没破坏更新链路。
- **清理：仓库里那份过期的 `package-lock.json`**：npm 时期遗留，内容连 electron-updater 都没记，留着会让依赖审计（Dependabot / `npm audit`）读到一份与真实安装树不符的锁文件。已移除并加入 `.gitignore`。**收益别高估**：Dependabot 在失去 package-lock.json 后会转而直接扫根 `package.json`，所以 open 告警只从 127 降到 111，并非腰斩——真实收益是消除了一份会误导判断的锁文件。（127 条里确有 63 条 GHSA 在两份 lockfile 上重复计数，但那是 Dependabot 按清单逐一上报的固有行为。）修复后 open 告警的 scope 分布为 **111 条全部 development、runtime 为 0**（修复前 runtime 1 条，即 builder-util-runtime），其中 62 条挂在 electron 上。注意 Dependabot 的 scope 标签只反映 package.json 分区，**Electron 虽在 devDependencies 却是随包发布的运行时**，其告警不应按"不发布"看待。
- **环境坑（重装依赖时必读）**：本仓库 `node_modules` 是 npm 时代遗留的混合树（实测 414 个实体目录 + 18 个 pnpm 链接），pnpm 会把冲突的旧目录挪到 `.ignored_<pkg>`。用 `pnpm install --ignore-scripts` 重装会跳过 postinstall，从而**清空 `node_modules/electron/dist` 与 `path.txt`、以及 better-sqlite3 的原生二进制**（打包不受影响，因为 electron-builder 自己会装原生预编译；但开发态与 m1/m2/m3/sec 起不来）。恢复方式：`electron/dist` + `path.txt` 从 `node_modules/.ignored_electron/` 拷回，better-sqlite3 的 `build/` 从 `node_modules/.ignored_better-sqlite3/` 拷回（或用 INSTALL.md 里的 `prebuild-install --runtime=electron --target=30.5.1`）。另：重装偶尔会报 `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR ... 拒绝访问 (os error 5)`，多为残留文件锁，重试即可。
- **设置弹窗（五个独立页签：配置 / 达人广场 / AI 配置 / Agent 团队 / 关于软件）**：入口在左栏底栏 `⚙ 设置`，左栏收起后的窄轨也有 `⚙`（`rail-settings`）。每个页签**只保存自己那页的数据**（点「保存」写库并关闭弹窗；「关于软件」页只有「关闭」）。Agent 团队页通过 Main IPC 读取组织、模型 Profile、Job 和本地记忆摘要；API Key 仅显示 `hasKey`。
  - **配置**页为国内四家平台逐个指定「首页」地址，落到 `app_settings.platform.homeUrls`（`{"拼多多":"https://…"}`，留空即用平台默认）。**首页按钮取值优先级：配置值 → 店铺自己的后台地址 → 平台目录默认**（配置过就以配置为准，压过店铺自填地址；用户明确选择）；新建店铺的后台地址预填也改用同一来源。
  - **达人广场**页按平台覆盖达人邀约入口地址，落到 `app_settings.invite.squareUrls`。覆盖后任务里的 `waitForPage.urlIncludes` **从该地址末段派生**（不再写死 `daren-square`，否则自定义地址会一直等到超时）——M1 断言直接读新建任务的步骤拿这条证据。
  - **AI 配置**页见下方「M3 能力 → IPC 与 UI」。
  - **关于软件**页显示名称/版本/构建标签/仓库地址，并承载**软件更新**——原先左栏品牌行的「↻ 更新」按钮与窄轨 `rail-update` 已移除，更新整体搬入此页（内部 `data-test` 保持原样，故更新链路的验收只改了"怎么进来"）。
  - 两个地址类页面都只做 `http(s)://` 格式校验、不联网探测可达性（与"不猜测地址"红线一致）。弹窗已登记进弹层遮挡逻辑（否则原生视图会盖住它）。顺带修掉一个老 bug：更新区"启动时自动检查"复选框被 `.modal input{width:100%}` 撑成整行宽（实测 474px + 文字 84px = 558px），把弹窗顶出横向滚动条——现按 `.store-pick input` 的既有做法改为 `width:auto`，并补了五个页签的横向溢出检查。
- **后端**：店铺 CRUD/归档/回收站/purge、`profile:*`、`audit:query`、`overview:stats`、`settings:*`、危险操作全审计、snake→camel 行映射统一。

### 平台适配范围：国内四家（§16 平台适配层）

- **平台目录**：拼多多 / 微信小店 / 快手小店 / 抖店，集中定义在 `packages/shared/src/constants/platforms.ts`（主进程与渲染层同源，preload 以只读静态数据暴露为 `window.shopilot.platforms`；`stores.platform` 仍是自由文本，可填"其他"自定义平台）。
- **默认后台地址**：拼多多 `https://mms.pinduoduo.com`、微信小店 `https://store.weixin.qq.com`、快手小店 `https://s.kwaixiaodian.com`、抖店 `https://fxg.jinritemai.com`。新建店铺时按所选平台**自动填入**（可改；切换平台会替换，但不覆盖用户手填的非默认地址）。
- **平台后台地址与深链的实测依据**（2026-09-11，未登录态 HTTP 校验，非猜测）：
  - 微信小店、抖店：请求不存在的路径返回 **404**，故只收录实测 **200** 的深链 —— 微信小店（`/shop/dashboard`、`/shop/order/list`、`/shop/product/list`、`/shop/aftersale/list`）、抖店（`/ffa/mshop/trade/dashboard`、`/ffa/mshop/order/list`、`/ffa/g/list`、`/ffa/mshop/aftersale/list`）；
  - 拼多多、快手小店：**任意路径都返回 200**（统一重定向到登录页），无法区分深链真伪，因此只收录后台首页，宁缺毋滥、不制造 404 死链。
- **平台入口**：收藏面板顶部按当前店铺平台展示"平台入口"（`bookmark:entryRoutes`，§5.8 `source=entry_route`），**只读展示、不重复入库**（M1 断言 `bookmarks` 表无 `entry_route` 行）；备注随附"页面改版可能调整地址"的如实提示；非内置平台（"其他"）不显示该段。
- 端到端断言（M1 新增 9 项）：目录=国内四家且每家带地址与入口、对话框选项=四家+其他、默认平台与自动填址、切换平台更新地址并提示、入口深链同域且 ≥3、入口不入库、非内置平台无入口、收藏面板渲染入口段、测试数据清理。

## M2 能力（环境·代理·备份）

### 代理管理（§5.3/§6.3）
- `proxy:create/update/delete/list/importBatch/test/bind/history`；凭据 safeStorage（DPAPI）加密入库仅存引用，渲染层绝不回显（`hasCredential` 布尔）。
- 体检：TCP 可达 + 延迟 → `proxy_checks`（滚动 100 条）→ `proxies.status` ok/error；绑定即时对活动 session 生效（`reconfigureProxy`）；代理被删自动回落直连。

### 代理 407 登录注入（§4.3）
- 实测 Electron 30 login `details={url,isMainFrame,firstAuthAttempt,responseHeaders}` **无 isProxy** → 以 `proxy-authenticate` 响应头判定；`session.on('login')` 对 WebContentsView 不触发 → app 级 + **会话对象身份比对**反查 storeId。
- E2E：407 → login → safeStorage 解密 → `callback(user,pass)`，注入事实经 `session:status.lastProxyAuth` 可观测验收；`firstAuthAttempt=false` 时取消防循环。
- 已知边界：无头/CDP 环境 Chromium 不重放 HTTP-GET 代理 407（桌面正常环境会重放），如实记录不伪造。

### 备份与恢复（§10.2/§20/§28）
- `backup:create`：Online Backup API + `integrity_check` + SHA-256 入库。
- `backup:restore`：pre-restore 安全快照 → 哈希校验 → schema 版本门禁 → 覆盖重开（迁移幂等）；任何失败自动回滚，现有数据零风险；恢复后元数据补齐登记。验收含篡改攻击（追加 3 字节 → `BACKUP_CHECKSUM_FAILED`，数据完好）。
- 跨机边界：元数据/配置/标签索引可恢复；DPAPI 会话与代理凭据异机需重登/重录。

### 环境指纹注入与实测（§4.3 机制表全落地）
- UA `session.setUserAgent(ua, langs)`；UA-CH `webRequest` 成对改写 `sec-ch-ua*`（禁止只改 UA 矛盾）。
- 时区 CDP `Emulation.setTimezoneOverride`（仅限本应用 WebContents，attach 失败如实"未验证"）。
- navigator/screen/WebGL/`userAgentData`：主世界注入覆盖（不暴露 Electron/IPC 句柄）。
- `profile:verify` 实测回填：期望 vs 页面实际 → verified/unverified（无头环境 8/8 verified）。
- 修复：WebContentsView 初始 about:blank 不显式 loadURL → 文档永不提交、executeJavaScript 永久挂起。

### UI
- 右栏**环境**标签页：网络出口即时切换 + 凭据注入提示、代理列表（状态/延迟/检测/删除）+ 添加表单、指纹一键验证（✅/❓ 期望→实际）。
- 修复 `store:create` adminUrl 缺省触发 NOT NULL（向导可选 → 空串兜底）。

## M3 能力（任务辅助 · §4.4/§9.2）

### TaskRunner（预定义步骤执行器，无任何任意代码路径）
- **8 种步骤白名单**：`navigate / waitForPage / waitForSelector / readText / readTable / screenshot / fillDraft / waitForUserConfirmation`；每步输入 Zod strict 校验（仅 http/https 导航、参数不可多余），每步独立超时与重试（`retryLimit≤5`，重试事件入进度流）。
- **状态机（§9.2 含 A1 修订）**：`queued→running→(waiting_confirmation⇄)→succeeded/failed/cancelled`，`running⇄paused`，`failed→queued→running`（从失败恢复）。每次迁移持久化 `status_reason`；非法迁移一律 `TASK_BAD_STATE`（含对终态运行暂停/确认的守卫，错误区分"已结束"vs"跨会话遗留"）。
- **失败恢复语义**：每步成功均落 `task_step_results` 凭据（产物步骤=内容结果；等待/导航类=`executed` 行）；"从失败步骤继续"据 `succeededStepIndexes` **跳过已成功步骤不重复执行**（验收：step0 结果行不增加）；副作用步骤（fillDraft/确认门禁）失败**拒绝**原地恢复，只能整任务重跑。
- **人工确认门禁**：`waitForUserConfirmation` → `waiting_confirmation` + `TASK_CONFIRMATION_REQUIRED` 事件 + 渲染层确认条；允许/拒绝/超时三态；**拒绝=门禁拦截**（run→cancelled，绝不继续后续步骤）；确认结果与审计（`task.confirm` 携带 approved 事实，§13 高风险可追溯）。暂停不打断门禁（等待人工即其语义）。
- **运行隔离**：每 run 专属标签页（createTab），跨步骤复用；店铺浏览器未开时入队等待不报错；全局串行队列（并发=1，M3 设计取舍），pump 仅取 `queued` 且店铺已开项（修复暂停后 keepAlive 误恢复竞态）。
- **工件与指标**：截图落 `userData/stores/<id>/artifacts/<runId>_step<i>.png` + SHA-256 入库（视口未渲染时如实 `CAPTURE_EMPTY` 失败，不落 0 字节假图）；`readText/readTable` 带 `metric` → `store_snapshots`（验收 unread_messages=12 / pending_orders=4，`snapshot:list` 查询通道）。填充只存 `{selector, length}` 摘要，**表单原文绝不落库**。

### Scheduler（§4.4-B5）
- 1s tick；`schedule.everyMs`（≥60s 强制）；首见不追赶（now+everyMs 起算，无惊群补发）；`last_fired_at` 落库；**店铺浏览器未开 → 保持排队 + `TASK_SCHEDULED_FIRED` 事件提示，绝不静默拉起**；打开浏览器即唤醒排队项（验收：queuedWaiting=true → 未拉起 → 打开后自动至 succeeded）。

### IPC 与 UI
- **面板二级页签：任务列表 / 达人邀约**（`data-test=task-tab-tasks / task-tab-invite`）。
- **达人邀约（抖店 / 微信小店 / 快手小店）**：面板按当前店铺平台匹配独立档案，未实现平台明确拒绝。抖店当前为结构化抽屉流：主推类目/达人等级/数量/主营/手机号/微信号/核心优势/权益；平台已移除自由话术框，因此不展示旧的手填/AI 话术控件，也不插入二次确认。微信小店为逐位辅助填单流，快手为批量勾选流。
- **AI 配置（设置 → AI 配置，独立页签）**：接口地址（OpenAI 兼容 `/chat/completions`）、模型名、API Key、超时（3–120s）；含「测试连接」（一次最小补全）与**「获取可用模型」**（只读 `GET /models`，地址由接口地址推导：`/chat/completions` 与 `/completions` 分两条正则匹配，合并写贪婪会把 `…/ai/chat/completions` 截成 `…/ai/chat/models`——实测踩过并已修）。推不出地址如实报 `AI_BAD_ENDPOINT`、未配 Key 报 `AI_NOT_CONFIGURED`，**不猜地址、不返回编造的模型名**；拉回的候选可在下拉里选，改接口地址立即作废旧候选。
  - **Key 边界**：`safeStorage`（DPAPI）加密存 `ai_cred.key`（`enc:` 前缀），IPC 只回 `hasKey`；验收断言界面输入框始终为空、DOM 内既无明文也无 `enc:` 密文、`ai_cred.*` 已进诊断包 `SETTING_DENY`。Key 只在主进程内存中使用、不进日志。
  - **网络边界（如实声明）**：主进程 `fetch` 直连出网、**不走店铺代理**；须 https://（仅 127.0.0.1/localhost 允许 http://）；失败按固定错误码如实返回，不静默重试。
- **AI 生成话术（`aiGenerate` 步骤）**：从 `sourceSelector` 读商品信息 → 主进程调大模型 → 用受控组件方式写回 `selector`。**商品来源的如实降级**：抖店邀约抽屉用哈希类名、结构随版本变，写死选择器等于猜测，故档案的 `goodsSourceSelector` 留空 = 运行时从话术框向上找最近的**固定定位浮层**（抽屉）读可见文本；找不到就报 `AI_EMPTY_OUTPUT`，**绝不把整页噪音当商品信息喂给模型**。payload 只存摘要（模型名/长度/来源字符数/来源路径 `sourceHow`/前 40 字预览），**完整话术由紧随其后的 `readText` 落库**（验收：写入后 `readText` 拿到的就是刚生成的话术本身）。
- **修复：`readText` 读表单控件取当前 `value`**。原实现一律读 `innerText || textContent`，而 `<textarea>` 的 `textContent` 是"默认值"，`setInput`/`aiGenerate` 写入后不会变——留档会拿到空串（实测）。现在 `input`/`textarea` 读 `value`，其余元素照旧。
- **任务引擎新增 5 种副作用步骤**：`click`（选择器点击；禁用态报新错误码 `TASK_TARGET_DISABLED`，不静默忽略）、`clickByText`（按元素自身文本点击，第三方平台无稳定选择器时的兜底，取文本最短命中项）、`clickAll`（批量点击并**跳过禁用项**，上限 ≤40；对应平台"已发过消息的达人不可重复邀约"这类限制）、`setInput`（原生 value setter + 派发 `input`/`change`，受控组件才生效）、`aiGenerate`（读页面信息 → 主进程调模型 → 写回输入框，`sourceSelector` 允许留空）。五者均入 `NON_RESUMABLE_TYPES`（不可从失败恢复重试），参数仍是 Zod `.strict()` 白名单、实现为固定注入脚本——**没有新增任何"执行任意代码"的入口**；payload 只存摘要与长度，不存写入原文。
  - **门禁不变量**：提交步骤前必放 `waitForUserConfirmation`；用户拒绝 → run 置 `cancelled` 且后续步骤**没有任何结果行**（M3 断言 `rows=["0:executed","1:executed","2:confirm"]` 即证）。
  - **修复：达人邀约任务此前创建不出来**（0.1.4 起就有的真实缺陷）。`taskCreateSchema` 的步骤超时上限写死 `max(600000)`（10 分钟），而邀约流程给门禁设的是 30 分钟、`DEFAULT_STEP_TIMEOUT.waitForUserConfirmation` 本身是 60 分钟 → `task:create` 一律 `steps[N].timeoutMs too_big` 被拒，界面只显示"步骤不合法：…"，用户点「开始邀约」没有任何反应。上限已提到 `max(3600000)`，并补三条边界断言（30 分钟可创建 / 超 1 小时仍拒 / 默认注入 60 分钟）。**这条是本次新增的"点一下「开始邀约」并检查生成的任务步骤"断言抓到的**——0.1.4 的验收只断言了面板渲染与按钮禁用态，没真正走到创建任务，所以漏了。
  - 平台口径（2026-09-13 抖店精选联盟实测）：单次勾选上限 40、话术 ≤150 字、推荐商品 ≤5 个；额度按「店铺类型 × 达人等级」下发（实测本店仅 LV0–LV3 有额度）；页面改版致文案失配时如实报 `TASK_SELECTOR_CHANGED`。已发过消息的达人行复选框为 disabled——`clickAll` 跳过并在结果里回报跳过数量。
- 通道：`task:create/list/run/pause/resume(mode=continue|retry)/cancel/confirm/results/delete` + `snapshot:list` + 事件 `TASK_PROGRESS / TASK_CONFIRMATION_REQUIRED / TASK_SCHEDULED_FIRED`；调试通道 `task:create:fire`（手动触发调度，测试用）。
- 右栏**任务**标签页：任务卡片（店铺/调度/实时状态 chip/进度日志流 ≤80 行）、步骤明细（✅❌⏳⏸ 图标+结果摘要）、运行控制（暂停/继续/从失败恢复/取消）、顶部黄色**人工确认条**（允许/拒绝按钮）、新建任务对话框（3 个快速模板 + 步骤增删/超时/重试参数）。
- 启动归档：进程重启遗留非终态 run 统一 `failed（进程重启，运行中断）`；跨进程原地恢复明确不支持并给出如实提示（M4+ 可议）。

## 安全与边界能力（会话 / Cookie / 应用锁 / 代理巡检）

### 会话导出/导入加密包（§10.2 / §6.3 / §13）
- **包格式**：`'SHSP' | u32le headerLen | header(JSON，同时作为 GCM AAD) | u32le ctLen | AES-256-GCM 密文 | tag(16B)`；header 携带 `{v, kdf:'scrypt', N:16384, r:8, p:1, keyLen:32, salt(32B 随机), nonce(12B 随机), exportedAt, expiresAt, srcStoreName, srcPlatform}`——KDF 参数随包携带，异机可解（跨机迁移设计）。
- **口令采集**：独立小窗（专用最小 preload + `sandbox:true` + `contextIsolation:true`），**不经过 Renderer、不走业务 IPC**；导出需二次输入确认，强度 <8 位拦截；确认框（危险样式）先于口令框。取消/超时（180s）/窗口关闭 → `SESSION_CANCELLED`，不落盘。
- **有效期**：默认 30 天；明文头（AAD 保护）与载荷双重承载，过期一律 `SESSION_PACKAGE_EXPIRED` 拒绝导入。
- **覆盖语义**：导入先清空目标店 Cookie 再逐条写入并统计 `imported/failed`；**认证失败/结构异常/过期的包绝不动目标现有会话**（验收断言：失败后自有 Cookie 仍在）。
- **指纹回填**：目标店 `browser_profiles.locked=1` 时不覆盖，导入结果如实返回 `profileRestored`。
- **审计**：`session.export` / `session.import`（含失败原因：expired / 认证失败），实体引用 JSON 入 `request_id`。
- **纯逻辑单测**：`tests/unit/session-package.test.ts`（9 项）覆盖往返、密文边界、口令错、密文篡改、头部篡改（AAD 绑定）、截断、过期、非本程序文件、salt/nonce 随机性。

### Cookie 查看器（§6.3）
- `session:cookies` 列表（值仅 `valuePreview` ≤24 字符 + 省略号，HttpOnly/Secure/会话级/到期时间如实展示）、按名称/域搜索、`session:deleteCookie` 单删、`session:clearCookies` 清空（二次确认 + `browser.clearData` 审计）。

### 应用锁（§187 / §189 / §818）
- 主密码校验信息 = `scrypt(salt=固定前缀+密码)` 32B，整段 JSON 再经系统 `safeStorage`（DPAPI）封装后才入库；验收**直接扫描 `shopilot.db` 字节**断言无明文密码。
- 锁定：销毁敏感引用（代理认证追踪 `clearProxyAuthTracking`）、**摘除 WebContentsView**（渲染层 overlay 无法覆盖原生视图，必须卸载）、广播 `SECURITY_LOCKED`。
- **IPC 门禁**：`installLockGate()` 在注册期包裹全部 `ipcMain.handle`，锁定时统一返回 `APP_LOCKED`（白名单仅 `security:unlock` / `security:status`）；验收断言业务通道被拒 + 解锁后恢复。
- 解锁：overlay 输入框（`data-test=unlock-input/btn`）与 IPC 双路径均验证；错误密码拒绝且保持锁定（审计 `security.unlock` failure）。
- `Ctrl+Shift+L` 快捷键锁定（合成键盘事件实测）；空闲自动锁定（`security.idleMinutes` 5/15/30/60，`powerMonitor.getSystemIdleTime()` 判定，实测持久化）。

### 代理健康巡检（§8.1 / §13 不切换红线）
- 三处复检：**绑定即刻**（`proxy:bind` 后异步 `revalidateProxy` + 广播）、**店铺浏览器打开**（绑定过期 >10 分钟或状态非 ok）、**后台每 5 分钟**（`sweepBoundProxies`）；变化通过 `proxy:healthChanged` 推送。
- 红线：**不自动切换、不静默降级**——验收断言代理不可达时绑定仍为 `bound`，且 UI toast 明示"按规范不会自动切换或降级"。

### 诊断与日志（§22 / §6.7）
- 诊断包（自实现 STORE 模式 ZIP，零新依赖，7 件）：`version.json / system.json / database.json`（迁移版本 + 14 张表规模）`/ proxies.json`（体检摘要，**无凭据**）`/ settings.json`（白名单键，**无值**）`/ audit-recent.jsonl / app.log`。
- 红线验收：诊断包字节内**不含** Cookie 值、口令字样；日志写入前对疑似凭据行整行掩码（`[REDACTED-SENSITIVE-LINE]`）。
- 日志按天 `userData/logs/app-YYYY-MM-DD.log`，**14 天保留**（验收：塞入 `app-2000-01-01.log` → 重启被清理，真实执行）；崩溃/未捕获异常/renderer 错误统一落盘（`did-fail-load`、`render-process-gone` 亦留痕）。
- `audit:export` JSONL 全量导出（可过滤）。

## M4 发布工程（§21 / §31）

- **打包**：electron-builder 24.13.3 + NSIS（`electron-builder.yml`），Windows x64、按用户安装、可选安装目录、桌面/开始菜单快捷方式、卸载不删用户数据；`asarUnpack` 解出 better-sqlite3 原生模块（打包态建店/读写实测通过）。
- **离线/受限环境构建要点**：`electronDist: node_modules/electron/dist` 复用本地 Electron；`ELECTRON_BUILDER_BINARIES_MIRROR` 走镜像；**winCodeSign 解压会因 macOS 符号链接权限失败**，需预置 `Cache/winCodeSign/winCodeSign-2.6.0`（本文档记录该环境处理方式）。
- **版本清单**：`release/release.json`（产物 SHA-256 + 体积 + Electron 版本 + DB schema 版本 + 已知边界）；变更与回滚见 `RELEASE_NOTES.md`。
- **构建标签**：无代码签名证书 → 按 §21.5 **只能标记 `INTERNAL_BUILD`**，不得标记 RELEASE。
- **验收（`m4-runner.js`）实测：13/13 阶段检查全通过（`M4_RUNNER_PASSED`）**
  - 阶段1 解包版 19/19：建店/列表/会话读、主进程对话真实点击链路（确认框 → 口令框二次输入 → `<8` 位拦截 → 加密导出落盘 1230B）、取消路径（`SESSION_CANCELLED`）、诊断包 7 件且脱敏、审计 JSONL 导出、按天日志 + 无明文口令、过期日志启动清理。
  - 阶段1 **单实例互斥**：同 userData 起第二个实例 → 15 秒内自行退出，首实例 CDP 仍可用，且首实例日志出现"重复启动"记录（证据取自 userData 日志文件）。
  - 阶段2 安装：NSIS `/S /D=<dir>` 静默安装到自定义目录 → 安装版冒烟 3/3 → 用户数据落盘。
  - 阶段3 升级：覆盖安装成功 → 目录完整性复核（exe + app.asar 均在，无挂起删除）→ 升级后 4/4（既有店铺保留、审计表可读）。
  - 阶段4 卸载：定位 `Uninstall ShopPilot.exe` → 静默卸载清空安装目录 → **用户数据保留**（`deleteAppDataOnUninstall=false`）。
  - 复现命令：`node tools/acceptance/m4-runner.js`（全量）、`node tools/acceptance/m4-runner.js --skip-install`（只跑解包态阶段，约 3 分钟）。

### M4 阶段发现并修复的真实缺陷（打包态验收的产出）

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | 会话包解包时 `tag` 后未推进偏移，结构校验恒失败 | **导入功能完全不可用**（真实用户 100% 复现） | `off += 16` 后再校验；单测覆盖截断/篡改用例 |
| 2 | 对话框资源路径写死 `app.getAppPath()/resources/pw-dialog` | 打包态与开发态均加载不到页面 → 导出/导入弹出**空白窗口**（口令无法回传） | 多候选探测（`__dirname` 相对 / appPath / resourcesPath）+ `did-fail-load` 留痕 + 验收就绪判定 |
| 3 | 对话框 preload 用 `window.__pwDone = …` 直接赋值 | `contextIsolation` 下只落在隔离世界 → **确认/口令按钮点击无反应** | 改用 `contextBridge.exposeInMainWorld`，页面增加"安全桥未就绪"如实提示 |
| 4 | `proxy:bind` 未做即时体检（仅 5 分钟周期 + 开店铺复检） | 绑定坏代理后用户要等巡检才发现 | 绑定后异步复检并广播 `proxy:healthChanged`（仍不自动切换） |
| 5 | 日志单文件滚动、无保留策略 | 与 §22"默认保留 14 天"不符 | 按天 `app-YYYY-MM-DD.log` + 启动清理 >14 天文件（验收实测清理） |
| 6 | 升级安装期间旧卸载器删不掉被占用的 exe → Windows **挂起删除**在本进程树退出后连新装文件一起删 | 覆盖安装后可能出现"装完就没有 exe"（危险） | 验收侧：安装前后整树结束应用进程并等进程消失、安装后等目录写入稳定、升级后 10 秒复核目录完整性（`exe + app.asar` 均在） |
| 7 | NSIS 静默安装按 `runAfterFinish` 自动拉起应用 | 残留实例阻塞后续卸载（阶段4 假失败） | 验收侧在安装/升级/卸载前后清理应用进程树并如实记录；不杀 `Un_A.exe`/`Au_.exe`（NSIS 自身副本，中断会导致卸载器未写回） |
| 8 | 应用未做单实例互斥（两实例会同时写同一个 SQLite 库） | 用户重复启动 → 数据竞争风险 | `app.requestSingleInstanceLock()`：重复启动直接退出并聚焦已有窗口 + 日志留痕（验收断言：第二实例退出 / 首实例存活 / 日志含"重复启动"） |
| 9 | 环境面板 CSS 用 `.env-sec input, .env-sec select {width:100%}` 覆盖了"添加代理"行的宽度定义（同优先级、更靠后生效） | 用户实报"环境界面显示有问题"：**右栏横向溢出被截断**（内容 382px > 可视 302px），协议下拉被撑到 258px、**主机输入框被挤成 18px 基本没法输入** | 通用样式改为只作用于会话/应用锁/备份诊断三段（`[data-test=...]` 限定）；`.add-line` 三个控件改为固定/弹性宽度（74/auto+min60/72）；新增 4 条 UI 布局断言（面板与各分区无横向溢出、协议下拉 74px、主机 ≥60px、三段存在） |
| 10 | 回收站/新建店铺/任务弹窗都是 HTML 弹层，而店铺页面是原生 `WebContentsView`（永远画在 HTML 之上） | 用户实报"回收站打开不正常"：弹窗 DOM 正常但被整块盖住（实测**重叠比例 100%**），用户只看到店铺页面 + 四周变暗，等于点了没反应 | 新增 `browser:setViewsObscured` + `setBrowserViewsObscured()`：弹层打开时摘除视图挂载、关闭后恢复（与锁定态互不干扰）；渲染层用 watch 监听弹层状态；新增 3 条断言（抽屉可开、弹层期间店铺页 `visibilityState` 必须为 `hidden`、关闭后恢复 `visible` 且中栏不空白） |
| 11 | 店铺右键菜单是占位实现：`window.confirm("确定 = 归档该店铺")`，既不显示可选操作、又把归档动作绑在"确定"上 | 用户实报"店铺右键显示不正常"：右键弹的是系统确认框，只有确定/取消，看不到重命名、复制配置等规范要求的能力（§4.3 / §6.6） | 改为应用内右键菜单（7 项：打开/关闭浏览器、独立窗口打开、重命名、复制环境配置、复制店铺 ID、归档、移入回收站），含边界夹取、Esc/点击外部关闭、危险操作二次确认弹窗；菜单与视口相交时才摘除视图（落左栏不摘，避免中栏白闪）；新增 8 条界面断言（含"右键链路 + 改名生效 + 复制配置生效"） |
| 12 | `ProfileManager.copyProfileConfig` 对**没有环境记录**的店铺静默跳过（`if (!target \|\| target.locked) continue`），返回值只有计数 | 从右键菜单"复制环境配置"到未打开过浏览器的店铺时，界面提示成功、实际什么都没复制（实测目标店铺 UA 复制前后都为空字符串），属于静默失败 | 目标缺环境记录时先 `ensureProfileForStore` 补建再复制；返回值改为 `{copied, skipped:[{storeId,reason}]}`，渲染层按实际结果提示（"已复制 N 个，跳过 M 个（环境已锁定/店铺不存在）"）；`profile:copyConfig` 审计保持记录 |
| 13 | 验收脚本自身缺陷：CDP 调用无超时、`attachReady` 只等 `readyState/bridge` 不等 `#title` | M4 打包态对话验收**静默卡死**（15 分钟无输出、残留 7 个实例），以及 `hasTitle=false` 误判（新建窗口先存在空白文档，导航会销毁执行上下文） | CDP `send()` 加 20s 超时与 `TARGET_CLOSED` 拒绝；`attachReady` 改为等到 `#title` 出现并允许重连重试 3 次；未就绪信息带 `href/bodyLen`；点击后窗口关闭导致的响应丢失按"窗口已消失"判定为成功；验收脚本加 8 分钟看门狗（超时明确失败而非挂住） |
| 14 | 人工确认门禁写在"任务"面板分支内部（注释却写着"任何面板都能看到"） | 用户实报"任务功能不正确"：任务进入 `waiting_confirmation` 时若用户正在收藏/下载/环境面板，**界面上看不到任何提示**，任务干等到 60 分钟超时（看起来像卡死） | 确认条移出面板分支、放在页签下方（`data-test=task-confirm`），任何面板都可见；新增断言"切到环境面板后确认条仍可见且不丢" |
| 15 | `.row-del` 把"绝对定位 + `opacity:0` 悬停显示"写在**基类**上（该样式只为 `.row-item` 列表行设计），且被 `.modal input{width:100%}` 覆盖步骤行宽度 | ① 新建任务对话框步骤行的"超时/重试"输入框被撑到 **496px**，整行 ~1100px 溢出，参数与删除按钮被挤出可视区；② 代理行、Cookie 行、任务卡、步骤行的删除按钮**既不可见（opacity 0）又相对 `.modal-mask` 跑到窗口右上角**（实测 x=1356,y=10），用户根本无法删除 | `.row-del` 基类改为可见的静态小按钮，仅 `.row-item .row-del` 保留绝对定位+悬停；`.tstep` 作用域内固定控件宽度（类型 168 / 超时 68 / 重试 68 / 参数自适应）并加"超时/重试"文字标签；新增 5 条断言（对话框无溢出、控件宽度、删除按钮在可视区、代理行删除按钮可见且在行内、标签存在） |
| 16 | `summarizeResult` 先判 `if (!payload) return ''`，而截图步骤载荷恒为 `null`（信息全在 `artifact_path`/`artifact_sha256`） | 截图步骤在任务明细里显示为空（用户看不到截图工件名），尽管文件已落盘并入库 | 截图分支改为优先用工件字段：`截图工件 <文件名> · <哈希前 8 位>`；新增断言"截图结果摘要含工件文件名" |
| 17 | 平台目录是海外平台（Amazon/Shopify/eBay/AliExpress/TikTok Shop/Temu），平台入口书签也指向海外域名且 `getEntryRoutes()` **无任何调用方**（能力悬空） | 与国内电商工作台定位不符：默认新建店铺的后台地址落到 `sellercentral.amazon.com`，平台入口能力在界面上根本不可见 | 平台目录改为国内四家（拼多多/微信小店/快手小店/抖店）+ "其他"自定义项，集中定义于 shared 常量表；`bookmark:entryRoutes` 打通并在收藏面板渲染"平台入口"；空地址时自动填平台默认后台地址；后台地址与深链按实测校验收录（见上节）；新增 9 条断言 |
| 18 | electron-builder 24 + pnpm 依赖收集漏掉 electron-updater 的 3 个叶子依赖（`tiny-typed-emitter` / `lodash.escaperegexp` / `lodash.isequal` 不在 asar 内，其余 74 包都在） | **打包态主进程 require 即崩**：无窗口、无日志、userData 只有 DevToolsActivePort、CDP 0 个页面 target（进程挂着错误框假活）；dev 态经 pnpm 符号链接解析正常，故 m1–m3/sec 全过而 m4/update 直接失败，极难定位 | 二分定位（11:43 旧包正常 vs 新包假活）+ 解析 asar 头部枚举 node_modules 实锤缺包；修复：`externalizeDepsPlugin({ exclude: ['electron-updater'] })` 把 electron-updater 连同依赖**内联进 main bundle**（190KB→677KB），不再依赖 builder 的 pnpm 收集；复测 m4 13/13、update-runner 下载校验链路全通 |
| 19 | `getUpdateStatus()` 返回模块初始化的静态快照，`channel`/`feedSource` 只在 `publish()`（状态变化事件）时刷新 | 验收断言抓到：设置 beta 通道后 `update:status` 仍回显 stable；带 feed 覆盖启动却回显 github（实际功能正确，仅查询回显滞后——正是"如实回显"红线不允许的） | 查询路径改为即时刷新 `channel/feedSource/currentVersion`（不广播事件）；update-runner 两条断言复测通过 |
| — | **工具链事故（如实记录）**：用 PowerShell `$raw.Replace($pair[0], $pair[1])` 批量改测试用例里的平台名时，`$pair[0]` 实为字符串首字符 `'p'`，导致 3 个验收脚本（`m4-cdp-verify.js`/`ui-task.js`/`dialog-probe.js`）中**所有小写 `p` 被替换成 `l`**（`platform`→`llatform`、`process`→`lrocess`），另 4 个套件因替换串较长未受损 | 三个脚本被破坏、无版本库可回滚 | 以完好源码/脚本为语料做"部分 `l` 还原为 `p`"的变体求解（唯一解才自动应用），再逐处人工确认外部契约名（`complete`/`app.log`/`__m4exp`/`panelBtn`/`paste` 等）；`node --check` + **重跑全部套件通过**证明恢复正确（M1 71/71、M4 13/13、两个探针跑通）；此后源码批量修改一律走 `edit` 工具或带命中计数的定点脚本 |

> 1–3 是"只有在**打包产物内真实点击**才会暴露"的缺陷；M4 之前的套件用测试钩子绕过对话框，故未发现。这套打包态对话验收现已固化为阶段1 的固定检查项（含"桥必须就绪"断言）。第 13 条是**验收脚本**自身的健壮性缺陷（非产品缺陷），一并记录以免后人重复踩坑。
>
> 另修一处**单测误报**：`密文边界` 用例用 2 字节 Cookie 值 `v1` 断言"不得出现在文件中"，而密文是随机字节，该断言约 1% 概率随机命中 → 已改用长标记值（`SID_VALUE_3f9a1c7e5b2d8a4097c6`），连跑 20 次 0 失败。产品代码与包格式未改动。



## 自动更新（§21 · electron-updater）

- **feed**：electron-builder `publish: github`（Amike-cc/ShopPilot），构建产出 `latest.yml`（stable 通道）；`beta.yml`（beta 通道，`allowPrerelease`）。环境变量 `SHOPPILOT_UPDATE_FEED` 可覆盖为 generic feed（内部镜像/验收用，`feedSource=env-override` 如实回显并写日志）。
- **链路**：左栏"↻ 更新"→ 对话框（当前版本/通道选择/自动检查开关）→ `update:check` → available → `update:download`（electron-updater 下载后 **SHA-512 校验**通过才进入 downloaded）→ `update:install`（`quitAndInstall`，NSIS 安装失败保留旧版本，§20 回退语义）。未下载完成时 install 被守卫拒绝。
- **双通道（§21 建议）**：设置键 `update.channel`（stable/beta），主进程检查时读取并映射 `autoUpdater.channel`（latest/beta）；`update.autoCheck`（默认关闭）开启后打包态启动 8s 延迟自动检查一次。
- **审计与事件**：`update.check` / `update.download` / `update.install` 全部落审计（含失败原因 JSON）；渲染层经 `update:statusChanged` / `update:progress` 白名单事件实时更新进度条。锁定态下更新通道同受 `APP_LOCKED` 门禁。
- **验收（`tools/release/update-runner.js`，16 项全过）**：本地 HTTP feed 伪装 9.9.9 版本驱动 `release/win-unpacked` 真实安装包——初始状态/对话框与通道 UI/install 守卫/发现新版本/80MB 下载+SHA-512 校验/pending 缓存落盘/安装按钮出现/审计 check+download success/同版本 not-available/beta 通道生效/feed 500 如实报错+审计 failure/重启后 autoCheck 自动检查。不执行 `quitAndInstall`（会真装伪装版本），安装器行为由 `tools/acceptance/m4-runner.js` 的 NSIS 阶段覆盖。
- **边界（如实）**：无代码签名证书 → 仅哈希校验、无签名校验（INTERNAL_BUILD）；开发态（非打包）不执行在线检查并如实提示。
- **线上发布历史**：GitHub Release v0.1.0 与 beta 演练曾完成并已清理；2026-09-27 已通过发布脚本幂等更新 GitHub Release `v0.4.48`，包含当前构建的 EXE、blockmap 与 `latest.yml`。
- **真实线上更新演练（2026-09-12，`update-online-drill.js` 12/12 通过）**：发布 `v0.1.1-beta.1` prerelease（exe + blockmap + `beta.yml`）后，用 0.1.0 打包版走**真实公网 GitHub 链路**：① stable 通道检查 → `not-available`（**prerelease 隔离**，GitHub `/releases/latest` 语义，实测确认）；② 切 beta 通道 → 发现 `0.1.1-beta.1`；③ **真实下载 85,660,524B（20s）→ SHA-512 校验通过 → pending 落盘（尺寸与 beta.yml 一致）→ 进度事件 → "重启并安装"按钮出现 → 审计落库**；④ 对下载产物 `/S` 静默安装 → 安装版 `currentVersion=0.1.1-beta.1`（**真实升级成功**）；⑤ 升级后 beta 复查 → `not-available`（版本闭环）；⑥ 静默卸载无残留。演练毕删除该 prerelease（release+tag 均 204）并恢复 0.1.0 现场（产物、版本号、`releases/latest` 均已验证复原）。注：产品内"重启并安装"走 `quitAndInstall(false,true)` 带交互向导，无人值守演练以同一 NSIS 安装包的 `/S` 静默安装等效替代。首轮演练曾暴露 2 处**脚本自身**缺陷（未先打开对话框即断言按钮；NSIS 卸载异步空壳目录），修脚本后复跑全绿——非产品缺陷，如实记录。

## 已知边界（如实声明）

- **验收环境边界**：`screenshot` 步骤要求店铺视图真的处于可见/可渲染状态。若桌面上有另一个 Electron 实例或最大化窗口压在前面，`capturePage` 会如实失败（`CAPTURE_EMPTY`／CDP 报 `Current display surface not available for capture`），m3 会因此在"推进至确认门禁"这条上前置失败。**跑验收前请先关掉其它 Electron 实例**（今天实测：忘记关就会 10/82，关掉即 82/82）。这是环境敏感而非产品缺陷，但会误导排查，故记在此。
  - 2026-09-13 补充：开发机的**普通浏览器窗口**（Chrome/Edge 等，不能替用户关）也会造成同样后果。已给 m1/m3 运行器加两项**测试环境专用**的处置：启动参数 `--disable-features=CalculateNativeWinOcclusion` + `--disable-backgrounding-occluded-windows`，以及运行期间每 2.5s 把被测窗口保持在前台（`SHOPILOT_NO_KEEP_FOREGROUND=1` 可关，会短暂抢焦点）。**产品启动参数与行为均未改动**；实测未加处置时 m3 稳定卡在截图步骤、加上后 90/90。
- **AI 边界**：① 主进程 `fetch` 直连出网、**不走店铺代理**（Chromium 的 session 代理管不到主进程）；② 接口地址须 https://（仅 127.0.0.1/localhost 允许 http://）；③ API Key 只在主进程使用（safeStorage 加密），界面与诊断包都不带出；④ 仅对仍存在自由话术框的平台启用 AI 话术，读不到稳定商品抽屉就如实失败（`AI_EMPTY_OUTPUT`），不拿整页文本充数；抖店当前结构化抽屉没有话术框，因此不展示 AI 话术控件。
- **会话包内容边界**：包内只有 Cookie（明文清单，容器级口令加密）+ 环境指纹配置 + 店铺元信息；**localStorage/IndexedDB 不在包内**（异机导入后部分站点可能要求二次验证）。包头明文暴露来源店铺名/平台/有效期（供导入前确认来源），Cookie 与指纹在密文内。
- **应用锁边界**：主密码用于应用锁与 KDF，**不重加密 Chromium profile**（§10.2/§633）；锁定隐藏视图 + 门禁业务 IPC，属"防顺手查看"级别，已解锁进程内存中的会话仍由操作系统用户隔离保护。
- **代理**：规范红线——不可用时不自动切换、不静默降级，仅检测 + 如实展示（无自动故障转移能力）。
- **发布**：无代码签名证书 → 构建标记 `INTERNAL_BUILD`；`v0.4.48` GitHub Release 已发布，更新包仅做 SHA-512 哈希校验、无签名校验；自动更新本地 feed 链路 16/16 通过。崩溃报告上传通道未实现（默认关闭，符合 §22 默认关闭要求，仅本地落盘）。
- 拖拽排序已接 UI，并由店铺拖动本地端到端验收 10/10 覆盖状态、插入线、数据库顺序与刷新恢复。
- 任务引擎边界：全局串行队列（并发=1）；确认门禁默认 60 分钟超时（期间队列停驻属预期语义）；截图需该店视口正在渲染；跨进程原地恢复不支持；步骤间无参数传递（后续步骤读前序结果需 M4 表达式能力）。
- **渲染层重载后中栏回到欢迎页**：主进程侧店铺页面仍在（数据无损失），但工作台不会自动恢复"正在显示哪个店铺"，需在左栏重新点开；仅在开发态 HMR 或渲染进程崩溃恢复时可见。
- 设计稿像素级人工核对待做（需用户比对 `../assets/design/shopilot-ui-concept-v1.png`）。
- 备份跨机恢复语义、浏览器崩溃隔离与"两店铺不串用"已由 M2 阶段验收覆盖，但**跨机恢复需在第二台真机人工复核**（自动化用独立 userData 模拟）。
- 真实桌面 SendInput 验收本次完成 12/13；最后一批输入时宿主窗口抢占前台，被 `win-input.ps1` 的 PID 保护拒绝，需在稳定前台的 Windows 会话补跑。

## 运行方式

```powershell
cd D:\code\电商浏览器
.\node_modules\electron\dist\electron.exe . --no-sandbox   # NODE_ENV=production
```

- 数据：`%APPDATA%\shopilot\shopilot.db`（WAL）；下载：`...\stores\<id>\downloads\`；备份：`...\backups\`；日志：`...\logs\app-YYYY-MM-DD.log`
- 验收：`node tools/acceptance/m1-runner.js`（115 项）；`node tools/acceptance/m2-runner.js [stage1|stage2]`（阶段1 30 项，阶段2 指纹字段）；`node tools/acceptance/m3-runner.js`（114 项）；`node tools/acceptance/sec-runner.js`（安全能力 44 项）；`node tools/acceptance/m4-runner.js [--skip-install]`（发布工程 13 项）；`node tools/release/update-runner.js`（更新链路 16 项，需先 `pnpm dist`）；`powershell -ExecutionPolicy Bypass -File tools/acceptance/run-acceptance.ps1`（一键串行：打包+全部套件+清单）；`node tools/ui/ui-panel.js`（右栏收起专项探针：打印面板/中栏/原生视图三项宽度实测）。各自使用独立临时 userData；跑前退出运行中实例释放 9223–9228、9232 端口；M3/M4/探针自带本地测试站点
- 单元测试：`pnpm test`（vitest）
- 打包：`pnpm dist`（electron-vite build + electron-builder NSIS）→ `node tools/release/release-manifest.js` 生成 `release/release.json`
- 开发模式：`pnpm dev`
- 调试工具：`node tools/ui/dialog-probe.js`（起一次开发态实例并直接查看主进程对话框窗口内 `__pwDone` 安全桥是否注入、导出调用返回值——排查"对话框点了没反应"这类问题的第一现场）

---

## v0.4.50 发版记录（2026-09-29）

- **提交**：`f8e45be85c9a42f281b45979b98e9b42bdd2530f`（分支 `main`，构建时工作区干净——发布清单 `release/release.json` 的 `git.dirty=false`/`git.rev` 可复核）。
- **产物**：`release/ShopPilot-Setup-0.4.50.exe`（85,681,112 B，sha256 `f2d2c870388e299c…`）+ `.blockmap` + `latest.yml`；`dbSchemaVersion=17`；构建标签 `INTERNAL_BUILD`（未配签名，§21.5）。
- **GitHub Release**：https://github.com/Amike-cc/ShopPilot/releases/tag/v0.4.50 （非 draft、非 prerelease、已标记 Latest；tag 指向上面那个提交）。
- **发版前的一个坑**：本地 `main` 比 `origin/main` 领先 14 个提交（前几次发版只打了包、没推分支，于是它们的 tag 都指到旧提交上）。本次先 `git push origin main` 再发布，保证「tag / 安装包 / 发布清单」三者指向同一份代码。
- **发布前复跑**：`typecheck` 通过、`lint` 0 errors、`vitest run` 70 文件/747 用例通过、`electron-builder --win --x64` 出包成功。过程中修掉一条**与实现无关的 flaky 用例**：调度器的「全局并发上限为 2」依赖 1 秒真定时器与测试里 `settle()` 的赛跑，机器快慢直接决定通过与否。
- **未闭环（如实声明）**：未做代码签名（Windows 可能显示未知发布者）；更新包只做 SHA-512 校验、无签名校验；本次**没有**在安装态实机跑完「检查更新 → 下载 → 安装」全流程（`tools/release/update-runner.js` 验的是本地 feed 的机制，不是线上 feed）。

**概览数据补全（2026-09-29，`v0.4.51` 同批，用户要求"补全概览数据"）**: 六项概览里「投放花费」「净成交ROI」长期恒为「—」，退款两项与订单数的覆盖也残缺。经营数据没有平台 API，只能按**实测标签锚点**读页面，所以先做真机锚点枚举（`artifacts/sales-metrics/*-discovery.json` 留档），再按证据登记：① **新字段 `adSpendMinor`（迁移 v18）**，抖店「投放消耗」+ 拼多多「推广花费」实测可读（拼多多 今日 ¥10.11 / 昨日 ¥48.48），快手/微信留 null，**不估算**；② 「净成交ROI」改成**「投产比 ROI」= Σ成交金额 ÷ Σ投放花费**，且只用同时报了这两个字段的店铺（分子分母同源）——原定义要净成交额÷花费，而缺退款来源的平台上净成交额必为 null，等于永远算不出来；③ **抖店从 1 项补到 3 项**（新识别「成交订单数」「投放消耗」，推翻 09-13 的旧结论），订单数覆盖变成 4/4；④ 抖店/拼多多的退款**故意不登记**（抖店退款列的默认基准是「支付时间」，与本仓"按退款完成时间"的定义不符，列内下拉切基准实测不可靠；拼多多首页只有待处理工单数，售后页会跳设置页）——宁缺不按错误基准填数。**真机验证**：四店「立即采集」全部 `SUCCEEDED`（抖店 ¥0/0 单/投放消耗 ¥0、拼多多 ¥61.78/5 单/推广花费 ¥10.11、快手 ¥4.90/1 单、微信 ¥89.10/9 单），总览「今日」口径 投放花费 ¥10（2/4 家）、投产比 ROI 6.11（2/4 家）。**同时修掉两处真缺陷**：① **快手连续 9 次 PERIOD_NOT_APPLIED 停采**是假阴性——页面本来就停在目标周期（SPA 记住上次选择），点同一个页签是空操作，值/文案两条判据必然不成立；新增第三条判据"控件自身显示该周期已选中"（文字色/背景色与同组页签不同，实测快手 未选中 `rgb(44,46,48)` / 选中 `rgb(50,107,251)`），**点击前也认**，且不放松 2026-09-28 事故的护栏（那次失败后页面仍停在「今天」，目标页签未呈现选中态 → 仍如实报错），判定依据写进运行记录（`周期判据：VALUE_CHANGED/MARKER/CONTROL_SELECTED/BASE_SELECTED`）；② 冷启动后台 SPA 的「未就绪」等待 30s→45s（拼多多在"刚启动+页面刚自动打开"那条路径上 30 秒没等到 `/home`，人工导航同址 4 秒就到，把"慢"误报成"坏"会白跑一轮）。测试：`vitest run` **70 文件/752 用例通过**（新增周期判据③行为用例 2 条、抖店档案 3 锚点、v18 迁移列断言、投放花费快照字段）；**M1 115/115**；typecheck / lint（0 errors）/ build 通过。**已知边界**：概览的每个口径不可能都 4/4——各平台只暴露一种固定窗口（抖店/拼多多"今日实时"、快手/微信"近 7 天"），要让每个页签都齐需要**多口径采集**（同店按多个周期各采一轮），本次未做，已如实写进发布说明。

## v0.4.51 发版记录（2026-09-29）

- **提交**：`5f63235814008fa2c4e0b4f1192bcee37b00f83a`（分支 `main`，构建时工作区干净——发布清单 `release/release.json` 的 `git.dirty=false`/`git.rev` 可复核）。
- **产物**：`release/ShopPilot-Setup-0.4.51.exe`（85,679,968 B，sha256 `ba74f908ed0d3aa3…`）+ `.blockmap` + `latest.yml`；`dbSchemaVersion=18`（本版新增 `ad_spend_minor` 列）。
- **GitHub Release**：https://github.com/Amike-cc/ShopPilot/releases/tag/v0.4.51 （非 draft、非 prerelease、已标记 Latest；tag 指向上面那个提交）。
- **发布前复跑**：`typecheck` 通过、`lint` 0 errors、`vitest run` 70 文件/752 用例通过、`electron-builder --win --x64` 出包成功、`m1-runner` 115/115（含 v18 迁移在全新库执行）。
- **未闭环（如实声明）**：未做代码签名（Windows 可能显示未知发布者）；更新包只做 SHA-512 校验、无签名校验；未在安装态实机跑完「检查更新 → 下载 → 安装」全流程；概览每个口径不可能都 4/4（各平台只暴露一种固定窗口，需要多口径采集才能补齐，本次未做）。

**多口径采集（2026-09-29，`v0.4.52` 同批，用户要求"四个平台的数据都要获取"）**: 0.4.51 把六项指标的**字段**补齐了，但总览每个页签仍只有一半平台有数据——各平台只暴露一种固定窗口（抖店/拼多多「今日实时」、快手/微信「近 7 天」）。这一版让**一次采集跑多个口径**：档案新增 `extraPeriods`（口径 + 控件文案 + 生效文案），真机验过才登记（快手「近30日」0→¥142.71/13 单/退款 ¥35.12；微信「今天」「近30天」→¥237.60/24 单/退款 ¥19.80）；抖店首页的「近7日」是卡片内对比标签（点了数值不变）、拼多多页签只切趋势图 → 都不登记，宁缺不点错。实现要点：① 每个口径各跑一遍"点控件 → 三条判据验证 → 等重取数 → 读锚点"，**主口径失败=整次失败、附加口径失败=部分成功**（主口径数据照旧落库并写明谁没成）；② 库里按 `(platform,store,period_start,period_end)` 唯一，一次采集写多行互不覆盖，服务层改按**每行自己的**口径归一化（此前统一按主口径写会把 30 天标成 7 天），运行快照改取主口径那一行；③ 附加口径在**进门时**按预算一次性决定（<45s 只采主口径并写明），调度器预算 90→120s、手动采集默认 60s。**真机验证（四店「立即采集」全部 SUCCEEDED，30 秒内跑完）**：快手 2 口径、微信 3 口径、拼多多/抖店各 1 口径；总览「近 30 天」从**完全没有数据**变成 ¥380（2/4 家）/订单 37/退款 ¥55/退款订单 3，「今日」六项里有五项有值（含投放花费 ¥10、投产比 ROI 6.03）。测试：`vitest run` **70 文件/757 用例通过**（新增多口径落库/附加口径失败/主口径失败/未登记口径被拒等 5 条）；M1 115/115；typecheck / lint（0 errors）/ build 通过。**已知边界**：「昨日」页签仍无自动采集（快手默认视图是昨日但页面上找不到可点的控件）；投放花费/ROI 只在「今日」有值（花费字段只存在于今日实时卡片）；退款金额/退款订单来源仍只有快手（+微信退款金额）。

## v0.4.52 发版记录（2026-09-29）

- **提交**：`e16295f60d4da15d6e8eb3e88fd1f5bdffd94273`（分支 `main`，构建时工作区干净——发布清单 `release/release.json` 的 `git.dirty=false`/`git.rev` 可复核）。
- **产物**：`release/ShopPilot-Setup-0.4.52.exe`（85,681,157 B）+ `.blockmap` + `latest.yml`；`dbSchemaVersion=18`。
- **GitHub Release**：https://github.com/Amike-cc/ShopPilot/releases/tag/v0.4.52 （非 draft、非 prerelease、已标记 Latest）。
- **发版时踩到一次网络抖动**：发布接口成功、但 `git push origin main` 超时失败，于是**服务端 tag 指到了上一个提交**（3023837）。补推分支后把 tag 强制指回 e16295f 并复核（`gh api …/commits/v0.4.52` 返回 e16295f）。教训：发布流水线里"先推送、后发布"两步都要各自确认结果，别把 push 的输出当成功。
- **发布前复跑**：`typecheck` 通过、`lint` 0 errors、`vitest run` 70 文件/757 用例通过、`electron-builder --win --x64` 出包成功、M1 115/115。
- **未闭环（如实声明）**：「昨日」页签无自动采集数据（快手默认视图是昨日但页面上找不到可点控件）；投放花费/ROI 只在「今日」有值；退款来源仍只有快手（+微信退款金额）；未做代码签名，更新包仅 SHA-512 校验。

**「浏览器不能打开新标签页」（2026-09-29，`v0.4.53` 同批修，用户实报）**: 真机逐段复现（生产构建 + CDP + 真鼠标）后定位到两点。① **根因：`<webview>` 没有 `allowpopups`**——Electron 的 `<webview>` 默认禁止弹窗，页面里 `target=_blank` 的链接与 `window.open` 在 webview 层就被丢弃，主进程 `setWindowOpenHandler` **根本不会被调用**（实测真鼠标点一个 `target=_blank` 链接：页签数不变、日志里一条 `window-open` 都没有）；加上 `allowpopups` 后同一次点击立刻开出新标签页并加载目标地址。这不是放开安全边界：该属性只是允许把新窗口请求交给主进程判断，主进程仍 `action:'deny'` 掉原生弹窗、改成同一 `persist:store_<id>` 分区下的**应用内标签页**，`will-attach-webview` 的 preload 剥离与权限锁死照旧。② **失败被静默吞掉**：旧 handler 是 `try { createTab } catch {}`，真出错时表现为"点了没反应"、现场只剩空白页且无日志——现在成功写 info（店铺/页签/disposition/目标）、失败写 warn（含原因）。顺带核实用户路径其它环节本来就正常：点左栏店铺卡会切到「店铺工作台」、工具栏「+」连点 3 次页签 3→6 且每个标签页各挂一个 `<webview>`。测试：`vitest run` **70 文件/759 用例通过**（新增 2 条源码级护栏：`<webview>` 必须带 `allowpopups`；window-open 失败分支必须留日志不许吞异常）；M1 115/115；typecheck / lint（0 errors）/ build 通过。

## v0.4.53 发版记录（2026-09-29）

- **提交**：`1dc6f319c3818280400ce314d7fc72c7dab79a76`（分支 `main`，构建时工作区干净；发布清单 `release/release.json` 的 `git.dirty=false`/`git.rev` 可复核）。
- **产物**：`release/ShopPilot-Setup-0.4.53.exe`（85,679,952 B）+ `.blockmap` + `latest.yml`；`dbSchemaVersion=18`。
- **GitHub Release**：https://github.com/Amike-cc/ShopPilot/releases/tag/v0.4.53 （非 draft、非 prerelease、已标记 Latest；tag 指向上面那个提交）。
- **流程改进**：这次按 0.4.52 的教训**先确认 `git push` 成功再发布**，tag 一次就指对（`gh api …/commits/v0.4.53` 返回 1dc6f31）。
- **发布前复跑**：`typecheck` 通过、`lint` 0 errors、`vitest run` 70 文件/759 用例通过、`electron-builder --win --x64` 出包成功、M1 115/115。
- **未闭环（如实声明）**：未做代码签名（Windows 可能显示未知发布者）；更新包只做 SHA-512 校验；安装态「检查更新 → 下载 → 安装」未跑全流程；页面弹出的新窗口统一变成应用内标签页（设计选择，需要独立窗口时用店铺右键菜单）。

**「刷新数据」改为手动采集 + 采集链路优化（2026-09-29，`v0.4.54` 同批，用户指出）**: 原来「刷新数据」只是把本地库已有数字重画一遍（数字来自每 10 分钟自动采集），按下去数字不变，看着像采集坏了。改为**真的去采**：对当前筛选范围内的店铺逐个入队「立即采集」（走调度器同一条路径：有运行记录、并发上限、失败退避），按钮等待期间显示 `采集中 n/4` 并禁用，全部跑完读库刷新卡片并弹汇总（成功家数 + 每个失败店铺的**原因码**，如「统计周期没切换成功」）。同时优化采集链路三处：① **手动并发 2→4**（周期采集仍保守 2 家）——四家从两两排队一分多钟变成同拍全开，实测整轮 **25 秒**；② **没有计划的店铺不再"点不动"**：`requestImmediateRun` 对无计划行的店铺**按需补建计划**（本机确有一家店如此，原来直接 `PLAN_NOT_FOUND`），平台没有实测档案时则如实返回 `PLATFORM_PROFILE_NOT_MEASURED` 而不建一个每轮必失败的计划；③ **计划同步不再为无实测档案的平台建计划**（自定义/未接入平台原会拿到一个每轮失败的计划，把健康度刷成噪声）——这类计划会被停用并写明原因。真机验证（生产构建 + CDP + 真鼠标）：点按钮 → `采集中 0/4`→`1/4`→`2/4`→`3/4`，同窗口新增 4 条运行记录且**四家全部 SUCCEEDED**，约 25 秒后按钮恢复、卡片新鲜度从「6 分钟前」变「刚刚」，汇总提示实测「已按当前口径采集 4 家店铺的最新数据」。测试：`vitest run` **70 文件/762 用例通过**（新增按需补建计划、无档案平台拒绝、手动并发放宽 3 条）；M1 115/115；typecheck / lint（0 errors）/ build 通过。
