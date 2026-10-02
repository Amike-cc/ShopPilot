# 项目文档

> **架构说明（当前有效）**：ShopPilot 已切换为单一 `root-ceo` 主 Agent。主 Agent 直接承担对话、规划、软件/浏览器操作、Job 执行、审核和记忆治理；Job、TaskRunner、证据、模型 Profile、fallback、预算、技能、插件、确认和恢复机制继续保留。下文和历史专项文档中出现的 HR、子 Agent、执行助手、按 Agent 绑定模型均属于兼容/历史记录，运行时统一拒绝组织变更并返回 `AGENT_SINGLETON_ONLY`。

- `DEVELOPMENT_SPEC.md`：工程设计、数据模型、IPC 契约和验收标准。
- `AGENT_DEVELOPMENT_SPEC.md`：单一 `root-ceo` Agent 的模型配置、Job、TaskRunner、本地记忆和验收标准；文档后半保留历史多 Agent 章节作为迁移参考。
- `ECOMMERCE_AGENT_CAPABILITY_SPEC.md`：单 Agent 电商运营全闭环能力设计、领域工具契约、确认/幂等边界、M0～M6 开发计划和真实验收门槛。
- `AGENT_PROGRESS.md`：A-M0～A-M6 当前实现状态、证据、冲突记录和回滚边界。
- `FUNCTIONAL_SPEC.md`：产品功能范围和 MVP 定义。
- `task-rpa-roadmap.md`：任务功能自研 RPA 方案与路线图。
- `STATUS_REPORT.md`：当前实现状态、验收记录和已知边界。
- `RELEASE_NOTES.md`：版本变更、发布和回滚说明。
- `INSTALL.md`：依赖安装与受限环境处理。
- `invite-optimization-report.md`：达人邀约优化报告（0.4.35 基线，历史存档）。
- `invite-p1-testing-checklist.md`：达人邀约 P1 真机测试清单（历史存档）。
- `REVIEW.md`：历史审查报告。
- `SALES_METRICS_AUTO_COLLECTION_DEVELOPMENT_SPEC.md`：四平台经营数据每 10 分钟自动采集、聚合、退避、证据和验收规范；当前实现边界为 `IMPLEMENTED / PARTIAL`。
