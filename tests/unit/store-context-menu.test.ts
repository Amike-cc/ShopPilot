import { describe, it, expect } from 'vitest'
import {
  buildStoreContextMenu,
  runStoreMenuAction,
  toStoreMenuInput,
  toElectronMenuTemplate
} from '../../apps/desktop/src/main/browser/store-context-menu'
import type {
  StoreMenuId,
  StoreMenuInput,
  StoreMenuItem,
  StoreMenuDeps,
  StoreMenuWebContents
} from '../../apps/desktop/src/main/browser/store-context-menu'

/**
 * 店铺页面（WebContentsView）右键菜单的单测。
 *
 * 模块刻意把「模板」与「动作」拆开、动作只依赖一个最小的 WebContents 形状，
 * 就是为了**在单测里不起 Electron**：模板直接断言标签/禁用态，动作传假 wc 断言"点了调哪个方法"。
 */

// ---------- 测试脚手架 ----------

/** 全部字段取最保守值（无历史、不可编辑、不是链接），再按用例覆盖 */
function makeInput(over: Partial<StoreMenuInput> = {}): StoreMenuInput {
  return {
    canGoBack: false,
    canGoForward: false,
    isEditable: false,
    canCopy: false,
    canPaste: false,
    canSelectAll: false,
    linkUrl: '',
    // 默认给一个落点：绝大多数用例不关心它，给上可避免"元素定位信息"项无谓置灰
    // 干扰其它断言（专门测置灰的用例会显式覆盖成 undefined）
    probePoint: { x: 10, y: 20 },
    ...over
  }
}

function findByItemId(items: StoreMenuItem[], id: StoreMenuId): StoreMenuItem | undefined {
  return items.find(it => it.id === id)
}

/** 假 wc：只记录被调用了哪个方法，用来断言「点了 reload 走的是 reload 还是 reloadIgnoringCache」 */
function makeFakeDeps() {
  const wcCalls: string[] = []
  const wc: StoreMenuWebContents = {
    goBack: () => { wcCalls.push('goBack') },
    goForward: () => { wcCalls.push('goForward') },
    reload: () => { wcCalls.push('reload') },
    reloadIgnoringCache: () => { wcCalls.push('reloadIgnoringCache') },
    cut: () => { wcCalls.push('cut') },
    copy: () => { wcCalls.push('copy') },
    paste: () => { wcCalls.push('paste') },
    selectAll: () => { wcCalls.push('selectAll') }
  }
  const openedUrls: string[] = []
  const copiedTexts: string[] = []
  const probedPoints: Array<{ x: number; y: number }> = []
  const box = { standaloneOpens: 0 }
  const deps: StoreMenuDeps = {
    wc,
    openUrl: url => { openedUrls.push(url) },
    copyText: text => { copiedTexts.push(text) },
    probeElement: point => { probedPoints.push(point) },
    openStandalone: () => { box.standaloneOpens += 1 }
  }
  return {
    deps, wcCalls, openedUrls, copiedTexts, probedPoints,
    get standaloneOpens() { return box.standaloneOpens }
  }
}

// ---------- 验收核心：重新加载 / 强制重新加载 ----------

