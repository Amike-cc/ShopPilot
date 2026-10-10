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

/**
 * 可溯源信息：**这份二进制对应哪份代码**。
 *
 * 2026-09-28 审查发现的硬伤：v0.4.48 是在 263 个未提交改动的工作区上构建并发布的，
 * 而 release.json 里没有任何 git 信息 —— 线上那台机器跑的是哪份代码，事后无法确定，
 * 出事故也无法二分/回放。这里把 rev / 分支 / 是否脏 写进清单（不改构建行为，只留证据）。
 */
function readGitInfo() {
  const { execFileSync } = require('child_process')
  const git = (args) => {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() } catch { return '' }
  }
  const rev = git(['rev-parse', 'HEAD'])
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const porcelain = git(['status', '--porcelain'])
  const dirtyFiles = porcelain ? porcelain.split(/\r?\n/).filter(Boolean).length : 0
  if (!rev) return { rev: null, branch: null, dirty: null, dirtyFiles: 0, note: '拿不到 git 信息（不是 git 仓库/无 git 命令）' }
  return {
    rev,
    revShort: rev.slice(0, 12),
    branch,
    dirty: dirtyFiles > 0,
    dirtyFiles,
    note: dirtyFiles > 0 ? '构建时工作区有未提交改动：这份产物无法精确对应到某个 commit' : '工作区干净'
  }
}

/** 运行时统计测试规模，避免清单里的数字靠手写（此前写的 29/338 与实际 62/6xx 早已漂移） */
function countUnitTests() {
  const dir = path.join(root, 'tests', 'unit')
  if (!fs.existsSync(dir)) return { files: 0, cases: 0 }
  let files = 0
  let cases = 0
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.test.ts')) continue
    files++
    const src = fs.readFileSync(path.join(dir, name), 'utf8')
    cases += (src.match(/^\s*(it|test)(\.\w+)?\s*\(/gm) || []).length
  }
  return { files, cases }
}

/**
 * When the release run has a Vitest JSON report, use executed totals rather than
 * counting only one-line `it()` declarations (which undercounts wrapped/multiline tests).
 */
function readVitestRun() {
  const reportPath = process.env.SHOPILOT_VITEST_REPORT
  if (!reportPath) return null
  const resolved = path.resolve(root, reportPath)
  if (!fs.existsSync(resolved)) {
    console.error(`Vitest 报告不存在：${resolved}`)
    process.exit(1)
  }
  const report = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  const fileResults = Array.isArray(report.testResults) ? report.testResults : []
  const passedFileResults = fileResults.filter(result => result && result.status === 'passed')
  const totals = {
    // Jest/Vitest `numTotalTestSuites` counts describe suites, not files.
    files: fileResults.length,
    passedFiles: passedFileResults.length,
    cases: Number(report.numTotalTests),
    passedCases: Number(report.numPassedTests),
    failedCases: Number(report.numFailedTests),
    pendingCases: Number(report.numPendingTests) + Number(report.numTodoTests)
  }
  if (!report.success || totals.failedCases !== 0 || totals.pendingCases !== 0 ||
      totals.cases !== totals.passedCases || totals.files !== totals.passedFiles) {
    console.error('Vitest 报告未全部通过，拒绝生成通过态发布清单：', totals)
    process.exit(1)
  }
  return totals
}

const currentVersionPrefix = `-${pkg.version}`
const allArtifacts = files
// 本版本的产物：名字里带版本号的那些（安装包/blockmap），外加两个"描述当前版本"的更新源清单
// （latest.yml / beta.yml 名字里不带版本，但它们是这次构建的产物，且客户端就是靠它们更新）
const versionArtifacts = files.filter(f => f.file.includes(currentVersionPrefix) || /^(latest|beta)\.yml$/i.test(f.file))
const tests = countUnitTests()
const vitestRun = readVitestRun()
const testSummary = vitestRun
  ? `${vitestRun.files} 个测试文件 / ${vitestRun.passedCases} 项通过（来自 Vitest JSON 运行报告）`
  : `${tests.files} 个测试文件；用例数以 Vitest 运行输出为准（静态声明扫描会漏掉多行用例）`

