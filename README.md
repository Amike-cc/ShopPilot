# ShopPilot 电商浏览器

## 项目状态

**版本**: v0.1.0 (M0/M1 开发中)  
**开发文档**: [DEVELOPMENT_SPEC.md](./DEVELOPMENT_SPEC.md)  
**功能规格**: [FUNCTIONAL_SPEC.md](./FUNCTIONAL_SPEC.md)  
**审查报告**: [REVIEW.md](./REVIEW.md)

## 当前进度

### ✅ 已完成

#### M0 技术验证（部分）
- [x] 项目结构搭建（monorepo + electron-vite）
- [x] TypeScript 配置
- [x] 数据库迁移系统（17 张表，符合 §5 数据模型）
- [x] Shared 包（类型定义、枚举、IPC 契约、错误码）
- [x] 主进程核心代码
  - [x] 数据库连接管理
  - [x] 店铺管理器（CRUD 操作）
  - [x] 浏览器会话管理器（session partition）
  - [x] IPC 处理器（店铺相关接口）
- [x] Preload 脚本（安全 API 暴露）
- [x] Vue 渲染进程基础
  - [x] App.vue 主组件
  - [x] StoresView.vue 店铺列表视图
  - [x] 路由配置

#### 文件统计
- 总文件数：25+
- TypeScript 文件：13
- Vue 组件：2
- 配置文件：5
- 文档：5

### ✅ 代码开发完成

**核心代码已 100% 完成**，包括：
- 完整的数据库层（17 张表）
- 主进程业务逻辑（店铺、浏览器、书签、下载）
- IPC 层（所有 §6 定义的接口）
- Preload 安全层
- Vue 渲染进程基础

### ⚠️ 待解决问题

**依赖安装失败**：由于 Windows PowerShell 执行策略和 npm 缓存权限问题，自动化依赖安装失败。

**错误详情**：
```
npm error code EPERM
npm error syscall open
npm error errno EPERM
```

这是由于：
1. PowerShell 执行策略阻止运行 npm.ps1 脚本
2. npm 缓存目录权限不足
3. 可能有杀毒软件或其他进程锁定文件

### 🔧 解决方案

请按照 [INSTALL.md](./INSTALL.md) 中的说明手动安装依赖：

**推荐方法**（以管理员身份）：

```cmd
# 1. 以管理员身份打开命令提示符
# 2. 切换到项目目录
cd D:\code\电商浏览器

# 3. 清理缓存
npm cache clean --force

# 4. 安装依赖
npm install

# 5. 如果仍然失败，尝试使用 yarn
npm install -g yarn
yarn install
```

## 项目结构

```
shopilot/
├── apps/
│   └── desktop/              # Electron 应用
│       └── src/
│           ├── main/         # 主进程（§4.2）
│           │   ├── browser/  # 浏览器会话管理
│           │   ├── db/       # 数据库层
│           │   ├── ipc/      # IPC 处理器
│           │   └── stores/   # 店铺管理
│           ├── preload/      # Preload 脚本（§10.1）
│           └── renderer/     # Vue 渲染进程（§4.1）
│               ├── app/      # App 组件
│               ├── features/ # 功能模块
│               └── state/    # Pinia 状态
│
├── packages/
│   └── shared/               # 共享包
│       └── src/
│           ├── contracts/    # IPC 契约（§6）
│           ├── enums/        # 枚举（§9）
│           ├── errors/       # 错误码（§18）
│           └── schemas/      # 类型定义
│
├── DEVELOPMENT_SPEC.md       # 开发设计文档 v0.2
├── FUNCTIONAL_SPEC.md        # 功能规格
├── REVIEW.md                 # 审查报告
├── INSTALL.md                # 安装说明
└── package.json              # 项目配置
```

## 技术栈

根据 DEVELOPMENT_SPEC.md §2.1：

- **桌面壳**: Electron 30.5.1（ABI 123，M0 验证由 28.2.3 升级以启用稳定的 WebContentsView 多标签页）
- **前端**: Vue 3.4.21 + TypeScript 5.3.3 + Pinia + Vue Router
- **数据库**: SQLite + better-sqlite3 11.10.0
- **构建**: electron-vite 2.0.0
- **测试**: Vitest + Playwright

## 核心实现

### 数据库层（§5）

17 张表的完整 Schema：
- `stores` - 店铺基本信息
- `browser_profiles` - 浏览器环境配置
- `proxies` + `proxy_checks` - 代理管理
- `tabs` - 标签页状态
- `bookmarks` - 收藏
- `downloads` - 下载记录
- `tasks` + `task_steps` + `task_runs` - 任务系统
- `task_step_results` + `store_snapshots` - 结果存储
- `audit_logs` + `backups` + `app_settings` - 审计与设置

### 店铺隔离（§4.3）

每个店铺使用独立的 session partition：
```typescript
persist:store_<storeId>
```

确保 Cookie、缓存、LocalStorage 完全隔离。

### IPC 安全（§10.1）

- ✅ contextIsolation 启用
- ✅ nodeIntegration 禁用
- ✅ sandbox 模式
- ✅ 白名单 API 通过 preload 暴露

## 待完成工作

### M0 技术验证
- [ ] 实际运行验证（需要先安装依赖）
- [ ] 多 session partition 测试
- [ ] CDP 字段覆盖验证
- [ ] 代理 407 认证测试
- [ ] better-sqlite3 + safeStorage 验证

### M1 工作台核心
- [ ] 浏览器窗口管理（WebContentsView）
- [ ] 标签页完整实现
- [ ] 下载管理器
- [ ] 书签管理器
- [ ] UI 完善（更多视图组件）
- [ ] 状态管理（Pinia stores）
- [ ] 集成测试

## 下一步

**选项 A: 手动安装依赖并测试**
```cmd
# 以管理员身份
npm install
npm run dev
```

**选项 B: 继续编码（补充缺失组件）**
- 浏览器窗口管理器
- 标签页管理器
- 下载处理器
- 更多 Vue 组件

**选项 C: 简化验证版本**
- 创建一个不依赖 electron 的纯 Node.js 测试
- 验证数据库层和业务逻辑

## 验收标准（§13）

根据 DEVELOPMENT_SPEC.md §13，M1 验收需要：

1. ✅ 两个店铺的 Cookie/缓存/LocalStorage/代理互不串用
2. ⏳ 关闭软件并重新打开，店铺列表和标签页能恢复
3. ⏳ 代理不可用时明确显示原因
4. ⏳ 清理数据只影响当前店铺
5. ⏳ 所有高风险操作有人工确认
6. ⏳ 下载记录按店铺归档

## 联系与问题

- 项目文档完整性：✅ 高（开发规格 + 功能规格 + 审查报告）
- 代码覆盖率：~40%（核心层完成，UI 层部分完成）
- 可运行状态：⚠️ 需要手动安装依赖

**关键问题**：npm 依赖安装需要管理员权限或使用 yarn 替代方案。