describe('右键菜单 · 重新加载与强制重新加载（本次验收核心）', () => {
  it('两项都在菜单里，标签分别是「重新加载」与「强制重新加载（不使用缓存）」', () => {
    const items = buildStoreContextMenu(makeInput())
    expect(findByItemId(items, 'reload')?.label, '缺「重新加载」项').toBe('重新加载')
    expect(findByItemId(items, 'hardReload')?.label, '缺「强制重新加载（不使用缓存）」项')
      .toBe('强制重新加载（不使用缓存）')
  })

  it('两项都与输入无关地可点（不会被任何输入置灰）', () => {
    // 覆盖各种输入组合：无论历史/可编辑/链接/独立窗口如何，这两项都不能变成 disabled。
    // 注意模板里它们**不给 enabled 字段**（undefined），由消费方 window-manager 映射成
    // `enabled: it.enabled !== false`，所以"没被显式置 false"才是这里的真实契约。
    const combos: Array<Partial<StoreMenuInput>> = [
      {},
      { canGoBack: true, canGoForward: true },
      { isEditable: true, canCopy: true, canPaste: true, canSelectAll: true },
      { linkUrl: 'https://example.com/a' },
      { isStandalone: true }
    ]
    for (const over of combos) {
      const items = buildStoreContextMenu(makeInput(over))
      const reload = findByItemId(items, 'reload')
      const hard = findByItemId(items, 'hardReload')
      expect(reload, `输入 ${JSON.stringify(over)} 下缺 reload`).toBeTruthy()
      expect(hard, `输入 ${JSON.stringify(over)} 下缺 hardReload`).toBeTruthy()
      expect(reload!.enabled, `输入 ${JSON.stringify(over)} 下 reload 被置灰`).not.toBe(false)
      expect(hard!.enabled, `输入 ${JSON.stringify(over)} 下 hardReload 被置灰`).not.toBe(false)
    }
  })

  it('hardReload 的动作走 reloadIgnoringCache()，绝不走 reload()', () => {
    const f = makeFakeDeps()
    runStoreMenuAction('hardReload', f.deps, { linkUrl: '' })
    expect(f.wcCalls, '强制重新加载必须忽略缓存').toEqual(['reloadIgnoringCache'])
    expect(f.wcCalls, '强制重新加载不能退化成普通 reload').not.toContain('reload')
  })

  it('reload 的动作走 reload()，不走 reloadIgnoringCache()', () => {
    const f = makeFakeDeps()
    runStoreMenuAction('reload', f.deps, { linkUrl: '' })
    expect(f.wcCalls).toEqual(['reload'])
    expect(f.wcCalls).not.toContain('reloadIgnoringCache')
  })
})

// ---------- 模板：导航 / 编辑 / 链接 / 独立窗口 ----------

