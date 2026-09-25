# ShopPilot 开发状态报告

**报告时间**: 2026-09-24
**开发阶段**: M0 ✅ + M1 工作台核心 ✅ + M2 环境·代理·备份 ✅ + M3 任务辅助 ✅ + M4 发布工程 ✅ + 自动更新（§21）✅
**当前状态**: ✅ v0.4.47 本地构建与验收通过：全量单测 370/370（33 个文件）、Agent 域 Electron/CDP 55/55、可见智能体 CDP 54/54、M1 108/108、M2 阶段1 30/30 且阶段2 必需指纹字段 verified、M3 113/113、安全 44/44、M4 13/13、更新 16/16、店铺拖动 10/10、抖店邀约本地 36/36、发票主体本地 26/26、自定义任务 54/54、邀约实时日志 16/16。构建标签为 `INTERNAL_BUILD`（未做代码签名）。

**Agent 扩展（2026-09-24）**: A-M0 已落库；A-M1～A-M4 为 `PARTIAL`，A-M5 为 `PARTIAL`，A-M6 达到 `PACKAGED/PARTIAL`。新增 v5→v7 Agent 迁移、root-ceo/HR/probation、模型 Profile/safeStorage、Job → Task → TaskRun → evidence、租约 owner 防旧 Worker 写回、权限快照变更阻塞、备用 Profile 环校验、结果审核、反馈指标、本地记忆、损坏正文恢复为 conflict 版本、重启后记忆检索、正文和加密快照原子 I/O 故障回滚、CEO 周期复盘摘要和设置页 Agent 团队。`pnpm.cmd test -- --run` 为 33 个文件/369 个测试；Agent Electron/CDP 54/54（含自治运营：非资金写操作免审批、资金 Job 必须确认；子 Agent 未绑定模型继承 default-main、设置页 AI 配置同步与继承、解绑恢复继承、CEO 无可用子 Agent 时拒绝执行、root-ceo 禁止作为执行者、CEO 派单经子 Agent 执行并落 TaskRunner 证据、HTTP 429 只重试一次、能力探测落库、503 后 fallback 路由与 fallbackUsed、401 不降级、日预算阻断、配置单价后的成本估算与未配置价格的“未估算”、进程中断 recovery_required 与安全重新排队、暂停 Agent 拒绝新 Job 并可恢复、FTS 索引重建 hash 保持、损坏正文 quarantine/恢复、同一 userData 重启恢复、备用 Profile 环和停用校验、无 Key 阻塞、safeStorage Key 下本地模型 Job 结果和 evidence、CEO 复盘摘要）；可见智能体真实 Electron/CDP 52/52（多店任务逐店派单；对话记忆：回合带最近对话 + 已审核记忆；思考可见 + 最多 3 轮；非资金自动派发/自动执行、资金与例外清单动作保留确认；模型 429 自动重试、不开店铺也能对话、自己打开店铺并续规划、团队/Job 感知问答、对话创建/激活子 Agent、打开面板、Job 完成自动复盘、计划经 job:delegate 派给 active 子 Agent）；记忆断电/磁盘满时序 4/4；安全套件 44/44；M4 完整安装生命周期 13/13（内含打包对话链路 19/19、安装 3/3、升级 4/4、卸载）；M1 inner CDP 108/108；打包目录 smoke 6/6（设置页 Agent 团队四个子页均可切换并渲染）；真实 Windows SendInput Agent 设置 smoke 7/7；隔离安装器降级/恢复 11/11；NSIS x64 构建通过；lint 0 errors。真实付费模型、真实店铺高风险写操作、完整人工桌面逐项验收、OS 级跨设备恢复未执行，详见 `docs/AGENT_PROGRESS.md` 与 `artifacts/agent/acceptance-manifest.json`。

