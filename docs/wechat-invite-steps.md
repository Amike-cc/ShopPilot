# 微信小店 · 达人邀约步骤（真机实测版）

> 本文由 `wx-invite-test/dump-invite-steps.mjs` 从**真实构造器**导出，不是手写抄录。
> 复现命令：`node wx-invite-test/dump-invite-steps.mjs`
> 代码位置：构造器 `packages/shared/src/invite-steps.ts` · 载荷/校验 `packages/shared/src/invite-task.ts` ·
> 执行引擎 `apps/desktop/src/main/tasks/task-runner.ts` · 面板 `DashboardBrowserSurface.vue`

## 0. 入口与前置

| 环节 | 说明 |
| --- | --- |
| 面板入口 | 右侧「达人邀约」面板 → 填配置 → **打开达人广场**（应用筛选并回报列表条数）→ **开始邀约** |
| 店铺页 | `https://store.weixin.qq.com/shop/findersquare/find`（带货者广场） |
| 必填 | 联系人 / 微信号 / 手机号；话术（手填或 AI 生成）；邀约商品 ID（最多 30 个） |
| 筛选（可选） | 带货者类型（4 种）、带货类目（34 项）、带货销售总额（16 档）、其他筛选（7 项） |
| 额度护栏 | 面板「本次最多邀约 N 位」，默认 **10**、范围 **1–50** → 直接作为 `loop.maxRounds` |
| 7 天不重复邀约 | 面板开跑时查**邀约台账**（近 7 天已邀昵称）→ 点「详情」前跳过这些行；台账没覆盖到的由平台兜底（详情页按钮禁用 → `TASK_DAREN_ALREADY_INVITED` → 换下一位） |
| 任务名 | `达人邀约 · 微信小店 · 辅助填单 · <联系人> · 类目 N 项 · 销售额 N 档 · 其他 N 项 · 最多 N 位` |

**开跑前会拦下的事**（`inviteTaskIssues`，逐条可读）：缺联系人/微信/手机号、话术为空（手填模式）、
筛选值不在平台实测清单里（平台改过名的旧值）、「带货销售总额」用在非「全部带货者」类型下、
「本次最多邀约」越界。

## 1. 任务结构

顶层只有 **1 个步骤：`loop`**（每轮 = 邀约 1 位达人），轮内 27 步。
「导航 + 筛选」放在**轮内**而不是开头——因为切到详情页再切回来时广场页会重新加载，页内筛选会丢，
只有每轮重新应用才保证第 2 轮起不会在"没筛选"的名单上邀人。

### loop 参数

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `maxRounds` | 面板设置（默认 10，上限 50） | 本次最多邀约几位（额度护栏） |
| `stopOn` | `TASK_QUOTA_EXCEEDED`、`TASK_SELECTION_SHORTFALL` | 干净收工：额度用完 / 没有更多候选 |
| `onCode` | 见下表 | 四类异常的自愈动作 |

| onCode | 触发场景 | 动作 | 上限 |
| --- | --- | --- | --- |
| `TASK_PAGE_EXHAUSTED` | 本页达人都已点过 | 点「下一页」后重试（点不动/末页置灰 → `TASK_SELECTION_SHORTFALL` 收工） | 10 次 |
| `TASK_DAREN_PAGE_UNOPENABLE` | 详情页微应用没渲染（平台限流） | **退避 20s 后重开本轮**（重试同一位，不消耗候选） | 6 次 |
| `TASK_DAREN_NOT_INVITABLE` | 页面写着「暂未到达合作门槛」 | **换下一位**（advance，不退避） | 20 次 |
| `TASK_DAREN_ALREADY_INVITED` | 按钮禁用 + 平台提示"7 天内不可再次邀请" | **换下一位** | 20 次 |

## 2. 每轮 27 步