describe('右键菜单 · 模板结构与禁用态', () => {
  it('back / forward 的可点性跟随 canGoBack / canGoForward', () => {
    const cold = buildStoreContextMenu(makeInput({ canGoBack: false, canGoForward: false }))
    expect(findByItemId(cold, 'back')!.enabled).toBe(false)
    expect(findByItemId(cold, 'forward')!.enabled).toBe(false)

    const backOnly = buildStoreContextMenu(makeInput({ canGoBack: true, canGoForward: false }))
    expect(findByItemId(backOnly, 'back')!.enabled).toBe(true)
    expect(findByItemId(backOnly, 'forward')!.enabled).toBe(false)

    const both = buildStoreContextMenu(makeInput({ canGoBack: true, canGoForward: true }))
    expect(findByItemId(both, 'forward')!.enabled).toBe(true)
  })

  it('非可编辑区域：cut / paste 禁用（即使平台报 canCopy/canPaste）', () => {
    const items = buildStoreContextMenu(makeInput({ isEditable: false, canCopy: true, canPaste: true }))
    expect(findByItemId(items, 'cut')!.enabled, '不可编辑时不该能剪切').toBe(false)
    expect(findByItemId(items, 'paste')!.enabled, '不可编辑时不该能粘贴').toBe(false)
    // copy 只看 canCopy（页面里选中文本就能复制，与是否可编辑无关）
    expect(findByItemId(items, 'copy')!.enabled).toBe(true)
  })

  it('可编辑且 canPaste：paste 可点；canCopy 决定 cut/copy', () => {
    const items = buildStoreContextMenu(makeInput({
      isEditable: true, canCopy: true, canPaste: true, canSelectAll: true
    }))
    expect(findByItemId(items, 'paste')!.enabled).toBe(true)
    expect(findByItemId(items, 'cut')!.enabled).toBe(true)
    expect(findByItemId(items, 'copy')!.enabled).toBe(true)
    expect(findByItemId(items, 'selectAll')!.enabled).toBe(true)

    // 可编辑但平台说不能粘贴 → 仍禁用；canCopy=false → cut 禁用、copy 禁用
    const noPaste = buildStoreContextMenu(makeInput({ isEditable: true, canCopy: false, canPaste: false }))
    expect(findByItemId(noPaste, 'paste')!.enabled).toBe(false)
    expect(findByItemId(noPaste, 'cut')!.enabled).toBe(false)
    expect(findByItemId(noPaste, 'copy')!.enabled).toBe(false)
  })

  it('链接项只在 linkUrl 非空时出现（空串 = 不是链接）', () => {
    const noLink = buildStoreContextMenu(makeInput({ linkUrl: '' }))
    expect(findByItemId(noLink, 'openLinkNewTab'), '空 linkUrl 不该出现「在新标签页中打开链接」').toBeUndefined()
    expect(findByItemId(noLink, 'copyLink'), '空 linkUrl 不该出现「复制链接地址」').toBeUndefined()

    const withLink = buildStoreContextMenu(makeInput({ linkUrl: 'https://example.com/detail?id=1' }))
    expect(findByItemId(withLink, 'openLinkNewTab')!.label).toBe('在新标签页中打开链接')
    expect(findByItemId(withLink, 'copyLink')!.label).toBe('复制链接地址')
    // 链接项不该被置灰
    expect(findByItemId(withLink, 'openLinkNewTab')!.enabled).not.toBe(false)
    expect(findByItemId(withLink, 'copyLink')!.enabled).not.toBe(false)
  })

  it('独立窗口不出现 standalone 项；默认（未传 isStandalone）出现', () => {
    const standaloneWin = buildStoreContextMenu(makeInput({ isStandalone: true }))
    expect(findByItemId(standaloneWin, 'standalone'), '独立窗口里不该再有「在独立窗口打开当前标签页」').toBeUndefined()

    const mainWin = buildStoreContextMenu(makeInput({ isStandalone: false }))
    expect(findByItemId(mainWin, 'standalone')!.label).toBe('在独立窗口打开当前标签页')

    const omitted = buildStoreContextMenu(makeInput())
    expect(omitted.some(it => it.id === 'standalone')).toBe(true)
  })

  it('用 separator 把「导航」与「编辑」分开（至少存在一个分隔项）', () => {
    const items = buildStoreContextMenu(makeInput())
    const separators = items.filter(it => it.type === 'separator')
    expect(separators.length, '菜单里必须有分隔项').toBeGreaterThanOrEqual(1)

    // 分隔项只有 type，不带 id / label
    for (const sep of separators) {
      expect(sep.id).toBeUndefined()
      expect(sep.label).toBeUndefined()
    }

    // 第一块（back/forward）与 reload 之间、reload 块与编辑块之间都应有分隔
    const ids = items.map(it => it.id ?? '|')
    expect(ids.indexOf('forward')).toBeLessThan(ids.indexOf('reload'))
    const editStart = ids.indexOf('cut')
    expect(ids.slice(0, editStart), '编辑块之前应有分隔项').toContain('|')
  })
})

// ---------- 动作分派 ----------

describe('右键菜单 · 动作分派（假 wc，不起 Electron）', () => {
  it('导航与编辑动作各自调对应的 wc 方法', () => {
    const table: Array<[StoreMenuId, string]> = [
      ['back', 'goBack'],
      ['forward', 'goForward'],
      ['reload', 'reload'],
      ['hardReload', 'reloadIgnoringCache'],
      ['cut', 'cut'],
      ['copy', 'copy'],
      ['paste', 'paste'],
      ['selectAll', 'selectAll']
    ]
    for (const [id, expected] of table) {
      const f = makeFakeDeps()
      runStoreMenuAction(id, f.deps, { linkUrl: '', probePoint: { x: 1, y: 2 } })
      expect(f.wcCalls, `${id} 应调用 ${expected}()`).toEqual([expected])
      expect(f.openedUrls, `${id} 不该碰 openUrl`).toEqual([])
      expect(f.copiedTexts, `${id} 不该碰 copyText`).toEqual([])
      expect(f.probedPoints, `${id} 不该碰元素采集`).toEqual([])
      expect(f.standaloneOpens, `${id} 不该开独立窗口`).toBe(0)
    }
  })

  it('openLinkNewTab 用 linkUrl 调 openUrl；copyLink 用 linkUrl 调 copyText', () => {
    const url = 'https://example.com/goods/10086'

    const open = makeFakeDeps()
    runStoreMenuAction('openLinkNewTab', open.deps, { linkUrl: url })
    expect(open.openedUrls).toEqual([url])
    expect(open.copiedTexts).toEqual([])
    expect(open.wcCalls).toEqual([])

    const copy = makeFakeDeps()
    runStoreMenuAction('copyLink', copy.deps, { linkUrl: url })
    expect(copy.copiedTexts).toEqual([url])
    expect(copy.openedUrls).toEqual([])
    expect(copy.wcCalls).toEqual([])
  })

  it('linkUrl 为空时链接动作是空操作（即使被误触发也不打开空白页/复制空串）', () => {
    const f = makeFakeDeps()
    runStoreMenuAction('openLinkNewTab', f.deps, { linkUrl: '' })
    runStoreMenuAction('copyLink', f.deps, { linkUrl: '' })
    expect(f.openedUrls).toEqual([])
    expect(f.copiedTexts).toEqual([])
  })

  it('standalone 调 openStandalone（恰好一次）', () => {
    const f = makeFakeDeps()
    runStoreMenuAction('standalone', f.deps, { linkUrl: '' })
    expect(f.standaloneOpens).toBe(1)
    expect(f.wcCalls).toEqual([])
  })
})

