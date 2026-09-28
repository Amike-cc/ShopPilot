/**
 * 家族级 IPC 注册器（2026-09-26 审计 P2-C）。
 *
 * 在此之前只有 Agent / AI 两个家族带可信渲染层校验，其余 8 个家族（店铺、浏览器、任务、
 * 设置、代理备份、会话安全、书签下载、更新）共 92 个通道都是裸 `ipcMain.handle`。
 * 今天能执行脚本的渲染层只有应用主窗口（store 视图与弹窗都没有业务 preload），
 * 所以这不是"已被利用的洞"，但**新增 preload 或视图类型时会静默多出一批可达的高危通道**
 * （改店铺凭据、清 Cookie、恢复备份、改设置）。这里把它变成一条统一、可测的规则：
 *
 *   · 发送方必须是应用主窗口的 webContents（其它 webContents 一律 IPC_FORBIDDEN）；
 *   · 应用锁定时拒绝，除非该家族显式 `allowWhenLocked`（只有解锁/锁状态这类通道可以）。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { assertTrustedRenderer } from '../services/renderer-trust'

export type FamilyHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

/**
 * 为一个 IPC 家族生成带校验的注册函数。用法：
 *   const handle = familyHandle('店铺管理')
 *   handle(IPC_CHANNELS.STORE_LIST, async (_e, input) => { ... })
 *
 * 少数通道需要单独放行锁定态（例如标题栏底色这种纯装饰通道：应用锁界面本身要靠它
 * 把标题栏刷成锁屏底色），用第三个参数按通道覆盖：
 *   handle(IPC_CHANNELS.WINDOW_SET_TITLEBAR_OVERLAY, fn, { allowWhenLocked: true })
 */
export function familyHandle(feature: string, options: { allowWhenLocked?: boolean } = {}) {
  return (
    channel: string,
    handler: FamilyHandler,
    perChannel: { allowWhenLocked?: boolean } = {}
  ): void => {
    const allowWhenLocked = perChannel.allowWhenLocked ?? options.allowWhenLocked === true
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: any[]) => {
      assertTrustedRenderer(event, {
        forbiddenCode: 'IPC_FORBIDDEN',
        feature,
        allowWhenLocked
      })
      try {
        return await handler(event, ...args)
      } catch (error) {
        // 兜底：handler 内部 try-catch 漏出的异常也必须回 IPCResult 信封——否则渲染层
        // 拿到的是 Electron 原生 invoke rejection（"Error invoking remote method ..."），
        // 绕开 {ok,error} 契约直穿 UI。可信校验失败仍按原样抛出（不在此捕获）。
        return {
          ok: false,
          error: {
            code: String((error as any)?.code || 'INTERNAL_ERROR'),
            message: String((error as any)?.message || error)
          },
          requestId: randomUUID()
        }
      }
    })
  }
}