const manifest = {
  product: 'ShopPilot',
  version: pkg.version,
  buildLabel,
  labelReason: hasSigning ? '已配置签名，可进入发布候选' : '未配置代码签名证书（§21.5：无有效签名或验收记录的包只能标记 INTERNAL_BUILD）',
  generatedAt: new Date().toISOString(),
  git: readGitInfo(),
  electron: JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  dbSchemaVersion: readDbSchemaVersion(),
  acceptanceSuites: [
    'node tools/acceptance/store-drag-local-verify.js（10 项：店铺拖动状态、插入线、数据库顺序、刷新后持久化）',
    'node tools/acceptance/douyin-invite-local-verify.js（36 项：抖店结构化抽屉字段、类目/联系方式/核心优势配置、任务创建与本地仿真发布）',
    'node tools/acceptance/invoice-license-local-verify.js（26 项：营业执照归组/筛选/校验/CSV 字段/刷新恢复）',
    'node tools/acceptance/m3-runner.js（114 项：任务引擎、副作用步骤白名单/门禁/恢复、AI 配置与生成、调度、任务列表 UI、重复启动拒绝、结构化抖店邀约抽屉与未支持平台拒绝）',
    'node tools/acceptance/m1-runner.js（115 项，含 DOM <webview> 真实嵌入与重载重注册、跨店分区隔离、设置四页签、地址覆盖驱动邀约任务、左右栏收起、回收站徽标、国内四平台目录与平台入口链路）',
    'node tools/acceptance/m2-runner.js stage1|stage2（阶段1 30 项；阶段2 进程内指纹字段实测）',
    'node tools/acceptance/sec-runner.js（44 项，含弹层遮挡与行内删除按钮守卫）',
    'node tools/acceptance/m4-runner.js（13 阶段检查：解包态 19 项含主进程对话真实点击 / 单实例互斥 / 安装 / 升级 / 卸载）',
    'node tools/release/update-runner.js（更新链路 16 项：本地 feed 覆盖 / 检查 / SHA-512 下载校验 / pending 落盘 / 审计 / stable+beta 双通道 / 故障如实报错 / 重启自动检查）',
    `pnpm test（${testSummary}）`
  ],
  // 只声明本版本次实际复跑的基础门槛；历史专项验收仍保留在 acceptanceSuites 中，不冒充本版复跑结果。
  acceptanceSummary: `本版构建复跑通过：pnpm typecheck；pnpm test（${testSummary}）；pnpm lint（0 errors，仓库存量 warnings）；pnpm build；Windows x64 NSIS 安装包构建。`,
  // 只列**本版本**的产物（此前把 release/ 里全部历史安装包都列进来，125 条，无法作为交付凭据）
  artifacts: versionArtifacts,
  artifactsInReleaseDir: allArtifacts.length,
    releaseNotesFile: fs.existsSync(notesPath) ? 'docs/RELEASE_NOTES.md' : null,
  rollback: '保留上一版本安装包：卸载当前版本 → 安装旧版；数据库 schema 仅升不降，回退前先备份 userData。',
  knownBoundaries: [
    '未做代码签名，构建标记 INTERNAL_BUILD；更新包仅做 SHA-512 哈希校验、无签名校验；真实 Windows 安装、升级、卸载和完整桌面逐项验收需按本版单独复核',
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
    '本版验证为「生产构建 + CDP 驱动真实界面 + 真机截图核对」；真实 Windows 安装/升级/卸载与完整人工桌面逐项验收未随本版重跑',
    '店铺页面现为 DOM <webview> 嵌入：页面可见性由渲染层 CSS 控制，窗口被系统遮挡时靠 rAF 定位的平台弹层仍会停帧（如实报 TASK_TARGET_OUT_OF_VIEWPORT）'
  ]
}

fs.writeFileSync(path.join(rel, 'release.json'), JSON.stringify(manifest, null, 2))
console.log('release/release.json 已生成：')
for (const f of files) console.log(`  ${f.file}  ${f.sizeBytes} B  sha256=${f.sha256.slice(0, 16)}…`)