// ---------- toStoreMenuInput：把 Electron 参数收敛成保守默认值 ----------

describe('toStoreMenuInput · 缺省值收敛', () => {
  const nav = { canGoBack: true, canGoForward: false }

  it('nav 直通；editFlags 整个缺失时 canCopy/canPaste/canSelectAll 都是 false', () => {
    const input = toStoreMenuInput({}, nav)
    expect(input.canGoBack).toBe(true)
    expect(input.canGoForward).toBe(false)
    expect(input.canCopy).toBe(false)
    expect(input.canPaste).toBe(false)
    expect(input.canSelectAll).toBe(false)
  })

  it('editFlags 里的字段缺失 / 给非布尔值时也收敛成 false（不给 undefined）', () => {
    const input = toStoreMenuInput({ editFlags: { canCopy: true } }, nav)
    expect(input.canCopy).toBe(true)
    expect(input.canPaste).toBe(false)
    expect(input.canSelectAll).toBe(false)

    const js = toStoreMenuInput({ editFlags: {} }, nav)
    expect(js.canCopy).toBe(false)
    expect(js.canPaste).toBe(false)
    expect(js.canSelectAll).toBe(false)
  })

  it('linkURL 缺失时 linkUrl 是空串（不是 undefined）；isEditable 缺失时 false', () => {
    const input = toStoreMenuInput({}, nav)
    expect(input.linkUrl, 'linkUrl 必须是字符串空串，不能是 undefined').toBe('')
    expect(typeof input.linkUrl).toBe('string')
    expect(input.isEditable).toBe(false)

    const withLink = toStoreMenuInput({ linkURL: 'https://example.com/x', isEditable: true }, nav)
    expect(withLink.linkUrl).toBe('https://example.com/x')
    expect(withLink.isEditable).toBe(true)
  })

  it('opts.isStandalone 缺省 → falsy（主窗口语义，standalone 项照常出现）', () => {
    expect(toStoreMenuInput({}, nav).isStandalone).toBeFalsy()
    expect(toStoreMenuInput({}, nav, {}).isStandalone).toBeFalsy()
    expect(toStoreMenuInput({}, nav, { isStandalone: true }).isStandalone).toBe(true)
  })

  it('收敛结果直接喂给 buildStoreContextMenu：链接与编辑能力如实反映到菜单上', () => {
    const input = toStoreMenuInput(
      { linkURL: 'https://example.com/detail', isEditable: true, editFlags: { canCopy: true, canPaste: false, canSelectAll: true } },
      { canGoBack: false, canGoForward: true }
    )
    const items = buildStoreContextMenu(input)
    expect(findByItemId(items, 'back')!.enabled).toBe(false)
    expect(findByItemId(items, 'forward')!.enabled).toBe(true)
    expect(findByItemId(items, 'paste')!.enabled, 'canPaste=false → 粘贴保持禁用').toBe(false)
    expect(findByItemId(items, 'cut')!.enabled).toBe(true)
    expect(findByItemId(items, 'copy')!.enabled).toBe(true)
    expect(findByItemId(items, 'selectAll')!.enabled).toBe(true)
    expect(findByItemId(items, 'openLinkNewTab')).toBeTruthy()
    expect(findByItemId(items, 'reload')).toBeTruthy()
    expect(findByItemId(items, 'hardReload')).toBeTruthy()
    // 收敛出的 linkUrl 会被动作原样使用
    const f = makeFakeDeps()
    runStoreMenuAction('openLinkNewTab', f.deps, { linkUrl: input.linkUrl })
    expect(f.openedUrls).toEqual(['https://example.com/detail'])
  })

  it('平台参数里完全没给链接 / 编辑标记时，菜单里既无链接项、编辑项也全灰', () => {
    const items = buildStoreContextMenu(toStoreMenuInput({}, { canGoBack: false, canGoForward: false }))
    expect(findByItemId(items, 'openLinkNewTab')).toBeUndefined()
    expect(findByItemId(items, 'copyLink')).toBeUndefined()
    for (const id of ['cut', 'copy', 'paste', 'selectAll'] as StoreMenuId[]) {
      expect(findByItemId(items, id)!.enabled, `${id} 应禁用`).toBe(false)
    }
  })
})

