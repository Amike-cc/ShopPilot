# ShopPilot 电商浏览器

> **Agent 当前形态（2026-10-17）**：Agent 是普通文字聊天助手，不具备店铺、网页、浏览器、工作台任务、Job、文件或系统设置操作能力。聊天模型只接收脱敏后的对话内容，不提供工具调用；旧 Agent 操作 IPC 在 Main 中拒绝。模型统一在「AI 配置」管理，Agent 不提供独立模型/操作设置。工作台原有的手动任务和浏览器功能保持独立可用。

多店铺电商工作台（Windows 桌面应用）：每个店铺一个完全隔离的内嵌浏览器环境，配套环境指纹、代理管理、任务辅助、加密备份、应用锁与发布工程。目标平台为国内四家：拼多多 / 微信小店 / 快手小店 / 抖店（另支持"其他"自定义平台）。

## 项目状态

**版本**: v0.5.0 · **构建标签**: `INTERNAL_BUILD`（未做代码签名，§21.5）
**里程碑**: M0 技术验证 ✅ · M1 工作台核心 ✅ · M2 环境/代理/备份 ✅ · M3 任务辅助 ✅ · M4 发布工程 ✅ · 自动更新（§21）✅
**界面**: 2026-09-29 按设计稿复刻完成（深色左栏 248px + 深色「销售概览」hero 卡 + 浅色内容区：页头面包屑/时钟/通知/头像、六项 KPI 带涨跌、双序列趋势图、快捷操作格（2026-10-19 移除「短视频去重」和「影像级干扰」占位，仅保留已接入项）、右栏平台同步/AI 助手/待办任务；工作台内嵌页面与其余页面同步浅色化）
**验收**: **本轮实测（2026-10-19，工作区 + 打包产物）**：`pnpm.cmd exec vitest run` = **164 个文件 / 1782 用例全绿**（2026-10-19 02:13 基线 162 文件 / 1767 用例 + 本轮新增的 acceptance-gate / ipc-contract 契约测试等；最终复跑），`pnpm.cmd exec tsc --noEmit` 与 `pnpm.cmd typecheck:tests` 均 0 错误、`pnpm.cmd run lint:ci` 0 error（1145 warning 封顶）。本轮完整修复清单、CDP 复验与未完成项见 `docs/FIXES-2026-10-19.md`。历史记录（仅供追溯）：M 阶段历史基线为 Vitest **148 个文件 / 1571 项**；2026-10-18 一轮工作区实测为 **160 个文件 / 1761 项，其中 1760 项通过、1 项被既有邀约导入字符串断言阻塞**（该问题已在本轮修复）。2026-10-18（打包产物，已过独立对抗性复验并把发现的问题全部修掉）本轮涉税/发票相关测试 **3 个文件 / 61 项通过**。标签页批量关闭 + 固定/拖拽重排 + 页面内真实按键转发 + 采集内部标签 CDP **42/42**；渲染层入口（店铺分组 / 主动检测登录状态 / AI 商品分析未配置态 / 占位删除防回退：锚点 + 文本双层）CDP **16/16**；AI 商品分析**成功路径**（本地 OpenAI 兼容桩，零费用）CDP **11/11**，并做了反向验证（桩不启动时 **5/11 必红**）；浏览器扩展 CDP **15/15**；tsc / vue-tsc 0 错误、eslint 0 error、`run-acceptance.ps1` 在 PowerShell 5.1 解析器下 0 错误。最终日志见 `artifacts/final-evidence-20261018-final/`，独立复验报告 `artifacts/verify-round2.md` / `verify-round3.md` / `verify-round4.md`，补齐清单与证据见 `docs/GAP-FIXES-2026-10-18.md`。历史套件结果：M1 108/108（含真实 DOM `<webview>`、重载重注册和跨店隔离）；M2 阶段 1 30/30、阶段 2 指纹字段实测通过；M3 114/114；安全 44/44；设置中心 47/47（6 页签）；商品管理 44/44；发票中心 51/51；M4 13/13（解包、安装、升级、卸载）；自定义任务 54/54；达人邀约实时日志 16/16；Agent 域与打包 smoke 通过（历史结果见 `docs/RELEASE_NOTES.md`，本版清单见 `release/release.json`）。当前源码 Electron 的 CDP 标签页复验为 **35/35**，720px/480px 为响应式视口验收并已通过。原生 Windows UIA 为 **PARTIAL**：目标 PID/HWND 已按 Win32 枚举严格锁定，Dashboard/客服抽屉、Escape/遮罩、标签切换/关闭、Ctrl+W、Ctrl+Alt+W、零标签清理与店铺重开已通过；`Ctrl+Shift+W` 未在原生 SendInput 路径触发关闭全部确认，保留为待验收，不计入通过项。未做代码签名，保留 `INTERNAL_BUILD`。

