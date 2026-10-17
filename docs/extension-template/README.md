# 自研插件模板（可直接导入）

这是一个能通过 ShopPilot 扩展校验的最小可用扩展：在店铺页面右下角放一个可点击的小徽章，并用 `chrome.storage.local` 记录「本店铺第几次注入」。

## 怎么用

1. 把这个文件夹复制到你自己的开发目录（例如 `D:\extensions\my-first-extension`），按需改 `manifest.json` 的 `name` / `version` / `matches`。
2. 打开 **设置中心 → 浏览器扩展**，打开「启用浏览器扩展」总开关。
3. 点「导入扩展文件夹」，选中**上面那个开发目录**。
4. 在扩展列表里点「启用」，然后打开（或重载）任意店铺页 —— 页面右下角应出现「插件已注入」。
5. 后续改代码：点该行的「目录」按钮打开**应用内的副本**，用编辑器改 `content.js` / `content.css`，保存后点「重载」，再刷新店铺页即可看到效果。

> 注意：导入是**复制**，不是链接。改原始开发目录不会生效，要改应用内副本（点「目录」打开的那个）。
> 想保留自己的开发目录做版本管理，就在改完后重新导入一次，并在列表里删掉旧的。

## 能力边界（和 Chrome 的差别）

支持：

- `content_scripts`（`js` / `css` / `matches` / `run_at`），只允许 `http(s)` 与 `*://` 通配；
- 扩展内的 `chrome.storage.local`（按店铺 Session 隔离，A 店和 B 店互不可见）；
- `chrome.runtime` 的基础消息与 `chrome.i18n`；
- `web_accessible_resources`（扩展内资源可被页面引用）。

不支持 / 会被拒绝：

- Chrome 应用商店安装、`.crx` 包（只支持解包目录）；
- `world: "MAIN"` 的内容脚本（会与应用的指纹注入互相覆盖，直接拒绝导入）；
- 以下权限任一出现即拒绝导入：`nativeMessaging`、`debugger`、`management`、`proxy`、`privacy`、`cookies`、`history`、`bookmarks`、`downloads`、`identity`、`contentSettings`、`certificateProvider`、`desktopCapture`、`pageCapture`、`tabCapture`、`ttsEngine`、`enterprise.*`；
- 注入 `file://` / `chrome-extension://` / `ftp://` 页面；
- 扩展目录里的符号链接；单个扩展超过 2000 个文件或 20MB。

## 重要：不要和指纹打架

ShopPilot 会给每个店铺注入一致的 UA / 语言 / 时区 / 屏幕 / Canvas 等指纹。如果你的插件：

- 用 `webRequest` / `declarativeNetRequest` 改 `User-Agent` 请求头；
- 在页面里重写 `navigator`、`screen`、`WebGL`、`Canvas`；

那么店铺页看到的指纹会和档案不一致（应用会在「档案校验」里如实报「未验证」，不会假通过）。这类改写请只在你确认平台能接受的范围内使用。

## 调试建议

当前版本没有给店铺页开 DevTools 的入口，推荐用页面内可见反馈调试：

- 往页面写一个带固定 id 的容器（模板里的 `#__shopilot_my_extension__`）；
- 把关键状态写到容器文本里（模板演示了「本店铺第 N 次注入」）；
- 出错时不要 `throw` 到页面，自己 try/catch 后把错误文案写进容器，避免影响平台脚本。

## 常见导入失败

| 提示 | 原因 |
| --- | --- |
| 缺少 manifest.json | 选的不是扩展根目录（manifest 必须在选中的那一层） |
| 只支持 manifest_version 2 或 3 | `manifest_version` 写成字符串或其它值 |
| 扩展名称缺失或超过 64 个字符 | `name` 为空 / 超长 / 全是控制字符 |
| 扩展版本号格式不合法 | `version` 不是 `1.0.0` 这类数字点分格式 |
| 该扩展申请了受限权限：xxx | 命中了上面的权限黑名单 |
| 暂不支持 world:"MAIN" 的内容脚本 | 把 `world` 改成默认（不写）或 `ISOLATED` |
| content_scripts 注入范围不允许 | `matches` 用了 `file://` 或其它非 http(s) 协议 |
| 扩展目录不能包含符号链接 | 目录里有快捷方式 / mklink，换成真实文件 |
