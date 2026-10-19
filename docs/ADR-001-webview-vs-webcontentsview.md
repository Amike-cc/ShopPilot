# ADR-001：店铺页面用 DOM `<webview>` 承载，暂不迁移 WebContentsView

> 状态：**已接受（暂缓迁移）** · 决策日期：2026-10-19（承接 2026-10-16 browser-review 的 P3-4 结论）
> 影响面：`apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue`、`apps/desktop/src/main/browser/window-manager.ts`、`apps/desktop/src/main/browser/session-manager.ts`

## 背景

店铺页面（拼多多/微信小店/快手小店/抖店后台）必须嵌在工作台主窗口内部，并满足：

1. **一店一个隔离会话**（`persist:store_<id>` 分区、Cookie/缓存/下载互不可见）；
2. **页面之上要能盖 UI**：标签栏下拉、右键菜单、元素拾取遮罩、弹层/抽屉/确认框；
3. 页面工具（读文本、截图、受信任输入、CDP 探针）需要稳定的 `webContents` 句柄。

Electron 提供两条路：

| 方案 | 优点 | 致命约束 |
|---|---|---|
| 原生 `WebContentsView`（旧实现） | 官方推荐路线、合成/性能更可控 | **永远绘制在渲染层 HTML 之上**，任何 HTML 弹层都会被页面盖住 |
| DOM `<webview>`（现实现） | 与渲染层同一文档流，CSS 层级即可覆盖页面，标签切换只切可见性 | Electron 官方标注"不推荐/建议迁移"，API 稳定性不如 WebContentsView |

历史上本项目先用了 `WebContentsView`，因为弹层问题在 2026-09 迁移到 DOM `<webview>`；`window-manager.ts` 相应改为由渲染层 `did-attach` 注册 guest（`browser:registerWebview`），主进程只持有已注册的 guest 句柄。

## 决策

**保持 DOM `<webview>`，本轮不做 WebContentsView 迁移。**

理由：
- 弹层/拾取/抽屉是产品的核心交互；迁移回 WebContentsView 需要重做"HTML 覆盖页面"的全部方案（要么改成原生浮层，要么把弹层做成独立窗口），成本与回归面远超收益；
- 当前 attach 收口严格（guest 未注册完成前页面工具按"未就绪"等待或如实失败），CDP/UIA 验收覆盖了标签切换、跨店隔离、真实按键转发；
- Electron 44 仍支持 webview tag，未出现弃用时间表。

## 触发重新评估的条件（任一满足即启动迁移评估）

1. Electron 发布 webview tag 弃用公告或将其标记为 deprecated；
2. 出现无法绕过的 webview 缺陷（崩溃、合成白屏、CDP 不可达、跨店串号）；
3. 产品决定"弹层全部改为原生视图"（届时 WebContentsView 反而更优）。

## 风险缓解（本轮已做/待做）

| 措施 | 状态 |
|---|---|
| 把 webview 的全部绑定（`did-attach`、`@did-attach`、`partition`、事件转发、可见性切换）收敛到**单一 composable**，而不是散在 2000 行的页面里 | 本轮由渲染层拆分一并处理（`features/workbench/use-*.ts`） |
| 主进程侧保持"只认已注册 guest"的边界（`registerWebview` / `window-manager`），避免渲染层直接操作 `webContents` | 现状已满足 |
| 把 `WebContentsView` 过时注释全部改为 DOM `<webview>` 事实描述，避免误导后续实现 | 本轮已完成 |
| 给 guest 生命周期（attach/detach/关店/重载）补回归测试 | 已有 `tests/unit/browser-view-diagnostics.test.ts`、`tests/unit/webview-*`；后续新增绑定必须带测试 |

## 备注

- 本文替代 `docs/browser-review-2026-10-16.md` 里"P3-4 暂缓"的口头结论，作为可追溯的架构决策记录；
- 若迁移启动，迁移范围与验收清单在此文档追加，不另开新文档。
