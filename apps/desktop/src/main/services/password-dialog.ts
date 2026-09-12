/**
 * 主进程托管密码对话框 - §6.3 约束：导出/导入密码不经过 Renderer、不走业务 IPC 通道。
 * 独立小窗（专用最小 preload），结果仅回主进程；取消/超时返回 null。
 *
 * 验收钩子：环境变量 SHOPILOT_TEST_PASSWORD 存在时直接以该值应答（仅测试环境注入；
 * 生产运行不设置该变量则始终走真实对话框）。
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { logMain } from './logger'

export interface AskOptions {
  title: string
  detail?: string
  detail2?: string
  /** 密码模式要求两次输入一致 */
  requireConfirm?: boolean
}

let handlerInstalled = false
let active = false

function ensureHandler(): void {
  if (handlerInstalled) return
  handlerInstalled = true
  // 该通道只被本对话框窗口触达（应用主窗口无此发送方）
}

/** 资源目录解析：开发态与应用打包（asar）态路径不同，逐候选探测避免空白对话框 */
function resourceDir(): string {
  const candidates = [
    join(__dirname, '..', '..', 'resources', 'pw-dialog'), // out/main → apps/desktop/resources（开发与 asar 内一致）
    join(app.getAppPath(), 'apps', 'desktop', 'resources', 'pw-dialog'),
    join(app.getAppPath(), 'resources', 'pw-dialog'),
    join(process.resourcesPath, 'apps', 'desktop', 'resources', 'pw-dialog')
  ]
  for (const c of candidates) {
    try { if (existsSync(join(c, 'index.html'))) return c } catch { /* 继续探测 */ }
  }
  return candidates[0]
}

function htmlPath(): string {
  return join(resourceDir(), 'index.html')
}

function preloadPath(): string {
  return join(resourceDir(), 'preload.cjs')
}

function runWindow(query: Record<string, string>, timeoutMs = 180000): Promise<string | null> {
  ensureHandler()
  if (active) return Promise.reject(new Error('DIALOG_BUSY: 已有密码/确认对话框在处理中'))
  active = true
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 420, height: query.mode === 'confirm' ? 240 : 300,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      title: 'ShopPilot 安全确认', autoHideMenuBar: true, backgroundColor: '#14161c',
      webPreferences: { preload: preloadPath(), contextIsolation: true, sandbox: true }
    })
    let settled = false
    const finish = (v: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener('pw-dialog:done', onDone)
      active = false
      if (win && !win.isDestroyed()) win.close()
      resolve(v)
    }
    const onDone = (e: Electron.IpcMainEvent, value: unknown) => {
      if (e.sender !== win.webContents) return // 仅接受本窗口的应答
      finish(value === null || value === undefined ? null : String(value))
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    ipcMain.on('pw-dialog:done', onDone)
    win.on('closed', () => finish(null))
    // 加载失败必须留痕（否则用户只会看到一个空白确认窗，无从排查）
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      logMain('error', `对话框页面加载失败 code=${code} desc=${desc} url=${url}`)
      finish(null)
    })
    win.webContents.on('render-process-gone', (_e, d) => {
      logMain('error', `对话框渲染进程退出 reason=${d.reason}`)
      finish(null)
    })
    win.loadFile(htmlPath(), { query })
  })
}

/** 采集密码；取消返回 null */
export async function askPassword(opts: AskOptions): Promise<string | null> {
  if (process.env.SHOPILOT_TEST_PASSWORD) return process.env.SHOPILOT_TEST_PASSWORD
  return runWindow({
    mode: 'password',
    title: opts.title,
    detail: opts.detail || '',
    detail2: opts.detail2 || '',
    confirm: opts.requireConfirm ? '1' : '0'
  })
}

export interface ConfirmOptions {
  title: string
  detail?: string
  /** 风险操作（红色按钮 + "确认执行"文案） */
  danger?: boolean
  detail2?: string
}

/** 人工确认；取消返回 false - §6.3 / §13 */
export async function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  if (process.env.SHOPILOT_TEST_AUTOCONFIRM === '1') return true
  const r = await runWindow({
    mode: 'confirm',
    title: opts.title,
    detail: opts.detail || '',
    detail2: opts.detail2 || '',
    danger: opts.danger ? '1' : '0'
  })
  return r === 'true'
}
