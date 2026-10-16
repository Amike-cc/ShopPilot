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
import { existsSync, realpathSync, statSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'

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
  let physical = resolved
  try {
    let parent = resolved
    const suffix: string[] = []
    while (!existsSync(parent)) {
      const next = resolve(parent, '..')
      if (next === parent) break
      suffix.unshift(parent.slice(next.length + 1))
      parent = next
    }
    if (existsSync(parent)) physical = resolve(realpathSync.native(parent), ...suffix)
  } catch { throw new Error('AI_BAD_INPUT: 保存路径无法解析') }

  const roots = [resolve(homedir()), resolve(tmpdir())]
  if (!app.isPackaged) {
    try { roots.push(resolve(app.getAppPath())) } catch { /* 拿不到应用路径就不放行该根 */ }
  }
  const allowed = roots.some(root => {
    const cmp = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    const base = process.platform === 'win32' ? root.toLowerCase() : root
    const physicalCmp = process.platform === 'win32' ? physical.toLowerCase() : physical
    const rel = relative(base, physicalCmp)
    return (cmp === base || cmp.startsWith(base.endsWith(sep) ? base : base + sep)) &&
      (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
  })
  if (!allowed) {
    throw new Error('AI_BAD_INPUT: 保存路径必须位于用户目录或系统临时目录下（开发态可写入应用目录）')
  }
  return resolved
}

/**
 * 校验渲染层要求文件管理器定位的图片路径。
 *
 * reveal 不是写盘操作，但 `shell.showItemInFolder` 同样会把一个任意路径
 * 交给操作系统。只允许应用可写的用户/临时根目录，并解析最终真实路径，
 * 防止用户目录里的 junction/symlink 把定位请求带到任意盘符。
 */
export function assertSafeImageRevealPath(rawPath: string): string {
  const p = String(rawPath || '').trim()
  if (!p) throw new Error('AI_BAD_INPUT: 文件路径为空')
  if (p.includes('\0') || p.split(/[\\/]+/).some(seg => seg === '..')) {
    throw new Error('AI_BAD_INPUT: 文件路径含非法跳过段')
  }
  if (!isAbsolute(p)) throw new Error('AI_BAD_INPUT: 文件路径必须是绝对路径')
  if (!existsSync(p)) throw new Error('AI_IMAGE_NOT_FOUND: 文件不存在，可能已被移动或删除')
  let physical: string
  try {
    physical = realpathSync.native(p)
    if (!statSync(physical).isFile()) throw new Error('AI_IMAGE_NOT_FOUND: 目标不是文件')
  } catch (error) {
    if (String((error as Error)?.message || error).startsWith('AI_IMAGE_NOT_FOUND')) throw error
    throw new Error('AI_IMAGE_NOT_FOUND: 文件不存在，可能已被移动或删除')
  }

  const roots = [resolve(homedir()), resolve(tmpdir())]
  if (!app.isPackaged) {
    try { roots.push(resolve(app.getAppPath())) } catch { /* 开发路径不可用时不放行 */ }
  }
  const inside = roots.some(root => {
    const cmp = process.platform === 'win32' ? physical.toLowerCase() : physical
    const base = process.platform === 'win32' ? root.toLowerCase() : root
    const rel = relative(base, cmp)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
  if (!inside) throw new Error('AI_BAD_INPUT: 文件路径必须位于用户目录或系统临时目录下（开发态可定位应用目录）')
  return physical
}
