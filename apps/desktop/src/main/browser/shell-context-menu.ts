/**
 * 壳层（主窗口渲染层）的右键菜单 —— 2026-11-15 补。
 *
 * 【为什么要补】
 * Electron **默认没有右键菜单**（只有 macOS 的 WebView 才有系统菜单）。店铺页面是 webview guest，
 * 主进程给 guest 挂了 `attachStoreContextMenu`；但**壳层自己的输入框**（地址栏、店铺搜索、新建店铺
 * 表单、任务表单、设置项…）一直没有任何菜单 —— 用户右键点地址栏，什么都不弹，"复制/粘贴"只能靠
 * 键盘。用户实报的「网址栏不能复制粘贴」就是这个（真机核实：Ctrl+C/Ctrl+V 正常，右键无菜单）。
 *
 * 【为什么和 store-context-menu 分开】
 * 壳层没有"后退/前进/重载/链接/元素定位"这些浏览能力，硬塞进同一个模板只会让两边都难读；
 * 这里只做编辑类动作（撤销/重做/剪切/复制/粘贴/全选），guest 那边继续用它自己的模板。
 *
 * 【模板/动作/翻译三层都做成纯函数】
 * 单测直接断言"该出现哪些项、哪项该灰、点了调哪个方法"，不需要起 Electron。
 */

export type ShellMenuId = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export interface ShellMenuInput {
  /** 右键落点是否在可编辑控件里（输入框/文本域/contenteditable） */
  isEditable: boolean
  /** 未聚焦的输入框里也可能有选中文本，只有"非编辑区"才用它决定是否给「复制」 */
  hasSelection: boolean
  canUndo: boolean
  canRedo: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
}

export interface ShellMenuItem {
  id?: ShellMenuId
  label?: string
  type?: 'separator'
  enabled?: boolean
}

/**
 * 组装菜单结构（纯函数）。
 *
 * - 编辑区：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选，按 `editFlags` 决定是否置灰
 *   ——置灰而不是隐藏：菜单项时有时无会让人以为"功能没了"。
 * - 非编辑区但选中了文字：只给「复制」（含地址栏里用鼠标选中的地址）。
 * - 非编辑区且没选中：**返回空数组**，调用方据此不弹菜单，避免弹一个全灰的空壳。
 */
export function buildShellContextMenu(input: ShellMenuInput): ShellMenuItem[] {
  if (input.isEditable) {
    return [
      { id: 'undo', label: '撤销', enabled: input.canUndo },
      { id: 'redo', label: '重做', enabled: input.canRedo },
      { type: 'separator' },
      { id: 'cut', label: '剪切', enabled: input.canCut },
      { id: 'copy', label: '复制', enabled: input.canCopy },
      { id: 'paste', label: '粘贴', enabled: input.canPaste },
      { type: 'separator' },
      { id: 'selectAll', label: '全选', enabled: input.canSelectAll }
    ]
  }
  if (input.hasSelection) return [{ id: 'copy', label: '复制', enabled: input.canCopy }]
  return []
}

/** 执行菜单动作所需的最小 WebContents 形状（便于单测传假对象） */
export interface ShellMenuWebContents {
  undo(): void
  redo(): void
  cut(): void
  copy(): void
  paste(): void
  selectAll(): void
}

/** 按菜单项 id 执行动作（纯分派） */
export function runShellMenuAction(id: ShellMenuId, wc: ShellMenuWebContents): void {
  switch (id) {
    case 'undo': return wc.undo()
    case 'redo': return wc.redo()
    case 'cut': return wc.cut()
    case 'copy': return wc.copy()
    case 'paste': return wc.paste()
    case 'selectAll': return wc.selectAll()
  }
}

/** Electron context-menu 事件参数里我们真正用到的字段（子集，便于单测构造） */
export interface ShellContextMenuParams {
  isEditable?: boolean
  selectionText?: string
  editFlags?: {
    canUndo?: boolean
    canRedo?: boolean
    canCut?: boolean
    canCopy?: boolean
    canPaste?: boolean
    canSelectAll?: boolean
  }
}

/** 把 Electron 参数收敛成模板输入：undefined 一律兜成"不可用"，别让菜单项假装能点 */
export function toShellMenuInput(params: ShellContextMenuParams): ShellMenuInput {
  const flags = params.editFlags || {}
  return {
    isEditable: !!params.isEditable,
    hasSelection: String(params.selectionText || '').length > 0,
    canUndo: !!flags.canUndo,
    canRedo: !!flags.canRedo,
    canCut: !!flags.canCut,
    canCopy: !!flags.canCopy,
    canPaste: !!flags.canPaste,
    canSelectAll: !!flags.canSelectAll
  }
}

/** 交给 `Menu.buildFromTemplate` 的最小形状 */
export type ElectronShellMenuItem = { type: 'separator' } | { label: string; enabled: boolean; click: () => void }

/**
 * 结构 → Electron 模板（纯函数）。
 *
 * `enabled !== false` 而不是 `!!enabled`：模板里不写 enabled 表示"可用"，
 * 用 `!!` 会把它们全部置灰——菜单在、点不动，而只测模板数据的单测照样全绿。
 * （store-context-menu 里踩过同一个坑，这里用同一套写法。）
 */
export function toShellMenuTemplate(
  items: ShellMenuItem[],
  onPick: (id: ShellMenuId) => void
): ElectronShellMenuItem[] {
  return items.map(item => {
    if (item.type === 'separator') return { type: 'separator' as const }
    const id = item.id as ShellMenuId
    return {
      label: item.label as string,
      enabled: item.enabled !== false,
      click: () => onPick(id)
    }
  })
}
