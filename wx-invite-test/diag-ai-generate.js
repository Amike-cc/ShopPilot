/**
 * 复现「AI 生成邀约话术」这条链路（只读 + 往搜索框里写字，无任何业务副作用）
 *   背景：真机跑到单轮第 11/19 步 aiGenerate 失败，报 AI_EMPTY_OUTPUT（模型返回了空内容），
 *   而设置里的「测试连接」是通的 —— 需要分清是"模型对这条提示词返回空"还是"我们的解析漏了什么"。
 *
 * 用法：node wx-invite-test/diag-ai-generate.js
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const OUT_DIR = path.resolve('wx-invite-test/evidence')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pending = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pending.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr, timeoutMs = 30000) => {
    const call = send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    const r = await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 求值超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { send, ev, call: async (expr) => JSON.parse(await ev(`(async () => JSON.stringify(await ${expr}))()`)), close: () => ws.close() }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display(${JSON.stringify(STORE)})`)
  await sleep(1500)

  // 只跑三步：进广场 → 让 AI 读「表」写进搜索框 → 把写进去的内容读出来落库
  const steps = [
    { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: 'find' }, timeoutMs: 45000 },
    {
      type: 'aiGenerate',
      input: {
        selector: 'input[placeholder*="搜索"]',
        sourceSelector: 'table',
        deep: true,
        maxLen: 200
      },
      timeoutMs: 120000,
      retryLimit: 2
    },
    { type: 'readText', input: { selector: 'input[placeholder*="搜索"]', metric: 'probe.script', deep: true }, timeoutMs: 15000 }
  ]
  const created = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: 'AI 话术链路复现（无副作用）', storeScope: STORE, steps })})`)
  if (!created?.ok) throw new Error('创建失败: ' + JSON.stringify(created?.error))
  const taskId = created.data.id
  console.log('任务:', taskId)
  await app.call(`window.shopilot.task.run(${JSON.stringify(taskId)})`)
  let run = null
  const seen = new Set()
  for (let i = 0; i < 80; i++) {
    await sleep(3000)
    const tasks = await app.call(`window.shopilot.task.list()`)
    run = (tasks?.data || []).find(t => t.id === taskId)?.latestRun || null
    if (run?.id) {
      const detail = await app.call(`window.shopilot.task.results(${JSON.stringify(run.id)})`)
      for (const row of (detail?.data?.results || [])) {
        const key = `${row.stepIndex}|${row.summary}`
        if (seen.has(key)) continue
        seen.add(key)
        console.log(`  第${row.stepIndex + 1}步 ${row.kind} ${String(row.summary).slice(0, 120)}`)
        console.log('    payload:', JSON.stringify(row.payload).slice(0, 400))
      }
    }
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
  }
  console.log('最终:', run?.status, run?.errorCode || '-', String(run?.errorMessage || '').slice(0, 300))
  fs.writeFileSync(path.join(OUT_DIR, 'diag-ai-generate.json'), JSON.stringify({ run }, null, 1))
  await app.call(`window.shopilot.task.delete(${JSON.stringify(taskId)})`).catch(() => null)
  app.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
