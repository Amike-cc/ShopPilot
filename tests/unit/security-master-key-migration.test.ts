import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * B3/B4（2026-10-15 全库审查）回归：主密码存储键统一与迁移。
 *
 * 背景：主密码记录的历史键是 `'securi…ster'`（中间是 U+2026 省略号，疑似占位符未还原），
 * 而诊断包排除名单硬编码的却是 `'security.master'`——两者从未对上，"排除主密码"的防呆
 * 条目从引入起就形同虚设（诊断导出靠白名单兜底才没有泄漏）。
 *
 * 修复：键统一为 `security.master`（单一事实来源常量），读取兼容旧键并就地迁移；
 * 诊断名单改为引用同一常量。本文件钉住：常量值（含旧键的精确字节）、迁移解析的优先级、
 * 以及"新写入只用新键、删除时两键都清"。
 */

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\test-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  },
  BrowserWindow: {},
  ipcMain: {}
}))

const { MASTER_PASSWORD_SETTING_KEY, LEGACY_MASTER_PASSWORD_SETTING_KEY, resolveMasterStoredKey } =
  await import('../../apps/desktop/src/main/services/security-manager')

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const SECURITY = read('apps/desktop/src/main/services/security-manager.ts')
const DIAGNOSTICS = read('apps/desktop/src/main/services/diagnostics.ts')

describe('B4 主密码键：常量与迁移解析', () => {
  it('新键是 security.master；旧键保留为迁移常量（精确钉住 U+2026）', () => {
    expect(MASTER_PASSWORD_SETTING_KEY).toBe('security.master')
    expect(LEGACY_MASTER_PASSWORD_SETTING_KEY).toBe('securi' + '\u2026' + 'ster')
  })

  it('resolveMasterStoredKey：新键优先；只有旧键时给出迁移标记；都没有返回 null', () => {
    const onlyFresh = resolveMasterStoredKey(k => (k === 'security.master' ? 'enc:fresh' : null))
    expect(onlyFresh).toEqual({ stored: 'enc:fresh', legacyKey: null })

    const onlyLegacy = resolveMasterStoredKey(k => (k === LEGACY_MASTER_PASSWORD_SETTING_KEY ? 'enc:legacy' : null))
    expect(onlyLegacy).toEqual({ stored: 'enc:legacy', legacyKey: LEGACY_MASTER_PASSWORD_SETTING_KEY })

    const both = resolveMasterStoredKey(() => 'enc:any')
    expect(both.stored).toBe('enc:any')
    expect(both.legacyKey).toBe(LEGACY_MASTER_PASSWORD_SETTING_KEY)

    const none = resolveMasterStoredKey(() => null)
    expect(none).toEqual({ stored: null, legacyKey: null })
  })

  it('源码级：写入只用新键、读取经 readMasterStored、删除两键都清', () => {
    expect(SECURITY).toContain('put(MASTER_PASSWORD_SETTING_KEY, seal(')
    expect(SECURITY).toContain('const stored = readMasterStored()')
    // 旧键绝不再被写：put 调用里不允许出现 LEGACY
    expect(SECURITY).not.toMatch(/put\(LEGACY_MASTER_PASSWORD_SETTING_KEY/)
    // 删除路径（removeMasterPassword）+ 迁移清理，共至少两处 DELETE
    const deletes = SECURITY.match(/DELETE FROM app_settings WHERE key = \?/g) || []
    expect(deletes.length).toBeGreaterThanOrEqual(2)
  })
})

describe('B3 诊断包排除名单与真实键同源', () => {
  it('diagnostics 从 security-manager 引入常量，且不再硬编码任何安全键名', () => {
    expect(DIAGNOSTICS).toContain("import { LEGACY_MASTER_PASSWORD_SETTING_KEY, MASTER_PASSWORD_SETTING_KEY } from './security-manager'")
    expect(DIAGNOSTICS).toContain('const SETTING_DENY = [MASTER_PASSWORD_SETTING_KEY, LEGACY_MASTER_PASSWORD_SETTING_KEY')
    // 硬编码正是漂移源头：不允许再出现写死的主密码键字面量
    expect(DIAGNOSTICS).not.toContain("'security.master'")
    expect(DIAGNOSTICS).not.toContain("'securi\u2026ster'")
  })
})
