/**
 * 回收站「彻底删除店铺」验收（2026-11-15，修复浮层叠浮层后补）。
 *
 * 背景：侧栏回收站浮层里点「彻底删除」会再开一个确认框，两者都是 `.ui-overlay`
 * （position:fixed + z-index:900）。确认框在 DOM 里排在回收站**之前**，同层级下后渲染的
 * 回收站盖在上面 → 确认框被遮罩埋掉、点不到，用户看到的是"弹了一下又没了/位置不对"。
 *
 * 覆盖：
 *   1) 建店、移入回收站、侧栏回收站能看到该店；
 *   2) 点「彻底删除」后确认框存在，且**在确认框中心命中的是确认框自己**（没被回收站盖住）；
 *   3) 确认框相对视口居中（偏差 ≤ 2px）；
 *   4) 点确认后店铺从回收站与店铺列表里真的消失。
 *
 * 运行：node tools/acceptance/store-purge-cdp-verify.js
 * 需要先 `pnpm build && npx electron-builder --win --x64 --dir`（跑的是 release/win-unpacked）。
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { resolveApp, appArgs, childEnv } = require('./app-launch')
const { waitForMainWindow, createChecker, sleep } = require('./cdp-client')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_PURGE_CDP_PORT || 9432)
const SHOT_DIR = path.join(ROOT, 'artifacts/store-purge')

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const userData = process.env.SHOPILOT_PURGE_USER_DATA || path.join(os.tmpdir(), 'shopilot-purge-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })

  const appInfo = resolveApp(ROOT)
  const child = spawn(appInfo.executable, appArgs(ROOT, appInfo, { port: PORT, userData }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({
      NODE_ENV: 'production',
      ELECTRON_ENABLE_LOGGING: '1',
      SHOPILOT_DISABLE_CDP_FP: '1',
      SHOPILOT_ACCEPTANCE: '1'
    })
  })
  let appLog = ''
  child.stdout.on('data', d => { appLog += d.toString() })
  child.stderr.on('data', d => { appLog += d.toString() })

  const { check, summary } = createChecker()
  try {
    const ui = await waitForMainWindow(PORT)
    if (!ui) throw new Error('主窗口 CDP 未就绪')
    await sleep(1200)

    const created = await ui.eval(`
      const r = await window.shopilot.store.create({ name: '彻底删除验收店', platform: 'douyin', adminUrl: '' })
      const t = r.ok ? await window.shopilot.store.deletePermanent(r.data.id) : null
      const list = await window.shopilot.store.trashList()
      return {
        id: r.ok ? r.data.id : null,
        createError: r.ok ? '' : JSON.stringify(r.error),
        trashed: !!t && t.ok,
        inTrash: list.ok && list.data.some(item => item.id === (r.ok ? r.data.id : ''))
      }
    `)
    check('建店并移入回收站', !!created.id && created.trashed && created.inTrash, JSON.stringify(created))
    if (!created.id) throw new Error('建店失败：' + created.createError)

    const opened = await ui.eval(`
      const btn = document.querySelector('[data-test="trash-open"]') || document.querySelector('[data-test="rail-trash"]')
      if (!btn) return { open: false }
      btn.click()
      await new Promise(r => setTimeout(r, 900))
      const dialog = document.querySelector('[data-test="trash-dialog"]')
      return { open: !!dialog, rows: dialog ? dialog.querySelectorAll('.trash-row').length : 0 }
    `)
    check('侧栏回收站里能看到这家店', opened.open && opened.rows === 1, JSON.stringify(opened))

    // 点「彻底删除」→ 确认框应当压在回收站之上
    const stacked = await ui.eval(`
      const dialog = document.querySelector('[data-test="trash-dialog"]')
      const purge = dialog && [...dialog.querySelectorAll('button')].find(el => (el.textContent || '').includes('彻底删除'))
      if (!purge) return { clicked: false }
      purge.click()
      await new Promise(r => setTimeout(r, 700))
      const confirm = document.querySelector('[data-test="confirm-dialog"]')
      if (!confirm) return { clicked: true, confirm: false }
      const card = confirm.querySelector('.ui-dialog')
      const b = card.getBoundingClientRect()
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
      return {
        clicked: true,
        confirm: true,
        zIndex: getComputedStyle(confirm).zIndex,
        trashZIndex: getComputedStyle(document.querySelector('[data-test="trash-dialog"]')).zIndex,
        centerOffset: {
          dx: Math.round(b.x + b.width / 2 - innerWidth / 2),
          dy: Math.round(b.y + b.height / 2 - innerHeight / 2)
        },
        hitOwner: hit
          ? (hit.closest('[data-test="confirm-dialog"]') ? 'confirm-dialog'
            : hit.closest('[data-test="trash-dialog"]') ? 'trash-dialog'
              : hit.tagName + '.' + hit.className)
          : null
      }
    `)
    check('点「彻底删除」会弹出确认框', stacked.clicked === true && stacked.confirm === true, JSON.stringify(stacked))
    check('确认框没被回收站遮罩盖住（中心命中的是确认框自己）', stacked.hitOwner === 'confirm-dialog', JSON.stringify(stacked))
    check('确认框相对视口居中（偏差 ≤ 2px）', !!stacked.centerOffset
      && Math.abs(stacked.centerOffset.dx) <= 2 && Math.abs(stacked.centerOffset.dy) <= 2, JSON.stringify(stacked.centerOffset))

    const shot = await ui.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOT_DIR, 'confirm-stacked.png'), Buffer.from(shot.data, 'base64'))

    const after = await ui.eval(`
      const okBtn = document.querySelector('[data-test="confirm-ok"]')
      if (!okBtn) return { okBtn: false }
      okBtn.click()
      await new Promise(r => setTimeout(r, 1200))
      const trash = await window.shopilot.store.trashList()
      const list = await window.shopilot.store.list()
      const dialog = document.querySelector('[data-test="trash-dialog"]')
      return {
        okBtn: true,
        inTrash: trash.ok && trash.data.some(item => item.id === ${JSON.stringify(created.id)}),
        inList: list.ok && list.data.some(item => item.id === ${JSON.stringify(created.id)}),
        rows: dialog ? dialog.querySelectorAll('.trash-row').length : -1,
        toast: (document.querySelector('.ui-toast-host')?.textContent || '').trim().slice(0, 40)
      }
    `)
    check('确认后店铺从回收站与店铺列表里都消失', after.okBtn && !after.inTrash && !after.inList, JSON.stringify(after))
    check('回收站浮层只剩空态（行已移除）', after.rows === 0, JSON.stringify({ rows: after.rows, toast: after.toast }))

    const finalShot = await ui.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOT_DIR, 'after-purge.png'), Buffer.from(finalShot.data, 'base64'))
  } catch (error) {
    console.error('验收中断:', error && error.message)
    console.error(appLog.slice(-1500))
    process.exitCode = 1
  } finally {
    const allPassed = summary('彻底删除店铺')
    try { child.kill() } catch {}
    await sleep(400)
    if (!allPassed) process.exitCode = 1
  }
}

main()
