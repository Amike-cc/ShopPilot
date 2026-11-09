/**
 * 店铺管理与维护设置验收（2026-11-09 / 0.9.5）
 *
 * 覆盖：
 *   1) 完整编辑店铺资料（名称/标签/分组/负责人/地区/外部编码/备注）；
 *   2) 分组筛选；
 *   3) 归档视图、侧栏排除归档店、恢复；
 *   4) 排序（上移）真实落库；
 *   5) 自动备份开关（UI → settings 落库）。
 *
 * 运行：node tools/acceptance/store-management-cdp-verify.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { childEnv } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_STORE_CDP_PORT || 9384)
const RUNTIME = process.env.SHOPILOT_RUNTIME_EXE || 'D:\\ShopPilot-runtime\\electron.exe'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(body, timeoutMs = 20000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ])
    if (result.timeout) throw new Error(`页面求值超时：${String(body).replace(/\s+/g, ' ').slice(0, 100)}`)
    if (result.exceptionDetails) throw new Error('页面异常：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text))
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
}

async function findUi(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await targets()
      const target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) {
        const cdp = new CDP(target.webSocketDebuggerUrl)
        await cdp.ready
        return cdp
      }
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('主窗口 CDP 未就绪')
}

async function click(ui, selector) {
  return ui.eval(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { ok: false, reason: 'not found' }
    el.click()
    return { ok: true }
  `)
}

async function setValue(ui, selector, value) {
  return ui.eval(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { ok: false, reason: 'not found' }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))})
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    return { ok: true }
  `)
}

async function clickButtonInCard(ui, cardText, buttonText) {
  return ui.eval(`
    const card = [...document.querySelectorAll('.unified-store-card')].find(item => item.textContent.includes(${JSON.stringify(cardText)}))
    if (!card) return { ok: false, reason: 'card not found' }
    const button = [...card.querySelectorAll('button')].find(item => item.textContent.trim().includes(${JSON.stringify(buttonText)}))
    if (!button) return { ok: false, reason: 'button not found' }
    button.click()
    return { ok: true }
  `)
}

async function clickCardCheckbox(ui, cardText) {
  return ui.eval(`
    const card = [...document.querySelectorAll('.unified-store-card')].find(item => item.textContent.includes(${JSON.stringify(cardText)}))
    const box = card?.querySelector('.store-select input')
    if (!box) return { ok: false, reason: 'checkbox not found' }
    box.click()
    return { ok: true }
  `)
}

async function main() {
  const userData = path.join(os.tmpdir(), 'shopilot-store-mgmt-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  if (!fs.existsSync(RUNTIME)) throw new Error(`找不到验收运行时：${RUNTIME}`)
  const packaged = process.env.SHOPILOT_ACCEPTANCE_PACKAGED === '1'
  const args = [...(packaged ? [] : [ROOT]), '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`]
  const child = spawn(RUNTIME, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ NODE_ENV: 'production', SHOPILOT_ACCEPTANCE: '1', SHOPILOT_DISABLE_CDP_FP: '1' })
  })
  let appLog = ''
  child.stdout.on('data', chunk => { appLog += chunk.toString() })
  child.stderr.on('data', chunk => { appLog += chunk.toString() })

  let ui = null
  try {
    ui = await findUi()
    await sleep(900)
    const createdA = await ui.eval(`return await window.shopilot.store.create({ name: '验收店A', platform: '抖店', adminUrl: 'https://fxg.jinritemai.com', tags: ['旧标签'] })`)
    const createdB = await ui.eval(`return await window.shopilot.store.create({ name: '验收店B', platform: '快手小店', adminUrl: 'https://s.kwaixiaodian.com' })`)
    const createdC = await ui.eval(`return await window.shopilot.store.create({ name: '验收店C', platform: '拼多多', adminUrl: 'https://mms.pinduoduo.com' })`)
    if (!createdA.ok || !createdB.ok || !createdC.ok) throw new Error('创建店铺失败：' + JSON.stringify({ a: createdA.error, b: createdB.error, c: createdC.error }))
    const storeA = createdA.data.id
    const storeB = createdB.data.id
    const storeC = createdC.data.id
    await ui.eval(`return await window.shopilot.store.setGroup(${JSON.stringify(storeA)}, '华东区')`)

    await click(ui, '[data-test="nav-stores"]')
    await sleep(800)
    check('在用店铺显示 3 家', await ui.eval(`return document.querySelectorAll('.unified-store-card').length === 3`))

    const editOpened = await clickButtonInCard(ui, '验收店A', '编辑')
    await sleep(300)
    check('打开完整编辑浮层', editOpened.ok && await ui.eval(`return !!document.querySelector('[data-test="store-edit-dialog"]')`))
    await setValue(ui, '[data-test="store-edit-name"]', '验收店A-改')
    await setValue(ui, '[data-test="store-edit-tags"]', '重点, 售后')
    await setValue(ui, '[data-test="store-edit-group"]', '华东一区')
    await setValue(ui, '[data-test="store-edit-owner"]', '张三')
    await setValue(ui, '[data-test="store-edit-region"]', '上海')
    await setValue(ui, '[data-test="store-edit-external"]', 'EXT-001')
    await setValue(ui, '[data-test="store-edit-notes"]', '完整编辑验收')
    await click(ui, '[data-test="store-edit-save"]')
    await sleep(900)
    const listAfterEdit = await ui.eval(`return await window.shopilot.store.list()`)
    const edited = listAfterEdit.ok ? listAfterEdit.data.find(item => item.id === storeA) : null
    check('编辑资料落库（名称/标签/分组/负责人/地区/外部编码/备注）',
      edited?.name === '验收店A-改' && edited?.tagsJson === JSON.stringify(['重点', '售后']) &&
      edited?.groupName === '华东一区' && edited?.owner === '张三' && edited?.region === '上海' &&
      edited?.externalCode === 'EXT-001' && edited?.notes === '完整编辑验收',
      JSON.stringify({ name: edited?.name, group: edited?.groupName, owner: edited?.owner, region: edited?.region, externalCode: edited?.externalCode }))

    await setValue(ui, '[data-test="store-group-filter"]', '华东一区')
    await sleep(500)
    check('分组筛选只显示该组店铺', await ui.eval(`
      const cards = [...document.querySelectorAll('.unified-store-card')]
      return cards.length === 1 && cards[0].textContent.includes('验收店A-改')
    `))
    await setValue(ui, '[data-test="store-group-filter"]', '')
    await sleep(300)

    const singleArchive = await clickButtonInCard(ui, '验收店A-改', '归档')
    await sleep(300)
    const confirmShown = await ui.eval(`
      const dialog = document.querySelector('[data-test="store-bulk-confirm"]')
      return !!dialog && dialog.textContent.includes('归档')
    `)
    await click(ui, '[data-test="store-bulk-confirm-cancel"]')
    await sleep(400)
    const listAfterCancel = await ui.eval(`return await window.shopilot.store.list()`)
    const stillActive = listAfterCancel.ok ? listAfterCancel.data.find(item => item.id === storeA)?.status : null
    check('单店归档使用页内确认，取消后不执行', singleArchive.ok && confirmShown && stillActive !== 'archived', JSON.stringify({ confirmShown, stillActive }))

    const archived = await ui.eval(`return await window.shopilot.store.archive(${JSON.stringify(storeB)})`)
    check('归档接口成功', archived.ok === true)
    await ui.eval('location.reload(); return true')
    await sleep(1700)
    await click(ui, '[data-test="nav-stores"]')
    await sleep(800)
    const archivedState = await ui.eval(`
      const cards = [...document.querySelectorAll('.unified-store-card')]
      const sidebar = [...document.querySelectorAll('[data-test="store-card"]')]
      return {
        activeCards: cards.length,
        hasB: cards.some(card => card.textContent.includes('验收店B')),
        sidebarHasB: sidebar.some(card => card.getAttribute('data-store-id') === ${JSON.stringify(storeB)})
      }
    `)
    check('归档后不再出现在在用店铺与侧栏', archivedState.activeCards === 2 && !archivedState.hasB && !archivedState.sidebarHasB,
      JSON.stringify(archivedState))

    await ui.eval(`
      const button = [...document.querySelectorAll('.unified-segment button')].find(item => item.textContent.includes('已归档'))
      if (button) button.click()
      return !!button
    `)
    await sleep(500)
    check('已归档视图显示归档店', await ui.eval(`
      return !!document.querySelector('[data-test="store-archived-view"]') &&
        document.querySelector('[data-test="store-archived-view"]').textContent.includes('验收店B')
    `))
    await click(ui, '[data-test="store-restore"]')
    await sleep(700)
    const restored = await ui.eval(`return await window.shopilot.store.list()`)
    const restoredB = restored.ok ? restored.data.find(item => item.id === storeB) : null
    check('恢复后状态不再为 archived', restoredB && restoredB.status !== 'archived', JSON.stringify({ status: restoredB?.status }))

    await ui.eval(`
      const active = [...document.querySelectorAll('.unified-segment button')].find(item => item.textContent.includes('在用店铺'))
      if (active) active.click()
      return !!active
    `)
    await sleep(500)
    await click(ui, '[data-test="store-sort-toggle"]')
    await sleep(300)
    const moved = await clickButtonInCard(ui, '验收店B', '↑')
    await sleep(600)
    await clickButtonInCard(ui, '验收店B', '↑')
    await sleep(900)
    const ordered = await ui.eval(`return await window.shopilot.store.list()`)
    const ids = ordered.ok ? ordered.data.filter(item => item.status !== 'archived').map(item => item.id) : []
    check('上移后排序真实落库（B 移到最前）', moved.ok && ids.indexOf(storeB) === 0, JSON.stringify(ids))
    await click(ui, '[data-test="store-sort-toggle"]')
    await sleep(300)

    // ---- 批量操作：分组 / 归档 / 恢复 / 移入回收站 ----
    await click(ui, '[data-test="store-bulk-toggle"]')
    await sleep(300)
    await clickCardCheckbox(ui, '验收店B')
    await clickCardCheckbox(ui, '验收店C')
    await click(ui, '[data-test="store-bulk-group"]')
    await sleep(300)
    await setValue(ui, '[data-test="store-bulk-group-input"]', '批量组')
    await click(ui, '[data-test="store-bulk-group-save"]')
    await sleep(900)
    const afterBulkGroup = await ui.eval(`return await window.shopilot.store.list()`)
    const bGroup = afterBulkGroup.ok ? afterBulkGroup.data.find(item => item.id === storeB)?.groupName : null
    const cGroup = afterBulkGroup.ok ? afterBulkGroup.data.find(item => item.id === storeC)?.groupName : null
    check('批量分组应用到所选店铺', bGroup === '批量组' && cGroup === '批量组', JSON.stringify({ bGroup, cGroup }))

    await clickCardCheckbox(ui, '验收店B')
    await clickCardCheckbox(ui, '验收店C')
    await click(ui, '[data-test="store-bulk-archive"]')
    await sleep(300)
    await click(ui, '[data-test="store-bulk-confirm-ok"]')
    await sleep(1000)
    const afterBulkArchive = await ui.eval(`return await window.shopilot.store.list()`)
    const bArchived = afterBulkArchive.ok ? afterBulkArchive.data.find(item => item.id === storeB)?.status : null
    const cArchived = afterBulkArchive.ok ? afterBulkArchive.data.find(item => item.id === storeC)?.status : null
    check('批量归档两家店铺', bArchived === 'archived' && cArchived === 'archived', JSON.stringify({ bArchived, cArchived }))

    await ui.eval(`
      const button = [...document.querySelectorAll('.unified-segment button')].find(item => item.textContent.includes('已归档'))
      if (button) button.click()
      return !!button
    `)
    await sleep(600)
    await click(ui, '[data-test="store-bulk-toggle"]')
    await sleep(300)
    await clickCardCheckbox(ui, '验收店B')
    await clickCardCheckbox(ui, '验收店C')
    await click(ui, '[data-test="store-bulk-restore"]')
    await sleep(300)
    await click(ui, '[data-test="store-bulk-confirm-ok"]')
    await sleep(1000)
    const afterBulkRestore = await ui.eval(`return await window.shopilot.store.list()`)
    const bRestored = afterBulkRestore.ok ? afterBulkRestore.data.find(item => item.id === storeB)?.status : null
    const cRestored = afterBulkRestore.ok ? afterBulkRestore.data.find(item => item.id === storeC)?.status : null
    check('批量恢复两家店铺', bRestored !== 'archived' && cRestored !== 'archived', JSON.stringify({ bRestored, cRestored }))

    await ui.eval(`
      const button = [...document.querySelectorAll('.unified-segment button')].find(item => item.textContent.includes('在用店铺'))
      if (button) button.click()
      return !!button
    `)
    await sleep(600)
    await click(ui, '[data-test="store-bulk-toggle"]')
    await sleep(300)
    await clickCardCheckbox(ui, '验收店C')
    await click(ui, '[data-test="store-bulk-trash"]')
    await sleep(300)
    await click(ui, '[data-test="store-bulk-confirm-ok"]')
    await sleep(1000)
    const afterBulkTrash = await ui.eval(`return await window.shopilot.store.list()`)
    const trashList = await ui.eval(`return await window.shopilot.store.trashList()`)
    check('批量移入回收站', afterBulkTrash.ok && !afterBulkTrash.data.some(item => item.id === storeC)
      && trashList.ok && trashList.data.some(item => item.id === storeC), JSON.stringify({ inActive: afterBulkTrash.data?.some(item => item.id === storeC), inTrash: trashList.data?.some(item => item.id === storeC) }))

    await click(ui, '[data-test="settings-open-btn"]')
    await sleep(800)
    await click(ui, '[data-test="settings-tab-maintenance"]')
    await sleep(700)
    const paths = await ui.eval(`return await window.shopilot.maintenance.paths()`)
    const dbText = await ui.eval(`return document.querySelector('[data-test="maintenance-path-db"]')?.textContent || ''`)
    const logsText = await ui.eval(`return document.querySelector('[data-test="maintenance-path-logs"]')?.textContent || ''`)
    check('维护页显示数据库与日志路径', paths.ok && paths.data?.databasePath?.endsWith('shopilot.db')
      && dbText.includes(paths.data.databasePath) && logsText.includes(paths.data.logsDir),
      JSON.stringify({ databasePath: paths.data?.databasePath, logsDir: paths.data?.logsDir }))
    const invalidDir = await ui.eval(`return await window.shopilot.maintenance.openDir('../outside')`)
    check('打开目录只接受白名单 target', invalidDir.ok === false, JSON.stringify(invalidDir.error))
    const before = await ui.eval(`return await window.shopilot.settings.get('backup.auto')`)
    const checked = await ui.eval(`return document.querySelector('[data-test="maintenance-auto-backup"]')?.checked`)
    check('维护页显示自动备份开关（默认开）', before.ok && before.data?.value !== false && checked === true)
    await click(ui, '[data-test="maintenance-auto-backup"]')
    await sleep(500)
    const afterOff = await ui.eval(`return await window.shopilot.settings.get('backup.auto')`)
    check('关闭自动备份落库', afterOff.ok && afterOff.data?.value === false, JSON.stringify(afterOff.data))
    await click(ui, '[data-test="maintenance-auto-backup"]')
    await sleep(400)
    const afterOn = await ui.eval(`return await window.shopilot.settings.get('backup.auto')`)
    check('重新开启自动备份落库', afterOn.ok && afterOn.data?.value === true)
    for (let i = 0; i < 4; i++) await ui.eval(`return await window.shopilot.backup.create('保留策略验收${i}')`)
    const beforePrune = await ui.eval(`return await window.shopilot.backup.list()`)
    await setValue(ui, '[data-test="maintenance-backup-keep"]', '3')
    await sleep(700)
    const keepThree = await ui.eval(`return await window.shopilot.settings.get('backup.retentionKeep')`)
    const afterPrune = await ui.eval(`return await window.shopilot.backup.list()`)
    check('备份保留份数可改为 3 并立即清理旧备份', keepThree.ok && Number(keepThree.data?.value) === 3
      && beforePrune.ok && beforePrune.data.length >= 4 && afterPrune.ok && afterPrune.data.length <= 3,
      JSON.stringify({ before: beforePrune.data?.length, after: afterPrune.data?.length }))
    await setValue(ui, '[data-test="maintenance-backup-keep"]', '7')
    await sleep(600)
    const keepSeven = await ui.eval(`return await window.shopilot.settings.get('backup.retentionKeep')`)
    check('备份保留份数恢复 7', keepSeven.ok && Number(keepSeven.data?.value) === 7)

    // 代理不可达 → 主框架加载失败应把店铺状态写成 proxy_error（不再是只留日志）
    const badProxy = await ui.eval(`return await window.shopilot.proxy.create({ type: 'socks5', host: '127.0.0.1', port: 9, label: '代理状态验收' })`)
    const proxyStore = await ui.eval(`return await window.shopilot.store.create({ name: '代理异常验收店', platform: '抖店', adminUrl: 'https://fxg.jinritemai.com' })`)
    if (badProxy.ok && proxyStore.ok) {
      await ui.eval(`return await window.shopilot.proxy.bind(${JSON.stringify(proxyStore.data.id)}, ${JSON.stringify(badProxy.data.id)})`)
      await ui.eval(`return await window.shopilot.browser.open(${JSON.stringify(proxyStore.data.id)})`)
      await sleep(6000)
      const proxyStatusList = await ui.eval(`return await window.shopilot.store.list()`)
      const proxyStatus = proxyStatusList.ok ? proxyStatusList.data.find(item => item.id === proxyStore.data.id)?.status : null
      check('代理不可达时店铺状态为 proxy_error', proxyStatus === 'proxy_error', JSON.stringify({ status: proxyStatus }))
      await ui.eval(`return await window.shopilot.proxy.delete(${JSON.stringify(badProxy.data.id)})`)
    } else {
      check('代理不可达时店铺状态为 proxy_error', false, '创建代理或店铺失败')
    }
  } finally {
    if (ui) ui.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
  }

  const failed = checks.filter(item => !item.pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length) {
    console.log('失败项：' + failed.map(item => item.name).join('；'))
    if (appLog) console.log('应用日志尾部：\n' + appLog.slice(-2000))
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error('验收异常：', error?.stack || error)
  process.exitCode = 1
})
