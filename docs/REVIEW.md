# ShopPilot 开发文档审查报告

> 审查对象：DEVELOPMENT_SPEC.md v0.1（行号引用均指向 v0.1 版本）与 FUNCTIONAL_SPEC.md，交叉核对，并参照 ../assets/design/shopilot-ui-concept-v1.png 的文档内引用关系。
> 审查日期：v0.2 修订时归档。
> 处理结果：A、B 类全部修复，C 类补充了机制说明，D 类随手修了 D1–D4；详见 DEVELOPMENT_SPEC.md §32 修订记录。

## 总体评价

文档质量较高：隔离模型（一店一 partition）、人工确认门禁、威胁模型、需求追踪、备份演练等章节在同类规格中属于少见的严谨。存在问题集中在三类：会直接导致开发分歧的硬矛盾、功能规格有而开发文档没有的接口/模型缺口、以及未写清实现机制的技术可行性风险。

## 🔴 A. 必须修复的矛盾（已全部处理）

### A1. 任务状态机与集成测试互斥 — ✅ v0.2 已修复

- v0.1 §9.2 中 `running -> failed` 后无任何出边，failed 为终态；但 §11.2 集成测试要求"任务失败后从失败步骤恢复"，FUNCTIONAL §3.7 也承诺该能力。
- **修复**：§9.2 补 `failed -> queued`、`failed -> running`（需用户显式触发确认、跳过已完成步骤），并补 `queued -> cancelled`、`paused -> cancelled`；注明副作用步骤不进入自动重试范围。

### A2. 里程碑命名冲突 — ✅ v0.2 已修复

- FUNCTIONAL §6 用 "M1/M2/M3" 指代后续方向，与 DEV §12 的 M0–M4 含义完全不同；"MVP" 一词在两文档中也有三种口径。
- **修复**：DEV §12 声明 M0–M4 为全仓库唯一编号序列，新增 §12.1 "MVP 功能 → 里程碑映射表"（逐项覆盖 FUNCTIONAL §5 的 9 条）；M1 交付语改为"工作台核心版本（第一版功能集的 M1 子集，非发布版）"；FUNCTIONAL §6 去 M 化并指向 DEV §12，§5 增加映射说明。

### A3. 跨机备份恢复没有实现路径 — ✅ v0.2 已修复

- FUNCTIONAL §7 验收要求"备份文件可在另一台 Windows 电脑上通过密码恢复"，但 DEV 的密钥体系是 safeStorage/DPAPI（绑定本机本用户），异机无法解密；备份包本身的加密方式全文未定义；FUNCTIONAL "主密码加密会话数据"的表述与 Chromium 实际落盘保护机制不符。
- **修复**：DEV §10.2 明确——备份包与导出包同等加密（主进程托管密码 + KDF + AES-256-GCM + 有效期）；写明跨机恢复边界（元数据/配置/标签索引可恢复，DPAPI 会话需重登或经导出包迁移，禁止承诺"备份直接带走登录态"）；写明主密码职责边界。§13 增加跨机恢复验收项，§28 增加季度跨机演练，FUNCTIONAL §3.5/§7 同步措辞。
- 连带修复：导出有效期从"可设置"统一为"必须设置、过期拒绝"（§6.3/§10.2/§14/§23 原三处口径不一致，"一次性密码"表述已移除）。

## 🟠 B. 数据模型 / IPC 覆盖缺口（已全部补齐）

### B1. 代理管理缺 CRUD 和检查历史 — ✅

§6.3 补 proxy:create/update/delete/importBatch；新增 §5.3.1 proxy_checks 表（支撑"最近 20 次检查"与 proxy:history）；proxies 表补 tags_json。

### B2. 收藏/书签未建模 — ✅

新增 §5.8 bookmarks 表（store_id 可空 = 全局；source=manual|entry_route，与 §16 适配器 getEntryRoutes 对齐）；§6.2 补 bookmark:list/create/delete。

### B3. 下载记录未建模 — ✅

新增 §5.9 downloads 表（含 state 枚举、店铺前缀命名规则）；§6.2 补 download:list/showInFolder；§7 补 browser:downloadProgress 事件；"清理下载记录"的操作对象落到本表。

### B4. 任务结果与概览指标没有落点 — ✅

新增 §5.10 task_step_results（payload 入库、截图存受控工件目录 + SHA-256）与 §5.11 store_snapshots（指标 + captured_at，界面必须显示新鲜度）；§6.6 补 overview:stats、task:results；§4.4 补写入说明。

### B5. 调度器缺设计 — ✅

§4.4 新增 Scheduler 设计（main/tasks 内，触发进 queued，与手动共享确认门禁，不静默拉起店铺浏览器）；§2.2 架构图、§12 M3、§25 矩阵同步。

