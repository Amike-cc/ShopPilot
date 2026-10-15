# 发票中心 UI 精简版 v2（2026-10-15）

「更简洁清爽」重制：把原「采集状态条 + 4 张 KPI 卡 + 自动更新行 + 2 条说明段落 + 7 控件工具栏 +
默认全部展开的方向明细」精简为**四层渐进披露**——信息不阉割，视觉元素与操作步骤双降。

## 文件

| 文件 | 说明 |
| --- | --- |
| `01-desktop.png` | **实现实拍（桌面）** · 真机数据：概览一行（193 条 / ¥114,277.22 / 4 店 + 条件 chip + 自动更新内联开关）、按主体分组、店铺行 4 元素（名称 · 数字 · 状态 chip · 进入店铺 →） |
| `02-mobile.png` | **实现实拍（窄屏 414px）** · 单列：横向主体胶囊（可滑）、概览换行、底部常驻操作条（采集 + 导出），异常 chip 常驻不依赖 hover |
| `capture-live.mjs` | **实机验证 + 重拍脚本**（连已运行实例 CDP 9250）：三页签渲染 → 默认按主体（家数与行数一致、未填写固定最后）→ 概览一行 → 筛选折叠 → 明细收起 → **414px 无横向溢出**断言 → 覆盖式重拍 01/02。当前实机 17/17 全过 |

## 复现 / 重拍

```bash
# 前提：应用已启动并带 --remote-debugging-port=9250（会话终端里先 unset ELECTRON_RUN_AS_NODE）
node assets/design/invoice-center-v2/capture-live.mjs
```

脚本只点视图开关（不写任何数据）；`01-desktop.png` / `02-mobile.png` 会被覆盖重拍，退出码 0 = 全部检查通过。

## 与 v1 的差异（精简清单）

- **概览**：状态条 + 4 张 KPI 卡 + 自动更新行 + 2 条说明段落 → **一行数字流**（完整解释收进各 chip 的 title）。
- **工具栏**：搜索 + 4 下拉 + 视图切换 → 搜索 + 「筛选 · N」+ 视图切换（四个下拉默认折叠在面板里）。
- **默认视图**：按店铺 → **按主体**（打开先看"票压在哪个主体"，店铺列表是二级视角）。
- **方向明细**：「按店铺」视图默认收起，点开才渲染（v-if，行多时首屏与渲染成本一起降）。
- **页头**：刷新从页头移入概览行（仅发票中心；其他模式的按钮不动）。
- **移动端**：新增 <768 单列断点 + 底部操作条；修复 rail 在窄屏的横向溢出（grid 项 min-width:0 + 胶囊 width:auto）。

## 契约（改 UI 前先看验收脚本）

- `[data-test="invoice-totals"]` 内 `.dc-num` **恰好 3 个**，顺序=待开票条数 / 可开金额 / 有票待开店铺数；
- `[data-test="invoice-license-bar"]` **恰 4 个** `.inv-lic-chip`（全部 / 各主体 / 未填写，顺序不变）；
- 保留：`invoice-export`（页头）、`invoice-view-summary/stores`、`invoice-scope-meta`、
  `invoice-status-login/license`、`invoice-schedule(-toggle)`、`invoice-filter-*`、
  `invoice-dir-toggle-*`、`invoice-subject-*`、`invoice-license-*`。

验收：`node tools/acceptance/invoice-license-local-verify.js`（**51 项**）+ 源码级回归
`tests/unit/invoice-center-simplified-ui.test.ts`（8 条）。
