/**
 * 本地解包扩展的 manifest 校验（纯函数，便于单测）。
 *
 * 安全边界（2026-10-17 设计稿）：
 *   · 只接受 http/https 页面注入，拒绝 file://、chrome-extension://、ftp://；
 *   · 硬阻断可越权/越界的权限（原生消息、调试器、代理、Cookie、下载、身份等）；
 *   · MVP 拒绝 world:"MAIN" 内容脚本 —— 主世界脚本会与指纹注入互相覆盖。
 *
 * 文件数量/总大小/符号链接/路径穿越由 extension-manager 在复制阶段检查。
 */

export interface NormalizedExtensionManifest {
  name: string
  version: string
  manifestVersion: 2 | 3
  permissions: string[]
  hostPermissions: string[]
  /** 仅用于界面展示（是否声明了会改请求头的权限） */
  requestsHeaders: boolean
}

export type ManifestValidation =
  | { ok: true; manifest: NormalizedExtensionManifest }
  | { ok: false; code: string; message: string }

/** 出现即拒绝导入：这些权限能碰到宿主/凭据/文件系统，超出“页面内插件”的边界。 */
export const BLOCKED_EXTENSION_PERMISSIONS: ReadonlySet<string> = new Set([
  'nativeMessaging',
  'debugger',
  'management',
  'proxy',
  'privacy',
  'cookies',
  'history',
  'bookmarks',
  'downloads',
  'identity',
  'contentSettings',
  'certificateProvider',
  'desktopCapture',
  'pageCapture',
  'tabCapture',
  'ttsEngine',
  'enterprise.deviceAttributes',
  'enterprise.hardwarePlatform',
  'enterprise.networkingAttributes',
  'enterprise.platformKeys'
])

const PERMISSION_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const VERSION_PATTERN = /^\d{1,4}(\.\d{1,4}){0,3}$/

function fail(code: string, message: string): ManifestValidation {
  return { ok: false, code, message }
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let name = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    if ((code >= 0 && code <= 31) || code === 127) continue
    name += char
  }
  name = name.trim()
  return name.length >= 1 && name.length <= 64 ? name : null
}

function stringArray(value: unknown, max: number): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > 256) return null
    out.push(trimmed)
    if (out.length > max) return null
  }
  return out
}

/** 注入范围：只允许 http/https/通配；显式 file/chrome/ftp 一律拒绝。 */
export function isAllowedInjectionPattern(pattern: string): boolean {
  const p = pattern.trim().toLowerCase()
  if (!p) return false
  if (p === '<all_urls>') return true
  if (p.startsWith('http://') || p.startsWith('https://')) return true
  if (p === '*://*/*') return true
  // 形如 *://*.example.com/*
  if (/^\*:\/\/([a-z0-9*.-]+)\/.*$/.test(p)) return true
  return false
}

export function validateExtensionManifest(raw: unknown): ManifestValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('EXTENSION_INVALID', 'manifest.json 不是合法的 JSON 对象')
  }
  const manifest = raw as Record<string, unknown>
  const manifestVersion = Number(manifest.manifest_version)
  if (manifestVersion !== 2 && manifestVersion !== 3) {
    return fail('EXTENSION_INVALID', '只支持 manifest_version 2 或 3')
  }
  const name = cleanName(manifest.name)
  if (!name) return fail('EXTENSION_INVALID', '扩展名称缺失或超过 64 个字符')
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : ''
  if (!VERSION_PATTERN.test(version)) {
    return fail('EXTENSION_INVALID', '扩展版本号格式不合法（例：1.0.0）')
  }

  const permissions = stringArray(manifest.permissions, 64)
  const optionalPermissions = stringArray(manifest.optional_permissions, 64)
  const hostPermissions = stringArray(manifest.host_permissions, 64)
  const optionalHostPermissions = stringArray(manifest.optional_host_permissions, 64)
  if (!permissions || !optionalPermissions || !hostPermissions || !optionalHostPermissions) {
    return fail('EXTENSION_INVALID', 'permissions / host_permissions 必须是字符串数组（各不超过 64 项）')
  }
  for (const permission of [...permissions, ...optionalPermissions]) {
    // MV2 允许把 http(s) host pattern 直接写入 permissions；按 host 权限校验，
    // 否则会错误拒绝常见的 MV2 扩展。optional_permissions 同样可能包含 host pattern。
    if (isAllowedInjectionPattern(permission)) continue
    if (!PERMISSION_PATTERN.test(permission)) {
      return fail('EXTENSION_INVALID', `权限名不合法：${permission.slice(0, 64)}`)
    }
    if (BLOCKED_EXTENSION_PERMISSIONS.has(permission) || permission.startsWith('enterprise.')) {
      return fail('EXTENSION_PERMISSION_BLOCKED', `该扩展申请了受限权限：${permission}（本地插件不支持）`)
    }
  }
  const allHostPermissions = [
    ...hostPermissions,
    ...optionalHostPermissions,
    ...permissions.filter(isAllowedInjectionPattern),
    ...optionalPermissions.filter(isAllowedInjectionPattern)
  ]
  for (const pattern of allHostPermissions) {
    if (!isAllowedInjectionPattern(pattern)) {
      return fail('EXTENSION_INVALID', `host_permissions 含不允许的地址范围：${pattern.slice(0, 80)}`)
    }
  }

  const contentScripts = manifest.content_scripts
  if (contentScripts !== undefined) {
    if (!Array.isArray(contentScripts)) return fail('EXTENSION_INVALID', 'content_scripts 必须是数组')
    if (contentScripts.length > 32) return fail('EXTENSION_INVALID', 'content_scripts 最多 32 组')
    for (const entry of contentScripts) {
      if (!entry || typeof entry !== 'object') return fail('EXTENSION_INVALID', 'content_scripts 条目结构不合法')
      const script = entry as Record<string, unknown>
      if (script.world === 'MAIN') {
        return fail('EXTENSION_MAIN_WORLD_UNSUPPORTED', '暂不支持 world:"MAIN" 的内容脚本（会与指纹注入冲突）')
      }
      const matches = stringArray(script.matches, 32)
      if (!matches || matches.length === 0) return fail('EXTENSION_INVALID', 'content_scripts[].matches 必须是非空数组')
      for (const pattern of matches) {
        if (!isAllowedInjectionPattern(pattern)) {
          return fail('EXTENSION_INVALID', `content_scripts 注入范围不允许：${pattern.slice(0, 80)}`)
        }
      }
      const js = stringArray(script.js, 32)
      const css = stringArray(script.css, 32)
      if (!js || !css) return fail('EXTENSION_INVALID', 'content_scripts[].js/css 必须是字符串数组')
      if (js.length === 0 && css.length === 0) return fail('EXTENSION_INVALID', 'content_scripts 条目必须至少包含一个 js 或 css')
    }
  }

  return {
    ok: true,
    manifest: {
      name,
      version,
      manifestVersion,
      permissions: [...new Set([...permissions, ...optionalPermissions])],
      hostPermissions: [...new Set(allHostPermissions)],
      requestsHeaders: permissions.includes('webRequest') || permissions.includes('declarativeNetRequest')
    }
  }
}
