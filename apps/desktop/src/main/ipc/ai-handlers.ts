/**
 * 大模型（AI）配置 IPC - §4.4
 *
 * 安全约定：
 * - **AI Key 只在主进程**：`ai:config:get` 只返回 `hasKey: boolean`，任何通道都不回传 Key 明文；
 * - 非敏感项（endpoint/model/timeoutMs）走 app_settings 明文存储，与其它设置一致；
 * - 失败一律如实返回错误码（`AI_NOT_CONFIGURED` / `AI_BAD_ENDPOINT` / `AI_TIMEOUT` / `AI_REQUEST_FAILED` …），
 *   不做静默重试或假装成功。
 */

import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { getDatabase } from '../db/database'
import * as AiClient from '../services/ai-client'
import { saveAiKey, deleteAiKey, hasAiKey } from '../services/credential-store'
import { writeAudit } from '../services/audit-logger'
import { logMain } from '../services/logger'

const success = <T>(data: T): IPCResult<T> => ({ ok: true, data, requestId: randomUUID() })
const failure = (code: string, message: string): IPCResult => ({ ok: false, error: { code, message }, requestId: randomUUID() })

function putSetting(key: string, value: unknown): void {
  getDatabase().prepare(`
    INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), Date.now())
}

export function registerAiHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.AI_CONFIG_GET, (): IPCResult => {
    try {
      return success(AiClient.getAiConfig())
    } catch (e: any) {
      return failure('AI_CONFIG_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_CONFIG_SET, (_e, input: { endpoint?: string; model?: string; timeoutMs?: number }): IPCResult => {
    try {
      if (input?.endpoint !== undefined) putSetting('ai.endpoint', String(input.endpoint).trim().slice(0, 500))
      if (input?.model !== undefined) putSetting('ai.model', String(input.model).trim().slice(0, 120))
      if (input?.timeoutMs !== undefined) {
        const t = Number(input.timeoutMs)
        if (!Number.isFinite(t)) return failure('AI_BAD_INPUT', '超时必须是数字（毫秒）')
        putSetting('ai.timeoutMs', Math.min(Math.max(Math.round(t), 3000), 120000))
      }
      return success(AiClient.getAiConfig())
    } catch (e: any) {
      return failure('AI_CONFIG_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_KEY_SET, (_e, input: { key: string }): IPCResult => {
    try {
      const key = String(input?.key || '').trim()
      if (key.length < 8) return failure('AI_BAD_INPUT', 'API Key 过长或过短，请检查')
      saveAiKey(key)
      writeAudit('ai.keySet', 'success', { requestId: 'ai_cred.key' })
      logMain('info', '[ai] API Key 已更新（safeStorage 加密存储，不回显）')
      return success({ hasKey: hasAiKey() })
    } catch (e: any) {
      writeAudit('ai.keySet', 'failure', { requestId: 'ai_cred.key' })
      return failure('AI_KEY_SAVE_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_KEY_CLEAR, (): IPCResult => {
    try {
      deleteAiKey()
      writeAudit('ai.keyClear', 'success', { requestId: 'ai_cred.key' })
      return success({ hasKey: false })
    } catch (e: any) {
      return failure('AI_KEY_CLEAR_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_TEST, async (): Promise<IPCResult> => {
    const r = await AiClient.testAiConnection()
    writeAudit('ai.test', r.ok ? 'success' : 'failure', { requestId: r.ok ? 'ai:test' : r.code })
    return r.ok ? success(r) : failure(r.code, r.message)
  })

  // 获取可用模型：只读接口，失败如实回错误码（不返回任何编造的模型名）
  ipcMain.handle(IPC_CHANNELS.AI_MODELS_LIST, async (): Promise<IPCResult> => {
    try {
      const r = await AiClient.listModels()
      writeAudit('ai.models', 'success', { requestId: `ai:models:${r.models.length}` })
      return success(r)
    } catch (e: any) {
      const code = e instanceof AiClient.AiError ? e.code : 'AI_REQUEST_FAILED'
      const message = String(e?.message || e).replace(/^[A-Z_]+:\s*/, '')
      writeAudit('ai.models', 'failure', { requestId: code })
      logMain('warn', `[ai] 获取可用模型失败 ${code}: ${message}`)
      return failure(code, message)
    }
  })
}