**窗口与响应式验收边界**：主 BrowserWindow 设计尺寸为 1400×900，原生最小尺寸为 1200×700（`apps/desktop/src/main/index.ts`）；720px / 480px 指 CDP 响应式视口验收，不要求把原生窗口缩到该尺寸。2026-10-18 已修正 UIA helper 的 HWND 发现与 PID/根窗口校验；当前源码运行记录（`artifacts/native-ui-current-20261018-184035/`）经 Win32 `EnumWindows + GetWindowThreadProcessId` 确认为 Electron PID 14508、根 HWND 96406462（`ShopPilot` / `Chrome_WidgetWin_1`），错误 PID 会被拒绝。原生 UIA 已完成非破坏性部分验收，但 `Ctrl+Shift+W` 仍受原生输入路径限制，完整桌面验收状态为 **PARTIAL**，不是 20/20 全通过。

## 文档索引

| 文档 | 内容 |
|---|---|
| [FIXES-2026-10-19.md](./docs/FIXES-2026-10-19.md) | **本轮优化修复记录**：P0/P1/P2 逐项改动、体积/性能实测、CDP 复验与未完成项 |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | **当前架构基准（以此为准）**：进程模型 / DOM `<webview>` / IPC 契约 / SQLite / 目录 / 构建测试发布链 |
| [ADR-001-webview-vs-webcontentsview.md](./docs/ADR-001-webview-vs-webcontentsview.md) | 架构决策记录：为何用 DOM `<webview>` 而非原生 `WebContentsView` |
| [ACCEPTANCE_HOOKS.md](./docs/ACCEPTANCE_HOOKS.md) | 验收测试钩子门禁：生产构建 vs 验收构建、发布前自检 |
| [RELEASE_SIGNING.md](./docs/RELEASE_SIGNING.md) | 代码签名配置就绪说明（凭据只走环境变量） |
| [DEPENDENCY_UPGRADES.md](./docs/DEPENDENCY_UPGRADES.md) | 依赖升级记录与升级注意事项 |
| [DEVELOPMENT_SPEC.md](./docs/DEVELOPMENT_SPEC.md) | 开发设计文档（架构 / 数据模型 / IPC 契约 / 里程碑 / 验收标准；§2.1 为历史选型） |
| [AGENT_DEVELOPMENT_SPEC.md](./docs/AGENT_DEVELOPMENT_SPEC.md) | Agent 历史架构设计与纯聊天模式边界 |
| [AGENT_PROGRESS.md](./docs/AGENT_PROGRESS.md) | Agent 历史实施记录、当前模式与验收状态 |
| [FUNCTIONAL_SPEC.md](./docs/FUNCTIONAL_SPEC.md) | 功能规格（MVP 9 项功能集） |
| [task-rpa-roadmap.md](./docs/task-rpa-roadmap.md) | 任务功能自研 RPA 方案与路线图 |
| [browser-extensions-design-2026-10-17.md](./docs/browser-extensions-design-2026-10-17.md) | 浏览器扩展（本地解包插件）设计、安全边界与验收 |
| [extension-template/](./docs/extension-template/) | 自研插件模板（可直接导入，含说明与常见失败对照） |
| [STATUS_REPORT.md](./docs/STATUS_REPORT.md) | 开发状态与验收明细（含已知边界如实声明） |
| [GAP-FIXES-2026-10-18.md](./docs/GAP-FIXES-2026-10-18.md) | 半截功能补齐记录：固定/重排、店铺分组、AI 商品分析、解除归并的补法、证据与有意不实现清单 |
| [RELEASE_NOTES.md](./docs/RELEASE_NOTES.md) | 版本变更说明与回滚方式 |
| [INSTALL.md](./docs/INSTALL.md) | 受限环境依赖安装说明 |
| [invite-optimization-report.md](./docs/invite-optimization-report.md) | 达人邀约优化报告（0.4.35 基线，历史存档） |
| [invite-p1-testing-checklist.md](./docs/invite-p1-testing-checklist.md) | 达人邀约 P1 真机测试清单（历史存档） |
| [REVIEW.md](./docs/REVIEW.md) | 早期审查报告（历史存档） |

