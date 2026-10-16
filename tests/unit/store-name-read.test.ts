import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  STORE_NAME_MAX_LENGTH,
  isLoginLikePage,
  isStoreNameJunk,
  looksLikePlaceholderStoreName,
  pickStoreName,
  stripStoreNameNoise
} from '@shared/store-name'
import { describeStoreNameSource } from '../../apps/desktop/src/main/browser/store-name-reader'

/**
 * 「从店铺页面读出真实店铺名」的回归网（2026-10-16 用户提出）。
 *
 * 现场：店铺列表里的名字是建店时手输的（「11121」「1111」），而平台后台页面上写着真名
 * ——实测微信小店 `[class*=shop-info-popover]` 里就是「柚子货货」。
 *
 * 这条链路最容易出的两种错：
 *   ① 把**登录页**的界面词当店名（"扫码登录""登录即代表同意"），用户看到的是假信息；
 *   ② 把整块粘在一起的文本（"柚子货货柚子好货退出登录"）当店名。
 * 所以判据集中在 @shared/store-name，用真值表钉死；主进程只负责按平台选择器取候选。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const READER = read('apps/desktop/src/main/browser/store-name-reader.ts')
const DASHBOARD = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')
const PRELOAD = read('apps/desktop/src/preload/index.ts')

describe('isLoginLikePage：登录页没有店名，不许硬凑', () => {
  it('按 URL 判：/login 与 passport 分支', () => {
    expect(isLoginLikePage({ url: 'https://fxg.jinritemai.com/login/common?extra=%7B' })).toBe(true)
    expect(isLoginLikePage({ url: 'https://login.kwaixiaodian.com/?biz=zone' })).toBe(true)
    expect(isLoginLikePage({ url: 'https://store.weixin.qq.com/shop/home' })).toBe(false)
  })

  it('按页面文案判：扫码/密码/短信登录、登录即代表同意', () => {
    expect(isLoginLikePage({ url: '', text: '扫码登录 密码登录 短信登录 登录即代表同意' })).toBe(true)
    expect(isLoginLikePage({ url: '', text: '如何诊断优化小店投放 商家社区 柚子货货' })).toBe(false)
  })

  it('后台页里的"退出登录"不算登录页（否则永远读不到店名）', () => {
    expect(isLoginLikePage({ url: 'https://store.weixin.qq.com/shop/home', text: '柚子货货 柚子好货 退出登录' })).toBe(false)
  })
})

describe('stripStoreNameNoise：切掉平台前后缀与"店铺名称："前缀', () => {
  it('平台标题后缀去掉', () => {
    expect(stripStoreNameNoise('柚子货货 - 微信小店')).toBe('柚子货货')
    expect(stripStoreNameNoise('福气满满-快手小店')).toBe('福气满满')
    expect(stripStoreNameNoise('慕么美-拼多多商家后台')).toBe('慕么美')
  })

  it('"店铺名称："前缀去掉、首尾分隔符去掉', () => {
    expect(stripStoreNameNoise('店铺名称：柚子货货')).toBe('柚子货货')
    expect(stripStoreNameNoise('  柚子货货 | ')).toBe('柚子货货')
  })
})

describe('isStoreNameJunk：界面词、纯编号、过长都不配当店名', () => {
  it('界面词一律拒绝（含"退出登录"这类混在名字后面的）', () => {
    for (const text of ['扫码登录', '退出登录', '店铺管理', '工作台', '免费注册开店', '加载中']) {
      expect(isStoreNameJunk(text)).toBe(true)
    }
  })

  it('纯编号/纯符号/过短/过长都拒绝', () => {
    expect(isStoreNameJunk('11121')).toBe(true)
    expect(isStoreNameJunk('---')).toBe(true)
    expect(isStoreNameJunk('店')).toBe(true)
    expect(isStoreNameJunk('好'.repeat(STORE_NAME_MAX_LENGTH + 1))).toBe(true)
  })

  it('正常店名通过（中英数字混合也算）', () => {
    for (const text of ['柚子货货', '福气满满', '慕么美', '361度官方旗舰店', 'Shop A1']) {
      expect(isStoreNameJunk(text)).toBe(false)
    }
  })

  it('平台产品/频道名不算店名（真机踩到：顶栏兜底读出「巨量千川」）', () => {
    for (const text of ['巨量千川', '电商罗盘', '飞鸽', '服务市场', '学习中心', '订单管理']) {
      expect(isStoreNameJunk(text)).toBe(true)
    }
    // 不能被误伤：真店名里带平台词也照样能用
    for (const text of ['柚子货货', '千川优选', '拼多多优选']) {
      expect(isStoreNameJunk(text)).toBe(false)
    }
  })
})

describe('pickStoreName：按可靠性取第一个能用的候选', () => {
  it('第一个候选是界面词时往后找（真实现场：微信小店 popover 的第一段就是店名）', () => {
    const picked = pickStoreName({
      candidates: [
        { text: '退出登录', source: '[class*=shop-info-popover]>leaf' },
        { text: '柚子货货', source: '[class*=shop-info-popover]>leaf' }
      ]
    })
    expect(picked).toEqual({ name: '柚子货货', source: '[class*=shop-info-popover]>leaf' })
  })

  it('粘在一起的文本读不出店名时，宁可返回 null，也不硬凑', () => {
    expect(pickStoreName({ candidates: [{ text: '扫码登录 密码登录 短信登录 登录即代表同意', source: 'body' }] })).toBeNull()
    expect(pickStoreName({ candidates: [] })).toBeNull()
  })

  it('标题兜底：只有平台名没有店名时返回 null（不是把"快手小店"当店名）', () => {
    expect(pickStoreName({ candidates: [{ text: '快手小店', source: 'title' }] })).toBeNull()
  })

  it('裸标题不算证据（真机踩到：抖店某页标题是「活动广场」，那是页面名不是店名）', () => {
    for (const text of ['活动广场', '商家账房', '微信小店 首页', '抖店登录-抖店后台-抖音电商后台']) {
      expect(pickStoreName({ candidates: [{ text, source: 'title' }] })).toBeNull()
    }
    // "店名 - 平台名"这种剥掉后缀还剩东西的标题才算证据
    expect(pickStoreName({ candidates: [{ text: '福气满满-快手小店', source: 'title' }] })?.name).toBe('福气满满')
  })

  it('带平台后缀的标题也能取出店名', () => {
    expect(pickStoreName({ candidates: [{ text: '柚子货货 - 微信小店', source: 'title' }] })?.name).toBe('柚子货货')
  })
})

describe('looksLikePlaceholderStoreName：识别"11121""测试店"这类占位名', () => {
  it('纯编号与占位词算占位', () => {
    expect(looksLikePlaceholderStoreName('11121')).toBe(true)
    expect(looksLikePlaceholderStoreName('1111')).toBe(true)
    expect(looksLikePlaceholderStoreName('店铺1')).toBe(true)
    expect(looksLikePlaceholderStoreName('测试')).toBe(true)
    expect(looksLikePlaceholderStoreName('')).toBe(true)
  })

  it('正常店名不算占位（不能拿它去自动改名）', () => {
    for (const text of ['柚子货货', '福气满满', '慕么美', '361度官方旗舰店']) {
      expect(looksLikePlaceholderStoreName(text)).toBe(false)
    }
  })
})

describe('接线：主进程取候选、界面只预填不静默改名', () => {
  it('主进程按平台选选择器，并共用共享判据', () => {
    expect(READER).toContain("import {\n  isLoginLikePage,\n  pickStoreName,")
    expect(READER).toContain('微信小店: [')
    expect(READER).toContain("'[class*=shop-info i]'")
    expect(READER).toContain('pushLeaves')
    expect(READER).toContain('READ_TIMEOUT_MS')
    // 读不到就如实说，不许返回空壳成功
    expect(READER).toContain('页面还停在登录页，先登录再读店铺名')
    expect(READER).toContain('这个页面读不到店铺名')
  })

  it('不做顶栏兜底（那里是「巨量千川」这类产品名，读到错的比读不到更糟）', () => {
    expect(READER).not.toContain('HEADER_SELECTOR')
    expect(READER).toContain('不做顶栏兜底')
  })

  it('选择器必须大小写无关（抖店类名是 index_shopTitle，小写写法一个都命不中）', () => {
    // 每个属性选择器都要带 i 标志
    const selectors = [...READER.matchAll(/'\[class\*=([^\]']+)\]'/g)].map(m => m[1])
    expect(selectors.length).toBeGreaterThan(6)
    for (const selector of selectors) expect(selector.trim().endsWith(' i')).toBe(true)
    // 抖店要优先取 shopTitle（真机实测那里就是店名「嘉年华福气满满工厂店」）
    const douyin = READER.match(/抖店: \[([\s\S]*?)\],\n/)![1]
    expect(douyin.indexOf('shoptitle')).toBeGreaterThan(-1)
    expect(douyin.indexOf('shoptitle')).toBeLessThan(douyin.indexOf('shopname'))
  })

  it('选择器要与真实类名同形（拼多多是 user-name-text，写成 username 命不中）', () => {
    const pdd = READER.match(/拼多多: \[([\s\S]*?)\],\n/)![1]
    // 真机实测：拼多多后台首页的店名在 [user-name-text]（→「柚子货架」）
    expect(pdd.indexOf('user-name-text')).toBeGreaterThan(-1)
    expect(pdd.indexOf('user-name-text')).toBeLessThan(pdd.indexOf('mall-name'))
  })

  it('来源给的是人话标签，不是选择器串', () => {
    expect(describeStoreNameSource('[class*=shop-info-popover]>leaf')).toBe('店铺信息卡')
    expect(describeStoreNameSource('title')).toBe('页面标题')
    expect(describeStoreNameSource('')).toBe('店铺页面')
    expect(DASHBOARD).toContain('data.sourceLabel')
  })

  it('IPC 走 familyHandle 且校验入参（tabId 可省）', () => {
    expect(PRELOAD).toContain('BROWSER_READ_STORE_NAME')
    expect(READER).not.toContain('ipcRenderer')
  })

  it('界面直接更新店铺名（右键是明确意图，不再弹对话框），且改了什么说得清', () => {
    const fn = DASHBOARD.match(/if \(kind === 'readname'\)[\s\S]*?\n {2}\}/)
    expect(fn).toBeTruthy()
    expect(fn![0]).toContain('window.shopilot.browser.readStoreName(store.id)')
    // 直接写库 + 刷新 + 提示（不是预填让用户再点一次）
    expect(fn![0]).toContain('window.shopilot.store.update({ storeId: store.id, patch: { name: data.name } })')
    expect(fn![0]).toContain('ws.refreshStores()')
    expect(fn![0]).toContain('店铺名已更新')
    expect(fn![0]).not.toContain('renameDialog')
    // 登录页给"先登录"的提示，不是报错
    expect(fn![0]).toContain("data?.pageKind === 'login' ? 'info' : 'error'")
  })

  it('右键菜单里有入口（真实用户路径）', () => {
    expect(DASHBOARD).toContain('data-test="ctx-readname"')
    expect(DASHBOARD).toContain('读取并更新店铺名（从页面）')
    // 手工改名入口仍在（直接更新之外还留了可改的地方）
    expect(DASHBOARD).toContain('data-test="ctx-rename"')
    expect(DASHBOARD).toContain('data-test="rename-dialog"')
  })

  it('页面加载完自动把占位名改成真名，但绝不碰手输的名字', () => {
    const fn = SURFACE.match(/async function maybeAutoNameStore[\s\S]*?\n\}/)
    expect(fn).toBeTruthy()
    // 只动占位名（「11121」这种）——手输的名字可能是有意命名，不许悄悄覆盖
    expect(fn![0]).toContain('looksLikePlaceholderStoreName(store.name)')
    // 走和手动改名同一条写库路径，并刷新列表 + 弹提示（不静默改数据）
    expect(fn![0]).toContain('window.shopilot.store.update({ storeId: item.storeId, patch: { name: data.name } })')
    expect(fn![0]).toContain('ws.refreshStores()')
    expect(fn![0]).toContain('店铺名已按店铺页面自动更新')
    // 一次会话只自动改一次；读不到（页面没就绪）要允许下次再试
    expect(fn![0]).toContain('autoNamedStores.has(item.storeId)')
    expect(fn![0]).toContain('autoNamedStores.delete(item.storeId)')
    // 由 did-finish-load（clearWebviewError）触发，且只对已挂上的视图做
    const clear = SURFACE.match(/function clearWebviewError[\s\S]*?\n\}/)![0]
    expect(clear).toContain('if (!webviewAttached(item)) return')
    expect(clear).toContain('void maybeAutoNameStore(item)')
  })
})
