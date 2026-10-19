# 验收测试钩子（ACCEPTANCE HOOKS）门禁说明

> 状态：2026-10-19 审查整改落地。适用于 v0.4.75+ 的构建与验收流程。
> 相关代码：`packages/shared/src/acceptance-gate.ts`（纯规则）、`apps/desktop/src/main/services/acceptance-gate.ts`（Electron 适配）、`electron.vite.config.ts` 的 `define`。

## 1. 问题背景

整改前，**打包版**只要运行期设置 `SHOPILOT_ACCEPTANCE=1`，就能启用以下测试钩子：

| 钩子 | 作用 | 位置 |
|---|---|---|
| `SHOPILOT_TEST_AUTOCONFIRM=1` | 人工确认对话框直接返回"确认" | `main/services/password-dialog.ts` |
| `SHOPILOT_TEST_PASSWORD=***` | 密码对话框直接返回环境变量里的值 | 同上 |
| `SHOPILOT_TEST_EXTENSION_IMPORT_DIR=...` | 跳过原生目录选择框，直接导入指定扩展目录 | `main/ipc/extension-handlers.ts` |
| `SHOPILOT_MEMORY_TEST_FAULT=...` | 记忆模块确定性故障注入 | `main/services/agent-memory.ts` |

对生产安装包而言，这是一个**可被环境变量单独打开的后门**：机器上任何能启动进程的人都能让"提交/发布/发送"类操作绕过人工确认。

## 2. 现行规则（三层，全部满足才启用）

```
开发态（app.isPackaged === false）                        → 放行
打包态 且 构建期 __SHOPILOT_ACCEPTANCE_BUILD__ !== true  → 拒绝（生产构建）
打包态 且 验收构建 且 运行期 SHOPILOT_ACCEPTANCE === '1' → 放行（会写一条 warn 审计日志）
```

- **构建期开关**：`SHOPILOT_BUILD_ACCEPTANCE=1`（只有 `pnpm run dist:acceptance` 会设置）。
  由 `electron.vite.config.ts` 注入主进程常量 `__SHOPILOT_ACCEPTANCE_BUILD__`；生产构建注入 `false`。
- **运行期开关**：`SHOPILOT_ACCEPTANCE=1`（由各 CDP/验收脚本在启动子进程时注入，与整改前一致）。
- 纯规则函数 `isAcceptanceHookEnabled()` 在 `packages/shared/src/acceptance-gate.ts`，单测见 `tests/unit/acceptance-gate.test.ts`。

## 3. 两种构建，别用错

| 命令 | 产物 | 测试钩子 | 用途 |
|---|---|---|---|
| `pnpm dist` | `release/`（NSIS + latest.yml） | **关闭**（运行期环境变量无效） | 发布给用户 / 自动更新 |
| `pnpm run dist:acceptance` | `release/`（NSIS + latest.yml） | 保留，但仍需 `SHOPILOT_ACCEPTANCE=1` | 全部验收套件 |
| `pnpm run dist:acceptance -- --dir` | `release/win-unpacked/` | 保留 | 只跑 CDP 套件的快速构建 |

`tools/acceptance/run-acceptance.ps1` 已切换为 `pnpm.cmd run dist:acceptance`；手工跑套件前也必须先产出验收构建，否则打包态套件会在"该弹的确认框没弹/扩展目录选择框无法自动化"处失败。

> ⚠️ 验收构建带测试钩子，**只允许本机验收使用，禁止外发或作为发布资产上传**。

## 4. 生产构建自检（发布前建议执行）

1. `pnpm dist` 构建安装包并安装到测试机；
2. 用 `SHOPILOT_ACCEPTANCE=1 SHOPILOT_TEST_AUTOCONFIRM=1` 启动应用，执行一个必须人工确认的动作（如导出会话/删除店铺）；
3. 预期：**仍然弹出确认框**，且 `%APPDATA%\shopilot\logs\app-*.log` 中**没有** `[acceptance]` warn；
4. 若第 3 步没弹框或日志出现 `[acceptance]`，说明打错了构建（用了验收构建），必须重新用 `pnpm dist` 出包。

## 5. 新增测试钩子时的约定

- 一律通过 `acceptanceHooksEnabled()`（主进程）或 `isAcceptanceHookEnabled()`（纯逻辑）判断，**禁止**直接读 `process.env.SHOPILOT_ACCEPTANCE`；
- 钩子行为必须只影响本地验收，不得改变正常路径的默认值；
- 在 `tests/unit/acceptance-gate.test.ts` 补一条覆盖（纯函数层）。