## 核心能力

- **店铺隔离浏览**：一店一 `persist:store_<id>` session（Cookie/localStorage/缓存/下载互不可见）；标签页由**主窗口 DOM 里的真实 `<webview>`** 承载——页面真的嵌在工作台内部，HTML 弹层/抽屉/右键菜单/拾取遮罩靠 CSS 层级盖在页面上，切标签或切店铺只切可见性（页面状态不丢），关闭重开恢复标签，固定/重排/独立窗口。每个 guest 关闭 Node 集成、隔离上下文并剥掉 preload，远程店铺页面拿不到工作台的 preload bridge；guest 未注册完成前页面工具按"未就绪"等待或如实失败。**标签页批量关闭**：Ctrl/Shift 多选（工具条一键关）、标签右键菜单（关闭/关闭其他/关闭全部）、快捷键 Ctrl+W（当前）/ Ctrl+Shift+W（全部）/ Ctrl+Alt+W（其他，页面内也生效——主进程 `before-input-event` 转发）；一键操作默认保留固定标签、必弹二次确认；关到 0 个即浏览器整体收起（既有语义）。
- **环境指纹**：UA/UA-CH 成对改写、时区（CDP）、navigator/screen/WebGL 主世界注入，`profile:verify` 实测回填 verified/unverified；一键复制环境配置到其他店铺。
- **浏览器扩展（本地解包，实验性，默认关闭）**：设置中心「浏览器扩展」页签导入含 `manifest.json` 的**文件夹**（不支持 Chrome 商店与 `.crx`），按店铺 Session 独立加载，扩展的 `chrome.storage` 也按店隔离。权限黑名单（nativeMessaging/debugger/cookies/proxy/downloads/identity 等）与 `world:"MAIN"` 直接拒绝；只允许 http(s) 注入；符号链接、超大目录、路径穿越在复制阶段拦截。自己写插件可直接用 `docs/extension-template/`：导入后点「目录」打开应用内副本编辑，点「重载」生效。
- **代理管理**：创建/批量导入/体检（延迟+状态）/绑定即时生效/周期巡检；407 认证经 safeStorage（DPAPI）注入；红线：不可用时**不自动切换、不静默降级**。
- **任务辅助**：17 种白名单步骤（导航/等待/读文本/读表格/截图/草稿填充/人工确认 + 点击/按文本点击/批量点击/写入/AI 生成 + 镜像标签页/受信任输入/等可见文本/确保行数），状态机+失败恢复+定时调度；人工确认门禁任何面板可见；截图工件 SHA-256 入库。**副作用步骤**（点击/写入/AI 生成）不可从失败恢复重试，且承载"提交"语义的步骤前必须有人工确认门禁。
- **达人邀约（抖店 / 微信小店 / 快手小店，平台流程相互独立）**：
  - **抖店·结构化抽屉流**：任务面板可选主推类目/达人等级/数量/主营/手机号/微信号/核心优势/权益；平台改版后没有可写话术框，运行时按抽屉字段拼装消息，填写必填项后直接执行，无 AI 话术框与二次确认门禁。
  - **快手小店·批量勾选流**：入口在**分销后台**（cps.kwaixiaodian.com），筛选分四行（内容标签 / 带货类目 / 带货数据 / 合作信息），带货类目是级联下拉（18 项 + 实测子类）。平台要求**至少勾 2 位**（只勾 1 位点「批量邀约」没有任何反应），抽屉里要填联系人/手机号/微信号（都必填）并**必选商品**（否则发送会被「请选择商品」拦下）。真实发送已实机跑通（「我的达人 → 邀约中」出现待处理记录）。
    - 点「发送邀请」后平台可能弹**「邀约提示」**（逐条列出佣金率/体验分低于达人要求），按钮是「继续发送邀约」——引擎会按档案 `postSendConfirmTexts` 自动点掉，否则抽屉永远不关、一条都发不出去。
    - 平台还会弹**「部分邀约发送失败」**并**故意留着抽屉**（让商家调整重试）。此时"抽屉没关"区分不出"失败了"与"还在处理"，所以引擎用 `requireTextAbsent` 读这段失败文案如实报 `TASK_SEND_PARTIAL`——并明说**本批其余人可能已发出**，别急着重发（平台规则：近 7 天有未处理/被拒绝邀约单的达人会被拒）。
    - **使用时请让店铺窗口保持在前台**：快手的级联弹层靠 `requestAnimationFrame` 定位，页面被遮挡时 Chromium 会停帧、弹层停在屏幕外；届时引擎如实报 `TASK_TARGET_OUT_OF_VIEWPORT`（而不是含糊的"被遮挡/窗口太窄"）。
  - **微信小店·辅助填单流**：微信按达人逐个邀约（每位达人独立表单，列表拿不到详情页 token，只能从列表点「详情」进）。软件自动跑：广场筛选 → 逐位取"还没点过的"达人 → 详情页点「邀请带货」→ 表单页受信任键鼠输入代填联系方式与合作说明（实测 ≤200 字）→ 按指定商品 ID 精确添加商品 → 点「发送邀约」→ 等平台「确认发送邀约」弹窗 → 点「确认」真实发出 → 校验表单被清空 → **自动截图留档**。整页在 ShadowRoot 里：引擎新增穿透查询（deep）与受信任输入管线。
    - 广场上有些达人**本身不能邀约**：不达合作门槛的详情页写着「暂未到达合作门槛」（没有按钮），7 天内已邀约过的按钮是灰色禁用——这两种都会被**跳过换下一位**，并根据平台给的禁用原因如实记进日志；连续跳过太多则干净收尾（不是报错）。
  - **任务面板有两个页签**：**任务列表**（本店铺任务的统一入口：看状态/运行/暂停/取消/删除/展开看步骤结果与实时日志；右上角「+ 新建任务」）与**达人邀约**（配置与「达人邀约实时日志」）。达人邀约的任务在两个地方都能看到——任务列表看"任务整体状态"，实时日志看"实时状态、卡在哪一步与实时日志"（只跟最近一次运行，不保留历史记录）。
  - **「新建任务」只从已实现的流程里挑**（当前＝达人邀约）：选中后只填「定时」（参数取「达人邀约」页签的当前配置）。两个入口共用同一份配置与**同一个步骤构造器**，所以从哪儿建都一样（已实测逐步骤一致）。不给底层步骤编辑器——自己拼步骤必然拼出跑不通的半成品，且会说不出错在哪。
  - **发票采集 / 经营数据采集**不列进任务列表：它们由各自面板发起、结果就在那个面板里。
  - 平台档案与流程集中在 `packages/shared/src/constants/invite.ts` + `packages/shared/src/invite-steps.ts`；未实现的平台会明确拒绝而不是猜测。
