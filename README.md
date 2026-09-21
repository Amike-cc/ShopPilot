# ShopPilot 电商浏览器

多店铺电商工作台（Windows 桌面应用）：每个店铺一个完全隔离的内嵌浏览器环境，配套环境指纹、代理管理、任务辅助、加密备份、应用锁与发布工程。目标平台为国内四家：拼多多 / 微信小店 / 快手小店 / 抖店（另支持"其他"自定义平台）。

## 项目状态

**版本**: v0.4.42 · **构建标签**: `INTERNAL_BUILD`（未做代码签名，§21.5）
**里程碑**: M0 技术验证 ✅ · M1 工作台核心 ✅ · M2 环境/代理/备份 ✅ · M3 任务辅助 ✅ · M4 发布工程 ✅ · 自动更新（§21）✅
**验收**: 单测 319/319（含导航 URL 协议白名单、调度器节拍锚定、启动对账分工、TASK_BAD_STATE 友好化、拾取原因码全覆盖）；自定义任务本地 CDP 验收与 SendInput 真机验收随包（`pnpm run test:custom-local` / `test:custom-realclick`，需真机 Electron 环境）。历史构建结果见 `docs/RELEASE_NOTES.md`；M1/M2/安全/更新链路的最近结果见 `release/release.json`。M2 29+8 是 0.1.0 构建上的结果，其后未复跑（改动未触及代理/指纹那条路径）。

## 文档索引

| 文档 | 内容 |
|---|---|
| [DEVELOPMENT_SPEC.md](./docs/DEVELOPMENT_SPEC.md) | 开发设计文档（架构 / 数据模型 / IPC 契约 / 里程碑 / 验收标准） |
| [FUNCTIONAL_SPEC.md](./docs/FUNCTIONAL_SPEC.md) | 功能规格（MVP 9 项功能集） |
| [STATUS_REPORT.md](./docs/STATUS_REPORT.md) | 开发状态与验收明细（含已知边界如实声明） |
| [RELEASE_NOTES.md](./docs/RELEASE_NOTES.md) | 版本变更说明与回滚方式 |
| [INSTALL.md](./docs/INSTALL.md) | 受限环境依赖安装说明 |
| [REVIEW.md](./docs/REVIEW.md) | 早期审查报告（历史存档） |

## 核心能力

