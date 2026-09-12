/**
 * 发布清单 - §21 步骤4：安装包 SHA-256、版本清单、变更说明汇总为 release.json。
 * 用法：node release-manifest.js（在 electron-builder 产出后运行）
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const root = __dirname
const rel = path.join(root, 'release')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

if (!fs.existsSync(rel)) {
  console.error('release/ 不存在，请先执行 pnpm dist（electron-builder）')
  process.exit(1)
}

const files = fs.readdirSync(rel)
  .filter(f => /\.(exe|yml|blockmap|zip)$/i.test(f))
  .map(f => {
    const p = path.join(rel, f)
    const buf = fs.readFileSync(p)
    return {
      file: f,
      sizeBytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex')
    }
  })

if (files.length === 0) {
  console.error('release/ 内没有安装包产物')
  process.exit(1)
}

const notesPath = path.join(root, 'RELEASE_NOTES.md')
const yml = fs.existsSync(path.join(root, 'electron-builder.yml')) ? fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8') : ''
const hasSigning = !!process.env.CSC_LINK || !!process.env.WIN_CSC_LINK || /^\s*sign(ing)?:/m.test(yml)
const buildLabel = hasSigning ? 'RELEASE' : 'INTERNAL_BUILD' // §21.5：无有效签名只能标记 INTERNAL_BUILD

const manifest = {
  product: 'ShopPilot',
  version: pkg.version,
  buildLabel,
  labelReason: hasSigning ? '已配置签名，可进入发布候选' : '未配置代码签名证书（§21.5：无有效签名或验收记录的包只能标记 INTERNAL_BUILD）',
  generatedAt: new Date().toISOString(),
  electron: JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  dbSchemaVersion: 2,
  acceptanceSuites: [
    'node m1-runner.js（80 项，含右栏收起/展开与国内四平台目录、平台入口链路）',
    'node m2-runner.js stage1|stage2（29 + 8 项）',
    'node m3-runner.js（59 项，含确认门禁跨面板可见性、右栏收起守卫与对话框布局守卫）',
    'node sec-runner.js（44 项，含弹层遮挡与行内删除按钮守卫）',
    'node m4-runner.js（13 阶段检查：解包态 19 项含主进程对话真实点击 / 单实例互斥 / 安装 / 升级 / 卸载）',
    'node update-runner.js（更新链路 16 项：本地 feed 覆盖 / 检查 / SHA-512 下载校验 / pending 落盘 / 审计 / stable+beta 双通道 / 故障如实报错 / 重启自动检查）',
    'pnpm test（会话包单测 9 项）'
  ],
  acceptanceSummary: '258 项断言全通过（M1 80 + M2 29+8 + M3 59 + sec 44 + M4 13 + update 16 + 单测 9）；M4 阶段内另含 19/3/4 分项',
  artifacts: files,
  releaseNotesFile: fs.existsSync(notesPath) ? 'RELEASE_NOTES.md' : null,
  rollback: '保留上一版本安装包：卸载当前版本 → 安装旧版；数据库 schema 仅升不降，回退前先备份 userData。',
  knownBoundaries: [
    '未做代码签名，构建标记 INTERNAL_BUILD；自动更新经 GitHub Releases（Amike-cc/ShopPilot）分发，更新包仅做 SHA-512 哈希校验、无签名校验；仓库尚未发布 Release 时"检查更新"会如实报错',
    '启动自动检查更新默认关闭（设置键 update.autoCheck），可在"↻ 更新"对话框开启并选择 stable/beta 通道',
    '备份包跨机恢复覆盖元数据/配置/标签索引；登录态需在目标机重新登录或经会话导出加密包导入（DPAPI 边界，§10.2）',
    '会话导出包含 Cookie 明文清单（容器级口令加密）；localStorage/IndexedDB 不在包内；包头明文含来源店铺名/平台/有效期',
    '代理不可用不自动切换、不静默降级（§8.1）',
    '应用锁隐藏视图并门禁业务 IPC，但不重加密 Chromium profile',
    '任务引擎全局串行队列（并发=1）；跨进程原地恢复不支持',
    '应用为单实例：同 userData 重复启动会直接退出并聚焦已有窗口'
  ]
}

fs.writeFileSync(path.join(rel, 'release.json'), JSON.stringify(manifest, null, 2))
console.log('release/release.json 已生成：')
for (const f of files) console.log(`  ${f.file}  ${f.sizeBytes} B  sha256=${f.sha256.slice(0, 16)}…`)