- **设置**（左栏底栏 `⚙ 设置`，收起后窄轨也可进入）：六个独立页签——**平台入口**为国内四家平台逐个指定「首页」与「达人广场」地址（默认值即平台后台地址，可一键恢复默认；只校验 `http(s)` 格式、不联网探测）；**AI 配置**（OpenAI 兼容接口地址 / 模型名 / API Key / 超时，含「测试连接」与「获取可用模型」，Key 经 safeStorage 加密、界面与诊断包都不带出）；**安全**、**浏览器扩展**、**数据与维护**和**关于软件**分别承载应用锁、受控本地解包扩展、备份/诊断/审计与软件更新。扩展默认关闭，只从主进程目录选择框导入并按店铺 Session 隔离加载。
- **发票中心（各平台发票页采集，左侧独立页面）**：抓取各店铺**待开票信息**并汇总展示，支持跨店铺合计、搜索、金额排序与 CSV 导出（UTF-8 BOM + 正确转义）。按**开票方向**分别采集与分组展示（同一发票页上「给平台开票 / 给买家开票 / 申请平台开票」是不同数据，只抓默认页签必漏）；方向可能在**另一个站点**（拼多多给平台开票在资金中心），也可能是**卡片而非表格**（标签 + 值）。采集是全只读步骤、不做任何开票动作；方向分「待办」与「无需操作」（已提交/已通过、商家没有待办动作），只有待办计入待开票合计。锚点全部实测登记在 `packages/shared/src/constants/invoice.ts`，未实测的平台如实说明"抓不了"，绝不猜选择器。
- **涉税信息（左侧独立页面 / 独立功能模块）**：单独查看平台按季度向税务机关报送的经营数据，支持按主体与按店铺两种视图、收入净额核对、平台用途限制原文和逐店失败态；仅做只读采集与展示，不代替税务申报。采集任务仍由任务引擎执行，页面入口与发票中心相互独立。
  - **按店铺营业执照（开票主体）分账与筛选**：发票是按**主体**开的、不是按平台账号开的，同一个执照下常挂好几家店（同公司开了抖店 + 快手 + 微信小店），只看店铺会把一个主体的票拆成几份。筛选条按主体列出「N 家 · M 条 · ¥金额」，**一点即筛**（总览合计同步变成该主体自己的数），另有「未填写营业执照」单独一桶提醒补录；每家店卡片头上也能就地补填主体名称与统一社会信用代码。归组口径：**代码优先**（18 位统一社会信用代码，旧税号 15 位也收；落库前统一去空格、连字符并转大写），只有名称的店若与某个有代码的主体**同名**会并进那个主体（不会出现两个同名胶囊各 1 家），名称相近但不是同一家的绝不合并——错一个公司就是错票。CSV 导出与左侧店铺搜索同样带营业执照。
  - **「获取主体营业执照」：让软件自己去平台后台把本店主体读回来**（筛选条右侧按钮）。采集是**只读**步骤（导航到平台的主体信息页 → 按页面标签文案读），结果落 `entity.name` / `entity.no` 快照，再由主进程写回店铺：**空着就填、与已填不一致不覆盖**（把两边值都摆出来让你核对）、**平台给的掩码值或形态不对的一律不写**；每家店的卡片上也会并排显示"平台读到的主体"，便于与手填值对照。实测状态（2026-09-17 真机）：**快手小店已实测可用**（店铺 → 资质管理 → 主体信息：主体名称 + 完整 18 位统一社会信用代码都读到了真值）；**微信小店读不到**（主体信息是悬浮卡，平时 `display:none`、点击与合成悬停都不展开，当前读取只认可见元素；且该页给的信用代码是掩码）；**抖店/拼多多未实测**（实测时一个未登录、一个登录态已过期）。读不到的平台在界面上逐家写明原因，**不猜选择器**。档案在 `packages/shared/src/constants/entity.ts`，步骤在 `packages/shared/src/entity-steps.ts`。
