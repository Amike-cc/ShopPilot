# 达人邀约真机探针

本目录保留抖店、快手、微信等平台的真机探针与复现脚本。

- 根目录：可执行探针、公共 CDP 辅助脚本，以及仍被脚本直接引用的输入数据。
- `evidence/`：截图、日志、JSON/文本转储、提交说明等静态实测留档。这里的文件只归档，不作为运行时输入。

运行脚本时从仓库根目录执行，例如：

```powershell
node wx-invite-test/check-ks-invite-records.mjs
```

新增实测产物优先放入 `evidence/`；如果脚本依赖某个输入文件，请保持该输入文件在根目录，并在脚本注释中说明用途。

## 微信小店「带货者广场」筛选实测（2026-10-02）

这一组探针量的是广场筛选（带货类目 / 近30日带货数据·带货销售总额 / 其他筛选），
并附带一个**不发邀约**的端到端验证。

**1) 准备一份独立 userData（不动正在运行的应用实例）**

Electron 的单实例锁按 userData 目录算，所以复制一份 profile 就能另起一个带调试端口的实例：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe wx-invite-test\prep-probe-profile.cjs   # 产出 .probe-wx-profile\
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

**2) 启动探针实例（端口 9250）**

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process node_modules\electron\dist\electron.exe -ArgumentList '.','--no-sandbox','--remote-debugging-port=9250','--user-data-dir=D:\code\电商浏览器\.probe-wx-profile','--disable-features=CalculateNativeWinOcclusion' -WorkingDirectory .
```

**3) 探针与验证**

| 脚本 | 用途 |
| --- | --- |
| `probe-wx-square-filters.js` | 广场筛选区的行标签与控件总览（只读） |
| `probe-wx-sales-menu.js` | 「带货销售总额」下拉的完整标记与 16 档文案 |
| `probe-wx-square-gestures.js` | 每种控件吃哪种手势（JS click / 受信任鼠标） |
| `probe-wx-square-facts.js` | 每个带货者类型页签各自提供哪些指标 |
| `probe-wx-sales-toggle.js` | 指标下拉的开关语义（点开/点收，Escape 无效） |
| `probe-wx-collapsed-click.js` | 折叠态下点类目 chip 是否生效 |
| `probe-chip-class.mjs` | 勾选态只有 `input.checked`、没有 class 变化 |
| `verify-wx-square-filters.js` | **不发邀约**的端到端验证：IPC 应用筛选 + 任务引擎跑真实生成的筛选步骤 + 负路径 + 面板 UI |

`verify-wx-square-filters.js` 会先把 `../packages/shared/src/invite-task.ts` 用 esbuild 打成一个 ESM 包
（`wx-invite-test/.tmp/probe-entry.mjs`），保证验证的就是面板/智能体实际会跑的那串筛选步骤
（只剔除末尾会真的发送的 `loop`）。

## 微信小店达人邀约「整条功能」实测（2026-10-03）

上面那组量的是筛选；下面这组量的是**整条邀约链路**（会真的发出去，用前先想清楚）。

| 脚本 | 用途 | 有无副作用 |
| --- | --- | --- |
| `wx-invite-preflight.js` | 开跑前体检：登录态 / 店铺配置 / 额度 / 可邀约行数 | 无 |
| `wx-invite-send-one.js` | **真发 1 位**的完整闭环：读店铺配置 → 真实构造器出载荷（只把 loop 钉成 1 轮）→ task.create/run → 附平台侧复核 | **会真实发送** |
| `check-inviting-tab.mjs` | 平台侧铁证：进「我的邀约 → 邀请中(n)」读这一条（谁 / 什么时候 / 状态） | 无 |
| `wx-invite-rehearse-no-send.js` | 彩排：跑真实生成的单轮/多轮步骤，但**砍掉发送那两步**；核对每轮是否重新应用筛选、标签页有没有泄漏 | 无（不发） |
| `verify-tab-state-persist.mjs` | 关键假设验证：切走标签页再切回，广场页的页内状态（筛选）还在不在 | 无 |
| `diag-ai-generate.js` | 复现「AI 生成话术」这条链路（模型返回空内容时打印 finish_reason 与字段长度） | 无（写进搜索框） |
| `read-real-db.cjs` / `read-real-invite-config.cjs` / `read-run-steps.cjs` | 只读排查真实应用的库：最近的邀约任务/运行/逐步结果、店铺邀约配置 | 无（readonly 打开） |
| `check-square-now.mjs` / `diag-square-tabs-state.mjs` | 只读看广场页/各广场标签页当前渲染状态（排查"找不到筛选文案"用） | 无 |
| `diag-repro-preamble.mjs` | 复现"发送脚本前置 → 第 1 轮等「带货类目」超时"（照抄前置 + 两侧采样） | 无 |
| `diag-tab-sync.mjs` | 同时打印"主进程认为的活动标签页"与"渲染层真正挂载的 webview" | 无 |
| `verify-paging.mjs` | 真机验证「下一页」：滚进视口 + 受信任鼠标点击，比对前后页名单 | 无（只翻页） |

### 2026-10-03 下午：连发反复卡在第 3 步的真根因

真机连发三次都停在 `第 1 轮（子步骤 3/27）waitForText「带货类目」超 40s`，而同一环境彩排能连过 3 轮。
受控实验把范围收窄到"间歇性"：手动导航 2s 渲染完成、最小任务连跑 8/8 成功。
采样发现**任务自报导航成功、页面却整轮停在旧地址** —— 根因是：切页/重挂载后渲染层换了新 guest，
而引擎在步骤里抓的是**旧 guest 句柄**；后台标签页的 `<webview>` 不挂在文档上、元素 rect 全为 0，
于是所有**可见性判据**（waitForText / clickByText）必然失败，而 URL 类判据照常通过，极具迷惑性。

修法：`task-runner` 新增 `ensureRunTabForeground`（每步开头确认运行标签页仍在前台且 guest 已注册，
被切走就切回来、切不回来明确报 `TASK_TAB_NOT_FOREGROUND`），`navigate` 步改为**现取** wc。
复现脚本修前必失败、修后 1.6s 通过。

`wx-invite-send-one.js` 支持 `WX_SCRIPT_MODE=manual` 覆盖话术模式（AI 模型不可用时先用配置里的手填话术跑闭环），
`wx-invite-rehearse-no-send.js` 支持 `REHEARSE_ROUNDS=n` 跑多轮彩排；话术模式默认**跟随店铺配置**（AI 模式就用 AI）。

### 2026-10-03 上午：用户那单为什么没跑完

真实应用库里的原始记录（`read-real-db.cjs`）：

```
run_f3ad7408875cad8c210ee5f4  failed  09:57:41 → 09:58:22
{"action":"loop","maxRounds":50,"completedRounds":0,"stopReason":"AI_EMPTY_OUTPUT",
 "failedRound":1,"failedChild":"18/25 aiGenerate","rounds":[]}
AI_EMPTY_OUTPUT: 模型返回了空内容（finish_reason=length，message 字段=[role,content,reasoning_content]，reasoning_content 1860 字）
```

即：邀约流程本身（筛选→详情→邀请带货→表单→额度）都过了，卡在「AI 生成话术」——
网关上的 `deepseek-flash` 是推理型，`max_tokens` 全被 `reasoning_content`（思考）吃掉、`content` 为空。
修法见 `ai-client.ts`：放宽 legacy 输出上限（1200 → 8192）、邀约话术预算按 `max(3000, maxLen*16)` 给、
首次空输出**加倍预算重试一次**、这条链路的超时放宽到 ≥120s；并在导航后加一步"等筛选区渲染"，
避免"地址到了就点"造成的 `TASK_SELECTOR_CHANGED`（真机连续踩到）。


