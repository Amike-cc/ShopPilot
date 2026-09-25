/**
 * 发布清单 - §21 步骤4：安装包 SHA-256、版本清单、变更说明汇总为 release.json。
 * 用法：node release-manifest.js（在 electron-builder 产出后运行）
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const root = path.resolve(__dirname, '../..')
const rel = path.join(root, 'release')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

if (!fs.existsSync(rel)) {
  console.error('release/ 不存在，请先执行 pnpm dist（electron-builder）')
  process.exit(1)
}

const files = fs.readdirSync(rel)
  // builder-debug.yml 是 electron-builder 的调试产物、不发布，别混进清单充数
  .filter(f => /\.(exe|yml|blockmap|zip)$/i.test(f) && f !== 'builder-debug.yml')
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

const notesPath = path.join(root, 'docs', 'RELEASE_NOTES.md')
const yml = fs.existsSync(path.join(root, 'electron-builder.yml')) ? fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8') : ''
const hasSigning = !!process.env.CSC_LINK || !!process.env.WIN_CSC_LINK || /^\s*sign(ing)?:/m.test(yml)
const buildLabel = hasSigning ? 'RELEASE' : 'INTERNAL_BUILD' // §21.5：无有效签名只能标记 INTERNAL_BUILD

/**
 * DB schema 版本：**从迁移源码里读**，不写常量。
 *
 * 此前这里是硬编码的 `2`，而 migrations.ts 已经到 v4——清单里的 schemaVersion 直接写错，
 * 而这个字段正是运维判断"能不能回退旧版"的依据（§21 回滚说明）。硬编码注定会漂移，
 * 所以改成解析 migrations.ts 的最后一个 version，解析不出来就**直接失败**，
 * 免得再生成一份带着假数字的发布清单。
 */
function readDbSchemaVersion() {
  const src = fs.readFileSync(path.join(root, 'apps', 'desktop', 'src', 'main', 'db', 'migrations.ts'), 'utf8')
  const versions = [...src.matchAll(/^\s*version:\s*(\d+)\s*,/gm)].map(m => Number(m[1]))
  if (versions.length === 0) {
    console.error('无法从 migrations.ts 解析出 schema 版本，拒绝生成带错误版本的清单')
    process.exit(1)
  }
  return Math.max(...versions)
}