- **会话与安全**：会话导出/导入加密包（scrypt+AES-256-GCM，带有效期）、Cookie 查看器、**环境面板一键主动检测登录状态**（结论如实区分「已登录 / 未登录 / 登录态已过期 / 需要安全验证 / 未识别 / 检测失败」，结构不认识时明说「未识别」绝不假装已登录；主进程检测到需要重新登录时发 `SESSION_EXPIRED`，界面按店铺提示一次）、应用锁（IPC 门禁+空闲自动锁定）、审计日志全量可导出、备份（Online Backup+校验+失败回滚）、诊断包（脱敏）。
- **自动更新（§21）**：electron-updater → GitHub Releases（`Amike-cc/ShopPilot`）；stable/beta 双通道；下载完成 SHA-512 校验后重启安装；检查/下载/安装均写审计；启动自动检查可选（默认关闭）。
- **发布工程**：electron-builder NSIS（按用户安装/可选目录/卸载保留数据）、单实例互斥、按天日志 14 天保留、`release/release.json` 版本清单（SHA-256）。

## 技术栈

Electron 44.7.2（ABI 149）· Vue 3.5.44 + TypeScript 5.9.3 + Pinia · better-sqlite3 13.0.3（WAL）· electron-vite 6.0.0 · electron-builder 26.15.3 · electron-updater 6.8.9 · Zod · Vitest（单测）+ 自研 CDP 驱动验收脚本（E2E）

实际未采用：**vue-router**（单工作台屏幕，无路由跳转）、**UI 组件库**（手写 CSS + CSS 变量，图标为 PNG 资源）、
**pino**（自研 `main/services/logger`，按天滚动 + 统一脱敏）；**Playwright 仅用于 `design/**` 与 `tools/ui/**` 的截图脚本**，不参与验收与发布门槛。详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 项目结构

