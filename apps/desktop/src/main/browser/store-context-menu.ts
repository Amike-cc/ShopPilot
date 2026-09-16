/**
 * 店铺页面（WebContentsView）的右键菜单 —— §4.3 浏览器能力
 *
 * 【为什么必须用原生菜单，不能用渲染层的 HTML 菜单】
 * 店铺页面是原生 `WebContentsView`，在窗口内容区里**永远画在渲染层 HTML 之上**。
 * 所以渲染层的 HTML 菜单有两条路都不通：
 *   ① 直接显示 → 被页面盖住，用户根本看不见；
 *   ② 先摘掉视图再显示 → 页面当场消失（白屏），右键一下页面没了。
 * Electron 的 `Menu.popup()` 是操作系统级弹窗，不受这个层级限制，所以走原生菜单。
 *
 * 【为什么模板与动作分开】
 * 模板 `buildStoreContextMenu` 是**纯函数**（单测直接断言标签/顺序/禁用态），
 * 动作 `runStoreMenuAction` 只依赖一个最小的 WebContents 形状（单测传假对象即可，
 * 不需要起 Electron）。这样"菜单项该不该可点""点了调哪个方法"都能在单测里钉住。
 */

export type StoreMenuId =
  | 'back'
  | 'forward'
  | 'reload'
  | 'hardReload'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'openLinkNewTab'
  | 'copyLink'
  | 'standalone'

export interface StoreMenuInput {
  /** 能否后退 / 前进（决定这两项是否可点） */
  canGoBack: boolean
  canGoForward: boolean
  /** 右键落点是否在可编辑控件内（剪切/粘贴的必要条件） */
  isEditable: boolean
  /** 平台给出的编辑能力标记（选中文本时 canCopy 才为真） */
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
  /** 右键是否落在链接上（空串 = 不是链接） */
  linkUrl: string
  /**
   * 是否身处独立窗口。独立窗口里不该再出现「在独立窗口打开当前标签页」——
   * 那项只在主窗口的标签页上有意义。
   */
  isStandalone?: boolean
}

export interface StoreMenuItem {
  id?: StoreMenuId
  label?: string
  type?: 'separator'
  enabled?: boolean
}

/**
 * 组装菜单结构（纯函数）。
 *
 * 顺序沿用浏览器惯例：导航在最上、编辑在中、链接相关靠近链接、窗口类操作垫底。
 * 「重新加载」与「强制重新加载」**并排**给出——平台页面常把静态资源/接口响应缓存住
 * （换了账号或改了配置还是旧页面），这时只有忽略缓存的重载能救，别让用户自己去清缓存。
 */
export function buildStoreContextMenu(input: StoreMenuInput): StoreMenuItem[] {
  const items: StoreMenuItem[] = [
    { id: 'back', label: '后退', enabled: input.canGoBack },
    { id: 'forward', label: '前进', enabled: input.canGoForward },
    { type: 'separator' },
    { id: 'reload', label: '重新加载' },
    { id: 'hardReload', label: '强制重新加载（不使用缓存）' }
  ]

  if (input.linkUrl) {
    items.push(
      { type: 'separator' },
      // 独立窗口没有标签页，链接只能在本窗口打开——文案跟着场景走，别让用户以为会开新标签页
      // （审计发现：原先两处共用「在新标签页中打开链接」，独立窗口里实为原地导航，属文案误导）
      { id: 'openLinkNewTab', label: input.isStandalone ? '在当前窗口打开链接' : '在新标签页中打开链接' },
      { id: 'copyLink', label: '复制链接地址' }
    )
  }

  items.push(
    { type: 'separator' },
    { id: 'cut', label: '剪切', enabled: input.isEditable && input.canCopy },
    { id: 'copy', label: '复制', enabled: input.canCopy },
    { id: 'paste', label: '粘贴', enabled: input.isEditable && input.canPaste },
    { id: 'selectAll', label: '全选', enabled: input.canSelectAll }
  )

  if (!input.isStandalone) {
    items.push({ type: 'separator' }, { id: 'standalone', label: '在独立窗口打开当前标签页' })
  }

  return items
}

