import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SOFTWARE_CHECK_STATUS_LABEL,
  describeCacheClearResult,
  formatBytesShort,
  summarizeSoftwareChecks,
  type CacheClearResult,
  type SoftwareCheckItem
} from '@shared/software-diagnostics'

/**
 * 「清除软件缓存 / 清除浏览器缓存 / 诊断软件」的回归网（2026-10-16 新增功能）。
 *
 * 这类"维护动作"最容易出的问题不是崩溃，而是**说假话**：
 *   · 清理失败了却提示"已清理完成"；
 *   · 明明没释放空间却说"释放了 0 B"看不出区别；
 *   · 诊断里有一项异常，总体却报"全部正常"。
 * 所以真值表钉在 shared 的纯函数上，源码级断言钉住"接线"与红线（不许清 Cookie/站点存储）。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const SHARED = read('packages/shared/src/software-diagnostics.ts')
const IPC_CONTRACT = read('packages/shared/src/contracts/ipc.ts')
const HANDLERS = read('apps/desktop/src/main/ipc/maintenance-handlers.ts')
const MAIN_INDEX = read('apps/desktop/src/main/index.ts')
const PRELOAD = read('apps/desktop/src/preload/index.ts')
const ENV_TYPES = read('apps/desktop/src/renderer/src/env.d.ts')
const SETTINGS = read('apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue')
const CACHE_CLEANUP = read('apps/desktop/src/main/services/cache-cleanup.ts')
const SOFTWARE_DIAG = read('apps/desktop/src/main/services/software-diagnostics.ts')

const item = (key: string, status: SoftwareCheckItem['status']): SoftwareCheckItem => ({ key, label: key, status, detail: 'd' })

describe('summarizeSoftwareChecks：最差的一项决定总体', () => {
  it('全正常 → ok，headline 报总项数', () => {
    const summary = summarizeSoftwareChecks([item('a', 'ok'), item('b', 'ok')])
    expect(summary).toMatchObject({ ok: 2, warn: 0, error: 0, status: 'ok' })
    expect(summary.headline).toContain('2 项正常')
  })

  it('有一项 warn → 总体 warn（不能说"全部正常"）', () => {
    const summary = summarizeSoftwareChecks([item('a', 'ok'), item('b', 'warn')])
    expect(summary.status).toBe('warn')
    expect(summary.headline).toContain('1 项注意')
  })

  it('有 error → 总体 error，且同时报出注意项', () => {
    const summary = summarizeSoftwareChecks([item('a', 'ok'), item('b', 'warn'), item('c', 'error')])
    expect(summary).toMatchObject({ ok: 1, warn: 1, error: 1, status: 'error' })
    expect(summary.headline).toContain('1 项异常')
    expect(summary.headline).toContain('1 项注意')
  })

  it('空列表如实说"没有可执行的检查项"，不谎报正常', () => {
    const summary = summarizeSoftwareChecks([])
    expect(summary.status).toBe('ok')
    expect(summary.headline).toContain('没有可执行的检查项')
  })

  it('状态标签覆盖三种状态', () => {
    expect(SOFTWARE_CHECK_STATUS_LABEL.ok).toBe('正常')
    expect(SOFTWARE_CHECK_STATUS_LABEL.warn).toBe('注意')
    expect(SOFTWARE_CHECK_STATUS_LABEL.error).toBe('异常')
  })
})

describe('formatBytesShort：一屏之内只有一种写法', () => {
  it('0 / 负数 / 非数字 → 0 B（不出现 NaN B）', () => {
    expect(formatBytesShort(0)).toBe('0 B')
    expect(formatBytesShort(-1)).toBe('0 B')
    expect(formatBytesShort(Number.NaN)).toBe('0 B')
    expect(formatBytesShort(null)).toBe('0 B')
  })

  it('按 1024 递进，100 以上取整、以下保留一位小数', () => {
    expect(formatBytesShort(512)).toBe('512 B')
    expect(formatBytesShort(2048)).toBe('2 KB')
    expect(formatBytesShort(1536)).toBe('1.5 KB')
    expect(formatBytesShort(1024 * 1024 * 1.25)).toBe('1.3 MB')
    expect(formatBytesShort(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB')
    expect(formatBytesShort(1024 * 1024 * 1024 * 512)).toBe('512 GB')
  })
})

describe('describeCacheClearResult：清理结果必须说真话', () => {
  const base: CacheClearResult = {
    scope: 'app',
    freedBytes: 0,
    items: ['HTTP 缓存'],
    failures: [],
    stores: [],
    skippedStores: 0
  }

  it('有失败项 → ok=false 且把失败原因说出来（不能报"已清理完成"）', () => {
    const result = describeCacheClearResult({ ...base, failures: ['代码缓存（JS/WASM）：被占用'] })
    expect(result.ok).toBe(false)
    expect(result.performed).toBe(true)
    expect(result.text).toContain('失败')
    expect(result.text).toContain('被占用')
  })

  it('没释放空间 → 说"没有可释放的缓存"，不糊成"释放 0 B"', () => {
    const result = describeCacheClearResult(base)
    expect(result.ok).toBe(true)
    expect(result.performed).toBe(true)
    expect(result.text).toContain('没有可释放的缓存')
  })

  it('有释放 → 报出释放量与清理项', () => {
    const result = describeCacheClearResult({ ...base, freedBytes: 3 * 1024 * 1024, items: ['HTTP 缓存', '代码缓存（JS/WASM）'] })
    expect(result.text).toContain('3 MB')
    expect(result.text).toContain('HTTP 缓存')
    expect(result.text).toContain('代码缓存')
  })

  it('浏览器缓存：报涉及店铺数与跳过数', () => {
    const result = describeCacheClearResult({
      ...base,
      scope: 'browser',
      freedBytes: 1024,
      stores: [{ storeId: 's1', storeName: 'A', freedBytes: 1024 }],
      skippedStores: 2
    })
    expect(result.text).toContain('1 家店铺')
    expect(result.text).toContain('另有 2 家尚未产生浏览器数据已跳过')
  })

  it('浏览器缓存但没有店铺可清 → 如实说"没有需要清理的店铺"', () => {
    const result = describeCacheClearResult({ ...base, scope: 'browser' })
    expect(result.text).toContain('没有需要清理的店铺')
  })

  it('一项都没执行 → performed=false，界面据此弹"没有需要清理"而不是绿色成功', () => {
    // 反向审查指出的坑：全部店铺被跳过后 items/failures 皆空，
    // 旧实现仍然 ok=true → 设置中心弹「浏览器缓存已清理」的成功提示，而实际什么都没做
    const result = describeCacheClearResult({ ...base, scope: 'browser', items: [], skippedStores: 3 })
    expect(result.performed).toBe(false)
    expect(result.text).not.toContain('（）')
    expect(result.text).toContain('没有需要清理的浏览器缓存')
  })
})

describe('接线：IPC / 预加载 / 设置中心', () => {
  it('三个通道都在契约里，并且都注册了 handler', () => {
    for (const channel of ['MAINTENANCE_CLEAR_APP_CACHE', 'MAINTENANCE_CLEAR_BROWSER_CACHE', 'MAINTENANCE_SOFTWARE_DIAGNOSTICS']) {
      expect(IPC_CONTRACT).toContain(channel)
      expect(HANDLERS).toContain(`IPC_CHANNELS.${channel}`)
    }
    expect(MAIN_INDEX).toContain('registerMaintenanceHandlers()')
  })

  it('预加载与渲染层类型都暴露了 maintenance API', () => {
    expect(PRELOAD).toContain('clearAppCache')
    expect(PRELOAD).toContain('clearBrowserCache')
    expect(PRELOAD).toContain('softwareDiagnostics')
    expect(ENV_TYPES).toContain('maintenance:')
  })

  it('设置中心有这三个入口，并且调用的是 maintenance API', () => {
    for (const hook of ['maintenance-clear-app-cache', 'maintenance-clear-browser-cache', 'maintenance-software-check']) {
      expect(SETTINGS).toContain(`data-test="${hook}"`)
    }
    expect(SETTINGS).toContain('window.shopilot.maintenance.clearAppCache()')
    expect(SETTINGS).toContain('window.shopilot.maintenance.clearBrowserCache()')
    expect(SETTINGS).toContain('window.shopilot.maintenance.softwareDiagnostics()')
    // 结论文案不自己编：走 shared 的判定
    expect(SETTINGS).toContain('describeCacheClearResult')
    expect(SETTINGS).toContain('summarizeSoftwareChecks')
  })

  it('清理边上必须写清边界（用户要能分清点哪个）', () => {
    expect(SETTINGS).toContain('Cookie 与站点存储保留')
    expect(SETTINGS).toContain('软件缓存 = 应用界面自己的网页缓存')
  })
})

describe('红线：清理不许碰登录态与站点存储', () => {
  it('缓存清理只调 clearCache / clearCodeCaches / shadercache', () => {
    expect(CACHE_CLEANUP).toContain('ses.clearCache()')
    expect(CACHE_CLEANUP).toContain('clearCodeCaches({})')
    expect(CACHE_CLEANUP).toContain("storages: ['shadercache']")
    // 不许出现 cookie / localstorage / indexdb / serviceworkers 的清理调用
    expect(CACHE_CLEANUP).not.toMatch(/storages:[^\]]*cookies/)
    expect(CACHE_CLEANUP).not.toMatch(/storages:[^\]]*localstorage/)
    expect(CACHE_CLEANUP).not.toMatch(/storages:[^\]]*indexdb/)
    expect(CACHE_CLEANUP).not.toMatch(/clearStorageData\(\{\s*storages:\s*\[[^\]]*(localstorage|indexdb|serviceworkers)/)
  })

  it('不为了清缓存去创建店铺分区（跳过从未打开的店铺）', () => {
    expect(CACHE_CLEANUP).toContain('openStoreIds.has(store.id)')
    expect(CACHE_CLEANUP).toContain('skippedStores += 1')
  })

  it('清缓存写审计（"登录态怎么没了"要查得到），且失败时审计也写 failure', () => {
    expect(CACHE_CLEANUP).toContain("writeAudit('maintenance.cache.clear'")
    // 页面报红字、审计报 success 是最难查的自相矛盾：有失败项必须写 failure
    expect(CACHE_CLEANUP).toMatch(/failures\.length > 0 \? 'failure' : 'success'/)
    // requestId 走 audit-logger 的约定（auditRequestId(rid, 上下文)），便于和一次 IPC 调用对齐
    expect(CACHE_CLEANUP).toContain('auditRequestId(requestId')
    expect(HANDLERS).toContain('clearAppCache(requestId)')
    expect(HANDLERS).toContain('clearBrowserCaches(requestId)')
  })

  it('统计范围 = 清理范围（measured == cleared，不许出现"占 300MB 却说没有可释放"）', () => {
    // 只钉住那一行常量：注释里会提到 Dawn/Dictionary 这些清不掉的目录，不能按全文出现与否判断
    const listLine = CACHE_CLEANUP.match(/const CLEARABLE_CACHE_DIRS = \[[^\]]*\]/)
    expect(listLine?.[0]).toBe("const CLEARABLE_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache']")
  })

  it('可写性探针不会在用户数据目录里留垃圾（删除放 finally）', () => {
    expect(SOFTWARE_DIAG).toMatch(/try \{\s*\n\s*writeFileSync\(probe, 'ok'\)\s*\n\s*\} finally \{/)
  })
})

describe('诊断软件：单项失败不能拖垮整份报告，且只读', () => {
  it('每一项都过 check() 包装（异常变成该项的 error）', () => {
    expect(SOFTWARE_DIAG).toContain('async function check(')
    expect(SOFTWARE_DIAG).toContain('检查未完成')
    const calls = SOFTWARE_DIAG.match(/await check\(/g) || []
    expect(calls.length).toBeGreaterThanOrEqual(8)
  })

  it('覆盖关键检查项（key 稳定，界面与测试都按 key 找）', () => {
    for (const key of ['runtime', 'database', 'dataDir', 'disk', 'logs', 'cache', 'encryption', 'proxies', 'stores', 'backups', 'window']) {
      expect(SOFTWARE_DIAG).toContain(`'${key}'`)
    }
  })

  it('只读：不写数据库、不改设置、不发网络请求', () => {
    expect(SOFTWARE_DIAG).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i)
    expect(SOFTWARE_DIAG).not.toContain('settings.set')
    expect(SOFTWARE_DIAG).not.toMatch(/\bfetch\(|net\.request|https?:\/\//)
  })

  it('唯一允许的写动作是"可写性探针"（写完即删）', () => {
    expect(SOFTWARE_DIAG).toContain('function assertWritable')
    expect(SOFTWARE_DIAG).toContain('unlinkSync(probe)')
  })

  it('shared 侧不依赖 Electron（主进程与渲染层都能 import）', () => {
    expect(SHARED).not.toContain("from 'electron'")
    expect(SHARED).not.toMatch(/require\('electron'\)/)
  })
})
