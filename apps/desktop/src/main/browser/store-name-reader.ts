/**
 * 从店铺页面读出真实店铺名（2026-10-16 用户提出：现场店铺名常是「11121」这种编号）。
 *
 * 分工：本文件只负责"把页面上的候选文本取出来"——每个平台的 DOM 结构不同，选择器写在这里；
 * "哪个候选能当店名"由 @shared/store-name 判据决定（纯函数、单测钉死）。
 *
 * 三条边界：
 *   ① 只在**已登录的后台页**上取数：登录页没有店名，如实返回 pageKind='login' 让界面提示"先登录"；
 *   ② 取到的名字只是**建议**：界面预填重命名对话框，由人确认后才落库（不静默改名）；
 *   ③ 读不到就如实说读不到，不拿标题里的"登录/工作台"之类界面词硬凑。
 */
import { getDatabase } from '../db/database'
import { getTabWebContents, getActiveTabId } from './window-manager'
import {
  isLoginLikePage,
  pickStoreName,
  type StoreNameCandidate,
  type StorePageKind
} from '@shared/store-name'

export interface StoreNameReadResult {
  /** false = 这次根本没读到页面（页面没挂上/读超时），与"读到了但页面没有店名"要分开 */
  ok: boolean
  /** 读到的店名（建议值），没读到为 null */
  name: string | null
  /** 命中来源（选择器/标题），用于诊断与"这名字哪来的" */
  source: string | null
  /** 来源的给人看的说法（"店铺信息卡"/"页面标题"），界面备注用这个 */
  sourceLabel: string | null
  pageKind: StorePageKind
  url: string
  /** ok=false 或 name=null 时的如实原因 */
  reason: string | null
}

/** 命中来源 → 给人看的说法（界面备注里不该出现 `[class*=shop-info-popover]>leaf` 这种） */
const SOURCE_LABELS: Array<[RegExp, string]> = [
  [/shop-info|shopinfo/i, '店铺信息卡'],
  [/shoptitle|shop-title/i, '店铺名'],
  [/shopname|shop-name|shop_name/i, '店铺名区域'],
  [/shopdetails|shop-details/i, '店铺信息'],
  [/mallname|mall-name/i, '店铺名区域'],
  [/merchantname/i, '商家名称'],
  [/username/i, '账号区域'],
  [/title/i, '页面标题']
]

export function describeStoreNameSource(source: string | null): string {
  const text = String(source || '')
  for (const [pattern, label] of SOURCE_LABELS) if (pattern.test(text)) return label
  return '店铺页面'
}

/**
 * 各平台后台页面里"店名最可能出现"的位置（按可靠性从高到低）。
 *
 * ⚠️ CSS 属性选择器**区分大小写**：抖店的类名是 `index_headerShopName` / `index_shopTitle`
 * （大写 S），写成 `[class*=shopName]` 一个都命中不了（2026-10-16 真机踩到，页面明明有店名
 * 却报"读不到"）。所以统一用小写 needle + `i` 标志做大小写无关匹配。
 */
const PLATFORM_SELECTORS: Record<string, string[]> = {
  微信小店: ['[class*=shop-info i]', '[class*=shopname i]', '[class*=shop-name i]', '[class*=shopinfo i]'],
  抖店: ['[class*=shoptitle i]', '[class*=shop-title i]', '[class*=shopname i]', '[class*=shop-name i]', '[class*=shopdetails i]', '[class*=shopinfo i]', '[class*=merchantname i]'],
  拼多多: ['[class*=mall-name i]', '[class*=mallname i]', '[class*=shopname i]', '[class*=shop-name i]', '[class*=username i]'],
  快手小店: ['[class*=shop-name i]', '[class*=shopname i]', '[class*=shopinfo i]', '[class*=username i]']
}

/** 没有平台专属规则时的兜底选择器 */
const GENERIC_SELECTORS = [
  '[class*=shop-title i]', '[class*=shoptitle i]', '[class*=shop-name i]', '[class*=shopname i]',
  '[class*=mall-name i]', '[class*=mallname i]', '[class*=merchantname i]', '[class*=storename i]'
]

const READ_TIMEOUT_MS = 3000

