import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string) => readFileSync(resolve(path), 'utf8')
const CORE = read('apps/desktop/src/main/browser/window-browser-core.ts')
const INDEX = read('apps/desktop/src/main/index.ts')

describe('浏览器安全加固', () => {
  it('工作台标签页与独立窗口都拦截服务端重定向（will-redirect）', () => {
    expect((CORE.match(/on\('will-redirect'/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(CORE).toContain('[nav] 页面重定向被拦截')
    expect(CORE).toContain('[nav] 独立窗口页面重定向被拦截')
  })

  it('webview attach 显式重置 Renderer 可传入的 webPreferences', () => {
    for (const line of [
      'webPreferences.webSecurity = true',
      'webPreferences.allowRunningInsecureContent = false',
      'webPreferences.nodeIntegrationInWorker = false',
      'webPreferences.nodeIntegrationInSubFrames = false',
      'webPreferences.safeDialogs = true',
      "webPreferences.enableBlinkFeatures = ''",
      "webPreferences.disableBlinkFeatures = ''"
    ]) {
      expect(INDEX).toContain(line)
    }
  })
})