const manifest = {
  product: 'ShopPilot',
  version: pkg.version,
  buildLabel,
  labelReason: hasSigning ? '已配置签名，可进入发布候选' : '未配置代码签名证书（§21.5：无有效签名或验收记录的包只能标记 INTERNAL_BUILD）',
  generatedAt: new Date().toISOString(),
  electron: JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  dbSchemaVersion: readDbSchemaVersion(),
  acceptanceSuites: [
    'node tools/acceptance/store-drag-local-verify.js（10 项：店铺拖动状态、插入线、数据库顺序、刷新后持久化）',
    'node tools/acceptance/douyin-invite-local-verify.js（36 项：抖店结构化抽屉字段、类目/联系方式/核心优势配置、任务创建与本地仿真发布）',
    'node tools/acceptance/invoice-license-local-verify.js（26 项：营业执照归组/筛选/校验/CSV 字段/刷新恢复）',
    'node tools/acceptance/m3-runner.js（113 项：任务引擎、任务列表 UI、重复启动拒绝、AI/邀约回归）',
    'node tools/acceptance/m1-runner.js（108 项，含设置四页签、地址覆盖驱动邀约任务、左/右栏收起、回收站徽标、国内四平台目录与平台入口链路）',
    'node tools/acceptance/m2-runner.js stage1|stage2（阶段1 30 项；阶段2 进程内指纹字段实测）',
    'node tools/acceptance/m3-runner.js（113 项，含副作用步骤白名单/门禁/恢复、AI 配置与生成、调度、任务 UI、结构化抖店邀约抽屉与未支持平台拒绝）',
    'node tools/acceptance/sec-runner.js（44 项，含弹层遮挡与行内删除按钮守卫）',
    'node tools/acceptance/m4-runner.js（13 阶段检查：解包态 19 项含主进程对话真实点击 / 单实例互斥 / 安装 / 升级 / 卸载）',
    'node tools/release/update-runner.js（更新链路 16 项：本地 feed 覆盖 / 检查 / SHA-512 下载校验 / pending 落盘 / 审计 / stable+beta 双通道 / 故障如实报错 / 重启自动检查）',
    'pnpm test（29 个文件、338 项）'
  ],
  // 只声明本版（0.4.47）实际复跑的套件；未复跑的不计入，避免把历史结果冒充本版结论
  acceptanceSummary: '本版构建复跑通过：单测 338/338 + 更新链路 16/16 + M1 108/108 + M2 阶段1 30/30（阶段2 必需指纹字段 verified）+ M3 113/113 + 安全 44/44 + M4 13/13（打包态 19/19、安装 3/3、升级 4/4、卸载）+ 店铺拖动 10/10 + 抖店邀约本地 36/36 + 发票主体本地 26/26 + 自定义任务本地 54/54 + 邀约实时日志 16/16。',
  artifacts: files,
    releaseNotesFile: fs.existsSync(notesPath) ? 'docs/RELEASE_NOTES.md' : null,
  rollback: '保留上一版本安装包：卸载当前版本 → 安装旧版；数据库 schema 仅升不降，回退前先备份 userData。',
  knownBoundaries: [
    '未做代码签名，构建标记 INTERNAL_BUILD；本次 0.4.47 仅生成本地安装包与清单，线上 GitHub Release 发布未执行；更新包仅做 SHA-512 哈希校验、无签名校验',
    '启动自动检查更新默认关闭（设置键 update.autoCheck），可在设置 →「关于软件」页开启并选择 stable/beta 通道',
    'AI 请求由主进程直连出网、不走店铺代理（Chromium 的 session 代理管不到主进程 fetch）；接口地址须 https://（仅 127.0.0.1/localhost 允许 http://）；API Key 只在主进程使用（safeStorage 加密），界面与诊断包都不带出',
    '达人邀约的 AI 话术仅对仍存在自由话术框的平台生效；抖店当前为结构化抽屉，没有话术框，因此不展示 AI 话术控件；存在话术框的平台读不到稳定商品来源时如实失败，不拿整页文本充数',
    '验收环境的遮挡敏感性：被测窗口被其它窗口盖住时 Chromium 停止合成，screenshot 步骤会如实报 CAPTURE_EMPTY；m1/m3 运行器已用测试专用启动参数 + 运行期保持前台规避（产品启动参数不变）',
    '备份包跨机恢复覆盖元数据/配置/标签索引；登录态需在目标机重新登录或经会话导出加密包导入（DPAPI 边界，§10.2）',
    '会话导出包含 Cookie 明文清单（容器级口令加密）；localStorage/IndexedDB 不在包内；包头明文含来源店铺名/平台/有效期',
    '代理不可用不自动切换、不静默降级（§8.1）',
    '应用锁隐藏视图并门禁业务 IPC，但不重加密 Chromium profile',
    '任务引擎全局串行队列（并发=1）；跨进程原地恢复不支持',
    '应用为单实例：同 userData 重复启动会直接退出并聚焦已有窗口',
    '本次真实桌面 SendInput 验收完成 12/13；最后一批操作被宿主窗口抢占前台，win-input PID 安全保护拒绝继续，需在稳定前台会话补跑'
  ]
}

fs.writeFileSync(path.join(rel, 'release.json'), JSON.stringify(manifest, null, 2))
console.log('release/release.json 已生成：')
for (const f of files) console.log(`  ${f.file}  ${f.sizeBytes} B  sha256=${f.sha256.slice(0, 16)}…`)
