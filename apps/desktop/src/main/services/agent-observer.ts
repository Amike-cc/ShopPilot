import { randomUUID } from 'crypto'
import type { AgentPageObservation } from '@shared/schemas/agent'
import { redactAgentText, sanitizeAgentUrl } from '@shared/agent-privacy'
import {
  getActiveTabId, getDisplayedStoreId, getOpenStoreIds, getStoreTabs,
  getTabWebContents, isBrowserTabMounted, isBrowserTabReadableForAgent, waitForTabWebContents, captureTab
} from '../browser/window-manager'
import { getStore } from '../stores/store-manager'
import { isAppLocked } from './security-manager'

export class AgentObservationError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'AgentObservationError'
  }
}

/** Fixed, read-only page inspection. It never reads input values or table body cells. */
const PAGE_OBSERVATION_SCRIPT = `(() => {
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const shortText = (el, max = 160) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, max);
  const selectorFor = (el) => {
    const tag = String(el.tagName || '').toLowerCase();
    if (!tag) return null;
    if (el.id && el.id.length <= 100) return '#' + CSS.escape(el.id);
    const testId = el.getAttribute('data-testid');
    if (testId && testId.length <= 100) return tag + '[data-testid=' + JSON.stringify(testId) + ']';
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length <= 100) return tag + '[aria-label=' + JSON.stringify(aria) + ']';
    const name = el.getAttribute('name');
    if (name && name.length <= 100) return tag + '[name=' + JSON.stringify(name) + ']';
    try { if (document.querySelectorAll(tag).length === 1) return tag; } catch {}
    return null;
  };
  const dedupe = (items) => [...new Set(items.filter(Boolean))];
  const title = String(document.title || '').trim().slice(0, 240);
  const buttons = [];
  for (const el of Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]'))) {
    if (!visible(el)) continue;
    const text = shortText(el, 160) || String(el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 160);
    if (text) buttons.push({ text, selector: selectorFor(el) });
    if (buttons.length >= 40) break;
  }
  const inputs = [];
  for (const el of Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'))) {
    if (!visible(el)) continue;
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text')).toLowerCase().slice(0, 30);
    const label = String(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    inputs.push({ label, type, selector: selectorFor(el) });
    if (inputs.length >= 30) break;
  }
  const tables = [];
  for (const table of Array.from(document.querySelectorAll('table'))) {
    if (!visible(table)) continue;
    const rows = Array.from(table.querySelectorAll('tr'));
    const theadRow = table.querySelector('thead tr');
    const headerRow = theadRow || rows.find(row => row.querySelector('th')) || null;
    // Only semantic header cells are exposed. Never infer the first <td> row as a header:
    // tables without <thead> often begin with real customer/order data.
    const headers = headerRow ? Array.from(headerRow.querySelectorAll('th')).map(el => shortText(el, 100)).filter(Boolean).slice(0, 20) : [];
    tables.push({ selector: selectorFor(table), headers, rowCount: Math.max(0, rows.length - (headerRow ? 1 : 0)) });
    if (tables.length >= 8) break;
  }
  const summary = [];
  // Exclude generic paragraphs: commerce pages commonly render full customer/order addresses there.
  for (const el of Array.from(document.querySelectorAll('h1,h2,h3,button,[role="button"],label,th'))) {
    if (!visible(el) || el.closest('tbody')) continue;
    const text = shortText(el, 120);
    if (text && !summary.includes(text)) summary.push(text);
    if (summary.length >= 50) break;
  }
  // Only expose a fixed allowlist of commerce metric labels; ordinary paragraph and card body
  // text may contain customer identities or delivery addresses and is intentionally omitted.
  const metricLabels = ['订单数','订单数量','支付订单数','成交订单数','成交金额','支付金额','销售额','商品销量','访客数','浏览量','退款金额'];
  let metricChecks = 0;
  for (const el of Array.from(document.querySelectorAll('span,strong,dt,th,label,div'))) {
    if (metricChecks++ > 1200 || !visible(el) || el.closest('tbody')) continue;
    const own = Array.from(el.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || '').join('').replace(/\s+/g, ' ').trim().replace(/[：:]$/, '');
    if (metricLabels.includes(own) && !summary.includes(own)) summary.push(own);
    if (summary.length >= 60) break;
  }
  const selectors = dedupe([
    'title',
    ...Array.from(document.querySelectorAll('h1,h2,h3,label,th')).filter(visible).map(selectorFor),
    ...buttons.map(x => x.selector),
    ...inputs.map(x => x.selector),
    ...tables.map(x => x.selector)
  ]).slice(0, 60);
  return {
    title,
    visibleTextSummary: summary.join(' · ').slice(0, 2400),
    buttons,
    inputs,
    tables,
    selectorCandidates: selectors,
    interactive: document.readyState !== 'loading' && document.visibilityState === 'visible'
  };
})()`

function observationError(code: string, message: string): never {
  throw new AgentObservationError(code, message)
}

/**
 * 取当前活动标签页的页面句柄。
 *
 * 页面句柄来自主窗口渲染层 DOM `<webview>` 的注册：Agent 刚打开店铺就立刻观察时，
 * 元素可能还没挂上（`guestAttached` 仍为 false）。这时直接判"已销毁"会误导用户，
 * 所以先等一小段（最多 5s），仍拿不到再如实报"页面未就绪"。
 */
