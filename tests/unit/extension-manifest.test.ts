import { describe, expect, it } from 'vitest'
import { isAllowedInjectionPattern, validateExtensionManifest } from '../../apps/desktop/src/main/services/extension-manifest'

const validManifest = (overrides: Record<string, unknown> = {}) => ({
  manifest_version: 3,
  name: 'Fixture extension',
  version: '1.2.3',
  permissions: ['storage'],
  host_permissions: ['https://*.example.com/*'],
  content_scripts: [{ matches: ['https://*.example.com/*'], js: ['content.js'] }],
  ...overrides
})

describe('browser extension manifest boundary', () => {
  it('accepts a normal MV3 page-scoped manifest and normalizes host permissions', () => {
    const result = validateExtensionManifest(validManifest())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.manifestVersion).toBe(3)
    expect(result.manifest.hostPermissions).toEqual(['https://*.example.com/*'])
    expect(result.manifest.permissions).toEqual(['storage'])
    expect(result.manifest.requestsHeaders).toBe(false)
  })

  it('accepts MV2 host patterns in permissions while keeping capability permissions', () => {
    const result = validateExtensionManifest(validManifest({
      manifest_version: 2,
      permissions: ['https://*.example.com/*', 'webRequest']
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.hostPermissions).toContain('https://*.example.com/*')
    expect(result.manifest.requestsHeaders).toBe(true)
  })

  it.each(['nativeMessaging', 'cookies', 'debugger', 'enterprise.someFuturePermission'])('rejects blocked permission %s', permission => {
    const result = validateExtensionManifest(validManifest({ permissions: [permission] }))
    expect(result).toMatchObject({ ok: false, code: 'EXTENSION_PERMISSION_BLOCKED' })
  })

  it('rejects file and other non-web optional host permissions', () => {
    const result = validateExtensionManifest(validManifest({
      optional_host_permissions: ['file:///*']
    }))
    expect(result).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' })
  })

  it('rejects main-world content scripts because they can overwrite fingerprint state', () => {
    const result = validateExtensionManifest(validManifest({
      content_scripts: [{ matches: ['https://*.example.com/*'], world: 'MAIN', js: ['content.js'] }]
    }))
    expect(result).toMatchObject({ ok: false, code: 'EXTENSION_MAIN_WORLD_UNSUPPORTED' })
  })

  it.each([
    ['https://example.com/*', true],
    ['*://*.example.com/*', true],
    ['<all_urls>', true],
    ['file:///*', false],
    ['chrome-extension://*/*', false],
    ['ftp://example.com/*', false]
  ])('classifies injection pattern %s', (pattern, allowed) => {
    expect(isAllowedInjectionPattern(pattern)).toBe(allowed)
  })
})
