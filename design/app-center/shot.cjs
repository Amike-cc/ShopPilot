// 一次性截图脚本：把设计稿渲染成 PNG（用系统 Edge，不下载 chromium）
const { chromium } = require('playwright')
const path = require('path')

const DIR = 'D:/code/电商浏览器/design/app-center'
const URL = 'file:///' + path.resolve(DIR, 'index.html').replace(/\\/g, '/')

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1500 },
    deviceScaleFactor: 2
  })
  await page.goto(URL, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  await page.evaluate(() => document.body.classList.add('chrome-hidden'))
  await page.waitForTimeout(250)

  // 1. 主界面画板
  await page.locator('.board-wrap').screenshot({ path: path.join(DIR, 'app-center-screen.png') })

  // 2. 标注版
  await page.evaluate(() => document.body.classList.add('annotate'))
  await page.waitForTimeout(250)
  await page.locator('.board-wrap').screenshot({ path: path.join(DIR, 'app-center-annotated.png') })
  await page.evaluate(() => document.body.classList.remove('annotate'))

  // 3. 状态矩阵
  await page.locator('.board-2 .states').screenshot({ path: path.join(DIR, 'app-center-states.png') })

  // 4. 设计规格
  await page.locator('.spec').screenshot({ path: path.join(DIR, 'app-center-spec.png') })

  // 5. 列表视图（临时切换）
  await page.click('#segList')
  await page.waitForTimeout(300)
  await page.locator('.board-wrap').screenshot({ path: path.join(DIR, 'app-center-list.png') })
  await page.click('#segGrid')

  // 6. 整页
  await page.evaluate(() => document.body.classList.remove('chrome-hidden'))
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(DIR, 'app-center-full.png'), fullPage: true })

  await browser.close()
  console.log('done')
})().catch(e => { console.error(e); process.exit(1) })
