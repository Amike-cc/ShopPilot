/**
 * 渲染层可信校验 —— 单一事实来源（2026-09-26 审计 P1）。
 *
 * 这条检查原先在三个地方各写了一遍（`ipc/agent-handlers.ts`、`ipc/agent-domain-handlers.ts`
 * 各一份，`services/agent-observer.ts` 另有一份"仅查锁"的版本），彼此措辞与错误码并不一致；
 * 而**所有其它 IPC 家族**（`ai-handlers` 的配置与 Key、店铺、设置、备份…）根本没有这道检查——
 * 任何能执行脚本的渲染层（例如被注入的第三方页面内容逃逸到渲染进程）都能直接调
 * `ai:key:set` / `ai:config:set` 这类通道。
 *
 * 判定本身在 `renderer-trust-rules.ts`（纯函数，可单测）；本模块只做 electron 侧取值与抛错。
 */

import type { IpcMainInvokeEvent } from 'electron'
import { getBrowserHostWindow } from '../browser/window-manager'
import { isAppLocked } from './security-manager'
import { evaluateRendererTrust, type RendererForbiddenCode } from './renderer-trust-rules'

/** 校验当前调用方；不可信时抛出带 `code` 的错误（调用方按既有错误映射返回给渲染层）。 */
export function assertTrustedRenderer(
  event: IpcMainInvokeEvent | null | undefined,
  options: { forbiddenCode?: RendererForbiddenCode; feature?: string; allowWhenLocked?: boolean } = {}
): void {
  const host = getBrowserHostWindow()
  const verdict = evaluateRendererTrust({
    hostWebContentsId: host && !host.isDestroyed() ? host.webContents.id : null,
    senderWebContentsId: (event as { sender?: { id?: number } } | null | undefined)?.sender?.id ?? null,
    locked: isAppLocked(),
    forbiddenCode: options.forbiddenCode,
    feature: options.feature,
    allowWhenLocked: options.allowWhenLocked
  })
  if (verdict.ok) return
  const error = new Error(verdict.message || '调用被拒绝')
  ;(error as any).code = verdict.code
  throw error
}
