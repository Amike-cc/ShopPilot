import fs from 'node:fs'
import path from 'node:path'

const port = 9258
const root = 'D:/code/电商浏览器'
const outputPath = path.join(root, 'artifacts', 'maintenance', 'real-ai-image-test-' + Date.now() + '.png')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json')
      if (response.ok) {
        const targets = await response.json()
        const target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
        if (target) return target
      }
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP target not found')
}

class Cdp {
  constructor(url) {
    this.id = 0
    this.pending = new Map()
    this.ws = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'))
    })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(body) {
    const result = await this.send('Runtime.evaluate', {
      expression: '(async () => { ' + body + ' })()',
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed')
    return result.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

const target = await getTarget()
const cdp = new Cdp(target.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable')
const ready = await cdp.evaluate('return Boolean(window.shopilot && window.shopilot.ai)')
if (!ready) throw new Error('ShopPilot preload bridge not ready')

const config = await cdp.evaluate('return await window.shopilot.ai.imageConfigGet()')
const configSummary = config?.ok ? {
  hasImageKey: Boolean(config.data?.hasImageKey),
  imageModel: String(config.data?.imageModel || ''),
  hasResolvedImageEndpoint: Boolean(config.data?.resolvedImageEndpoint)
} : { ok: false, error: config?.error?.message || '读取图片配置失败' }
console.log('CONFIG ' + JSON.stringify(configSummary))
if (!config?.ok || !config.data?.hasImageKey || !config.data?.imageModel || !config.data?.resolvedImageEndpoint) {
  throw new Error('真实生图配置未完成')
}

const prompt = '一张真实摄影风格的白色陶瓷马克杯商品主图，纯白背景，柔和摄影棚光线，主体居中且完整，无文字、无水印、无品牌标识'
const startedAt = Date.now()
const expression = 'return await (async () => {' +
  'const result = await window.shopilot.ai.generateImage(' + JSON.stringify({ prompt, size: '1024x1024', n: 1, confirmed: true, sourceImages: [] }) + ');' +
  'if (!result.ok) return { ok: false, error: result.error?.message || "生成失败", code: result.error?.code || "" };' +
  'const item = Array.isArray(result.data?.images) ? result.data.images[0] : null;' +
  'if (!item?.b64Json) return { ok: false, error: "接口返回成功但没有 Base64 图片", code: "AI_EMPTY_OUTPUT" };' +
  'const saved = await window.shopilot.ai.saveImage({ b64Json: item.b64Json, mimeType: item.mimeType || "image/png", suggestedName: "real-ai-image-test", outputPath: ' + JSON.stringify(outputPath) + ' });' +
  'return { ok: true, model: String(result.data?.model || ""), elapsedMs: Number(result.data?.elapsedMs || 0), images: result.data?.images?.length || 0, mimeType: String(item.mimeType || "image/png"), base64Length: item.b64Json.length, saved: saved.ok ? { path: saved.data?.path || "", bytes: saved.data?.bytes || 0 } : { error: saved.error?.message || "保存失败" } };' +
  '})()'
const result = await cdp.evaluate(expression)
console.log('RESULT ' + JSON.stringify({ ...result, wallClockMs: Date.now() - startedAt }))
cdp.close()
if (result?.saved?.path && fs.existsSync(result.saved.path)) console.log('FILE ' + JSON.stringify({ path: result.saved.path, bytes: fs.statSync(result.saved.path).size }))