```
├── apps/desktop/src
│   ├── main/           # 主进程：db / stores / browser / tasks / services / ipc / products / sales-metrics
│   ├── preload/        # 白名单 API（contextIsolation + sandbox，window.shopilot.* 共 25 个命名空间）
│   └── renderer/       # Vue 工作台（单屏，无路由）；features/ 分 workbench / tasks / products / invite / customer-service / agent / stores
├── packages/shared/    # IPC 契约、枚举、错误码、Zod schema、平台档案（三端经 @shared 别名同源消费）
├── tests/unit/         # 纯逻辑单测（vitest）+ tests/fixtures/
├── docs/               # 架构基准、开发规范、功能规格、路线图、状态与发布说明
├── assets/             # 设计稿与平台图标等静态资源
├── tools/
│   ├── acceptance/     # M0–M4、Agent、安全验收脚本 + 一键验收入口 + 验收构建脚本
│   ├── release/        # 发布清单、上传、更新演练与打包后处理（after-pack.js）
│   ├── ui/             # UI、窗口与几何探针（Playwright 只用在这里的截图脚本）
│   ├── ci/             # 打包态原生模块 smoke 等 CI 检查
│   └── maintenance/    # 图标生成、源码导出等维护工具
├── wx-invite-test/     # 平台真机探针；静态实测留档在 evidence/
├── artifacts/          # 本地截图、临时数据库和维护报告（不入 git）
├── logs/               # 仓库级验收、构建与诊断日志
├── build/              # electron-builder 构建资源
└── release/            # 打包产物 + release.json 清单（不入 git）
```

> `apps/*` 下没有 `package.json`，`packages/shared` 走 `@shared` 别名消费源码——本仓库实际按**单包**方式
> 工作，依赖与脚本都在根 `package.json`（见 `pnpm-workspace.yaml` 顶部说明）。

## 运行与构建

```powershell
pnpm install                                  # 依赖（受限环境见 docs/INSTALL.md）
pnpm dev                                      # 开发模式
pnpm build                                    # 只编译：electron-vite build → apps/desktop/out
pnpm dist                                     # 生产构建 → release/（NSIS + latest.yml），发布用
pnpm run dist:acceptance                      # 验收构建（保留测试钩子），验收套件用
node tools/acceptance/build-acceptance.mjs --dir   # 快速验收构建，只出 release/win-unpacked
node tools/release/release-manifest.js        # 生成 release/release.json 清单
.\node_modules\electron\dist\electron.exe . --no-sandbox   # 直接跑生产构建
start-shoppilot.cmd                           # 同上（快捷方式）
```

**生产构建 vs 验收构建（别用错）**：

- `pnpm dist` = **生产构建**（NSIS + latest.yml），**打包态验收测试钩子关闭**——运行期即使设
  `SHOPILOT_ACCEPTANCE=1` 也不会打开自动确认/替代密码框等钩子，用于发布；未配置代码签名证书时产物为
  `INTERNAL_BUILD`（见 [docs/RELEASE_SIGNING.md](./docs/RELEASE_SIGNING.md)）。
- `pnpm run dist:acceptance` = **验收构建**（钩子保留，运行期仍需显式 `SHOPILOT_ACCEPTANCE=1`），
  供 `tools/acceptance` 全套使用；**只本机验收用，禁止外发**。
- `node tools/acceptance/build-acceptance.mjs --dir` = 只出 `release/win-unpacked` 的快速验收构建，
  CDP 套件够用。

门禁细节见 [docs/ACCEPTANCE_HOOKS.md](./docs/ACCEPTANCE_HOOKS.md)。