// ---------- 元素定位信息（本次新增） ----------

/**
 * 「元素定位信息」是给**任务档案取选择器**用的：平台类名普遍带构建哈希，档案常量全靠实测，
 * 此前要开 DevTools 翻 DOM。这一组钉住三件事：
 *   ① 有落点才可点（用过期/缺失坐标采到的是别的元素，比不采集更误导人）；
 *   ② 点它只调 probeElement，不碰导航/编辑/独立窗口；
 *   ③ 坐标如实透传（不能四舍五入错、不能两个坐标搞反）。
 */
describe('右键菜单 · 元素定位信息', () => {
  it('菜单里有该项，标签点明用途', () => {
    const items = buildStoreContextMenu(makeInput())
    const probe = findByItemId(items, 'elementProbe')
    expect(probe, '缺「元素定位信息」项').toBeTruthy()
    expect(probe!.label).toContain('元素定位信息')
  })

  it('有落点时可点；无落点（键盘唤出菜单）时置灰但仍出现', () => {
    const withPoint = buildStoreContextMenu(makeInput({ probePoint: { x: 5, y: 6 } }))
    expect(findByItemId(withPoint, 'elementProbe')!.enabled).toBe(true)

    const noPoint = buildStoreContextMenu(makeInput({ probePoint: undefined }))
    const item = findByItemId(noPoint, 'elementProbe')
    expect(item, '无落点时该项应仍在菜单里（让用户知道重新右键即可）').toBeTruthy()
    expect(item!.enabled, '无落点必须置灰').toBe(false)
  })

  it('点击只调 probeElement，坐标原样透传，且不碰任何其它动作', () => {
    const f = makeFakeDeps()
    runStoreMenuAction('elementProbe', f.deps, { linkUrl: '', probePoint: { x: 321, y: 654 } })
    expect(f.probedPoints).toEqual([{ x: 321, y: 654 }])
    expect(f.wcCalls, '采集元素不该触发导航/编辑').toEqual([])
    expect(f.openedUrls).toEqual([])
    expect(f.copiedTexts, '剪贴板由 probeElement 内部负责，分派层不该直接写').toEqual([])
    expect(f.standaloneOpens).toBe(0)
  })

  it('无落点却误触发时是空操作（不采集、也不报错）', () => {
    const f = makeFakeDeps()
    runStoreMenuAction('elementProbe', f.deps, { linkUrl: '', probePoint: undefined })
    expect(f.probedPoints, '没有落点就不该采集').toEqual([])
    expect(f.wcCalls).toEqual([])
  })

  it('独立窗口里也有该项（独立窗口同样需要取锚点）', () => {
    const items = buildStoreContextMenu(makeInput({ isStandalone: true }))
    expect(findByItemId(items, 'elementProbe'), '独立窗口不该缺元素定位信息').toBeTruthy()
    expect(findByItemId(items, 'standalone')).toBeUndefined()
  })

  it('toStoreMenuInput：x/y 齐备才产出 probePoint，缺一个或非数字都不产出', () => {
    const nav = { canGoBack: false, canGoForward: false }

    expect(toStoreMenuInput({ x: 12, y: 34 }, nav).probePoint).toEqual({ x: 12, y: 34 })
    // 坐标是 0 也是合法落点（页面左上角），不能被当成"缺失"丢掉
    expect(toStoreMenuInput({ x: 0, y: 0 }, nav).probePoint, '0,0 是合法落点').toEqual({ x: 0, y: 0 })

    expect(toStoreMenuInput({ x: 12 }, nav).probePoint, '缺 y 不该产出落点').toBeUndefined()
    expect(toStoreMenuInput({ y: 34 }, nav).probePoint, '缺 x 不该产出落点').toBeUndefined()
    expect(toStoreMenuInput({}, nav).probePoint, '都没给不该产出落点').toBeUndefined()
    expect(toStoreMenuInput({ x: NaN, y: 5 }, nav).probePoint, 'NaN 不是合法坐标').toBeUndefined()
  })

  it('收敛结果直接喂给菜单：缺落点 → 该项置灰', () => {
    const items = buildStoreContextMenu(toStoreMenuInput({}, { canGoBack: false, canGoForward: false }))
    expect(findByItemId(items, 'elementProbe')!.enabled).toBe(false)
  })
})

