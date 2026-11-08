# ShopPilot 适配说明（luopan-downloader 2.1.9）

原包：`C:\Users\15240\Documents\luopan-downloader-2.1.9.zip`（未改动，留档在
`D:\code\电商浏览器\artifacts\luopan-extract`）。本目录是 ShopPilot 适配版。

## 为什么必须改

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| `downloads` 权限被拒 | ShopPilot 硬阻断清单包含 downloads（extension-manifest.ts） | manifest 移除该权限 |
| `chrome.downloads.*` 不存在 | Electron 未实现该 API（官方支持清单无 downloads） | 下载改为后台 fetch → 分块发内容脚本 → `<a download>` 触发 |
| `chrome.action.setBadge*` 不存在 | Electron 未实现 chrome.action | 移除徽标，进度只存 storage（lpStat） |

## 新下载链路

1. 面板点下载 → `LP_DOWNLOAD` 发给后台（不变）；
2. 后台并发 3 路按签名直链 `fetch` 视频流（host_permissions 内不受 CORS 限制，不带 Cookie）；
3. 按 1MiB 分块（base64）经 `chrome.tabs.sendMessage` 发回罗盘页面的内容脚本；
4. 内容脚本攒齐后 `Blob + URL.createObjectURL + <a download>` 触发下载；
5. ShopPilot 的 `will-download` 接管：存到 `userData/stores/<店铺id>/downloads`，
   （2026-11-02 起文件名**不带店铺前缀**，重名追加序号），应用内「下载面板」可看进度与结果。

## 与原版的行为差异

- 文件不再按「罗盘带货视频/xxx」子目录归档（`<a download>` 不支持路径），全部落在
  该店铺的下载目录，文件名保留 `标题_作者_视频ID` 结构；
- 扩展内的「完成/失败」统计表示"已触发下载"，真实完成状态以应用下载面板为准；
- host_permissions 追加了字节系 CDN（douyinpic/zjcdn/bytecdn/ibyteimg/douyin.com），
  用于直链 302 跳转后仍能读取视频流。

2026-11-02 · ShopPilot 适配

## 2026-11-08 · 修复「获取不到链接」

**根因**：抓数链路第一步是往罗盘页面注入 `chrome-extension://<id>/fetch.js`（依赖
manifest 的 `web_accessible_resources`）。而 Electron 官方支持的 manifest 键清单里
**没有 `web_accessible_resources`**——页面加载不到这个资源，`injectFetcher` 返回失败；
更糟的是原实现在这条失败路径上**静默返回**（`loadRankAll` 里 `if (!ready) return`），
界面上没有任何错误提示，表现就是"面板永远是 0 条 / 按钮不出现"。

**修复**（v2.2.0）：

1. **双通道取数**：页面桥（fetch.js）仍优先（兼容真 Chrome 与页面环境差异）；
   桥不可用或连续超时 → 自动回退到 content script **直连同源接口**（带 Cookie，
   扩展请求不受页面 CSP 约束）。桥故障被记住，后续请求不再白等 20 秒。
2. **失败不再静默**：榜单页抓取失败会在页面左下角出现红色提示条（含重试状态与
   最终错误）；竞品详情条原本就有错误显示，保持不变。
3. **自检可见**：后台 SW 启动时把「webRequest / tabs 是否可用」写进 storage；
   popup 增加自检行——「后台：正常 · webRequest：可用 · 取数：直连 / 页面桥 · 最近错误：…」。
4. **后台防御**：`chrome.webRequest` 监听注册改为存在性判断——此前若该 API 缺失，
   顶层代码一抛错整个 Service Worker 直接死掉，所有消息通道全部失效且无痕。

**升级方式**：设置 → 浏览器扩展 → 插件中心 → 三鱼带货视频下载 → 「重新安装」
（覆盖升级，会重载会话里的扩展），然后刷新罗盘页面。

## 2026-11-08 · v2.3.0 真正根因与架构修正（a_bogus 签名）

v2.2.0 的"WAR 不支持"假设被探针**证伪**（实测注入链路全通）。继续取证：

| 实验 | 结果 |
| --- | --- |
| 隔离世界直连接口 | `{"msg":"当前环境存在风险，请稍后重试"}`（风控拒绝） |
| 页面桥（fetch.js）请求 | `st=0` 但 `data_result` 为空——**成功但空** |
| 抓页面自己的请求 | 参数与插件几乎一致，但多 `msToken` / `a_bogus` / `verifyFp` / `fp` |

**根因**：罗盘接口现在强校验字节系签名 `a_bogus`（页面请求库在发请求时自动附加，
绑定 URL+时间戳+设备指纹）。插件裸 fetch 没有签名 → 空数据/风控拒绝。
2026-11-02 之前罗盘未强校验，所以旧版能用。改参数绕不过去——签名在页面 JS 里。

