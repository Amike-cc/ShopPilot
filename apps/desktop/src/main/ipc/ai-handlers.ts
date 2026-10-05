/**
 * 大模型（AI）配置 IPC - §4.4
 *
 * 安全约定：
 * - **AI Key 只在主进程**：`ai:config:get` 只返回 `hasKey: boolean`，任何通道都不回传 Key 明文；
 * - 非敏感项（endpoint/model/timeoutMs）走 app_settings 明文存储，与其它设置一致；
 * - 失败一律如实返回错误码（`AI_NOT_CONFIGURED` / `AI_BAD_ENDPOINT` / `AI_TIMEOUT` / `AI_REQUEST_FAILED` …），
 *   不做静默重试或假装成功。
 */

import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { AI_IMAGE_SETTING_KEYS, AI_IMAGE_TEXT_SETTING_KEYS, AI_IMAGE_TIMEOUT_MAX_MS, AI_TIMEOUT_MAX_MS, AI_TIMEOUT_MIN_MS } from '@shared/constants/ai'
import { getDatabase } from '../db/database'
import * as AiClient from '../services/ai-client'
import { deleteAiImageKey, deleteAiImageTextKey, deleteAiKey, hasAiImageKey, hasAiImageTextKey, hasAiKey, saveAiImageKey, saveAiImageTextKey, saveAiKey } from '../services/credential-store'
import { writeAudit, auditRequestId } from '../services/audit-logger'
import { logMain } from '../services/logger'
import { syncMainAgentProfileFromAiConfig } from '../services/agent-runtime'
import { assertTrustedRenderer } from '../services/renderer-trust'

const success = <T>(data: T): IPCResult<T> => ({ ok: true, data, requestId: randomUUID() })
const failure = (code: string, message: string): IPCResult => ({ ok: false, error: { code, message }, requestId: randomUUID() })

/**
 * 可信调用方校验（审计 P1）：这一族通道原来没有任何校验，而它们能改 AI 配置、写/清 API Key。
 * 校验失败时不再落到各 handler 自己的错误码上，而是如实回 APP/AI 家族的错误码。
 */
function assertTrusted(event: IpcMainInvokeEvent): void {
  assertTrustedRenderer(event, { forbiddenCode: 'AI_FORBIDDEN', feature: 'AI 配置' })
}

/** 把可信校验抛出的错误映射成 IPC 失败结果；不是这类错误则返回 null（交给原 handler 的错误处理）。 */
function deniedResult(error: unknown): IPCResult | null {
  const code = String((error as any)?.code || '')
  if (code === 'AI_FORBIDDEN' || code === 'APP_LOCKED') return failure(code, String((error as any)?.message || '调用被拒绝'))
  return null
}