/** 注入页面的取数脚本：候选按"可靠性从高到低"排列，判据由共享模块决定 */
export function buildStoreNameProbeScript(platform: string): string {
  const platformSelectors = PLATFORM_SELECTORS[platform] || []
  const selectors = [...platformSelectors, ...GENERIC_SELECTORS.filter(s => !platformSelectors.includes(s))]
  return `(() => {
  const selectors = ${JSON.stringify(selectors)}
  const candidates = []
  const push = (raw, source) => {
    const text = String(raw == null ? '' : raw).replace(/\\s+/g, ' ').trim()
    if (text) candidates.push({ text: text.slice(0, 120), source })
  }
  // 元素文本常是「店名+副标题+退出登录」粘在一起：先取**叶子节点**的短文本，再退回整块文本
  const pushLeaves = (node, source, limit) => {
    let count = 0
    for (const child of node.querySelectorAll('*')) {
      if (child.children.length > 0) continue
      const text = String(child.textContent || '').trim()
      if (!text || text.length > 60) continue
      push(text, source + '>leaf')
      if (++count >= limit) break
    }
  }
  for (const selector of selectors) {
    let nodes = []
    try { nodes = Array.from(document.querySelectorAll(selector)) } catch { continue }
    for (const node of nodes.slice(0, 3)) {
      if (!(node instanceof Element)) continue
      pushLeaves(node, selector, 4)
      push(node.textContent, selector)
    }
    if (candidates.length >= 12) break
  }
  // 注意：**不做顶栏兜底**。实测抖店顶栏里是「巨量千川」这种平台产品名，
  // 兜底会把产品名当店名读出来——读到错的名字比读不到更糟（用户会照着改错）。
  // 宁可如实返回"读不到，回店铺首页再试"，选择器覆盖不到的页面再按现场补。
  push(document.title, 'title')
  return JSON.stringify({
    url: String(location.href || ''),
    title: String(document.title || ''),
    text: String(document.body ? document.body.innerText : '').slice(0, 4000),
    candidates
  })
})()`
}

interface ProbePayload {
  url?: string
  title?: string
  text?: string
  candidates?: StoreNameCandidate[]
}

/**
 * 读当前（或指定）标签页上的店铺名。
 * @param storeId 店铺 id
 * @param tabId   不传则取该店铺当前活动标签页
 */
export async function readStoreNameFromTab(storeId: string, tabId?: string): Promise<StoreNameReadResult> {
  const row = getDatabase().prepare('SELECT platform FROM stores WHERE id = ? AND deleted_at IS NULL').get(storeId) as { platform?: string } | undefined
  if (!row) {
    return { ok: false, name: null, source: null, sourceLabel: null, pageKind: 'backend', url: '', reason: '店铺不存在或已移入回收站' }
  }
  const targetTabId = tabId || getActiveTabId(storeId) || ''
  const wc = targetTabId ? getTabWebContents(storeId, targetTabId) : null
  if (!wc) {
    return { ok: false, name: null, source: null, sourceLabel: null, pageKind: 'backend', url: '', reason: '页面还没挂上，先打开店铺浏览器' }
  }

  let payload: ProbePayload
  try {
    const raw: unknown = await Promise.race([
      wc.executeJavaScript(buildStoreNameProbeScript(row.platform || ''), true),
      new Promise((resolve) => { setTimeout(() => resolve(''), READ_TIMEOUT_MS) })
    ])
    const text = String(raw || '')
    if (!text) {
      return { ok: false, name: null, source: null, sourceLabel: null, pageKind: 'backend', url: '', reason: `页面 ${READ_TIMEOUT_MS}ms 内没有响应，稍后再试` }
    }
    payload = JSON.parse(text) as ProbePayload
  } catch (error) {
    return {
      ok: false, name: null, source: null, sourceLabel: null, pageKind: 'backend', url: '',
      reason: `读取页面失败：${String((error as Error)?.message || error).slice(0, 80)}`
    }
  }

  const url = String(payload.url || '')
  if (isLoginLikePage({ url, text: payload.text })) {
    return {
      ok: true, name: null, source: null, sourceLabel: null, pageKind: 'login', url,
      reason: '页面还停在登录页，先登录再读店铺名'
    }
  }

  const picked = pickStoreName({ candidates: payload.candidates || [] })
  if (!picked) {
    return {
      ok: true, name: null, source: null, sourceLabel: null, pageKind: 'backend', url,
      reason: '这个页面读不到店铺名（可能停在子页面，回店铺首页再试）'
    }
  }
  return { ok: true, name: picked.name, source: picked.source, sourceLabel: describeStoreNameSource(picked.source), pageKind: 'backend', url, reason: null }
}
