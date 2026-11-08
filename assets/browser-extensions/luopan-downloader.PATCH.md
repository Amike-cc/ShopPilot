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