// ---------- 翻译层契约（复核指出的"测试照绿但功能已错"缝隙） ----------

/**
 * 这一组专门防一个**静默报废**：模板对「重新加载 / 强制重新加载」不给 enabled 字段（undefined），
 * 翻译层必须用 `it.enabled !== false` 才算"可用"。若谁改成 `!!it.enabled`，
 * 两项会被双双置灰——菜单还在、但点不动，而只测模板数据的用例**全部照绿**。
 */
describe('右键菜单 · 翻译成 Electron 模板（enabled 契约 + id 透传）', () => {
  const labelOf = (x: any) => ('label' in x ? x.label : undefined)

  it('未显式置 false 的项一律 enabled=true（两项重载不能被 !!enabled 弄灰）', () => {
    const tpl = toElectronMenuTemplate(buildStoreContextMenu(makeInput()), () => {})
    const reload = tpl.find(x => labelOf(x) === '重新加载')!
    const hard = tpl.find(x => labelOf(x) === '强制重新加载（不使用缓存）')!
    expect('enabled' in reload && (reload as any).enabled, '「重新加载」必须可点').toBe(true)
    expect('enabled' in hard && (hard as any).enabled, '「强制重新加载」必须可点').toBe(true)
  })

  it('显式 enabled=false 的项在模板里确实是 disabled（不能一律放行）', () => {
    // 后退/前进在无历史时被模板显式置 false，翻译后必须仍是 false
    const tpl = toElectronMenuTemplate(buildStoreContextMenu(makeInput({ canGoBack: false, canGoForward: false })), () => {})
    const back = tpl.find(x => labelOf(x) === '后退')!
    expect('enabled' in back && (back as any).enabled).toBe(false)
  })

  it('分隔项不含 enabled/click（避免把 separator 当按钮）', () => {
    const tpl = toElectronMenuTemplate(buildStoreContextMenu(makeInput()), () => {})
    const seps = tpl.filter(x => (x as any).type === 'separator')
    expect(seps.length, '至少要有一个分隔项').toBeGreaterThan(0)
    for (const s of seps) {
      expect('enabled' in s).toBe(false)
      expect('click' in s).toBe(false)
    }
  })

  it('点任意项都按它自己的 id 回调（防翻译层把两项都接到同一个 id）', () => {
    const seen: string[] = []
    const tpl = toElectronMenuTemplate(buildStoreContextMenu(makeInput()), id => seen.push(id))
    const click = (label: string) => (tpl.find(x => labelOf(x) === label) as any).click()
    click('重新加载')
    click('强制重新加载（不使用缓存）')
    click('全选')
    expect(seen).toEqual(['reload', 'hardReload', 'selectAll'])
  })
})
