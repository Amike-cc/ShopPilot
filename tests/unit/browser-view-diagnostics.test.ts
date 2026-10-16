import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  BROWSER_VIEW_STATE_LABEL,
  BROWSER_VIEW_STATE_SENTENCE,
  VIEW_PROBE_TIMEOUT_MARKER,
  classifyLoadFailure,
  classifyProbeFailure,
  classifyProbeState,
  formatViewUrl
} from '@shared/view-state'

/**
 * 浏览器视图诊断的回归网（2026-10-16 审查第 7 条 / V5）。
 *
 * 背景：这套诊断此前**一条断言都没有**——失败文案被 `!webviewAttached` 过滤成"永远不显示"、
 * 重试会在元素登记缺失时把自己的按钮点掉、看门狗不存在、探针把"崩溃"报成"卡死"，
 * 全都没有任何测试会因为坏掉而变红。本仓库自己的教训写在 docs/product-profiles.md:1154：
 * 「把'诊断没输出'当成'没有更多信息'是错的——它更可能是诊断坏了」。
 *
 * 这里分两层钉：
 *   ① 纯函数用真值表钉死（@shared/view-state，主进程与渲染层共用）；
 *   ② 源码级断言钉住"接线" —— 这类约定删掉后照样编译通过，但功能会静默退化。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')
const SETTINGS = read('apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue')
const WINDOW_MANAGER = read('apps/desktop/src/main/browser/window-manager.ts')

describe('视图状态词表：两处诊断读同一份定义（V4）', () => {
  it('每个状态都有短标签与一句话，且不为空', () => {
    for (const state of Object.keys(BROWSER_VIEW_STATE_LABEL) as Array<keyof typeof BROWSER_VIEW_STATE_LABEL>) {
      expect(BROWSER_VIEW_STATE_LABEL[state].length).toBeGreaterThan(0)
      expect(BROWSER_VIEW_STATE_SENTENCE[state].length).toBeGreaterThan(0)
    }
  })

  it('崩溃与卡死是两个不同的词：混成一个就回到 V1 的误报', () => {
    expect(BROWSER_VIEW_STATE_LABEL.hung).not.toBe(BROWSER_VIEW_STATE_LABEL.crashed)
    expect(BROWSER_VIEW_STATE_LABEL.hung).toContain('卡死')
    expect(BROWSER_VIEW_STATE_LABEL.crashed).toContain('崩溃')
  })

  it('渲染层浮层与设置中心体检都从共享词表取文案', () => {
    expect(SURFACE).toContain("from '@shared/view-state'")
    expect(SURFACE).toContain('BROWSER_VIEW_STATE_SENTENCE')
    expect(SETTINGS).toContain('BROWSER_VIEW_STATE_LABEL')
    // 设置页不得再读探针自己的 responsive 字段（旧实现把 error 归成"卡死"）
    expect(SETTINGS).not.toContain('v.responsive')
    expect(SETTINGS).toContain('BROWSER_VIEW_STATE_LABEL[v.state]')
  })
})

describe('classifyLoadFailure：did-fail-load 的判据（第 8 条）', () => {
  it('主框架 DNS/代理失败 → 给出原因', () => {
    expect(classifyLoadFailure({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: true }))
      .toBe('ERR_NAME_NOT_RESOLVED')
  })

  it('-3（net::ERR_ABORTED）算"被取消"，不是页面失败', () => {
    // Electron 对 did-fail-load 的定义就是 "fired when the load failed **or was cancelled**"：
    // 用户按停止、重定向打断都会带 -3 进来
    expect(classifyLoadFailure({ errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true })).toBeNull()
  })

  it('子框架（广告/统计/第三方登录 iframe）失败不算整页失败', () => {
    expect(classifyLoadFailure({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: false })).toBeNull()
  })

  it('没有描述时退回错误码；两者都没有时给"未知原因"，绝不返回空串', () => {
    expect(classifyLoadFailure({ errorCode: -105, isMainFrame: true })).toBe('错误码 -105')
    expect(classifyLoadFailure({ errorCode: 0, isMainFrame: true })).toBe('未知原因')
    expect(classifyLoadFailure(null)).toBeNull()
  })
})

describe('formatViewUrl：地址展示（V2）', () => {
  it('http(s) 去掉查询串（token / 重定向参数不进界面与日志）', () => {
    expect(formatViewUrl('https://fxg.jinritemai.com/ffa/mshop/homepage/index?token=abc&x=1'))
      .toBe('https://fxg.jinritemai.com/ffa/mshop/homepage/index')
  })

  it('about:blank / chrome-error 给可读文案，而不是 nullblank / nullchromewebdata', () => {
    expect(formatViewUrl('about:blank')).toBe('空白页（尚未导航）')
    expect(formatViewUrl('chrome-error://chromewebdata/')).toBe('加载失败页（Chromium 错误页）')
    // 旧实现 stripQuery 把 origin('null') 与 pathname 直接拼起来，界面上就是这么两个串
    expect(formatViewUrl('about:blank')).not.toContain('null')
  })

  it('应用界面与非 http(s) 兜底：只留协议，不回显可能带凭据的整串', () => {
    expect(formatViewUrl('file:///C:/app/index.html')).toBe('（应用界面）')
    expect(formatViewUrl('myscheme://user:pass@host/x')).toBe('myscheme://…')
    expect(formatViewUrl('')).toBe('（空地址）')
  })
})

describe('探针归类：卡死与崩溃必须分开（V1）', () => {
  it('超时标记 → timeout（渲染主线程卡死）', () => {
    expect(classifyProbeFailure(new Error(VIEW_PROBE_TIMEOUT_MARKER)).outcome).toBe('timeout')
  })

  it('其他异常（进程消失 / 求值失败）→ error，并带原因', () => {
    const result = classifyProbeFailure(new Error('Render frame was disposed'))
    expect(result.outcome).toBe('error')
    expect(result.reason).toContain('Render frame was disposed')
  })

  it('状态映射：崩溃 ≠ 卡死，未挂载 ≠ 崩溃', () => {
    expect(classifyProbeState({ attached: true, destroyed: true, outcome: 'error', loading: false })).toBe('crashed')
    expect(classifyProbeState({ attached: true, destroyed: false, outcome: 'error', loading: false })).toBe('crashed')
    expect(classifyProbeState({ attached: true, destroyed: false, outcome: 'timeout', loading: false })).toBe('hung')
    expect(classifyProbeState({ attached: true, destroyed: false, outcome: 'ok', loading: true })).toBe('loading')
    expect(classifyProbeState({ attached: true, destroyed: false, outcome: 'ok', loading: false })).toBe('ready')
    // 从未挂载的视图是"未挂载"（重试注册就能救），不是"崩溃"（要重开页面）
    expect(classifyProbeState({ attached: false, destroyed: false, outcome: 'error', loading: false })).toBe('unattached')
    // 曾挂上但 webContents 已销毁才是崩溃
    expect(classifyProbeState({ attached: false, destroyed: true, outcome: 'error', loading: false })).toBe('crashed')
  })

  it('旧实现 `.then(() => \'ok\', () => \'hung\')` 的形态不得回来（它让 error 不可达）', () => {
    expect(WINDOW_MANAGER).not.toMatch(/\.then\(\(\) => 'ok' as const, \(\) => 'hung' as const\)/)
  })
})

describe('接线：主进程探针与浮层（源码级约定，删掉不会编译报错）', () => {
  it('探针用共享判据，且不再有 origin+pathname 的 stripQuery', () => {
    expect(WINDOW_MANAGER).toContain('classifyProbeState')
    expect(WINDOW_MANAGER).toContain('classifyProbeFailure')
    expect(WINDOW_MANAGER).toContain('formatViewUrl')
    expect(WINDOW_MANAGER).not.toContain('function stripQuery')
  })

  it('视图体检包含未挂载的视图（不再只 filter 已挂载的 guest）', () => {
    expect(WINDOW_MANAGER).toMatch(/const views = await Promise\.all\([\s\S]{0,400}\.map\(tab => probeView\(tab, storeId\)\)/)
    expect(WINDOW_MANAGER).not.toMatch(/const views = await Promise\.all\([\s\S]{0,200}\.filter\(tab => tab\.guestAttached/)
  })

  it('主进程也按同一判据记日志（子框架/取消不记）', () => {
    expect(WINDOW_MANAGER).toContain('classifyLoadFailure({ errorCode: code, errorDescription: desc, isMainFrame })')
    expect(WINDOW_MANAGER).toContain('[webview] load failed')
  })

  it('浮层的失败态不受 guestAttached 约束（P1 不许回退）', () => {
    expect(SURFACE).toContain('.filter(row => !!row.failure || !row.attached)')
    expect(SURFACE).not.toMatch(/filter\(item => !webviewAttached\(item\)\)/)
  })

  it('失败动作必须落在被诊断的店铺上（跨店红线 §3.3）', () => {
    // 直接调 ws.navigate 会用 displayedStoreId，把别的店导航走；地址栏那条路径（submitUrl）
    // 本来就是"导航当前显示的店铺"，不在此约束内，所以只检查 reopenHome 函数体
    const reopen = SURFACE.match(/async function reopenHome[\s\S]*?\n\}/)
    expect(reopen).toBeTruthy()
    expect(reopen![0]).toContain('focusDiagnosedStore')
    expect(reopen![0]).toContain('browser.navigate(diagnostic.storeId, diagnostic.tabId, url)')
    expect(reopen![0]).not.toContain('ws.navigate')
  })

  it('清理站点数据只用 schema 白名单里的类型（大小写敏感）', () => {
    // packages/shared/src/schemas/browser.ts: ['cookies','cache','localStorage','downloads']
    expect(SURFACE).toMatch(/clearData\(diagnostic\.storeId, \['localStorage', 'cache'\]\)/)
    for (const bogus of ['indexdb', 'cachestorage', 'serviceworkers', 'filesystem']) {
      expect(SURFACE).not.toMatch(new RegExp(`browser\\.clearData\\([^)]*'${bogus}'`))
    }
  })

  it('live region 只包文本：动作按钮在 region 之外（朗读器不重复播报控件）', () => {
    const panel = SURFACE.slice(SURFACE.indexOf('data-test="webview-diagnostics"'), SURFACE.indexOf('data-test="webview-diagnostics"') + 2200)
    expect(panel).toContain('aria-live="polite"')
    expect(panel).not.toContain('role="status"')
    // 按钮块在 live region 的闭合 div 之后
    expect(panel.indexOf('diagnostic-actions-list')).toBeGreaterThan(panel.indexOf('</div>\n              <div v-if="failedDiagnostics.length"'))
  })

  it('浮层可收起，且失败条数在标题栏可见（不再永久盖住平台页面左下角）', () => {
    expect(SURFACE).toContain('diagnosticsCollapsed')
    expect(SURFACE).toContain(':aria-expanded="!diagnosticsCollapsed"')
    expect(SURFACE).toContain('failedDiagnostics.length')
  })

  it('ref 闭包与看门狗都有清理点（P4-11）', () => {
    expect(SURFACE).toContain('webviewRefCallbacks.clear()')
    expect(SURFACE).toMatch(/for \(const key of Array\.from\(attachWatchdogs\.keys\(\)\)\) clearAttachWatchdog\(key\)/)
    expect(SURFACE).toContain('webviewRefCallbacks.delete(key)')
  })

  it('destroyed 不再删除元素登记（P2-5 竞态不许回退）', () => {
    const fn = SURFACE.match(/function handleWebviewDestroyed[\s\S]*?\n\}/)
    expect(fn).toBeTruthy()
    expect(fn![0]).not.toMatch(/\n\s+webviewEls\.delete\(/)
  })
})