- **店铺隔离浏览**：一店一 `persist:store_<id>` session（Cookie/localStorage/缓存/下载互不可见），多标签 WebContentsView，关闭重开恢复标签，固定/重排/独立窗口。
- **环境指纹**：UA/UA-CH 成对改写、时区（CDP）、navigator/screen/WebGL 主世界注入，`profile:verify` 实测回填 verified/unverified；一键复制环境配置到其他店铺。
- **代理管理**：创建/批量导入/体检（延迟+状态）/绑定即时生效/周期巡检；407 认证经 safeStorage（DPAPI）注入；红线：不可用时**不自动切换、不静默降级**。
- **任务辅助**：17 种白名单步骤（导航/等待/读文本/读表格/截图/草稿填充/人工确认 + 点击/按文本点击/批量点击/写入/AI 生成 + 镜像标签页/受信任输入/等可见文本/确保行数），状态机+失败恢复+定时调度；人工确认门禁任何面板可见；截图工件 SHA-256 入库。**副作用步骤**（点击/写入/AI 生成）不可从失败恢复重试，且承载"提交"语义的步骤前必须有人工确认门禁。
- **达人邀约（抖店 / 微信小店 / 快手小店，平台流程相互独立）**：
  - **抖店·批量勾选流**：任务面板可选主推类目/达人等级/数量/权益，话术**手填或 AI 生成**（AI 读抽屉里的推荐商品现场生成，生成原文落库留档），一键生成受策展任务（进达人广场 → 选类目等级 → 搜索 → 勾选未邀约过的达人 → 开抽屉填话术 → **停下等确认** → 才点确认发送）。
  - **快手小店·批量勾选流**：入口在**分销后台**（cps.kwaixiaodian.com），筛选分四行（内容标签 / 带货类目 / 带货数据 / 合作信息），带货类目是级联下拉（18 项 + 实测子类）。平台要求**至少勾 2 位**（只勾 1 位点「批量邀约」没有任何反应），抽屉里要填联系人/手机号/微信号（都必填）并**必选商品**（否则发送会被「请选择商品」拦下）。真实发送已实机跑通（「我的达人 → 邀约中」出现待处理记录）。
    - 点「发送邀请」后平台可能弹**「邀约提示」**（逐条列出佣金率/体验分低于达人要求），按钮是「继续发送邀约」——引擎会按档案 `postSendConfirmTexts` 自动点掉，否则抽屉永远不关、一条都发不出去。
    - 平台还会弹**「部分邀约发送失败」**并**故意留着抽屉**（让商家调整重试）。此时"抽屉没关"区分不出"失败了"与"还在处理"，所以引擎用 `requireTextAbsent` 读这段失败文案如实报 `TASK_SEND_PARTIAL`——并明说**本批其余人可能已发出**，别急着重发（平台规则：近 7 天有未处理/被拒绝邀约单的达人会被拒）。
    - **使用时请让店铺窗口保持在前台**：快手的级联弹层靠 `requestAnimationFrame` 定位，页面被遮挡时 Chromium 会停帧、弹层停在屏幕外；届时引擎如实报 `TASK_TARGET_OUT_OF_VIEWPORT`（而不是含糊的"被遮挡/窗口太窄"）。
  - **微信小店·辅助填单流**：微信按达人逐个邀约（每位达人独立表单，列表拿不到详情页 token，只能从列表点「详情」进）。软件自动跑：广场筛选 → 逐位取"还没点过的"达人 → 详情页点「邀请带货」→ 表单页受信任键鼠输入代填联系方式与合作说明（实测 ≤200 字）→ 按指定商品 ID 精确添加商品 → 点「发送邀约」→ 等平台「确认发送邀约」弹窗 → 点「确认」真实发出 → 校验表单被清空 → **自动截图留档**。整页在 ShadowRoot 里：引擎新增穿透查询（deep）与受信任输入管线。
    - 广场上有些达人**本身不能邀约**：不达合作门槛的详情页写着「暂未到达合作门槛」（没有按钮），7 天内已邀约过的按钮是灰色禁用——这两种都会被**跳过换下一位**，并根据平台给的禁用原因如实记进日志；连续跳过太多则干净收尾（不是报错）。
  - **任务面板有两个页签**：**任务列表**（本店铺任务的统一入口：看状态/运行/暂停/取消/删除/展开看步骤结果与实时日志；右上角「+ 新建任务」）与**达人邀约**（配置与「邀约记录」）。达人邀约的任务在两个地方都能看到——任务列表看"任务整体状态"，邀约记录看"邀约业务明细"（发给谁/额度/留档截图）。
  - **「新建任务」只从已实现的流程里挑**（当前＝达人邀约）：选中后只填「定时」（参数取「达人邀约」页签的当前配置）。两个入口共用同一份配置与**同一个步骤构造器**，所以从哪儿建都一样（已实测逐步骤一致）。不给底层步骤编辑器——自己拼步骤必然拼出跑不通的半成品，且会说不出错在哪。
  - **发票采集 / 经营数据采集**不列进任务列表：它们由各自面板发起、结果就在那个面板里。
  - 平台档案与流程集中在 `packages/shared/src/constants/invite.ts` + `packages/shared/src/invite-steps.ts`；未实现的平台会明确拒绝而不是猜测。