**Agent 扩展（2026-09-25，未提交）**: 新增 v8 迁移（`agent_skills`/`agent_plugins`）、工具目录 `packages/shared/src/agent-tools.ts`（提示词白名单由目录生成）、技能（AI 用现有工具制作声明式工作流：`createSkill` 自动执行、`runSkill` 逐步执行并回传真实结果、技能只能包含自动执行类工具且禁止嵌套技能管理）、插件（`createPlugin` 打包、`listPlugins`）与技能/插件 JSON 分享包导入导出（`shopilot-agent-pack` v1，设置 → Agent 团队 → 技能与插件，需用户确认、整体校验、同名更新、不含凭据）；技能进入软件上下文与 Agent 抽屉。**真机实测轮**：用真实数据副本（不动原库）按用户路径实测 11 项（对话/工具/技能/插件/记忆/审批/经营数据派单/面板导入导出/v8 迁移/崩溃恢复），发现并修复 5 个真实问题：复合指令被快捷路由劫持、只读指标（退款金额）误触发资金门禁、派单跳过原因被吞、采集 Job 因店铺未打开永久卡 running（TaskRunner 排队泵只启动已打开店铺 → 浏览器 Job 自动开店 + 租约巡检兜底）、采集幂等键跨版本冲突/复用终态 Job 计为已派发（分钟桶幂等键 + 如实标注 + 未实测平台提示）。验证：`pnpm.cmd exec vitest run` 34 个文件/381 个测试；`pnpm.cmd typecheck` 通过；`pnpm.cmd lint` 0 errors（810 warnings）；Agent 域 Electron/CDP 69/69；可见智能体真实 Electron/CDP 61/61；M3 任务引擎 113/113 随本轮改动复跑通过；`pnpm.cmd build` 与 `pnpm.cmd dist:dir` 通过、打包目录 smoke 6/6（Agent 团队五个子页均可切换渲染）。安全 44/44 等不涉及本次改动，未重跑。

**Agent 审查轮（2026-09-25，未提交）**: 对智能体与 Agent 域做功能审查：静态契约比对（45 个软件动作 × 执行分支/标签/目录/提示词白名单一致；页面规划步骤闭合白名单且无写入类步骤）+ 关键链路走查。修复 8 项：①只读范围（`storeScope.readOnly`）从未参与 Job 门禁 → 带 browserTask 的写/提交 Job 拒绝只读 Agent、派单只选非只读执行者（共享选择器 + 单测）、执行助手按需恢复可写并审计、设置面板加「只读范围」开关；②聊天/回合不记模型用量（违反 §7.3）→ 每次调用写 `agent_usage`；③聊天无备用 Profile 降级 → 按白名单降级一次；④Job 轮询超时静默 → 明确提示；⑤采集类 Job 名提取回退到「· 店铺名」；⑥规格要求的 `AGENT_STATUS_CHANGED`/`AGENT_USAGE_UPDATED` 事件从未发出 → 现在发出且抽屉监听刷新；⑦12 个错误码补登记；⑧Workbench 事件监听改用 `EVENT_CHANNELS` 常量。验证：typecheck、单测 34 文件/382、lint 0 errors、Agent 域 CDP 70/70、可见智能体 CDP 61/61、M3 113/113、dist:dir + 打包 smoke 6/6。

**Agent 能力扩展轮（2026-09-25，未提交）**: ①聊天/回合日预算硬阻断（与 Job 同口径，`AGENT_BUDGET_BLOCKED`）；②达人邀约发送接入智能体（`runInvite`，面板与 Main 共用 `@shared/invite-task` 构造器，缺项/未实测如实报错，发送类不进技能）；③逐条订单明细采集（`collectOrders` + `@shared/orders-steps`，实测档案红线 + 设置 `orders.profiles` 即时登记 + 整表逐行落库）；④连带修复：Job 载荷清洗嵌套上限 6→16 层且超限如实报错（旧实现把邀约 loop 载荷第 6 层静默替换成字符串 → `TASK_INVALID_STEP`）、凭据不可解密不再让应用启动失败、显式指定店铺全部无效时如实说明。验证：typecheck、单测 34 文件/391、lint 0 errors（831 warnings）、Agent 域 CDP 78/78、可见智能体 CDP 61/61、M3 113/113、dist:dir + 打包 smoke 6/6。