| # | 步骤 | 作用 | 关键参数 / 失败码 |
| --- | --- | --- | --- |
| 1 | `navigate` | 进广场（每轮重载，页内状态本来就不跨标签页保留） | 目标 `.../findersquare/find` |
| 2 | `waitForPage` | 等地址就绪 | `urlIncludes=find` |
| 3 | `waitForText` | **等筛选区真的渲染出来**（micro-app 挂载完成）再动手 | `text=带货类目`；不等就会点空 |
| 4 | `clickByText` | 选带货者类型页签 | `mode=real`（受信任鼠标） |
| 5 | `clickByText` | 选类目（逐个） | 限定在「带货类目」行内 `climb=2`、JS 点击、**点后回读勾选态** `verifyChecked` → 没选上报 `TASK_FILTER_NOT_APPLIED` |
| 6 | `clickByText` | 展开「带货销售总额」指标下拉 | `exact=true`（DT 是开关） |
| 7 | `clickByText` | 选销售额档位（逐个） | 限定在该指标 `dl` 内 `climb=1`、`exact=true`、`verifyChecked` |
| 8 | `clickByText` | 收起指标下拉 | 与第 6 步同一个开关 |
| 9 | `clickByText` | 选其他筛选项（逐个） | 限定在「其他筛选」行内、`verifyChecked` |
| 10 | `waitForText` | 等列表出现「详情」入口 | `text=详情` |
| 11 | `clickByText` | 点开**还没访问过的**达人详情 | `nth=unvisited`（列表每次加载都洗牌）、`mode=real`、跟随新标签页 `followTab{finder-detail, closeOld:true}`；**`skipTexts`=近 7 天已邀昵称**（这些行直接跳过）、`recordRowText=true`（回传昵称供记账）；取不出 → `TASK_PAGE_EXHAUSTED`（交给 onCode 翻页） |
| 12 | `waitForPage` | 等详情页 | `urlIncludes=finder-detail` |
| 13 | `clickByText` | 点「邀请带货」 | `mode=real`、`waitUrl{initiate-invite, attempts:4}`（SPA 事件没挂上时重定位再点）；按钮不在 → `TASK_DAREN_PAGE_UNOPENABLE`；写着「暂未到达合作门槛」→ `TASK_DAREN_NOT_INVITABLE`；按钮禁用 → `TASK_DAREN_ALREADY_INVITED` |
| 14 | `waitForPage` | 等邀约表单页 | `urlIncludes=initiate-invite` |
| 15 | `requireQuota` | 额度预检（**可选**：平台页面没有这段文案时不拦） | `textIncludes=今日剩余`，`metric=invite.quota` |
| 16 | `typeText` | 填联系人 | `input[placeholder*="邀约联系人"]` |
| 17 | `typeText` | 填微信号 | `input[placeholder*="微信号"]` |
| 18 | `typeText` | 填手机号 | `input[placeholder*="手机号码"]` |
| 19 | `aiGenerate` | **AI 生成邀约话术**（以邀约商品表为参考） | `textarea[placeholder*="合作说明"]`、`sourceSelector=table`、`maxLen=200`；AI 模式才用，`retryLimit=2` |
| 20 | `readText` | 回读话术留档 | `metric=invite.script` |
| 21 | `ensureRowsById` | 按**商品 ID** 添加邀约商品 | `添加商品` → 搜索 ID → 勾选 → `确认` |
| 22 | `clickByText` | **点「发送邀约」（真实发出，无人工门禁）** | `mode=real` |
| 23 | `waitForText` | 等平台确认弹窗 | `text=确认发送邀约` |
| 24 | `clickByText` | 点「确认」 | `mode=real` |
| 25 | `waitForGone` | **判据①：确认弹窗关闭**（按文案等消失） | `text=确认发送邀约` |
| 26 | `waitForGone` | **判据②：平台清空了「邀约商品」行** | `selector=tbody tr` |
| 27 | `screenshot` | 留档截图（**尽力而为**，失败只记 warn，不会打挂已发成功的批次） | 超时上限 8s |

## 3. 发送后的核对（不靠任务自述）

| 核对方式 | 位置 |
| --- | --- |
| 平台绿色横幅「已成功发送邀约」 | 第 27 步截图里 |
| 我的邀约 → **邀请中** 新增一行 | `https://store.weixin.qq.com/shop/findersquare/my-invite`（页签「邀请中(n)」） |
| 任务逐步骤结果 + 轮次汇总 | 任务详情：`completedRounds / stopReason / rounds[].ms` |

## 4. 已知边界

1. **额度**：平台不显示「今日剩余 N 次」，`requireQuota` 因此是可选；真正的上限是面板那个「最多 N 位」。
2. **发送后判据**：第 25/26 两条都过才算这一位发出去了；两条都依赖平台把表单清空/弹窗关闭。
3. **平台改版**：所有文案/选择器基于 2026-10-02/03 真机实测；改版会以 `TASK_SELECTOR_CHANGED` /
   `TASK_FILTER_NOT_APPLIED` 如实失败（不会静默乱邀），面板「打开达人广场」会先回报可见「详情」条数。
4. **运行标签页必须在前台**：引擎每步开头会确认（被切走就切回来），否则"可见性"判据必然失败。
5. **深分页**：一单里翻到第 3 页取人尚未端到端跑过（「下一页」的平台交互已真机验证）。
6. **7 天不重复邀约的两道闸**：
   - **台账预跳过**（我们自己的记录）：广场列表行没有"已邀约"标记、也拿不到 finderUsername
     （2026-10-04 实测），所以只能按**昵称**剔行。候选池远大于单页、且每次加载都洗牌，
     所以命中率取决于"近 7 天邀过的人是否刚好出现在这一页"；
   - **平台兜底**（权威）：台账没覆盖到的（手工邀过、或洗牌没碰上）会在详情页被平台拦下
     （按钮禁用 / 页面写着「你已经邀请过该达人，7天内不可再次发送带货邀约」）→
     `TASK_DAREN_ALREADY_INVITED` → 换下一位（advance 上限 60）。
   **因此"7 天内不会重复邀约"是平台保证的**；我们做的是"尽量别白跑一趟详情页"。