- **设置**（左栏底栏 `⚙ 设置`，收起后窄轨也可进入）：四个独立页签——**配置**为国内四家平台逐个指定「首页」地址（默认值即平台后台地址，可一键恢复默认；只校验 `http(s)` 格式、不联网探测）；**达人广场**按平台覆盖达人邀约入口地址（改地址后任务的就绪判据同步派生）；**AI 配置**（OpenAI 兼容接口地址 / 模型名 / API Key / 超时，含「测试连接」与「获取可用模型」，Key 经 safeStorage 加密、界面与诊断包都不带出）；**关于软件**显示名称/版本/构建标签，并承载**软件更新**（stable/beta 通道、启动自动检查、检查/下载/重启安装）。
- **发票中心（各平台发票页采集）**：抓取各店铺**待开票信息**并汇总展示，支持跨店铺合计、搜索、金额排序与 CSV 导出（UTF-8 BOM + 正确转义）。按**开票方向**分别采集与分组展示（同一发票页上「给平台开票 / 给买家开票 / 申请平台开票」是不同数据，只抓默认页签必漏）；方向可能在**另一个站点**（拼多多给平台开票在资金中心），也可能是**卡片而非表格**（标签 + 值）。采集是全只读步骤、不做任何开票动作；方向分「待办」与「无需操作」（已提交/已通过、商家没有待办动作），只有待办计入待开票合计。锚点全部实测登记在 `packages/shared/src/constants/invoice.ts`，未实测的平台如实说明"抓不了"，绝不猜选择器。
  - **按店铺营业执照（开票主体）分账与筛选**：发票是按**主体**开的、不是按平台账号开的，同一个执照下常挂好几家店（同公司开了抖店 + 快手 + 微信小店），只看店铺会把一个主体的票拆成几份。筛选条按主体列出「N 家 · M 条 · ¥金额」，**一点即筛**（总览合计同步变成该主体自己的数），另有「未填写营业执照」单独一桶提醒补录；每家店卡片头上也能就地补填主体名称与统一社会信用代码。归组口径：**代码优先**（18 位统一社会信用代码，旧税号 15 位也收；落库前统一去空格、连字符并转大写），只有名称的店若与某个有代码的主体**同名**会并进那个主体（不会出现两个同名胶囊各 1 家），名称相近但不是同一家的绝不合并——错一个公司就是错票。CSV 导出与左侧店铺搜索同样带营业执照。
  - **「获取主体营业执照」：让软件自己去平台后台把本店主体读回来**（筛选条右侧按钮）。采集是**只读**步骤（导航到平台的主体信息页 → 按页面标签文案读），结果落 `entity.name` / `entity.no` 快照，再由主进程写回店铺：**空着就填、与已填不一致不覆盖**（把两边值都摆出来让你核对）、**平台给的掩码值或形态不对的一律不写**；每家店的卡片上也会并排显示"平台读到的主体"，便于与手填值对照。实测状态（2026-09-17 真机）：**快手小店已实测可用**（店铺 → 资质管理 → 主体信息：主体名称 + 完整 18 位统一社会信用代码都读到了真值）；**微信小店读不到**（主体信息是悬浮卡，平时 `display:none`、点击与合成悬停都不展开，当前读取只认可见元素；且该页给的信用代码是掩码）；**抖店/拼多多未实测**（实测时一个未登录、一个登录态已过期）。读不到的平台在界面上逐家写明原因，**不猜选择器**。档案在 `packages/shared/src/constants/entity.ts`，步骤在 `packages/shared/src/entity-steps.ts`。
- **会话与安全**：会话导出/导入加密包（scrypt+AES-256-GCM，带有效期）、Cookie 查看器、应用锁（IPC 门禁+空闲自动锁定）、审计日志全量可导出、备份（Online Backup+校验+失败回滚）、诊断包（脱敏）。
- **自动更新（§21）**：electron-updater → GitHub Releases（`Amike-cc/ShopPilot`）；stable/beta 双通道；下载完成 SHA-512 校验后重启安装；检查/下载/安装均写审计；启动自动检查可选（默认关闭）。
- **发布工程**：electron-builder NSIS（按用户安装/可选目录/卸载保留数据）、单实例互斥、按天日志 14 天保留、`release/release.json` 版本清单（SHA-256）。

## 技术栈