**Agent 完善轮（2026-09-25，未提交）**: ①数据中心新增「订单明细」区块（`overview:orders`：表头文案匹配映射统一列、多余列进 extras、无表头退回列序；一键采集复用面板/智能体同一步骤构造器；可展开全部行）；②智能体新增只读工具 `getOrderDetails`（读最近一次快照、最多 20 条、买家列不进上下文），意图路由区分「采集/查看」；③技能生命周期 `updateSkill`（改名/描述/启用停用 + `agent:skill:update` + 设置面板按钮，停用后 runSkill 如实拒绝）；④对话自动滚动到最新消息（用户报告）：根因是消息 40 条上限后 push 触发 shift、长度恒定而旧实现只 watch length → 改签名式 watcher + 双帧贴底；⑤上翻阅读不打断：新内容只显示「有新消息 ↓」按钮（点击回到最新并恢复跟随），自己发消息仍跟到底，补滚的下一帧回调只在仍跟随时执行；⑥删除截图功能并把原位置改为「待办事件（消息通知）」：待确认计划/等待确认的 Job/未完成 Job/结果待审核/记忆待审核，Job 条目点击直达 Job 看板、记忆条目打开 Agent 团队面板。验证：typecheck、单测 34 文件/392、lint 0 errors（845 warnings）、Agent 域 CDP 81/81、可见智能体 CDP 66/66、M1 108/108、M3 113/113、dist:dir + 打包 smoke 6/6。

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
- **线上发布历史（2026-09-12）**：GitHub Release v0.1.0 与 beta 演练曾完成并已清理；这些记录不代表 v0.4.47 已发布。v0.4.47 本次只生成本地安装包与清单，线上发布需另行执行并复核资产。
- **真实线上更新演练（2026-09-12，`update-online-drill.js` 12/12 通过）**：发布 `v0.1.1-beta.1` prerelease（exe + blockmap + `beta.yml`）后，用 0.1.0 打包版走**真实公网 GitHub 链路**：① stable 通道检查 → `not-available`（**prerelease 隔离**，GitHub `/releases/latest` 语义，实测确认）；② 切 beta 通道 → 发现 `0.1.1-beta.1`；③ **真实下载 85,660,524B（20s）→ SHA-512 校验通过 → pending 落盘（尺寸与 beta.yml 一致）→ 进度事件 → "重启并安装"按钮出现 → 审计落库**；④ 对下载产物 `/S` 静默安装 → 安装版 `currentVersion=0.1.1-beta.1`（**真实升级成功**）；⑤ 升级后 beta 复查 → `not-available`（版本闭环）；⑥ 静默卸载无残留。演练毕删除该 prerelease（release+tag 均 204）并恢复 0.1.0 现场（产物、版本号、`releases/latest` 均已验证复原）。注：产品内"重启并安装"走 `quitAndInstall(false,true)` 带交互向导，无人值守演练以同一 NSIS 安装包的 `/S` 静默安装等效替代。首轮演练曾暴露 2 处**脚本自身**缺陷（未先打开对话框即断言按钮；NSIS 卸载异步空壳目录），修脚本后复跑全绿——非产品缺陷，如实记录。

## 已知边界（如实声明）

