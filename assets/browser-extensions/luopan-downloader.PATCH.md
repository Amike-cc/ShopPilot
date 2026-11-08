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

