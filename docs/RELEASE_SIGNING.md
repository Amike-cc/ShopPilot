# Windows 代码签名（发布链）配置就绪说明

> 状态：**配置与流程已就绪，证书未采购/未配置**——当前发布产物仍是 `INTERNAL_BUILD`（无签名）。
> 本文是执行清单，不代表已经签名。相关配置：`electron-builder.yml` 的 `win` 段。

## 1. 为什么必须做

| 风险 | 现状 | 签名后 |
|---|---|---|
| Windows SmartScreen / 杀软拦截 | 未签名安装包首次运行普遍弹"未知发布者"，企业环境可能直接拦 | 受信任证书 + 稳定签名主体后逐步建立信誉 |
| 自动更新完整性 | `electron-updater` 只校验 `latest.yml` 里的 SHA-512；**不校验 Authenticode 签名**。若发布源（GitHub 账号/Token）被控，攻击者可同时替换安装包与哈希 | 签名主体可在更新前被系统/工具校验，降低供应链风险 |
| 溯源 | 无法证明 exe 由本项目构建 | 签名时间戳 + 主体可审计 |

> 说明：electron-updater 当前不做签名校验，"已签名"不会自动让更新链变安全；仍需保护 GitHub 发布权限（`release:full` 依赖本机 Git Credential Manager）。签名是本项目从 `INTERNAL_BUILD` 走向正式发布的最低门槛。

## 2. 方案

### 方案 A（推荐起步）：PFX 代码签名证书 + 环境变量

Electron-builder 26 在检测到证书环境变量时会自动调用 `signtool` 签名，**无需改代码**：

| 环境变量 | 说明 |
|---|---|
| `WIN_CSC_LINK`（或 `CSC_LINK`） | 证书来源：`.pfx` 的 base64（CI secret）或本机绝对路径 |
| `WIN_CSC_KEY_PASSWORD`（或 `CSC_KEY_PASSWORD`） | 证书密码 |
| `CSC_TIMESTAMP_URL`（可选） | 时间戳服务地址（默认 electron-builder 内置） |

对应 `electron-builder.yml` 已显式设置：

```yaml
win:
  # 未配置证书时保持可构建（INTERNAL_BUILD）；配置 CSC_LINK 后自动签名。
  forceCodeSigning: false
```

发布时在 CI 或本机注入上述环境变量后执行 `pnpm dist` 即产出已签名安装包；本地无证书时行为不变（不签名、不阻塞）。

### 方案 B（后续）：Azure Trusted Signing / 云签名

- 优点：私钥不落地、签名主体可长期维护、CI 友好；适合团队化发布。
- 现状：当前 `app-builder-lib@26.15.3` 的 Windows 配置里**没有** `azureSignOptions` 类型（已核对 `node_modules` 类型定义），不能直接开箱使用。
- 接入方式（待采购后）：在 `win.sign` 自定义钩子（`tools/release/sign-win.js`）里调用 Azure Trusted Signing 客户端对 `release/win-unpacked/ShopPilot.exe` 签名，或升级到内建支持的 electron-builder 版本后再切配置。

## 3. CI 配置清单（使用 GitHub Actions 时）

1. 仓库 Settings → Secrets and variables → Actions 增加：
   - `WIN_CSC_LINK`：pfx 的 base64（`certutil -encode` 或 `base64 -w0`）
   - `WIN_CSC_KEY_PASSWORD`：证书密码
2. 发布 job 的环境变量里透传上述 secret（**绝不写入仓库、绝不打印**）；
3. 发布产物上传前用 `signtool verify /pa /v release/win-unpacked/ShopPilot.exe` 校验，失败即阻断发布；
4. `release/release.json` 清单与 GitHub Release 资产保持一一对应（现有 `tools/release/release-manifest.js` 逻辑）。

## 4. 验收命令

```powershell
# 1) 确认 exe 已签名（需要 Windows SDK 的 signtool）
signtool verify /pa /v release\win-unpacked\ShopPilot.exe

# 2) 查看签名主体与时间戳
Get-AuthenticodeSignature release\win-unpacked\ShopPilot.exe | Format-List Status, SignerCertificate, TimeStamperCertificate

# 3) 安装包同名验证
Get-AuthenticodeSignature release\ShopPilot-Setup-<version>.exe | Format-List Status
```

预期：`Status = Valid`，`SignerCertificate.Subject` 与证书主体一致，`TimeStamperCertificate` 非空。

## 5. 发布 Checklist（新增项）

- [ ] 证书/云签名凭据已注入构建环境（未配置时本项不适用，发布说明必须写明"未签名 INTERNAL_BUILD"）
- [ ] `signtool verify` 通过
- [ ] `release.json` 的 SHA-256 与新产物一致
- [ ] 自动更新演练（stable/beta 各一次）
- [ ] 发布说明如实标注签名状态

## 6. 当前状态（如实声明）

- v0.4.75 及之前版本：**未签名**，`INTERNAL_BUILD`；
- `pnpm dist` 在未配置证书时照常出包（`forceCodeSigning: false`），不会因缺少证书失败；
- 本文档不包含任何证书、密码或密钥；采购/申请证书属于外部依赖，完成前该项保持未完成。
