import fs from 'node:fs'
import path from 'node:path'

const port = 9258
const root = 'D:/code/电商浏览器'
const artifactDir = path.join(root, 'artifacts', 'maintenance')
const examplePath = path.join(root, 'apps', 'desktop', 'src', 'renderer', 'src', 'assets', 'ui', 'image-studio', 'examples', 'example-2.png')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
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
      expression: `(async () => { ${body} })()`,
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
await cdp.send('DOM.enable')

const ev = expression => cdp.evaluate(`return await (async () => { ${expression} })()`)
const setValue = async (selector, value) => ev(`
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('missing input ' + ${JSON.stringify(selector)});
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
`)
const click = async selector => ev(`
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('missing button ' + ${JSON.stringify(selector)});
  if (el.disabled) throw new Error('button disabled ' + ${JSON.stringify(selector)});
  el.click();
  return true;
`)
const snapshot = async () => ev(`
  const dataImages = [...document.querySelectorAll('[data-test="detail-generated-image"], .results-card .result-thumb img, [data-test="edit-result"] img, [data-test="studio-results"] .result-thumb img, [data-test="studio-preview"] .single-image-preview img')]
    .filter(img => String(img.src || '').startsWith('data:image/') && !String(img.src || '').startsWith('data:image/svg+xml'));
  return {
    url: location.href,
    active: [...document.querySelectorAll('[data-test^="studio-top-nav-"]')].find(el => el.classList.contains('active'))?.dataset.test || '',
    generating: Boolean(document.querySelector('.chat-generating, [data-test="generating"]')),
    imageCount: dataImages.length,
    images: dataImages.slice(0, 8).map(img => ({ src: img.src, alt: img.alt })),
    error: document.querySelector('.config-warn.error, .edit-generation-error, [data-test="generation-error"]')?.innerText || '',
    notice: [...document.querySelectorAll('.generation-notice, .chat-notice')].map(el => el.innerText).join('；'),
    bodyTail: document.body.innerText.slice(-1800)
  };
`)
const waitUntil = async (predicate, timeoutMs = 480000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await snapshot()
    if (predicate(value)) return value
    await sleep(1000)
  }
  return await snapshot()
}
const setFile = async (selector, file) => {
  const doc = await cdp.send('DOM.getDocument', { depth: 0 })
  const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  if (!node.nodeId) throw new Error(`file input not found: ${selector}`)
  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [file] })
  await ev(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('missing file input');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.files?.[0]?.name || '';
  `)
  await sleep(500)
}
const savePreview = async (label) => ev(`
  const image = [...document.querySelectorAll('[data-test="detail-generated-image"], .results-card .result-thumb img, [data-test="edit-result"] img, [data-test="studio-results"] .result-thumb img, [data-test="studio-preview"] .single-image-preview img')]
    .find(img => String(img.src || '').startsWith('data:image/') && !String(img.src || '').startsWith('data:image/svg+xml'));
  if (!image) return { ok: false, error: 'no data image in preview' };
  const match = /^data:([^;]+);base64,(.+)$/i.exec(image.src);
  if (!match || !window.shopilot?.ai?.saveImage) return { ok: false, error: 'preview or bridge unavailable' };
  const outputPath = ${JSON.stringify(artifactDir)} + '/real-studio-' + ${JSON.stringify(label)} + '-' + Date.now() + '.png';
  const result = await window.shopilot.ai.saveImage({ b64Json: match[2], mimeType: match[1], suggestedName: 'real-studio-' + ${JSON.stringify(label)}, outputPath });
  return result.ok ? { ok: true, path: result.data?.path || outputPath, bytes: result.data?.bytes || 0 } : { ok: false, error: result.error?.message || 'save failed' };
`)

const results = []
const record = (label, startedAt, state, save) => {
  const item = { label, elapsedMs: Date.now() - startedAt, active: state.active, imageCount: state.imageCount, generating: state.generating, error: state.error, notice: state.notice, saved: save }
  results.push(item)
  console.log('MODE ' + JSON.stringify(item))
}

// Seed one real source image through the page's own example-material control.
if (!(await ev(`return Boolean(document.querySelector('[data-test="studio-top-nav-create"]'))`))) {
  await ev(`
    const nav = [...document.querySelectorAll('button')].find(button => button.innerText.trim() === 'AI 创作');
    const card = [...document.querySelectorAll('.app-card-action')].find(item => item.innerText.includes('AI 生成商品图'));
    if (card) card.click();
    else if (nav) nav.click();
    else throw new Error('AI 商品创作 entry not found');
    return true;
  `)
  for (let i = 0; i < 40; i++) {
    if (await ev(`return Boolean(document.querySelector('[data-test="studio-top-nav-create"]'))`)) break
    await sleep(100)
  }
}
await click('[data-test="studio-top-nav-create"]')
if (!(await ev(`return Boolean(document.querySelector('.dz-list li'))`))) {
  await click('[data-test="material-examples-toggle"]')
  await click('[data-test="material-examples"] button')
}

async function runMode(label, mode, setup, buttonSelector, resultPredicate) {
  await click(`[data-test="studio-top-nav-${mode}"]`)
  await sleep(250)
  await setup()
  const before = await snapshot()
  console.log('START ' + JSON.stringify({ label, active: before.active, error: before.error }))
  const startedAt = Date.now()
  for (let i = 0; i < 30; i++) {
    const enabled = await ev(`return Boolean(document.querySelector(${JSON.stringify(buttonSelector)}) && !document.querySelector(${JSON.stringify(buttonSelector)}).disabled)`)
    if (enabled) break
    await sleep(100)
  }
  await click(buttonSelector)
  let confirmOpen = false
  for (let i = 0; i < 20; i++) {
    confirmOpen = await ev(`return Boolean(document.querySelector('.confirm-backdrop'))`)
    if (confirmOpen) break
    await sleep(100)
  }
  if (!confirmOpen) throw new Error(`${label}: confirmation dialog did not open`)
  await click('.confirm-actions button.primary')
  const state = await waitUntil(resultPredicate, 480000)
  const saved = state.imageCount ? await savePreview(label) : { ok: false, error: 'no preview' }
  record(label, startedAt, state, saved)
}

await runMode('detail', 'detail', async () => {
  await setValue('[data-test="detail-product-name"]', '真实测试旅行箱')
  await setValue('[aria-label="卡片数量"]', 1)
  await setValue('[data-test="detail-prompt"]', '突出箱体材质、容量和旅行收纳场景')
}, '[data-test="detail-generate-button"]', state => !state.generating && state.imageCount > 0 || Boolean(state.error))

await runMode('model', 'model', async () => {
  await setValue('input[aria-label="生成数量"]', 1)
}, '[data-test="model-generate-button"]', state => !state.generating && state.imageCount > 0 || Boolean(state.error))

await runMode('replicate', 'replicate', async () => {
  if (!(await ev(`return Boolean(document.querySelector('[data-test="competitor-reference-input"]')?.files?.length)`))) await setFile('[data-test="competitor-reference-input"]', examplePath)
  if (!(await ev(`return Boolean(document.querySelector('[data-test="replicate-material-input"]')?.files?.length) || document.querySelector('[data-test="replicate-material-dropzone"] + ul li') || document.querySelector('.replicate-sidebar .dz-list li:last-child')`))) {
    // The shared material state is normally retained from the seed image; only upload if this page starts empty.
    await setFile('[data-test="replicate-material-input"]', examplePath)
  }
}, '[data-test="replicate-generate-button"]', state => !state.generating && state.imageCount > 0 || Boolean(state.error))

await runMode('edit', 'edit', async () => {
  if (!(await ev(`return Boolean(document.querySelector('[data-test="edit-reference-input"]')?.files?.length)`))) await setFile('[data-test="edit-reference-input"]', examplePath)
  await setValue('[data-test="edit-prompt"]', '把背景改成明亮的旅行房间，商品保持清晰完整')
}, '[data-test="edit-generate-button"]', state => !state.generating && state.imageCount > 0 || Boolean(state.error))

await runMode('quantity', 'quantity', async () => {
  const count = await ev(`return document.querySelector('.quantity-workspace .dz-list li')?.innerText || ''`)
  if (!count) await setFile('[data-test="quantity-material-dropzone"] input[type="file"]', examplePath)
  await setValue('input[aria-label$="数量"]', 3)
  await setValue('[data-test="quantity-copy-input"]', '3件套')
}, '[data-test="quantity-generate-button"]', state => !state.generating && state.imageCount > 0 || Boolean(state.error))

// AI scene generation is a separate real request in the model workspace.
await click('[data-test="studio-top-nav-model"]')
await sleep(250)
await ev(`
  const tabs = document.querySelectorAll('.model-workspace .model-source-tabs');
  if (tabs.length < 2) throw new Error('scene source tabs not found');
  tabs[1].querySelector('button:nth-child(2)')?.click();
  return true;
`)
await sleep(100)
await setValue('.scene-ai-editor input', '明亮的旅行房间，窗边自然光，干净生活方式背景')
const sceneStart = Date.now()
await click('.scene-generate-button')
const sceneState = await (async () => {
  while (Date.now() - sceneStart < 480000) {
    const result = await ev(`return { generating: Boolean(document.querySelector('.scene-generate-button')?.disabled), selected: document.querySelector('.scene-reference-selected')?.innerText || '', error: document.querySelector('.scene-ai-editor .config-warn.error')?.innerText || '' }`)
    if (result.selected || result.error) return result
    await sleep(1000)
  }
  return await ev(`return { generating: Boolean(document.querySelector('.scene-generate-button')?.disabled), selected: document.querySelector('.scene-reference-selected')?.innerText || '', error: document.querySelector('.scene-ai-editor .config-warn.error')?.innerText || '' }`)
})()
console.log('MODE ' + JSON.stringify({ label: 'scene-ai', elapsedMs: Date.now() - sceneStart, active: 'model', imageCount: sceneState.selected ? 1 : 0, generating: sceneState.generating, error: sceneState.error, saved: { ok: false, error: 'scene is used as a library asset; no duplicate save' } }))

const report = { ok: results.every(item => item.imageCount > 0 && !item.error) && Boolean(sceneState.selected), results, scene: sceneState, finishedAt: new Date().toISOString() }
const reportPath = path.join(artifactDir, `real-image-studio-modes-${Date.now()}.json`)
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
console.log('REPORT ' + JSON.stringify({ path: reportPath, ok: report.ok }))
cdp.close()
if (!report.ok) process.exitCode = 1