- **验收环境边界**：`screenshot` 步骤要求店铺视图真的处于可见/可渲染状态。若桌面上有另一个 Electron 实例或最大化窗口压在前面，`capturePage` 会如实失败（`CAPTURE_EMPTY`／CDP 报 `Current display surface not available for capture`），m3 会因此在"推进至确认门禁"这条上前置失败。**跑验收前请先关掉其它 Electron 实例**（今天实测：忘记关就会 10/82，关掉即 82/82）。这是环境敏感而非产品缺陷，但会误导排查，故记在此。
  - 2026-09-13 补充：开发机的**普通浏览器窗口**（Chrome/Edge 等，不能替用户关）也会造成同样后果。已给 m1/m3 运行器加两项**测试环境专用**的处置：启动参数 `--disable-features=CalculateNativeWinOcclusion` + `--disable-backgrounding-occluded-windows`，以及运行期间每 2.5s 把被测窗口保持在前台（`SHOPILOT_NO_KEEP_FOREGROUND=1` 可关，会短暂抢焦点）。**产品启动参数与行为均未改动**；实测未加处置时 m3 稳定卡在截图步骤、加上后 90/90。
- **AI 边界**：① 主进程 `fetch` 直连出网、**不走店铺代理**（Chromium 的 session 代理管不到主进程）；② 接口地址须 https://（仅 127.0.0.1/localhost 允许 http://）；③ API Key 只在主进程使用（safeStorage 加密），界面与诊断包都不带出；④ 仅对仍存在自由话术框的平台启用 AI 话术，读不到稳定商品抽屉就如实失败（`AI_EMPTY_OUTPUT`），不拿整页文本充数；抖店当前结构化抽屉没有话术框，因此不展示 AI 话术控件。
- **会话包内容边界**：包内只有 Cookie（明文清单，容器级口令加密）+ 环境指纹配置 + 店铺元信息；**localStorage/IndexedDB 不在包内**（异机导入后部分站点可能要求二次验证）。包头明文暴露来源店铺名/平台/有效期（供导入前确认来源），Cookie 与指纹在密文内。
- **应用锁边界**：主密码用于应用锁与 KDF，**不重加密 Chromium profile**（§10.2/§633）；锁定隐藏视图 + 门禁业务 IPC，属"防顺手查看"级别，已解锁进程内存中的会话仍由操作系统用户隔离保护。
- **代理**：规范红线——不可用时不自动切换、不静默降级，仅检测 + 如实展示（无自动故障转移能力）。
- **发布**：无代码签名证书 → 构建标记 `INTERNAL_BUILD`；自动更新本地 feed 链路 16/16 通过，但 v0.4.47 线上 GitHub Release 尚未发布；更新包仅做 SHA-512 哈希校验、无签名校验。崩溃报告上传通道未实现（默认关闭，符合 §22 默认关闭要求，仅本地落盘）。
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
- 验收：`node tools/acceptance/m1-runner.js`（108 项）；`node tools/acceptance/m2-runner.js [stage1|stage2]`（阶段1 30 项，阶段2 指纹字段）；`node tools/acceptance/m3-runner.js`（113 项）；`node tools/acceptance/sec-runner.js`（安全能力 44 项）；`node tools/acceptance/m4-runner.js [--skip-install]`（发布工程 13 项）；`node tools/release/update-runner.js`（更新链路 16 项，需先 `pnpm dist`）；`powershell -ExecutionPolicy Bypass -File tools/acceptance/run-acceptance.ps1`（一键串行：打包+全部套件+清单）；`node tools/ui/ui-panel.js`（右栏收起专项探针：打印面板/中栏/原生视图三项宽度实测）。各自使用独立临时 userData；跑前退出运行中实例释放 9223–9228、9232 端口；M3/M4/探针自带本地测试站点
- 单元测试：`pnpm test`（vitest）
- 打包：`pnpm dist`（electron-vite build + electron-builder NSIS）→ `node tools/release/release-manifest.js` 生成 `release/release.json`
- 开发模式：`pnpm dev`
- 调试工具：`node tools/ui/dialog-probe.js`（起一次开发态实例并直接查看主进程对话框窗口内 `__pwDone` 安全桥是否注入、导出调用返回值——排查"对话框点了没反应"这类问题的第一现场）
