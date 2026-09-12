# ShopPilot 电商浏览器

多店铺电商工作台（Windows 桌面应用）：每个店铺一个完全隔离的内嵌浏览器环境，配套环境指纹、代理管理、任务辅助、加密备份、应用锁与发布工程。目标平台为国内四家：拼多多 / 微信小店 / 快手小店 / 抖店（另支持"其他"自定义平台）。

## 项目状态

**版本**: v0.1.0 · **构建标签**: `INTERNAL_BUILD`（未做代码签名，§21.5）  
**里程碑**: M0 技术验证 ✅ · M1 工作台核心 ✅ · M2 环境/代理/备份 ✅ · M3 任务辅助 ✅ · M4 发布工程 ✅ · 自动更新（§21）✅  
**验收**: 258 项断言全通过（M1 80 + M2 29+8 + M3 59 + 安全 44 + M4 13 + 更新链路 16 + 单测 9），全部由脚本驱动真实应用取证，可复跑。

## 文档索引

| 文档 | 内容 |
|---|---|
| [DEVELOPMENT_SPEC.md](./DEVELOPMENT_SPEC.md) | 开发设计文档（架构 / 数据模型 / IPC 契约 / 里程碑 / 验收标准） |
| [FUNCTIONAL_SPEC.md](./FUNCTIONAL_SPEC.md) | 功能规格（MVP 9 项功能集） |
| [STATUS_REPORT.md](./STATUS_REPORT.md) | 开发状态与验收明细（含已知边界如实声明） |
| [RELEASE_NOTES.md](./RELEASE_NOTES.md) | 0.1.0 变更说明与回滚方式 |
| [INSTALL.md](./INSTALL.md) | 受限环境依赖安装说明 |
| [REVIEW.md](./REVIEW.md) | 早期审查报告（历史存档） |

## 核心能力

- **店铺隔离浏览**：一店一 `persist:store_<id>` session（Cookie/localStorage/缓存/下载互不可见），多标签 WebContentsView，关闭重开恢复标签，固定/重排/独立窗口。
- **环境指纹**：UA/UA-CH 成对改写、时区（CDP）、navigator/screen/WebGL 主世界注入，`profile:verify` 实测回填 verified/unverified；一键复制环境配置到其他店铺。
- **代理管理**：创建/批量导入/体检（延迟+状态）/绑定即时生效/周期巡检；407 认证经 safeStorage（DPAPI）注入；红线：不可用时**不自动切换、不静默降级**。
- **任务辅助**：8 种白名单步骤（导航/等待/读文本/读表格/截图/草稿填充/人工确认），状态机+失败恢复+定时调度；人工确认门禁任何面板可见；截图工件 SHA-256 入库。
- **会话与安全**：会话导出/导入加密包（scrypt+AES-256-GCM，带有效期）、Cookie 查看器、应用锁（IPC 门禁+空闲自动锁定）、审计日志全量可导出、备份（Online Backup+校验+失败回滚）、诊断包（脱敏）。
- **自动更新（§21）**：electron-updater → GitHub Releases（`Amike-cc/ShopPilot`）；stable/beta 双通道；下载完成 SHA-512 校验后重启安装；检查/下载/安装均写审计；启动自动检查可选（默认关闭）。
- **发布工程**：electron-builder NSIS（按用户安装/可选目录/卸载保留数据）、单实例互斥、按天日志 14 天保留、`release/release.json` 版本清单（SHA-256）。

## 技术栈

Electron 30.5.1（ABI 123）· Vue 3.4 + TypeScript 5.3 + Pinia · better-sqlite3 11.10（WAL）· electron-vite 2.0 · electron-builder 24.13 · electron-updater 6.6 · Vitest（单测）+ CDP 驱动验收脚本（E2E）

## 项目结构

```
├── apps/desktop/src
│   ├── main/           # 主进程：db / stores / browser / tasks / services / ipc
│   ├── preload/        # 白名单 API（contextIsolation + sandbox）
│   └── renderer/       # Vue 工作台（深色三栏 UI，§17）
├── packages/shared/    # IPC 契约、枚举、错误码、平台目录（主/渲染同源）
├── tests/unit/         # 纯逻辑单测（vitest）
├── m1-runner.js … m4-runner.js / sec-runner.js / update-runner.js   # 验收套件
└── release/            # 打包产物 + release.json 清单（不入 git）
```

## 运行与构建

```powershell
pnpm install                                  # 依赖（受限环境见 INSTALL.md）
pnpm dev                                      # 开发模式
pnpm dist                                     # 打包 → release/（NSIS + latest.yml）
node release-manifest.js                      # 生成 release/release.json 清单
.\node_modules\electron\dist\electron.exe . --no-sandbox   # 直接跑生产构建
start-shoppilot.cmd                           # 同上（快捷方式）
```

数据目录：`%APPDATA%\shopilot\`（shopilot.db / stores / backups / logs）。安装版数据在用户 AppData，卸载不删除。

## 验收（可复跑）

```powershell
pnpm exec vitest run        # 单测 9 项（会话包加解密/篡改/过期）
node update-runner.js       # 更新链路 16 项（需先 pnpm dist；本地 feed 驱动真实安装包）
node m1-runner.js           # 工作台 80 项
node m2-runner.js stage1    # 代理/备份 29 项；stage2 指纹注入 8 项
node m3-runner.js           # 任务引擎 59 项
node sec-runner.js          # 安全能力 44 项
node m4-runner.js           # 发布工程 13 阶段检查（含 NSIS 安装/升级/卸载）
pwsh -File run-acceptance.ps1   # 以上全部串行 + 打包 + 清单（一键）
```

各套件使用独立临时 userData 与 CDP 端口（9223–9228、9232、9241、9245），跑前请退出运行中的 ShopPilot 实例。

## 已知边界（如实声明，详见 STATUS_REPORT.md）

- 未做代码签名：`INTERNAL_BUILD`；自动更新仅 SHA-512 哈希校验，无签名校验；GitHub 仓库未发布 Release 时"检查更新"如实报错。
- 会话导出包仅含 Cookie + 环境配置（不含 localStorage/IndexedDB）；跨机登录态需重登或经加密包导入（DPAPI 边界）。
- 代理不可用不自动切换；任务引擎全局串行（并发=1）；跨进程原地恢复不支持。
- 备份跨机恢复的登录态路径需在第二台真机人工复核；设计稿像素级人工核对待做。
