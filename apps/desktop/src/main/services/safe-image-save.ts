/**
 * 生图保存路径校验（B5，2026-10-15 审查）。
 *
 * 背景：`ai:image:save` 的 `outputPath` 由渲染层提供（验收/设计脚本直传），
 * 但此前除了补扩展名没有任何边界——等于给渲染层一个"以用户权限写任意 *.png/jpg/webp"的落盘原语，
 * 而同类导出（诊断包）早就有 `assertSafeExportPath`（仅用户目录/系统临时目录）。
 *
 * 规则与 `assertSafeExportPath`（diagnostics.ts）同源，两处差异**刻意**：
 *   · 非打包态额外放行**应用根目录**下——设计留档脚本（capture-implemented / real-ai-image-test）
 *     把截图与生成图写进仓库的 artifacts/、assets/，打包用户不受此放行影响；
 *   · 扩展名不在这里收口（调用方按 mimeType 决定并补名），只要求"补名后的路径"落在允许根内。
 *
 * 单独成模块的原因：可被单测直接导入（只依赖 electron 的 app.isPackaged/getAppPath，可 mock），
 * 不牵入 ai-handlers 的整条服务依赖链。
 */
import { app } from 'electron'
import { homedir, tmpdir } from 'os'
import { isAbsolute, resolve, sep } from 'path'

/**
 * 校验并归一化生图保存路径。不合法时抛 `AI_BAD_INPUT` 前缀的错误（IPC 层原样转码）。
 * @param rawPath 渲染层提供的输出路径（未补扩展名之前的原文）
 * @param ext 调用方决定的扩展名（不含点，如 'png'），仅用于补名与提示
 */
export function assertSafeImageSavePath(rawPath: string, ext: string): string {
  const p = String(rawPath || '').trim()
  if (!p) throw new Error('AI_BAD_INPUT: 保存路径为空')
  if (p.includes('\0')) throw new Error('AI_BAD_INPUT: 保存路径含非法字符')
  // Windows 上 '\' 与 '/' 都是分隔符，`..` 跳过段两种写法都要拦（与 assertSafeExportPath 同规则）
  if (p.split(/[\\/]+/).some(seg => seg === '..')) {
    throw new Error('AI_BAD_INPUT: 保存路径不允许包含 .. 跳过段')
  }
  if (!isAbsolute(p)) throw new Error('AI_BAD_INPUT: 保存路径必须是绝对路径')

  let target = p
  if (!new RegExp(`\\.${ext}$`, 'i').test(target)) target = `${target}.${ext}`
  const resolved = resolve(target)

  const roots = [resolve(homedir()), resolve(tmpdir())]
  if (!app.isPackaged) {
    try { roots.push(resolve(app.getAppPath())) } catch { /* 拿不到应用路径就不放行该根 */ }
  }
  const allowed = roots.some(root => {
    const cmp = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    const base = process.platform === 'win32' ? root.toLowerCase() : root
    return cmp === base || cmp.startsWith(base.endsWith(sep) ? base : base + sep)
  })
  if (!allowed) {
    throw new Error('AI_BAD_INPUT: 保存路径必须位于用户目录或系统临时目录下（开发态可写入应用目录）')
  }
  return resolved
}