**v2.3.0 架构**：不再自己发请求，改为**拦截页面自己的请求响应**——

1. `fetch.js`（页面世界）hook `fetch` + `XMLHttpRequest`：命中
   `video_bring_good`（榜单）/ `flow_more`（竞品详情）就把响应体 `postMessage` 给内容脚本；
2. content script 收到推送：榜单**只增不删**（页面翻页时逐页到达，自动去重），
   详情按 videoId 去重追加；签名、分页、筛选全部天然正确；
3. 使用方式随之变化：**数据跟着页面走**——要点开「短视频榜」标签页/「视频分析」标签页，
   页面发请求插件才有数据；12 秒没数据会出现引导提示条；
4. 弹窗「重新抓取」= 刷新罗盘页面（让页面重新发带签名的请求）；
5. 主动请求通道（req/res）保留但不再使用，留作日后兜底。

**升级方式不变**：插件中心「重新安装」→ 刷新罗盘页面。



## 2026-11-08 · v2.4.1 最终根因（两层叠加，均有实证）

v2.4.0 的内联同步注入修复了 hook 时序，但端到端仍拿不到数据。继续取证：

| 实验 | 结果 |
| --- | --- |
| `chrome.webRequest`（MV3 SW）观察页面请求 | **零捕获**（lpUrlSeen 始终缺失）——Electron 里应用自身的 session.webRequest 处理器使扩展 webRequest 失效 |
| 内联 hook 后 `window.fetch` 源码 | 当前 fetch 是**罗盘自己的签名包装器**（`rG({...}, t.config, t.signType||"pubKey")`），但页面请求**绕过 window.fetch**（bundle 保存了原生引用），hook 链路通但拦不到 |
| 页面自己收到的响应（CDP Network 抓包） | `st:0`、10 商品、100 视频——**`video_play_url` 全空（0/100）、`video_id` 全空**，只有 `video_ref` 引用键（`k1.xxxx`） |

**最终根因：罗盘服务端改版（两层叠加）**
1. 接口强校验 `a_bogus`/`msToken` 签名 → 插件自己拼参数的请求一律「成功但空」或风控拒绝；
2. 榜单接口**不再直接下发播放地址**：`video_play_url`/`video_id` 置空，只发 `video_ref`
   引用键，真实地址要用 ref 走换链流程（页面播放器内部通道）获取。
11-02 之前没有这两层，所以旧版能用；这不是 ShopPilot 侧的回归。

**v2.4.1 交付**：
- 数据通道重构为「页面响应推送」（inline 同步 hook + src 兜底），在接口恢复直发地址时立即恢复工作；
- **改版检测**：响应里视频存在但 play_url 全空 → 页面左下角明确提示「罗盘已改版…」；
- 失败可见 + popup 自检行（后台 SW / webRequest / 最近错误）；
- 完整恢复下载需要新一轮适配：驱动页面播放器逐视频取直链（需要应用侧受信任点击配合）
  或抓用户点播放时的真实请求——作为 v3 跟进。

## 2026-11-09 · v2.6.0 「复制链接」适配完成（换链接口逆向成功）

**换链接口已逆向并验证**：受信任点击打开罗盘播放器后抓到——

```
POST /compass_api/shop/common/market/entity_by_ref?msToken=..&a_bogus=..
Body: {"ref":"k1.xxx","access_type":1,"_lid":"..."}
响应: { st:0, entity:{ video:{ play_url:"https://v11-wha.douyinvod.com/..", video_id:"7694862398826468091" } }, remaining_cnt }
```

签名 a_bogus 由罗盘自己的 fetch 包装器在页面世界调用时自动附加——插件经页面桥调用即可。

**v2.6.0 实现**：
- parseRank：video_id 置空时用 video_ref 兜底，条目不再丢失（按钮恢复渲染）；
- 复制链接：点击后对每个视频 POST entity_by_ref 解析真实抖音 ID（并发 3，
  进度显示在按钮上），拼 `douyin.com/video/<id>` 复制；
- 批量下载：同样解析后用 play_url 走下载通道；
- 预解析缓存：数据推送后自动解析（点击时直接命中缓存，复制回到手势内同步路径）；
- 剪贴板写入走页面桥（罗盘 origin 的 clipboard-sanitized-write 已被应用放行，
  绕过罗盘对 clipboard.writeText 的反复制 hook——实测它被替换成了签名函数）；
- clipboardWrite 权限已加入 manifest（不在应用受限清单内）。

**验证状态**：按钮渲染（10 行）、解析接口、下载提交链路均在真机 CDP 环境验证；
系统剪贴板写入受 OS 焦点限制无法在沙箱后台验证（hasFocus 模拟通过但 OS 层拒绝），
真实前台使用走浏览器标准复制机制。
