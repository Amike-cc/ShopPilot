# ShopPilot 全面代码审查报告（2026-10-21）

> 审查人：架构师（高见远）· software-company 专家团
> 基线：工作区未提交状态（85 个变更文件，达人邀约 v2 第四轮 + 商品管理 v4）
> 性质：只读审查，覆盖代码结构 / 功能实现 / 性能 / 安全 / 可维护性五维度

## 审查结论摘要

整体健康度：**优秀**。项目经历过至少三轮系统性审查（docs/CODE_REVIEW_2026-10-15、CONTINUATION_REVIEW_2026-10-17、2026-10-21 局部审查），此前审计发现的问题基本已闭环修复且质量高。本轮横向扫描**未发现 P0（安全漏洞/数据丢失）问题**。

关键安全事实（已核实）：
- 全仓无裸 `shell.openExternal` / `child_process` / `eval`
- 所有 webPreferences 均为 contextIsolation:true + nodeIntegration:false + sandbox:true；`will-attach-webview` 做了 preload 删除 + partition 校验 + 不可伪造 attach-token 配对
- 19 个 IPC 家族全部经 `familyHandle`/`assertTrustedRenderer` 可信渲染层校验（有 ipc-trust-guard 测试钉死）
- better-sqlite3 全参数化，动态片段（ORDER BY / UPDATE SET）均走白名单映射
- 迁移逐版本事务化、版本只增、v35/v36 幂等
- CSV 导出有 escapeCsvCell + neutralizeCsvFormula 公式注入防护
- 路径边界（product-media-protocol 三层校验、safe-image-save、export-path-guard）有测试覆盖
- setInterval 共 11 处全部有成对 clear/stop；before-quit 统一收尾已在位

主要剩余风险：
1. 发正式版前的更新链路签名缺失（已知 INTERNAL_BUILD 边界）
2. 新增功能正在重新积累巨型文件（ProductManagementPage.vue 1734 行、window-browser-core.ts 1528 行）
3. lint 警告积压（约 1094 条 no-explicit-any，--max-warnings 封顶门禁）
4. 若干注释/实现漂移与低概率边界路径

## 问题清单

### P2-1: 更新链路无代码签名，正式发布前存在供应链投毒面
- 位置：electron-builder.yml:92（forceCodeSigning: false）、services/update-manager.ts（文件头已如实记录）
- 影响：正式版用户可能被推送恶意更新（feed 与安装包同源分发，SHA-512 防不了同源投毒）
- 处置：**发正式版硬前置**——购买代码签名证书，electron-builder.yml 补 win.certificateSubjectName/publisherName，发布流程切回 forceCodeSigning: true
- 状态：📋 留档（非代码可解）

### P2-2: 渲染层巨型页面问题在新功能上重现
- 位置：features/products/ProductManagementPage.vue（1734 行）、browser/window-browser-core.ts（1528 行）
- 处置建议：按 ADR-001/composable 惯例拆「列表+筛选」「批量操作」「导入导出」三个子模块，目标 ≤1200 行
- 状态：📋 留档（迭代级重构，需专轮验收，不适合夹带在优化轮）

### P3-1: lint 警告积压（约 1094 条 no-explicit-any）
- 位置：package.json lint:ci 门禁；重灾区 services/agent-runtime.ts（130）、unit/invite.test.ts（74）
- 处置建议：按目录分批清零（优先 ipc/ 与 preload/），每清一批同步下调 --max-warnings；IPC 家族迁移到 IpcContract/Zod strict 模式（salesMetrics/invite 域已是范本）
- 状态：✅ 本轮部分修复（新改动引入的 +17 需清零使门禁回绿；存量另有分批计划）

### P3-2: 迁移版本读取失败按 0 处理，可能诱导不必要的备份恢复
- 位置：db/migrations.ts:1940-1950（getCurrentVersion catch 分支）
- 影响：瞬时读失败（杀软/同步盘锁库）被当"新库"→ v1 重放必失败 → 启动失败 → 可能误导用户用旧备份覆盖较新数据
- 修复：区分"表不存在"（返回 0）与"其他读失败"（上抛走 startup-error）
- 状态：✅ 本轮修复

### P3-3: AI 商品分析图片上限注释与实现漂移（2 vs 3）
- 位置：ipc/ai-handlers.ts:365-366、services/ai-client.ts:403
- 修复：上限收敛到 @shared/constants 单一常量
- 状态：✅ 本轮修复