数据目录：`%APPDATA%\shopilot\`（shopilot.db / stores / backups / logs）。安装版数据在用户 AppData，卸载不删除。

### 发布新版本（一条命令，EXE 自动上传 GitHub）

1. 改 `package.json` 版本号（如 `0.1.1`；预发布用 `0.1.1-beta.1`，自动走 beta 通道）
2. `pnpm release:full` —— 打包 → 生成 `release.json` 清单 → 创建 GitHub Release 并上传 **安装包 EXE + blockmap + latest.yml/beta.yml**（幂等：同 tag 复用、同名资产先删后传；凭据走本机 Git Credential Manager，不落盘）

发布后老版本用户经「↻ 更新」即可发现并升级（stable 用户只见正式版；beta 通道见预发布版，已实测隔离）。每个版本的 EXE 都作为 **GitHub Release 资产**永久可下载——不提交进 git 历史：GitHub 单文件 100MB 硬上限（瘦身前 win-unpacked 413.8 MB、安装包 135.2 MB；2026-10-19 瘦身后 win-unpacked **321.6 MB**，安装包待 `pnpm dist` 实测），且二进制入库会使仓库历史永久膨胀、克隆变慢，故 `release/` 保持不入 git。体积治理细节见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) §7。

## 验收（可复跑）

```powershell
pnpm exec vitest run        # 单测（导航白名单 / 调度器 / 对账 / 错误分类 / 拾取 / 邀约与发票档案等）
pnpm run test:custom-local  # 自定义任务本地 CDP 验收（合成事件驱动，需 Electron 环境）
pnpm run test:custom-realclick # 自定义任务真机 SendInput 验收（真实桌面输入，需前台窗口）
node tools/release/update-runner.js       # 更新链路 16 项（需先 pnpm dist；本地 feed 驱动真实安装包）
node tools/acceptance/m1-runner.js        # 工作台验收
node tools/acceptance/m2-runner.js stage1 # 代理/备份；stage2 指纹注入
node tools/acceptance/m3-runner.js        # 任务引擎验收
node tools/acceptance/sec-runner.js       # 安全能力验收
node tools/acceptance/settings-cdp-verify.js      # 设置中心 6 页签验收
node tools/acceptance/extensions-cdp-verify.js    # 浏览器扩展（导入/注入/隔离/卸载/自研模板）
node tools/acceptance/tabs-batch-close-cdp-verify.js # 标签页批量关闭 + 固定/拖拽重排 + 采集内部标签（多选/右键/快捷键/跨店隔离）
node tools/acceptance/renderer-entries-cdp-verify.js # 渲染层补齐入口（店铺分组保存/清除、AI 商品分析未配置时的行内报错）
node tools/acceptance/products-redesign-cdp-verify.js # 商品管理验收（需先启动带 CDP 的实例）
node tools/acceptance/m4-runner.js        # 发布工程验收（含 NSIS 安装/升级/卸载）
pwsh -File tools/acceptance/run-acceptance.ps1 # 以上全部串行 + 自定义任务本地验收 + 打包 + 清单
```

各套件使用独立临时 userData 与 CDP 端口（默认值写在各自脚本的 `*_PORT` / `SHOPILOT_*_PORT` 常量里，可用同名环境变量覆盖；本轮用到 9380/9381、9390/9391），跑前请退出运行中的 ShopPilot 实例；CDP 套件默认跑 `release/win-unpacked` 打包产物（`SHOPILOT_ACCEPTANCE_SOURCE=1` 可切源码 Electron）。

## 已知边界（如实声明，详见 docs/STATUS_REPORT.md）

- 未做代码签名：`INTERNAL_BUILD`；自动更新仅 SHA-512 哈希校验、无签名校验（签名配置就绪说明见 [docs/RELEASE_SIGNING.md](./docs/RELEASE_SIGNING.md)）。v0.5.0 的安装包与清单按本次构建重新生成，线上 GitHub Release 由发布脚本幂等更新。
- 会话导出包仅含 Cookie + 环境配置（不含 localStorage/IndexedDB）；跨机登录态需重登或经加密包导入（DPAPI 边界）。
- 代理不可用不自动切换；任务引擎全局串行（并发=1）；跨进程原地恢复不支持。
- 浏览器扩展只支持**本地解包目录**（需含 `manifest.json`），不支持 Chrome 应用商店与 `.crx`；Electron 只实现部分 Chrome 扩展 API，`chrome.action` 弹窗、`webRequest` 阻断等能力不完整；扩展与指纹注入可能互相覆盖，`profile:verify` 会如实报「未验证」。
- 备份跨机恢复的登录态路径需在第二台真机人工复核；设计稿像素级人工核对待做。
- 本版自动验收使用打包版 Electron + CDP/本地仿真，未替代真实平台登录、真实商品/订单副作用和人工逐项 Windows 桌面验收；这些边界仍保持 `INTERNAL_BUILD`。