function putSetting(key: string, value: unknown): void {
  getDatabase().prepare(`
    INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), Date.now())
}

export function registerAiHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.AI_CONFIG_GET, (event: IpcMainInvokeEvent): IPCResult => {
    try {
      assertTrusted(event)
      return success(AiClient.getAiConfig())
    } catch (e: any) {
      return deniedResult(e) ?? failure('AI_CONFIG_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_CONFIG_SET, (event: IpcMainInvokeEvent, input: { endpoint?: string; model?: string; timeoutMs?: number }): IPCResult => {
    // 改模型地址/模型名会直接改变"哪个模型在替用户干活"，属于必须留痕的配置变更
    // （审计 P2：这条通道此前既无审计也无日志），requestId 里带上变更字段名。
    const requestId = randomUUID()
    const changed: string[] = []
    try {
      assertTrusted(event)
      if (input?.endpoint !== undefined) { putSetting('ai.endpoint', String(input.endpoint).trim().slice(0, 500)); changed.push('endpoint') }
      if (input?.model !== undefined) { putSetting('ai.model', String(input.model).trim().slice(0, 120)); changed.push('model') }
      if (input?.timeoutMs !== undefined) {
        const t = Number(input.timeoutMs)
        if (!Number.isFinite(t)) {
          writeAudit('ai.config', 'failure', { requestId: auditRequestId(requestId, 'AI_BAD_INPUT') })
          return failure('AI_BAD_INPUT', '超时必须是数字（毫秒）')
        }
        putSetting('ai.timeoutMs', Math.min(Math.max(Math.round(t), 3000), 120000))
        changed.push('timeoutMs')
      }
      // The visible root-ceo Agent uses the dedicated Profile backed by this
      // legacy AI configuration.  Child Agents without an explicit binding
      // resolve to that Profile in Main at Job/chat snapshot time.
      syncMainAgentProfileFromAiConfig()
      if (changed.length) {
        writeAudit('ai.config', 'success', { requestId: auditRequestId(requestId, changed.join(',')) })
        logMain('info', `[ai] 模型配置已更新：${changed.join(',')}（不含 API Key）`)
      }
      return success(AiClient.getAiConfig())
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      writeAudit('ai.config', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_CONFIG_FAILED')) })
      return failure('AI_CONFIG_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_KEY_SET, (event: IpcMainInvokeEvent, input: { key: string }): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const key = String(input?.key || '').trim()
      if (key.length < 8) {
        writeAudit('ai.keySet', 'failure', { requestId: auditRequestId(requestId, 'AI_BAD_INPUT') })
        return failure('AI_BAD_INPUT', 'API Key 过长或过短，请检查')
      }
      saveAiKey(key)
      writeAudit('ai.keySet', 'success', { requestId })
      logMain('info', '[ai] API Key 已更新（safeStorage 加密存储，不回显）')
      return success({ hasKey: hasAiKey() })
    } catch (e: any) {
      writeAudit('ai.keySet', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_KEY_SAVE_FAILED')) })
      return deniedResult(e) ?? failure('AI_KEY_SAVE_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_KEY_CLEAR, (event: IpcMainInvokeEvent): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      deleteAiKey()
      writeAudit('ai.keyClear', 'success', { requestId })
      return success({ hasKey: false })
    } catch (e: any) {
      writeAudit('ai.keyClear', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_KEY_CLEAR_FAILED')) })
      return deniedResult(e) ?? failure('AI_KEY_CLEAR_FAILED', String(e?.message || e))
    }
  })

  // 生图配置单独保存：不会同步到主 Agent，也不会覆盖文本 AI 配置。
  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_CONFIG_GET, (event: IpcMainInvokeEvent): IPCResult => {
    try {
      assertTrusted(event)
      return success(AiClient.getAiConfig())
    } catch (e: any) {
      return deniedResult(e) ?? failure('AI_CONFIG_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_CONFIG_SET, (event: IpcMainInvokeEvent, input: { endpoint?: string; model?: string; timeoutMs?: number }): IPCResult => {
    const requestId = randomUUID()
    const changed: string[] = []
    try {
      assertTrusted(event)
      if (input?.endpoint !== undefined) { putSetting(AI_IMAGE_SETTING_KEYS.endpoint, String(input.endpoint).trim().slice(0, 500)); changed.push('endpoint') }
      if (input?.model !== undefined) { putSetting(AI_IMAGE_SETTING_KEYS.model, String(input.model).trim().slice(0, 120)); changed.push('model') }
      if (input?.timeoutMs !== undefined) {
        const t = Number(input.timeoutMs)
        if (!Number.isFinite(t)) {
          writeAudit('ai.imageConfig', 'failure', { requestId: auditRequestId(requestId, 'AI_BAD_INPUT') })
          return failure('AI_BAD_INPUT', '生图超时必须是数字（毫秒）')
        }
        putSetting(AI_IMAGE_SETTING_KEYS.timeoutMs, Math.min(Math.max(Math.round(t), AI_TIMEOUT_MIN_MS), AI_IMAGE_TIMEOUT_MAX_MS))
        changed.push('timeoutMs')
      }
      if (changed.length) {
        writeAudit('ai.imageConfig', 'success', { requestId: auditRequestId(requestId, changed.join(',')) })
        logMain('info', `[ai:image] 生图配置已更新：${changed.join(',')}（不含 API Key）`)
      }
      return success(AiClient.getAiConfig())
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      writeAudit('ai.imageConfig', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_IMAGE_CONFIG_FAILED')) })
      return failure('AI_IMAGE_CONFIG_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_KEY_SET, (event: IpcMainInvokeEvent, input: { key: string }): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const key = String(input?.key || '').trim()
      if (key.length < 8) {
        writeAudit('ai.imageKeySet', 'failure', { requestId: auditRequestId(requestId, 'AI_BAD_INPUT') })
        return failure('AI_BAD_INPUT', '生图 API Key 过长或过短，请检查')
      }
      saveAiImageKey(key)
      writeAudit('ai.imageKeySet', 'success', { requestId })
      logMain('info', '[ai:image] 生图 API Key 已更新（safeStorage 加密存储，不回显）')
      return success({ hasImageKey: hasAiImageKey() })
    } catch (e: any) {
      writeAudit('ai.imageKeySet', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_IMAGE_KEY_SAVE_FAILED')) })
      return deniedResult(e) ?? failure('AI_IMAGE_KEY_SAVE_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_KEY_CLEAR, (event: IpcMainInvokeEvent): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      deleteAiImageKey()
      writeAudit('ai.imageKeyClear', 'success', { requestId })
      return success({ hasImageKey: false })
    } catch (e: any) {
      writeAudit('ai.imageKeyClear', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_IMAGE_KEY_CLEAR_FAILED')) })
      return deniedResult(e) ?? failure('AI_IMAGE_KEY_CLEAR_FAILED', String(e?.message || e))
    }
  })

  // 商品图片页面的文本分析配置：独立于 Agent 文本配置与生图配置，不同步 Agent Profile。
  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_TEXT_CONFIG_GET, (event: IpcMainInvokeEvent): IPCResult => {
    try {
      assertTrusted(event)
      return success(AiClient.getAiConfig())
    } catch (e: any) {
      return deniedResult(e) ?? failure('AI_CONFIG_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_TEXT_CONFIG_SET, (event: IpcMainInvokeEvent, input: { endpoint?: string; model?: string; timeoutMs?: number }): IPCResult => {
    const requestId = randomUUID()
    const changed: string[] = []
    try {
      assertTrusted(event)
      if (input?.endpoint !== undefined) { putSetting(AI_IMAGE_TEXT_SETTING_KEYS.endpoint, String(input.endpoint).trim().slice(0, 500)); changed.push('endpoint') }
      if (input?.model !== undefined) { putSetting(AI_IMAGE_TEXT_SETTING_KEYS.model, String(input.model).trim().slice(0, 120)); changed.push('model') }
      if (input?.timeoutMs !== undefined) {
        const t = Number(input.timeoutMs)
        if (!Number.isFinite(t)) {
          writeAudit('ai.imageTextConfig', 'failure', { requestId: auditRequestId(requestId, 'AI_BAD_INPUT') })
          return failure('AI_BAD_INPUT', '生图文本超时必须是数字（毫秒）')
        }
        putSetting(AI_IMAGE_TEXT_SETTING_KEYS.timeoutMs, Math.min(Math.max(Math.round(t), AI_TIMEOUT_MIN_MS), AI_TIMEOUT_MAX_MS))
        changed.push('timeoutMs')
      }
      if (changed.length) {
        writeAudit('ai.imageTextConfig', 'success', { requestId: auditRequestId(requestId, changed.join(',')) })
        logMain('info', `[ai:image-text] 商品分析文本配置已更新：${changed.join(',')}（不含 API Key）`)
      }
      return success(AiClient.getAiConfig())
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      writeAudit('ai.imageTextConfig', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_IMAGE_TEXT_CONFIG_FAILED')) })
      return failure('AI_IMAGE_TEXT_CONFIG_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_TEXT_KEY_SET, (event: IpcMainInvokeEvent, input: { key: string }): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const key = String(input?.key || '').trim()
      if (key.length < 8) {
        writeAudit('ai.imageTextKeySet', 'failure', { requestId: auditRequestId(requestId, 'AI_BAD_INPUT') })
        return failure('AI_BAD_INPUT', '生图文本 API Key 过长或过短，请检查')
      }
      saveAiImageTextKey(key)
      writeAudit('ai.imageTextKeySet', 'success', { requestId })
      logMain('info', '[ai:image-text] 商品分析文本 API Key 已更新（safeStorage 加密存储，不回显）')
      return success({ hasImageTextKey: hasAiImageTextKey() })
    } catch (e: any) {
      writeAudit('ai.imageTextKeySet', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_IMAGE_TEXT_KEY_SAVE_FAILED')) })
      return deniedResult(e) ?? failure('AI_IMAGE_TEXT_KEY_SAVE_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_TEXT_KEY_CLEAR, (event: IpcMainInvokeEvent): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      deleteAiImageTextKey()
      writeAudit('ai.imageTextKeyClear', 'success', { requestId })
      return success({ hasImageTextKey: false })
    } catch (e: any) {
      writeAudit('ai.imageTextKeyClear', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_IMAGE_TEXT_KEY_CLEAR_FAILED')) })
      return deniedResult(e) ?? failure('AI_IMAGE_TEXT_KEY_CLEAR_FAILED', String(e?.message || e))
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_TEST, async (event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
    } catch (e) {
      return deniedResult(e)!
    }
    const r = await AiClient.testAiConnection()
    writeAudit('ai.test', r.ok ? 'success' : 'failure', { requestId: r.ok ? requestId : auditRequestId(requestId, r.code) })
    return r.ok ? success(r) : failure(r.code, r.message)
  })

  // 获取可用模型：只读接口，失败如实回错误码（不返回任何编造的模型名）
  ipcMain.handle(IPC_CHANNELS.AI_MODELS_LIST, async (event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const r = await AiClient.listModels()
      writeAudit('ai.models', 'success', { requestId: auditRequestId(requestId, `${r.models.length}个`) })
      return success(r)
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      const code = e instanceof AiClient.AiError ? e.code : 'AI_REQUEST_FAILED'
      const message = String(e?.message || e).replace(/^[A-Z_]+:\s*/, '')
      writeAudit('ai.models', 'failure', { requestId: auditRequestId(requestId, code) })
      logMain('warn', `[ai] 获取可用模型失败 ${code}: ${message}`)
      return failure(code, message)
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_TEST, async (event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = randomUUID()
    try { assertTrusted(event) } catch (e) { return deniedResult(e)! }
    const r = await AiClient.testImageConnection()
    writeAudit('ai.image.test', r.ok ? 'success' : 'failure', { requestId: r.ok ? requestId : auditRequestId(requestId, r.code) })
    return r.ok ? success(r) : failure(r.code, r.message)
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_MODELS_LIST, async (event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const r = await AiClient.listImageModels()
      writeAudit('ai.image.models', 'success', { requestId: auditRequestId(requestId, `${r.models.length}个`) })
      return success(r)
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      const code = e instanceof AiClient.AiError ? e.code : 'AI_REQUEST_FAILED'
      const message = String(e?.message || e).replace(/^[A-Z_]+:\s*/, '')
      writeAudit('ai.image.models', 'failure', { requestId: auditRequestId(requestId, code) })
      logMain('warn', `[ai:image] 获取可用模型失败 ${code}: ${message}`)
      return failure(code, message)
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_TEXT_TEST, async (event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = randomUUID()
    try { assertTrusted(event) } catch (e) { return deniedResult(e)! }
    const r = await AiClient.testImageTextConnection()
    writeAudit('ai.imageText.test', r.ok ? 'success' : 'failure', { requestId: r.ok ? requestId : auditRequestId(requestId, r.code) })
    return r.ok ? success(r) : failure(r.code, r.message)
  })

  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_TEXT_MODELS_LIST, async (event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const r = await AiClient.listImageTextModels()
      writeAudit('ai.imageText.models', 'success', { requestId: auditRequestId(requestId, `${r.models.length}个`) })
      return success(r)
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      const code = e instanceof AiClient.AiError ? e.code : 'AI_REQUEST_FAILED'
      const message = String(e?.message || e).replace(/^[A-Z_]+:\s*/, '')
      writeAudit('ai.imageText.models', 'failure', { requestId: auditRequestId(requestId, code) })
      logMain('warn', `[ai:image-text] 获取可用模型失败 ${code}: ${message}`)
      return failure(code, message)
    }
  })

  // 商品分析只接受结构化字段 + 受限图片，由 Main 负责组装提示词，避免 Renderer 注入任意 system/工具指令。
  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_TEXT_ANALYZE, async (event: IpcMainInvokeEvent, input: { name?: string; tags?: string; price?: string; originalPrice?: string; images?: Array<{ mimeType?: string; b64Json?: string }> }): Promise<IPCResult> => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const name = String(input?.name || '').trim().slice(0, 120)
      const tags = String(input?.tags || '').trim().slice(0, 240)
      const price = String(input?.price || '').trim().slice(0, 24)
      const originalPrice = String(input?.originalPrice || '').trim().slice(0, 24)
      // 图片：最多 2 张，单张 ≤ 8MB，类型白名单（与上传时一致）
      const images = (Array.isArray(input?.images) ? input.images : []).slice(0, 3).map(item => ({
        mimeType: String(item?.mimeType || '').split(';')[0].trim().toLowerCase(),
        b64Json: String(item?.b64Json || '')
      })).filter(item => {
        if (!item.b64Json || !['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType)) return false
        return Math.ceil(item.b64Json.length * 3 / 4) <= 8 * 1024 * 1024
      })
      if (!name && !tags && !images.length) {
        writeAudit('ai.imageText.analyze', 'failure', { requestId: auditRequestId(requestId, 'AI_EMPTY_SOURCE') })
        return failure('AI_EMPTY_SOURCE', '请先上传商品图，或填写商品名称/卖点，再请求 AI 分析')
      }
      const result = await AiClient.analyzeImageProductText({ name, tags, price, originalPrice, images })
      const usedVision = images.length > 0
      writeAudit('ai.imageText.analyze', 'success', { requestId: auditRequestId(requestId, `${result.model}${usedVision ? `(读图${images.length}张)` : ''}${result.source === 'main-text' ? '(回退主文本 API)' : ''}`) })
      // source / 读图张数一并回传：界面要如实显示这次分析用的是哪套配置、有没有真的看图
      return success({ text: result.text, model: result.model, elapsedMs: result.elapsedMs, source: result.source, imageCount: images.length })
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      const code = e instanceof AiClient.AiError ? e.code : 'AI_REQUEST_FAILED'
      const message = String(e?.message || e).replace(/^[A-Z_]+:\s*/, '')
      writeAudit('ai.imageText.analyze', 'failure', { requestId: auditRequestId(requestId, code) })
      logMain('warn', `[ai:image-text] 商品分析失败 ${code}: ${message}`)
      return failure(code, message)
    }
  })

  // 图片生成：只接受受限的提示词和用户明确选择的图片数据，API Key 和网络请求始终留在主进程。
  // 是否产生第三方费用由渲染层在调用前向用户明确确认；这里不自动重试、不伪造结果。
  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_GENERATE, async (event: IpcMainInvokeEvent, input: { prompt?: string; size?: string; n?: number; confirmed?: boolean; sourceImages?: Array<{ name?: string; mimeType?: string; b64Json?: string }> }): Promise<IPCResult> => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      if (input?.confirmed !== true) {
        writeAudit('ai.generate', 'failure', { requestId: auditRequestId(requestId, 'AI_CONFIRM_REQUIRED') })
        return failure('AI_CONFIRM_REQUIRED', '图片生成请求需要先完成费用与模型确认')
      }
      const prompt = String(input?.prompt || '').trim()
      if (!prompt || prompt.length > 4000) return failure('AI_BAD_INPUT', '图片描述不能为空且不能超过 4000 个字符')
      const size = String(input?.size || '1024x1024')
      const n = Number(input?.n ?? 1)
      if (!['1024x1024', '1536x1024', '1024x1536'].includes(size) || !Number.isInteger(n) || n < 1 || n > 4) {
        return failure('AI_BAD_INPUT', '图片尺寸或生成数量不受支持')
      }
      const sourceImages = Array.isArray(input?.sourceImages) ? input.sourceImages.slice(0, 10).map((source) => ({
        name: String(source?.name || 'reference-image'),
        mimeType: String(source?.mimeType || ''),
        b64Json: String(source?.b64Json || '')
      })) : []
      // model 字段不从渲染层透传；AiClient 会从设置中心读取唯一生图模型。
      const result = await AiClient.generateImage({ prompt, size, n, sourceImages })
      writeAudit('ai.generate', 'success', { requestId: auditRequestId(requestId, `${result.model}/${result.images.length}张`) })
      return success(result)
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      const code = e instanceof AiClient.AiError ? e.code : 'AI_REQUEST_FAILED'
      const message = String(e?.message || e).replace(/^[A-Z_]+:\s*/, '')
      writeAudit('ai.generate', 'failure', { requestId: auditRequestId(requestId, code) })
      logMain('warn', `[ai] 图片生成失败 ${code}: ${message}`)
      return failure(code, message)
    }
  })

  /**
   * 保存生成结果到本地。
   *
   * 为什么必须有这条：生成结果此前只以 data URL 活在渲染层内存里——页面一切走就没了，
   * 用户拿不到图（"生成成功但用不了"）。这里把它落盘，并且**如实返回真实写入路径**。
   *
   * `outputPath` 与其它导出通道（发票 CSV / 诊断包 / 会话包）一致：验收脚本可以直传路径，
   * 界面不传就走系统"另存为"对话框。只接受受信任渲染层调用，写入内容限图片类型与大小。
   */
  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_SAVE, async (event: IpcMainInvokeEvent, input: { b64Json?: string; mimeType?: string; suggestedName?: string; outputPath?: string }): Promise<IPCResult> => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const b64 = String(input?.b64Json || '')
      if (!b64) return failure('AI_BAD_INPUT', '没有可保存的图片数据')
      let buffer: Buffer
      try { buffer = Buffer.from(b64, 'base64') } catch { return failure('AI_BAD_INPUT', '图片数据不是合法 base64') }
      if (!buffer.length) return failure('AI_BAD_INPUT', '图片数据为空')
      if (buffer.length > 24 * 1024 * 1024) return failure('AI_BAD_INPUT', '图片超过 24MB，已拒绝保存')
      const mimeType = String(input?.mimeType || 'image/png').split(';')[0].trim().toLowerCase()
      const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : mimeType === 'image/png' ? 'png' : ''
      if (!ext) return failure('AI_BAD_INPUT', `不支持的图片类型：${mimeType || '未知'}`)
      // 文件名只保留安全字符，避免用户输入拼出奇怪路径
      const safeName = String(input?.suggestedName || '').replace(/[^\w\u4e00-\u9fa5.-]/g, '').slice(0, 60)
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)

      let targetPath = String(input?.outputPath || '').trim()
      if (!targetPath) {
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        const res = await dialog.showSaveDialog(win, {
          title: '保存生成的商品图',
          defaultPath: join(app.getPath('pictures'), `${safeName || '商品图'}-${stamp}.${ext}`),
          filters: [{ name: ext.toUpperCase() + ' 图片', extensions: [ext] }]
        })
        if (res.canceled || !res.filePath) return success({ canceled: true })
        targetPath = res.filePath
      } else {
        // 脚本直传路径时补上扩展名，避免存出没有后缀的文件
        if (!new RegExp(`\\.${ext}$`, 'i').test(targetPath)) targetPath = `${targetPath}.${ext}`
      }
      writeFileSync(targetPath, buffer)
      writeAudit('ai.imageSave', 'success', { requestId: auditRequestId(requestId, `${Math.round(buffer.length / 1024)}KB`) })
      logMain('info', `[ai:image] 生成结果已保存 ${Math.round(buffer.length / 1024)}KB`)
      return success({ canceled: false, path: targetPath, bytes: buffer.length })
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      writeAudit('ai.imageSave', 'failure', { requestId: auditRequestId(requestId, String(e?.code || 'AI_IMAGE_SAVE_FAILED')) })
      return failure('AI_IMAGE_SAVE_FAILED', String(e?.message || e))
    }
  })

  /** 在文件管理器里定位刚保存的图片（用户点了"打开所在文件夹"）。 */
  ipcMain.handle(IPC_CHANNELS.AI_IMAGE_REVEAL, async (event: IpcMainInvokeEvent, input: { path?: string }): Promise<IPCResult> => {
    try {
      assertTrusted(event)
      const target = String(input?.path || '').trim()
      if (!target) return failure('AI_BAD_INPUT', '没有要定位的文件路径')
      if (!existsSync(target)) return failure('AI_IMAGE_NOT_FOUND', '文件不存在，可能已被移动或删除')
      shell.showItemInFolder(target)
      return success({ path: target })
    } catch (e: any) {
      const denied = deniedResult(e)
      if (denied) return denied
      return failure('AI_IMAGE_REVEAL_FAILED', String(e?.message || e))
    }
  })
}