async function resolveTabWebContents(storeId: string, tabId: string): Promise<Electron.WebContents> {
  const immediate = getTabWebContents(storeId, tabId)
  if (immediate) return immediate
  try {
    return await waitForTabWebContents(storeId, tabId, 5000)
  } catch {
    observationError('AGENT_VIEW_NOT_MOUNTED', '店铺页面尚未就绪（webview 未注册或正在重载），请稍后重试')
  }
}


export async function observeCurrentPage(): Promise<AgentPageObservation> {
  if (isAppLocked()) observationError('APP_LOCKED', '应用已锁定，请先解锁')
  const storeId = getDisplayedStoreId()
  if (!storeId) observationError('AGENT_NO_STORE', '请先打开一个店铺浏览器')
  const store = getStore(storeId)
  if (!store || store.deletedAt) observationError('AGENT_STORE_NOT_AUTHORIZED', '当前店铺不存在或已移入回收站')
  if (!getOpenStoreIds().includes(storeId)) observationError('AGENT_BROWSER_CLOSED', '当前店铺浏览器未打开')
  const tabId = getActiveTabId(storeId)
  if (!tabId) observationError('AGENT_NO_ACTIVE_TAB', '当前店铺没有活动标签页')
  const tab = getStoreTabs(storeId).find(x => x.id === tabId)
  if (!tab) observationError('AGENT_TAB_CLOSED', '当前标签页已关闭')
  const wc = await resolveTabWebContents(storeId, tabId)
  if (!wc || wc.isDestroyed()) observationError('AGENT_TAB_DESTROYED', '当前标签页已销毁，请重新打开后重试')
  const viewMounted = isBrowserTabMounted(storeId, tabId)
  if (!viewMounted && !isBrowserTabReadableForAgent(storeId, tabId)) {
    observationError('AGENT_VIEW_NOT_MOUNTED', '当前页面视图未挂载或被应用弹层遮挡，请回到浏览器页面后重试')
  }

  let snapshot: any
  try {
    snapshot = await wc.executeJavaScript(PAGE_OBSERVATION_SCRIPT, true)
  } catch {
    if (wc.isDestroyed()) observationError('AGENT_TAB_DESTROYED', '观察期间当前标签页已销毁')
    observationError('AGENT_OBSERVE_FAILED', '当前页面观察失败，请刷新页面后重试')
  }
  if (getDisplayedStoreId() !== storeId || getActiveTabId(storeId) !== tabId || wc.isDestroyed()) {
    observationError('AGENT_CONTEXT_CHANGED', '观察期间店铺或标签页已变化，请重新观察')
  }

  const buttons = (Array.isArray(snapshot?.buttons) ? snapshot.buttons : []).map((item: any) => ({
    text: redactAgentText(item?.text, 160),
    selector: item?.selector ? redactAgentText(item.selector, 500) : null
  })).filter((item: any) => item.text)
  const inputs = (Array.isArray(snapshot?.inputs) ? snapshot.inputs : []).map((item: any) => ({
    label: redactAgentText(item?.label, 120),
    type: redactAgentText(item?.type, 30),
    selector: item?.selector ? redactAgentText(item.selector, 500) : null
  }))
  const tables = (Array.isArray(snapshot?.tables) ? snapshot.tables : []).filter((item: any) => item?.selector).map((item: any) => ({
    selector: redactAgentText(item.selector, 500),
    headers: (Array.isArray(item.headers) ? item.headers : []).map((x: unknown) => redactAgentText(x, 100)).slice(0, 20),
    rowCount: Math.max(0, Math.min(1000000, Number(item.rowCount) || 0))
  }))
  const selectorCandidates = (Array.isArray(snapshot?.selectorCandidates) ? snapshot.selectorCandidates : [])
    .filter((x: unknown): x is string => typeof x === 'string')
    .map((x: string) => redactAgentText(x, 500)).filter(Boolean).slice(0, 60)
  const url = sanitizeAgentUrl(wc.getURL())
  const pageTitle = redactAgentText(wc.getTitle() || snapshot?.title || tab.title || '', 240)
  let screenshot: AgentPageObservation['screenshot']
  try {
    const base64 = await captureTab(storeId, tabId, 'jpeg')
    const dataUrl = `data:image/jpeg;base64,${base64}`
    screenshot = dataUrl.length <= 1_500_000
      ? { ref: randomUUID(), capturedAt: Date.now(), available: true, dataUrl, errorCode: null }
      : { ref: randomUUID(), capturedAt: Date.now(), available: false, dataUrl: null, errorCode: 'AGENT_CAPTURE_TOO_LARGE' }
  } catch {
    screenshot = { ref: randomUUID(), capturedAt: Date.now(), available: false, dataUrl: null, errorCode: 'AGENT_CAPTURE_FAILED' }
  }

  return {
    storeId, storeName: redactAgentText(store.name, 120), storePlatform: redactAgentText(store.platform, 80),
    tabId, tabTitle: redactAgentText(tab.title || pageTitle, 240), currentUrl: url, pageTitle,
    visibleTextSummary: redactAgentText(snapshot?.visibleTextSummary, 2400),
    buttons, inputs, tables, selectorCandidates,
    interactive: !!snapshot?.interactive && !wc.isLoading(), screenshot
  }
}