/** 执行菜单动作所需要的最小 WebContents 形状（便于单测传假对象） */
export interface StoreMenuWebContents {
  goBack(): void
  goForward(): void
  reload(): void
  /** 忽略缓存的整页重载（对应「强制重新加载」） */
  reloadIgnoringCache(): void
  cut(): void
  copy(): void
  paste(): void
  selectAll(): void
}

export interface StoreMenuDeps {
  wc: StoreMenuWebContents
  /** 用新标签页打开链接（主窗口传 createTab；独立窗口传 win.loadURL） */
  openUrl(url: string): void
  /** 写系统剪贴板 */
  copyText(text: string): void
  /** 在独立窗口打开当前标签页（独立窗口场景传空实现） */
  openStandalone(): void
}

/** 按菜单项 id 执行动作（纯分派，便于单测用假 wc 断言"点了调哪个方法"） */
export function runStoreMenuAction(id: StoreMenuId, deps: StoreMenuDeps, ctx: { linkUrl: string }): void {
  switch (id) {
    case 'back': return deps.wc.goBack()
    case 'forward': return deps.wc.goForward()
    case 'reload': return deps.wc.reload()
    case 'hardReload': return deps.wc.reloadIgnoringCache()
    case 'cut': return deps.wc.cut()
    case 'copy': return deps.wc.copy()
    case 'paste': return deps.wc.paste()
    case 'selectAll': return deps.wc.selectAll()
    case 'openLinkNewTab': if (ctx.linkUrl) deps.openUrl(ctx.linkUrl); return
    case 'copyLink': if (ctx.linkUrl) deps.copyText(ctx.linkUrl); return
    case 'standalone': return deps.openStandalone()
  }
}

/** 交给 `Menu.buildFromTemplate` 的最小形状（只列本模块产出的字段） */
export type ElectronMenuItem = { type: 'separator' } | { label: string; enabled: boolean; click: () => void }

/**
 * 把「菜单结构（纯数据）」翻译成「Electron 模板」——**也做成纯函数**，理由是这条翻译里
 * 藏着一个会让功能整体报废的陷阱：
 *
 *   `buildStoreContextMenu` 对「重新加载 / 强制重新加载」**不写 enabled 字段**（表示"可用"），
 *   所以这里必须用 `it.enabled !== false`。若有人图省事写成 `!!it.enabled`，
 *   这两项会因为 `undefined` 而被**双双置灰**——右键菜单还在、但两项点不动，
 *   而只测模板数据的单测**全部照绿**（复核实测指出过这个缝隙）。
 *   抽出来就能把这条契约钉在单测里。
 */
export function toElectronMenuTemplate(
  items: StoreMenuItem[],
  onPick: (id: StoreMenuId) => void
): ElectronMenuItem[] {
  return items.map(it => {
    if (it.type === 'separator') return { type: 'separator' as const }
    const id = it.id as StoreMenuId
    return {
      label: it.label as string,
      enabled: it.enabled !== false,
      click: () => onPick(id)
    }
  })
}

/** Electron 的 context-menu 事件参数里我们真正用到的字段（子集，便于单测构造） */
export interface StoreContextMenuParams {
  isEditable?: boolean
  linkURL?: string
  editFlags?: { canCopy?: boolean; canPaste?: boolean; canSelectAll?: boolean }
}

/** 把 Electron 的 context-menu 参数收敛成模板输入（顺带把 undefined 兜成保守默认值） */
export function toStoreMenuInput(
  params: StoreContextMenuParams,
  nav: { canGoBack: boolean; canGoForward: boolean },
  opts?: { isStandalone?: boolean }
): StoreMenuInput {
  return {
    canGoBack: nav.canGoBack,
    canGoForward: nav.canGoForward,
    isEditable: !!params.isEditable,
    canCopy: !!params.editFlags?.canCopy,
    canPaste: !!params.editFlags?.canPaste,
    canSelectAll: !!params.editFlags?.canSelectAll,
    linkUrl: String(params.linkURL || ''),
    isStandalone: !!opts?.isStandalone
  }
}
