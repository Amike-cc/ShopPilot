/**
 * 把「发票中心」高保真原型渲染成设计图（PNG）。
 *
 * 用法：
 *   node render.mjs                     → 输出到脚本同目录
 *   DS_OUT=<目录> node render.mjs        → 输出到指定目录
 *
 * 依赖：仓库根目录的 playwright（devDependency）+ 本机已安装的 Chrome。
 * 说明：原型是自包含的单文件 HTML（无网络请求），截图只读本地文件。
 */
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.DS_OUT || HERE
const PAGE = pathToFileURL(join(HERE, 'invoice-center-prototype.html')).href
const W = 1600, H = 1000, DSF = 2

mkdirSync(OUT, { recursive: true })

/** 设计图清单：每张 = 一个真实使用场景 */
const SHOTS = [
  { file: '01-overview.png',  note: '主界面 · 全部主体',
    state: { entity: 'ALL', view: 'stores', sort: 'none', onlyWithData: false, query: '', open: [] } },

  { file: '02-detail.png',    note: '展开某方向的明细表',
    state: { entity: 'ALL', view: 'stores', sort: 'none', open: ['s1:applyPlatform'] }, scroll: 260 },

  { file: '03-summary.png',   note: '按开票主体汇总（申报/代账视角）',
    state: { entity: 'ALL', view: 'summary', sort: 'none' } },

  { file: '04-entity-license.png', note: '未填写主体分账 + 行内补录',
    state: { entity: '__none__', view: 'stores', sort: 'none', editing: 's5' } },

  { file: '05-entity-report.png', note: '获取主体营业执照 · 逐店结果',
    state: { entity: 'ALL', view: 'stores', sort: 'none', report: true } },

  { file: '06-export.png',    note: '导出待开票清单（按主体分账，保存框）',
    state: { entity: 'ALL', view: 'stores', sort: 'none', exportSheet: true } },

  { file: '07-states.png',    note: '异常态如实呈现：登录失效 / 金额未解析 / 无需操作不计入',
    state: { entity: 'ALL', view: 'stores', sort: 'amountDesc' }, scroll: 1010 },
]

const FULL = { file: '08-full-page.png', note: '整页长图（全部主体）',
  state: { entity: 'ALL', view: 'stores', sort: 'none', open: ['s1:applyPlatform'] } }

const browser = await chromium.launch({ channel: 'chrome' })

async function open(state) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DSF })
  await page.goto(PAGE, { waitUntil: 'load' })
  await page.waitForFunction('window.__ready === true')
  await page.evaluate(s => window.__ds(s), state)
  await page.waitForTimeout(180)
  return page
}

for (const shot of SHOTS) {
  const page = await open(shot.state)
  if (shot.scroll) {
    await page.evaluate(y => { document.querySelector('#main').scrollTop = y }, shot.scroll)
    await page.waitForTimeout(150)
  }
  await page.screenshot({ path: join(OUT, shot.file) })
  console.log('OK  ' + shot.file + '   —— ' + shot.note)
  await page.close()
}

/* 整页长图：解除内层滚动容器的约束后按内容高度截图 */
{
  const page = await browser.newPage({ viewport: { width: W, height: 1200 }, deviceScaleFactor: DSF })
  await page.goto(PAGE, { waitUntil: 'load' })
  await page.waitForFunction('window.__ready === true')
  await page.evaluate(s => window.__ds(s), FULL.state)
  await page.addStyleTag({ content: `
    html,body{height:auto!important;overflow:visible!important}
    .app{height:auto!important;min-height:0!important}
    .main{overflow:visible!important;height:auto!important}
  ` })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(OUT, FULL.file), fullPage: true })
  console.log('OK  ' + FULL.file + '   —— ' + FULL.note)
  await page.close()
}

await browser.close()
console.log('DONE -> ' + OUT)