### P3-4: 指纹注入目标生命周期缺单测
- 位置：browser/fingerprint-injector.ts（803 行）；background-page.ts 成为第三注册方后风险上升
- 修复：补"重复注册幂等 / destroyed 后注销 / 多注册方共存"三场景单测
- 状态：✅ 本轮修复

### P3-5: 副作用埋在 IPC 注册函数里（引擎/调度器启动点）
- 位置：ipc/task-handlers.ts:156-158（registerTaskHandlers 内含 Runner.startEngine / Scheduler.startScheduler / startInviteScheduler）
- 处置建议：services 层建统一 lifecycle（startAllSchedulers/stopAllSchedulers），registerXxx 只做 handle 注册
- 状态：📋 留档（当前退出路径已在 before-quit 统一收，无行为问题；结构调整收益/风险比不足，建议随下次迭代消化）

## 红线条目复核（全部在位）
- 解析不出=null 不当 0（overview/sales-metrics 如实口径在位）
- 采集前缀不计概览 / 通知上限 8 失败 3（既有实现未动）
- chat-only 拒旧 agent IPC（agent-domain-chat-only 测试在位）
- 迁移版本只增（确认）
- pnpm 10.34.7 / better-sqlite3 v13 N-API 未触碰

## 本轮优化基线快照（2026-10-21 修复前）
- typecheck ✅ 0 错误
- test ✅ 174 文件 / 1928 用例全绿
- build ✅ 8.98s
- diff --check ✅ 干净
- lint:ci ❌ 1162 警告 > 门禁 1145（新改动 +17）

## 本轮优化执行记录（2026-10-21 第四轮，专家团 SOP）

### 已修复 4 项（工程师实施 + QA 独立验证通过）
1. **lint 门禁回绿**：invite 渲染层 23 处 no-explicit-any → 具体类型（TaskView / InviteRunLogEntry / InviteEntryRoute）；警告 1162 → 1133 ≤ 1145。改动：features/invite/composables/*、CreatorInvitePage.vue、invite-page-context.ts
2. **迁移版本读取失败误判新库**：db/migrations.ts getCurrentVersion 区分 "no such table"（返回 0）与其他错误（原样上抛）；上抛链路经 QA 逐层核实（migrate → initDatabase → initialize 第一步 → handleStartupFailure，中间无吞 catch、无半初始化状态）。+2 单测（含变异验证：改回旧行为测试立刻红）
3. **AI 图片上限收敛**：packages/shared/src/constants/ai.ts 新增 AI_PRODUCT_ANALYSIS_IMAGE_LIMIT=3，ai-handlers.ts / ai-client.ts 引用同一份（行为不变仍 3 张），注释漂移修复
4. **指纹注入生命周期单测**：新建 tests/unit/fingerprint-injector-lifecycle.test.ts（4 用例：重复注册幂等 / destroyed 注销不抛+不 detach / 存活目标注销序列 / 多注册方含后台页共存）；产品代码零改动；断言走产品注册表状态机非 mock 自身

### 最终验证（QA 独立复核）
- typecheck ✅ 0 错误 ｜ test ✅ 176 文件 / 1941 用例全绿 ｜ lint ✅ 0 errors / 1133 ≤ 1145 ｜ build ✅ 19.4s ｜ diff --check ✅
- 智能路由判定：NoOne（源码、测试均无 Bug）

### 遗留风险记档（不阻塞）
1. 启动失败弹窗默认项仍是"用备份恢复并重启"（既有设计）：瞬时 SQLITE_BUSY 上抛后用户可能拿旧备份覆盖较新库（busy_timeout=5000 已降低概率；弹窗已声明当前库不删）。建议后续迭代做错误码分流提示
2. 渲染层 image-text-analysis.ts:16 平行常量 ANALYSIS_MAX_IMAGES=3 未收敛到 @shared（行为一致，可选后续收敛）
3. 发正式版硬前置：代码签名证书（见 P2-1）

### 待办建议（下一轮迭代）
- P2-2：ProductManagementPage.vue（1734 行）按 composable 惯例拆分，目标 ≤1200 行
- P3-5：services 层统一调度器 lifecycle（startAll/stopAll），registerXxx 去副作用
- P3-1：lint 存量 ~1094 条按目录分批清零（优先 ipc/ 与 preload/），每批同步下调门禁
