import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildShellContextMenu,
  runShellMenuAction,
  toShellMenuInput,
  toShellMenuTemplate,
  type ShellMenuWebContents
} from '../../apps/desktop/src/main/browser/shell-context-menu'

/**
 * 壳层右键菜单（2026-11-15）。
 *
 * 起因：Electron 默认没有右键菜单，壳层输入框（含地址栏）右键无反应，用户实报
 * 「网址栏不能复制粘贴」。这里钉住三件事：编辑区给全编辑项且按 editFlags 置灰、
 * 非编辑区有选中只给复制、两者都不是时**不弹菜单**（空数组）。
 */

const allFalse = {
  canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false
}

function fakeWc(): { wc: ShellMenuWebContents; calls: string[] } {
  const calls: string[] = []
  const record = (name: string) => () => { calls.push(name) }
  return {
    calls,
    wc: {
      undo: record('undo'),
      redo: record('redo'),
      cut: record('cut'),
      copy: record('copy'),
      paste: record('paste'),
      selectAll: record('selectAll')
    }
  }
}

describe('壳层右键菜单结构', () => {
  it('编辑区：撤销/重做/剪切/复制/粘贴/全选，顺序与浏览器一致', () => {
    const items = buildShellContextMenu({ ...toShellMenuInput({ isEditable: true }), canUndo: true, canCopy: true, canPaste: true, canSelectAll: true })
    const labels = items.filter(item => item.type !== 'separator').map(item => item.label)
    expect(labels).toEqual(['撤销', '重做', '剪切', '复制', '粘贴', '全选'])
    // 分隔线把"历史/剪切复制粘贴/全选"三组分开
    expect(items.filter(item => item.type === 'separator')).toHaveLength(2)
  })

  it('编辑区里不可用的项置灰而不是隐藏（菜单项时有时无更难懂）', () => {
    const items = buildShellContextMenu(toShellMenuInput({ isEditable: true, editFlags: allFalse }))
    const byLabel = new Map(items.filter(item => item.type !== 'separator').map(item => [item.label, item.enabled]))
    expect(byLabel.get('粘贴')).toBe(false)
    expect(byLabel.get('复制')).toBe(false)
    expect(byLabel.size).toBe(6)
  })

  it('非编辑区但选中了文字：只给「复制」', () => {
    const items = buildShellContextMenu(toShellMenuInput({ isEditable: false, selectionText: 'https://a.b', editFlags: { canCopy: true } }))
    expect(items).toEqual([{ id: 'copy', label: '复制', enabled: true }])
  })

  it('非编辑区且没有选中：返回空数组（调用方据此不弹菜单）', () => {
    expect(buildShellContextMenu(toShellMenuInput({ isEditable: false, selectionText: '', editFlags: { canCopy: false } }))).toEqual([])
  })

  it('Electron 参数缺字段时一律当"不可用"，不假装能点', () => {
    expect(toShellMenuInput({})).toEqual({
      isEditable: false,
      hasSelection: false,
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false
    })
  })
})

describe('壳层右键菜单动作与模板', () => {
  it('点了哪项就调哪个方法', () => {
    const { wc, calls } = fakeWc()
    for (const id of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const) runShellMenuAction(id, wc)
    expect(calls).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  })

  it('模板不写 enabled 的项必须保持可用（写成 !!enabled 会全灰）', () => {
    const template = toShellMenuTemplate([{ id: 'copy', label: '复制' }], () => {})
    expect(template).toHaveLength(1)
    expect((template[0] as { enabled: boolean }).enabled).toBe(true)
  })

  it('模板点击回调把 id 传回去，分隔线不挂回调', () => {
    const picked: string[] = []
    const template = toShellMenuTemplate(
      [{ id: 'paste', label: '粘贴', enabled: true }, { type: 'separator' }],
      id => picked.push(id)
    )
    ;(template[0] as { click: () => void }).click()
    expect(picked).toEqual(['paste'])
    expect(template[1]).toEqual({ type: 'separator' })
  })
})

describe('壳层右键菜单接线', () => {
  const mainIndex = readFileSync('apps/desktop/src/main/index.ts', 'utf8')

  it('主窗口挂上了 context-menu，并走同一套构建/执行函数', () => {
    expect(mainIndex).toContain("shellWin.webContents.on('context-menu'")
    expect(mainIndex).toContain('buildShellContextMenu(toShellMenuInput(params))')
    expect(mainIndex).toContain('Menu.buildFromTemplate(toShellMenuTemplate(')
    expect(mainIndex).toContain('runShellMenuAction(id, shellWin.webContents)')
  })

  it('菜单为空时不弹空壳（用户在空白处右键不该看到全灰菜单）', () => {
    expect(mainIndex).toContain('if (!items.length) return')
  })
})
