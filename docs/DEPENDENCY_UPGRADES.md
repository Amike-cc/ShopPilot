# 依赖升级评估（暂不执行）

> 2026-10-19 审查产出。本文件只记录评估结论，**本轮不做升级**。

## zod：3.22.4 → 4.x（评估结论：可升，但单独一轮做）

**收益**
- zod 4 的解析性能约为 3.x 的 2–7 倍（官方基准），包体更小（tree-shaking 更彻底）。
- 本项目 zod 只用在主进程 IPC 入口校验（`apps/desktop/src/main/ipc/*` 共 7 个文件、`tasks/task-step-schemas.ts`），版本升级的影响面清晰。

**成本 / 风险**
- zod 4 有破坏性 API 变更：`z.string().email()` 等链式 API 调整、错误对象结构（`ZodError.issues` 形状与 message 定制）、`z.record`/`z.union` 的类型推导差异。本项目 7 个文件都有 `safeParse` 与错误分支，需要逐处回归。
- 部分共享 schema（`packages/shared/src/schemas/*`）同时被主进程与测试使用，升级会牵动 tests/unit 的断言。

**建议执行方式（未来单独一轮）**
1. 先只升 zod 到 4 的最新 4.x，跑 `pnpm typecheck` + `pnpm typecheck:tests` + 全量 vitest，按错误清单收敛；
2. 重点回归 IPC 非法入参错误码（`INVALID_ARGUMENT`）与错误 message 是否与前端提示一致；
3. 升级后重跑 `tools/ci/audit-gate.mjs` 与打包冒烟（`package-smoke.ps1`）。

## 其他候选（同样暂不动）

| 依赖 | 当前 | 说明 |
|---|---|---|
| Electron | 44.7.2 | 与 better-sqlite3 ABI、webview tag 行为强绑定；升级需整套 CDP 验收复跑，按 Electron 发布节奏单独排期 |
| better-sqlite3 | 13.0.3 | 预编译 N-API 版本与本机/CI 匹配，升级收益低、原生依赖风险高 |
| electron-builder | 26.15.3 | 26.x 内保持；升级前先确认（当前 26.15.3 无内置 Azure Trusted Signing 选项，见 RELEASE_SIGNING.md） |
| pnpm | 10.34.7（packageManager 锁定） | 本机曾遇 pnpm 12 的链接问题，保持锁定 |

## 结论

依赖不在本轮（2026-10-19 修复轮）升级范围内；zod 4 升级建议在功能冻结期单独做一轮，并以上述验证清单为准。
