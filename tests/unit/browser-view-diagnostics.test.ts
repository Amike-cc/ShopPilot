import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  BROWSER_VIEW_STATE_LABEL,
  BROWSER_VIEW_STATE_SENTENCE,
  GUEST_ID_READ_ATTEMPTS,
  VIEW_PROBE_TIMEOUT_MARKER,
  classifyLoadFailure,
  classifyProbeFailure,
  classifyProbeState,
  formatViewUrl,
  readGuestWebContentsId
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

/**
 * 2026-10-16 用户实报「主界面浏览器连接不到店铺网页」的回归网。
 *
 * 现场链条：点侧栏店铺卡片 → 面板已可见 → `<webview>` 元素走同步 attach 快路径 →
 * `did-attach` 在 59ms 触发时 `getWebContentsId()` **还读到 0**（dom-ready 时才可读）。
 * 旧实现"一次读不到就 return"，而且这条失败随后被 about:blank 的 did-finish-load 擦掉，
 * 界面永远停在「正在连接店铺页面…」——没有原因、没有按钮，30 秒后才由看门狗兜底。
 */
describe('guest id 就绪等待：读不到 ≠ 失败（用户实报回归）', () => {
  it('第一次就能读到：立刻返回，不等待', async () => {
    const waits: number[] = []
    const id = await readGuestWebContentsId(() => 7, async (ms) => { waits.push(ms) })
    expect(id).toBe(7)
    expect(waits).toEqual([])
  })

  it('先抛错/先读到 0，随后就绪：返回真实 id，不当失败', async () => {
    let calls = 0
    const id = await readGuestWebContentsId(() => {
      calls += 1
      if (calls === 1) throw new Error('guest 还没就绪')
      if (calls === 2) return 0
      return 42
    }, async () => {})
    expect(id).toBe(42)
    expect(calls).toBe(3)
  })

  it('非正整数与非整数都算"还没好"（0 / -1 / NaN / 1.5）', async () => {
    const values = [0, -1, Number.NaN, 1.5, 12]
    let i = 0
    const id = await readGuestWebContentsId(() => values[i++]!, async () => {})
    expect(id).toBe(12)
    expect(i).toBe(5)
  })

  it('有界：一直读不到时读 attempts 次、等 attempts-1 次后返回 0（不许无限转圈）', async () => {
    let reads = 0
    let waits = 0
    const id = await readGuestWebContentsId(() => { reads += 1; return 0 }, async () => { waits += 1 }, 5)
    expect(id).toBe(0)
    expect(reads).toBe(5)
    expect(waits).toBe(4)
  })

  it('等待节奏：前几次 16ms 抢快、之后 60ms，总时长有界（不到看门狗的 30s）', async () => {
    const waits: number[] = []
    await readGuestWebContentsId(() => 0, async (ms) => { waits.push(ms) })
    expect(waits.slice(0, 3)).toEqual([16, 16, 16])
    expect(new Set(waits.slice(3))).toEqual(new Set([60]))
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(1000)
    expect(GUEST_ID_READ_ATTEMPTS).toBeGreaterThan(3)
  })

  it('渲染层用共享的等待函数，而不是"读一次读不到就当失败"', () => {
    const fn = SURFACE.match(/async function handleWebviewAttach[\s\S]*?\n\}/)
    expect(fn).toBeTruthy()
    expect(fn![0]).toContain('await readGuestWebContentsId(')
    expect(fn![0]).not.toContain("webviewFailures[key] = '无法读取页面进程标识'")
  })

  it('先占位再 await：did-attach 与 dom-ready 同时打进来不会双开注册', () => {
    const fn = SURFACE.match(/async function handleWebviewAttach[\s\S]*?\n\}/)![0]
    const addAt = fn.indexOf('registeringKeys.add(key)')
    const awaitAt = fn.indexOf('await readGuestWebContentsId(')
    expect(addAt).toBeGreaterThan(-1)
    expect(awaitAt).toBeGreaterThan(addAt)
  })

  it('dom-ready 兜底再触发一次注册，且已挂上的直接跳过', () => {
    expect(SURFACE).toContain('@dom-ready="handleWebviewAttach(item)"')
    const fn = SURFACE.match(/async function handleWebviewAttach[\s\S]*?\n\}/)![0]
    expect(fn).toContain('if (webviewAttached(item)) return')
  })

  it('did-finish-load 不许擦掉"还没注册上"的失败原因（现场就是这么失去线索的）', () => {
    const fn = SURFACE.match(/function clearWebviewError[\s\S]*?\n\}/)
    expect(fn).toBeTruthy()
    expect(fn![0]).toContain('if (!webviewAttached(item)) return')
  })

  it('主进程挂 guest 幂等：重复注册不再叠加监听器', () => {
    const fn = WINDOW_MANAGER.match(/function attachGuestWebContents[\s\S]*?\n\}/)
    expect(fn).toBeTruthy()
    const guardAt = fn![0].indexOf('if (tab.guestAttached && tab.webContents === wc && !wc.isDestroyed()) return')
    const firstOnAt = fn![0].indexOf('wc.on(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(firstOnAt).toBeGreaterThan(guardAt)
  })

  it('guest 首次落 about:blank 不许覆盖已恢复的真实 URL（第二位成因）', () => {
    // 现场：库里存的是真 URL，重开后 main 的 tab 变成 about:blank → pendingUrl 也是空白页 → 永不导航
    const nav = WINDOW_MANAGER.match(/wc\.on\('did-navigate'[\s\S]*?\n {2}\}\)/)
    expect(nav).toBeTruthy()
    expect(nav![0]).toContain("if (newUrl !== 'about:blank' || tab.url === 'about:blank')")
    expect(nav![0]).toMatch(/tab\.url = newUrl[\s\S]*saveTabToDatabase\(tab\)/)
    // 关店保存同样不许被 about:blank 洗掉
    const save = WINDOW_MANAGER.match(/function saveTabs[\s\S]*?\n\}/)
    expect(save).toBeTruthy()
    expect(save![0]).toContain("if (live && (live !== 'about:blank' || tab.url === 'about:blank')) tab.url = live")
  })

  it('新店第一次打开落到自己的后台地址，而不是一张空白页', () => {
    const fn = WINDOW_MANAGER.match(/function restoreTabs[\s\S]*?\n\}/)
    expect(fn).toBeTruthy()
    expect(fn![0]).toContain('SELECT admin_url FROM stores WHERE id = ?')
    expect(fn![0]).not.toContain("createTab(storeId, 'about:blank')")
  })

  it('恢复时优先挑非空白标签，并把「上次所在标签」写回库（旧库被写坏也能自愈）', () => {
    const fn = WINDOW_MANAGER.match(/function restoreTabs[\s\S]*?\n\}/)![0]
    expect(fn).toContain("const realTabs = savedTabs.filter((savedTab: any) => savedTab.url && savedTab.url !== 'about:blank')")
    expect(fn).toContain('const pool = realTabs.length > 0 ? realTabs : savedTabs')
    expect(fn).toMatch(/UPDATE tabs SET last_active_at = \?, updated_at = \? WHERE id = \?/)
  })
})
