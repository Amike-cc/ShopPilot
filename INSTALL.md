# ShopPilot - 依赖安装说明

由于遇到了 npm 权限问题，请按以下步骤手动安装依赖：

## 方法 1：使用管理员权限运行

1. 以管理员身份打开命令提示符（cmd）
2. 切换到项目目录：
   ```cmd
   cd D:\code\电商浏览器
   ```
3. 运行安装命令：
   ```cmd
   npm install
   ```

## 方法 2：清理 npm 缓存后重试

1. 打开命令提示符
2. 清理 npm 缓存：
   ```cmd
   npm cache clean --force
   ```
3. 删除可能存在的 node_modules 和 package-lock.json：
   ```cmd
   rmdir /s /q node_modules
   del package-lock.json
   ```
4. 重新安装：
   ```cmd
   npm install
   ```

## 方法 3：使用 Yarn 替代 npm

如果 npm 持续失败，可以尝试使用 yarn：

1. 全局安装 yarn（以管理员身份）：
   ```cmd
   npm install -g yarn
   ```
2. 使用 yarn 安装依赖：
   ```cmd
   yarn install
   ```

## 安装完成后

依赖安装成功后，你可以运行以下命令：

### 开发模式
```cmd
npm run dev
```

### 构建生产版本
```cmd
npm run build
```

### 运行测试
```cmd
npm test
```

## 注意事项

1. 本项目使用 Electron 30.5.1（对应 ABI 123 / Node 20.16）
2. better-sqlite3 是原生模块，已锁定 Electron 30.5.1 的预编译版本（11.10.0）
3. 若原生模块报 ABI 版本不匹配，用 prebuild-install 拉取 Electron 目标版本预编译即可，
   **无需** 本机 Visual Studio：
   ```cmd
   node_modules\.bin\prebuild-install --runtime=electron --target=30.5.1 --arch=x64
   ```

## 技术栈版本锁定

项目已锁定以下关键依赖版本（§2.1 技术选型），并通过 M0 技术验证：
- Electron: 30.5.1（ABI 123）
- Vue: 3.4.21
- TypeScript: 5.3.3
- better-sqlite3: 11.10.0

> 升级历史：初版为 Electron 28.2.3 + better-sqlite3 9.4.3，M0 验证发现
> Electron 28 的 `BrowserWindow.contentView` 与 `WebContentsView` API 尚不稳定
> （`contentView.children` getter 缺失），多标签页方案无法工作；因此升级到
> Electron 30.5.1，并同步升级到带 ABI 123 预编译的 better-sqlite3 11.10.0。