Electron 30.5.1（ABI 123）· Vue 3.4 + TypeScript 5.3 + Pinia · better-sqlite3 11.10（WAL）· electron-vite 2.0 · electron-builder 24.13 · electron-updater 6.8.9 · Vitest（单测）+ CDP 驱动验收脚本（E2E）

## 项目结构

```
├── apps/desktop/src
│   ├── main/           # 主进程：db / stores / browser / tasks / services / ipc
│   ├── preload/        # 白名单 API（contextIsolation + sandbox）
│   └── renderer/       # Vue 工作台（深色三栏 UI，§17）
├── packages/shared/    # IPC 契约、枚举、错误码、平台目录（主/渲染同源）
├── tests/unit/         # 纯逻辑单测（vitest）
├── docs/               # 开发规范、功能规格、安装、审查、状态与发布说明
├── assets/             # 设计稿与平台图标等静态资源
├── tools/
│   ├── acceptance/     # M0–M4、安全验收与一键验收入口
│   ├── release/        # 发布清单、上传与更新演练
│   ├── ui/             # UI、窗口与几何探针
│   └── maintenance/    # 图标生成、源码导出等维护工具
├── wx-invite-test/     # 平台真机探针；静态实测留档在 evidence/
├── artifacts/          # 本地截图、临时数据库和维护报告（不入 git）
├── logs/               # 仓库级验收、构建与诊断日志
├── build/              # electron-builder 构建资源
└── release/            # 打包产物 + release.json 清单（不入 git）
```

## 运行与构建

```powershell
pnpm install                                  # 依赖（受限环境见 docs/INSTALL.md）
pnpm dev                                      # 开发模式
pnpm dist                                     # 打包 → release/（NSIS + latest.yml）
node tools/release/release-manifest.js        # 生成 release/release.json 清单
.\node_modules\electron\dist\electron.exe . --no-sandbox   # 直接跑生产构建
start-shoppilot.cmd                           # 同上（快捷方式）
```

数据目录：`%APPDATA%\shopilot\`（shopilot.db / stores / backups / logs）。安装版数据在用户 AppData，卸载不删除。

### 发布新版本（一条命令，EXE 自动上传 GitHub）

1. 改 `package.json` 版本号（如 `0.1.1`；预发布用 `0.1.1-beta.1`，自动走 beta 通道）
2. `pnpm release:full` —— 打包 → 生成 `release.json` 清单 → 创建 GitHub Release 并上传 **安装包 EXE + blockmap + latest.yml/beta.yml**（幂等：同 tag 复用、同名资产先删后传；凭据走本机 Git Credential Manager，不落盘）

发布后老版本用户经「↻ 更新」即可发现并升级（stable 用户只见正式版；beta 通道见预发布版，已实测隔离）。每个版本的 EXE 都作为 **GitHub Release 资产**永久可下载——不提交进 git 历史：GitHub 单文件 100MB 硬上限（当前安装包已 81.7MB，随依赖增长必然突破），且二进制入库会使仓库历史永久膨胀、克隆变慢，故 `release/` 保持不入 git。

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
node tools/acceptance/m4-runner.js        # 发布工程验收（含 NSIS 安装/升级/卸载）
pwsh -File tools/acceptance/run-acceptance.ps1 # 以上全部串行 + 自定义任务本地验收 + 打包 + 清单
```

各套件使用独立临时 userData 与 CDP 端口（9223–9228、9232、9241、9245），跑前请退出运行中的 ShopPilot 实例。

## 已知边界（如实声明，详见 docs/STATUS_REPORT.md）

- 未做代码签名：`INTERNAL_BUILD`；自动更新仅 SHA-512 哈希校验、无签名校验。Release v0.1.4 已发布于 GitHub Releases（仓库 public，打包态在线检查链路已实测）。
- 会话导出包仅含 Cookie + 环境配置（不含 localStorage/IndexedDB）；跨机登录态需重登或经加密包导入（DPAPI 边界）。
- 代理不可用不自动切换；任务引擎全局串行（并发=1）；跨进程原地恢复不支持。
- 备份跨机恢复的登录态路径需在第二台真机人工复核；设计稿像素级人工核对待做。
