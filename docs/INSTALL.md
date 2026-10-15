# ShopPilot - 依赖安装说明

## 环境要求

- Windows x64（本项目以 Windows 为发布目标）
- Node.js 22（CI 固定 22；本机 22.x 即可）
- **pnpm 10.34.7**：根 package.json 已用 `packageManager` 字段锁定，corepack 会自动使用该版本。
  若 corepack 未生效：`corepack prepare pnpm@10.34.7 --activate`。
  （2026-10-15 审查实测：本机曾装的 pnpm 12.3.4 在此环境存在"install 报告成功但不创建顶层
  symlink"的系统级问题，故与 CI 统一锁到 pnpm 10。）
- Visual Studio 2022 Build Tools，含「使用 C++ 的桌面开发」工作负载（better-sqlite3 需本地编译）

## 安装

```cmd
pnpm install
```

安装会自动完成三件事（见 `tools/maintenance/postinstall-native.mjs`）：

1. 依赖链接（pnpm 10 隔离布局）；
2. 依赖包构建脚本（better-sqlite3 本地编译，需要 VS 工具链）；
3. postinstall：补齐 **electron 运行时二进制**（electron ≥ 44 起不再自带下载脚本）+
   按 Electron ABI 重建原生模块（electron-builder 的 install-app-deps）。

## 网络受限时的加速

- **Electron 二进制**：默认从 GitHub Releases 下载（国内可能极慢）。设置镜像后重跑安装：
  ```cmd
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  pnpm install
  ```
- electron 与 node-gyp 的缓存分别在 `%LOCALAPPDATA%\electron\Cache`、`%LOCALAPPDATA%\node-gyp\Cache`；
  删除对应缓存可强制重新下载。

## 原生模块与 ABI（常见故障）

- better-sqlite3 13.x 为跨平台预编译（N-API）：同一份二进制在 Node 与 Electron 下都可用，
  不需要手工对齐 ABI；打包时 electron-builder 仍会按 electron 版本重建。
- 若编译报 `Could not find any Visual Studio installation` 或
  `could not use PowerShell to find Visual Studio`（node-gyp 在部分环境探测失败）：
  改用「VS 2022 开发人员命令提示符」执行，或在普通终端先设置下列变量（等价于开发人员命令提示符）：
  ```cmd
  set VCINSTALLDIR=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC
  set VSCMD_VER=17.14.37628.2
  set WindowsSDKVersion=10.0.26100.0
  pnpm install
  ```

## 安装完成后

| 用途 | 命令 |
| --- | --- |
| 开发模式 | `pnpm dev` |
| 构建 | `pnpm build` |
| 单测 | `pnpm test` |
| 打包（NSIS 安装包） | `pnpm run dist` |
| 仅打包目录（快） | `pnpm run dist:dir` |
| 重建原生模块 | `pnpm run rebuild:native` |

## 技术栈版本（2026-10-15 安全升级后）

| 依赖 | 版本 |
| --- | --- |
| Electron | **44.7.2** |
| electron-builder | **26.15.3** |
| electron-vite | **6.0.0** |
| Vite | **7.3.7** |
| Vitest | **5.0.4** |
| Vue / vue-router / Pinia | 3.4.21 / 4.3.0 / 2.1.7 |
| TypeScript | 5.3.3 |
| better-sqlite3 | **13.0.3** |
| pnpm | 10.34.7（packageManager 锁定） |

> 升级历史：初版 Electron 28.2.3（`contentView`/`WebContentsView` 不稳定）→ 30.5.1；
> 2026-10-15 安全审查（Electron 30 已 EOL 两年、全仓 86 条依赖漏洞）升级到 Electron 44.7.2
> + electron-builder 26 + Vite 7 + Vitest 5，并引入 postinstall 的运行时/原生模块自愈。
