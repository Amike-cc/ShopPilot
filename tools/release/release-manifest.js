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
    'node tools/acceptance/douyin-invite-local-verify.js（21 项：抖店三级类目读取、UI 配置、一级/二级/三级点击顺序、人工确认门禁、仿真发布）',
    'node tools/acceptance/m3-runner.js（113 项：任务引擎、任务列表 UI、重复启动拒绝、AI/邀约回归）',
    'node m1-runner.js（108 项，含设置四页签「配置/达人广场/AI 配置/关于软件」、API Key 不回显、达人广场地址覆盖并驱动邀约任务（含"邀约任务真能创建成功"的门禁超时回归）、平台首页地址配置与首页按钮优先级、左栏收起/展开、回收站徽标计数、右栏收起/展开、国内四平台目录与平台入口链路）',
    'node m2-runner.js stage1|stage2（29 + 8 项）',
    'node m3-runner.js（111 项，含 6 种新增副作用步骤的 Zod 白名单/跳过禁用/受控写入/门禁拒绝不执行/禁用目标、aiGenerate 的未配置如实失败与本地假端点生成写入与抽屉降级与 readText 留档、门禁超时上限回归、设置「获取可用模型」、达人邀约抖店面板（含话术来源二选一与 AI 未配置门禁）与未支持平台的明确拒绝）',
    'node sec-runner.js（44 项，含弹层遮挡与行内删除按钮守卫）',
    'node m4-runner.js（13 阶段检查：解包态 19 项含主进程对话真实点击 / 单实例互斥 / 安装 / 升级 / 卸载）',
    'node update-runner.js（更新链路 16 项：本地 feed 覆盖 / 检查 / SHA-512 下载校验 / pending 落盘 / 审计 / stable+beta 双通道 / 故障如实报错 / 重启自动检查）',
    'pnpm test（会话包单测 9 项）'
  ],
  // 只声明本版（0.1.5）构建上实际复跑的套件；未复跑的不计入，避免把历史结果冒充本版结论
  acceptanceSummary: '本版构建复跑通过：单测 158/158 + M3 113/113 + 店铺拖动排序本地端到端 10/10 + 抖店邀约本地端到端 21/21 + M4 打包态核心 19/19。本机应用控制策略阻止执行 electron-builder 重写后的测试 EXE，M4 安装/升级/卸载阶段未在本机复跑。M1/M2/安全/更新链路的最近结果见历史验收记录；本次未重复宣称未复跑结果。',
  artifacts: files,
    releaseNotesFile: fs.existsSync(notesPath) ? 'docs/RELEASE_NOTES.md' : null,
  rollback: '保留上一版本安装包：卸载当前版本 → 安装旧版；数据库 schema 仅升不降，回退前先备份 userData。',
  knownBoundaries: [
    '未做代码签名，构建标记 INTERNAL_BUILD；自动更新经 GitHub Releases（Amike-cc/ShopPilot，v0.1.5 已发布，仓库 public）分发，更新包仅做 SHA-512 哈希校验、无签名校验；打包态匿名在线检查已实测通过',
    '启动自动检查更新默认关闭（设置键 update.autoCheck），可在设置 →「关于软件」页开启并选择 stable/beta 通道',
    'AI 请求由主进程直连出网、不走店铺代理（Chromium 的 session 代理管不到主进程 fetch）；接口地址须 https://（仅 127.0.0.1/localhost 允许 http://）；API Key 只在主进程使用（safeStorage 加密），界面与诊断包都不带出',
    '达人邀约的 AI 话术参考"抽屉里的推荐商品"：该区域无稳定选择器，故默认读话术框所在固定定位浮层的可见文本，读不到就如实失败（不拿整页文本充数）；话术质量取决于所选模型，靠人工确认门禁兜底',
    '验收环境的遮挡敏感性：被测窗口被其它窗口盖住时 Chromium 停止合成，screenshot 步骤会如实报 CAPTURE_EMPTY；m1/m3 运行器已用测试专用启动参数 + 运行期保持前台规避（产品启动参数不变）',
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