### B6. 环境配置接口与字段错位 — ✅

- §5.2 browser_profiles 与 §4.3 白名单对齐：补 name、user_agent、ua_client_hints_json、color_depth、hardware_concurrency、webgl_vendor/renderer、config_digest、profile_schema_version（§20 承诺的列进了表）、locked。
- §6.6 新增 profile:get/update/verify/lock/copyConfig：verify 对应"启动校验、未验证如实显示"；lock 对应 FUNCTIONAL"锁定环境"；copyConfig 对应右键"复制配置"（只复制配置结构，不含会话与凭据）。

### B7. stores 缺列、标签缺接口 — ✅

§5.1 补 sort_order、group_name、external_code、owner、region；§6.1 补 store:reorder、store:setGroup，注明 avatar_color 由主进程生成；§6.2 补 browser:tab:setPinned。

### B8. 杂项接口与矩阵覆盖 — ✅

§6.7 补 settings:get/set、audit:query/export、diagnostics:export；§6.2 补 browser:openWindow（兑现 §14"独立窗口"入口）；§25 矩阵从 7 行扩到 17 行，含里程碑列，覆盖 MVP 全部条目，并规定"行只增不改义"。

## 🟡 C. 技术可行性风险（已补机制说明）

### C1. 环境字段实现手段 — ✅ 已写入 §4.3

新增"字段实现机制约定"表：UA 必须与 UA-CH Client Hints 成对覆盖；时区/WebGL 走 CDP（仅限本应用 WebContents）；颜色深度/硬件并发数走主世界脚本注入（不暴露 Electron 句柄，与 §10.1 边界自洽）；落不到机制的字段退回"未验证"。§27 补充代理凭据注入边界。M0 清单加入对应验证项（§12）。

### C2. 代理认证注入 — ✅ 已写入 §4.3/§5.3/§27

明确 Chromium proxyRules 不接受内嵌凭据，407 经 `login` 事件从 safeStorage 取凭据注入；HTTPS 型代理协议需 M0 验证后才开放。

### C3. 小项 — ✅ 已处理

- better-sqlite3 原生模块 ABI 重建：进 M0 清单与 §21 CI 第 1 条。
- SQLite `foreign_keys=ON`、WAL、外键索引：进 §5 前言。
- 店铺创建代理测试失败路径（显式选择直连，不默认降级）：进 §8.1。
- 导出/导入密码改为主进程托管对话框采集，不经过 Renderer/IPC：进 §6.3。
- Mermaid 节点标签 `\n` 改 `<br/>`：§2.2。
- E2E 本地站点用 http://127.0.0.1 动态端口（与拒绝 file:// 的策略一致）：§29。
- audit_logs 保留期：随 §22 日志策略，在 M2 实现时补充为设置项（settings key: auditRetentionDays，默认永久保留——审计日志不套用 14 天日志保留期）。

## 🔵 D. 结构与表述建议（D1–D4 已修，D5–D6 已修）

- **D1 ✅**：`renderer/stores/`（Pinia）更名 `renderer/state/`，`features/stores/` 加注释防混淆。
- **D2 ✅**：补 `features/overview/` 目录与 §17.1 `StoreOverview` 组件。
- **D3 ✅**：§2.2 图中 "Security & Key Manager" 统一为 SecurityManager。
- **D4 ✅**：§5.1 注明 status 枚举以 shared/enums 为唯一来源；§9.1 补 `launching -> needs_login`。
- **D5 ✅**：§19 注明 1000 店铺搜索的实现手段（虚拟滚动 + 索引/FTS5）与硬件基准。
- **D6 ✅**：§24 增加各项决策的最迟确定时点，逾期按"不做"处理。

## 保留的亮点（不建议改动）

- §4.3 不伪造健康度、未验证字段如实标注、禁止随机漂移环境。
- §4.4/§8.5 步骤白名单 + 提交动作绝不无人值守，与 §30 使用边界闭环。
- §28 恢复演练、§26 契约版本、§13 "无验收记录即 INTERNAL_BUILD"。

## 遗留事项（建议下一次评审确认）

1. 功能规格与设计图的数值一致性（侧栏 304px/328px、10px 圆角、配色）本次未能读图核对，需人工过一遍。
2. §29 fixtures 的"登录态"如何在不使用真实会话的前提下构造（建议 fixtures 站点自带假登录接口，而非导出的 Cookie 包）。
3. 主世界注入与电商页面 CSP 的兼容性（部分平台页面 CSP 可能拒绝注入），应加入 M0 验证矩阵。
4. 团队共享电脑决策（§24）若答案为"是"，数据目录和审计 actor 模型需要单独修订一轮。
