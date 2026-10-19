/**
 * 页面交互原语与注入脚本常量：等待/轮询/定位/点击/写入/证据读取/登录态停滞判据。
 * 2026-10-19 P1 重构：由 task-runner.ts 等价搬迁——**注入脚本字符串逐字保留**，
 * 单测（injected-script-syntax / silent-success-boundary）以这些锚点为断言对象，勿重排或压缩。
 */

import { logMain } from '../services/logger'
import { classifyInviteBlockNotice, matchSessionStall } from '@shared/invite-notices'
import { getTabWebContents, getStoreTabs } from '../browser/window-manager'
import { cancelSig, getCurrent, pauseSig } from './task-runner-registry'
import type { RunHandle } from './task-runner-registry'

/**
 * 页面上是否**明说**"这一位已经邀过（7 天内不可再邀）"。
 *
 * 返回命中的那句提示文案（用于错误信息），没有则返回 null。
 * 只认平台自己的措辞（已邀约/已邀请/7天内不可再次发送…），不做任何推断：
 * 判错方向会让"该跳过的人"变成"整单失败"，也可能把"页面还没渲染"误判成"已邀约"而漏邀。
 */
export async function readAlreadyInvitedEvidence(wc: Electron.WebContents): Promise<string | null> {
  const found = await wc.executeJavaScript(`(() => {
    const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
    const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const pat = /你已经邀请过该达人|已邀请过该达人|7\\s*天内不可再次发送|已邀约|已经邀约/;
    for (const e of all) {
      const t = own(e);
      if (t && pat.test(t) && t.length <= 120) return t;
    }
    // 兜底：整段文本里出现（文案可能被拆进子 span）
    const body = String(document.body ? document.body.innerText : '');
    const m = body.match(pat);
    return m ? m[0] : null;
  })()`).catch(() => null)
  return typeof found === 'string' && found.trim() ? found.trim().slice(0, 120) : null
}

/**
 * 读页面上**当前正在显示的**提示（toast / 弹窗 / 悬浮说明）——"为什么点不动"的答案通常在这里。
 *
 * 为什么要它：真机两次（10:31/10:34）点「邀请带货」4 次都没跳转，日志里只有一句
 * `TASK_TIMEOUT: 点击「邀请带货」4 次后地址仍未变为…`，**平台到底说了什么一个字都没有**，
 * 只能靠猜（已邀约？额度用完？操作过于频繁？）。这里把平台的措辞如实读出来，
 * 分类与错误信息都以它为准（见 classifyInviteBlockNotice）。
 */
export async function readBlockingNotice(wc: Electron.WebContents): Promise<string | null> {
  const found = await wc.executeJavaScript(`(() => {
    const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const sel = '.weui-desktop-toast, .weui-desktop-dialog, [role="alert"], [role="tooltip"], .weui-desktop-popover, [class*="toast"], [class*="message"]';
    const cands = [];
    for (const e of all) {
      if (!e.matches || !vis(e)) continue;
      try { if (!e.matches(sel)) continue } catch { continue }
      const t = String(e.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t && t.length <= 120) cands.push(t);
    }
    // 取最短的一条：最具体的提示（容器会把自己的标题也带进来）
    cands.sort((a, b) => a.length - b.length);
    return cands[0] || null;
  })()`).catch(() => null)
  return typeof found === 'string' && found.trim() ? found.trim().slice(0, 120) : null
}

/**
 * 把平台提示分类成**可处置**的错误码。
 * 规则本体在 `@shared/invite-notices`（纯函数、可单测），这里只做 re-export，避免两处漂移。
 */
export { classifyInviteBlockNotice }

/**
 * "登录态没拿到"的判据（用在超时分支里）。
 *
 * 真机来源（2026-10-04 快手分销后台）：页面地址完全正确（`/zone/daren-match/daren-square-pro`），
 * 标题也是「分销商家」，但正文只有一句「正在获取用户信息，请稍后…」——平台拿不到用户信息，
 * 界面永远不渲染。此时任何"等文案/等元素"都只会超时报 TASK_TIMEOUT，
 * 而用户能做的唯一一件事就是**重新登录**，所以必须把话说到点子上。
 *
 * 只认平台自己的措辞与登录域，不做推断（判错会把"页面慢"说成"登录失效"）。
 */
export async function detectSessionStall(wc: Electron.WebContents): Promise<string | null> {
  const url = (() => { try { return String(wc.getURL()) } catch { return '' } })()
  if (/login|passport|signin|sso/i.test(url)) return `页面被重定向到登录页（${url.slice(0, 100)}）`
  const body = await wc.executeJavaScript(`String(document.body ? document.body.innerText : '')`).catch(() => '')
  const hit = matchSessionStall(body)
  return hit ? `页面正文停在「${hit}」` : null
}

/**
 * 这次的运行标签页是不是**采集专用页**（internal）。
 *
 * internal 页由渲染层隐藏挂载：不进标签栏、不占活动位，但 guest 照常注册、页面照常有真实布局盒。
 * 采集走它就不会动用户正在看的页面（见 ensureRunTabForeground 的说明）。
 * 「什么样的任务才允许隐藏跑」的规则在 shared 的 shouldUseInternalRunTab（纯函数、有单测）。
 */
export function isInternalRunTab(run: RunHandle): boolean {
  if (!run.tabId) return false
  try {
    return getStoreTabs(run.storeId).some(t => t.id === run.tabId && t.internal === true)
  } catch { return false }
}
export function wcOrThrow(run: RunHandle): Electron.WebContents {
  const wc = run.tabId ? getTabWebContents(run.storeId, run.tabId) : null
  if (wc) return wc
  // 「标签页还在、只是页面句柄没注册」与「标签页真被关了」是两件事：
  // 前者由渲染层重新挂载 <webview> 后会恢复（可重试），后者只能重建任务。
  // 都报 BROWSER_CLOSED 会让用户看着一个还在的标签页去做无用功。
  const tabStillOpen = !!run.tabId && getStoreTabs(run.storeId).some(t => t.id === run.tabId)
  if (tabStillOpen) throw new Error('BROWSER_NOT_READY: 标签页页面尚未就绪（店铺 webview 未注册或正在重载）')
  throw new Error('BROWSER_CLOSED: 店铺浏览器或任务标签页已被关闭')
}

export function guardSignals(run: RunHandle): void {
  if (run.cancelRequested) throw cancelSig()
  if (run.pauseRequested && getCurrent() === run) throw pauseSig()
}

export async function withTimeout<T>(fn: () => Promise<T>, run: RunHandle, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`TASK_TIMEOUT: ${label} 超过 ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([fn(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 页签存活检查：轮询里 executeJavaScript 失败可能是"页签已销毁"，
 * 不能一律吞成 false 空转到超时——销毁了就立刻报 BROWSER_CLOSED */
function throwIfDestroyed(wc: Electron.WebContents): void {
  try {
    if (wc.isDestroyed()) throw new Error('BROWSER_CLOSED: 店铺浏览器或任务标签页已被关闭')
  } catch (e: any) {
    if (String(e?.message).startsWith('BROWSER_CLOSED')) throw e
    // isDestroyed 自身抛错（如句柄失效）同样视为已销毁
    throw new Error('BROWSER_CLOSED: 店铺浏览器或任务标签页已被关闭')
  }
}

/** 轮询式等待（每 300ms 检查一次，支持暂停/取消协作式打断） */
export async function pollUntil(run: RunHandle, cond: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  await withTimeout(async () => {
    for (;;) {
      guardSignals(run)
      if (await cond()) return
      await new Promise(r => setTimeout(r, 300))
    }
  }, run, timeoutMs, label)
}

/** 轮询等待选择器出现；超时抛 TASK_SELECTOR_CHANGED（区别于纯超时）。
 *  deep = 穿透 ShadowRoot 查询（微信小店整页在 <micro-app shadowdom> 里，普通 querySelector 不可见）；
 *  deadline = 可选的绝对截止时间（与后续执行共享步骤超时，避免"等待一个 timeout + 执行一个 timeout"的双倍耗时） */
export async function waitForSelector(wc: Electron.WebContents, sel: string, run: RunHandle, timeoutMs: number, deep = false, deadline = 0): Promise<void> {
  const expr = deep
    ? `(() => { ${ENUM_DEEP_FN} return __enumDeep().some(el => { try { return el.matches(${JSON.stringify(sel)}) } catch { return false } }) })()`
    : `!!document.querySelector(${JSON.stringify(sel)})`
  try {
    await withTimeout(async () => {
      for (;;) {
        guardSignals(run)
        if (deadline > 0 && Date.now() >= deadline) throw new Error(`TASK_TIMEOUT: 等待选择器 ${sel} 超过步骤时限`)
        // 注入失败先查存活：页签已销毁就立刻报 BROWSER_CLOSED，
        // 别吞成 false 空转到整步超时再报 SELECTOR_CHANGED
        const found = await wc.executeJavaScript(expr).catch(() => { throwIfDestroyed(wc); return false })
        if (found) return
        await new Promise(r => setTimeout(r, 300))
      }
    }, run, timeoutMs, `等待选择器 ${sel}`)
  } catch (e: any) {
    if (String(e?.message).startsWith('BROWSER_CLOSED')) throw e
    if (String(e?.message).startsWith('TASK_TIMEOUT')) throw new Error(`TASK_SELECTOR_CHANGED: 超时未出现元素 ${sel}`)
    throw e
  }
}

/** 共享截止版 withTimeout：等待与执行共用一个步骤时限，避免双倍超时 */
export async function withDeadline<T>(fn: () => Promise<T>, run: RunHandle, deadline: number, label: string): Promise<T> {
  guardSignals(run)
  const remain = deadline - Date.now()
  if (remain <= 0) throw new Error(`TASK_TIMEOUT: ${label} 超过步骤时限`)
  return withTimeout(fn, run, remain, label)
}

// ---------- ShadowRoot 穿透与受信任输入（微信小店 assist-form 流程的基础设施） ----------

/**
 * 枚举主文档与所有开放 ShadowRoot 的元素（文档序深度优先，宿主先于其 Shadow 内容）。
 * 以字符串注入 executeJavaScript 使用；只声明注入脚本自身的常量，不碰页面全局。
 */
export const ENUM_DEEP_FN = `
  const __enumDeep = () => {
    const out = []
    const walk = (r) => {
      for (const el of r.querySelectorAll('*')) {
        out.push(el)
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    return out
  }
`

/**
 * 元素可见性判据（微信的弹窗节点常预渲染在 DOM 里，仅靠存在性判断会被隐藏节点骗过）。
 * 导出供单测复用同一份源码（见 tests/unit/click-absent-text.test.ts）。
 */
export const VISIBLE_JS = `
  const __visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
`

/** 按自有文本定位可见目标（取最短命中），滚动到可见并返回真实点击坐标 */
/**
 * 候选排序：先按"自身文本最短"（最具体的那个），长度相同的再优先"看起来可点的标签"。
 * 实测动机：容器元素常常和里面的按钮拥有**同样的自身文本**（如 <div>达人等级
 * <button>达人等级</button></div>），只按长度排会先命中容器——点容器是个空操作，
 * 后续步骤就找不到本该出现的元素（仿真站点验证时踩到）。
 */
export const PICK_SORT_FN = `
  const __clickableScore = (el) => {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'LABEL' || tag === 'SELECT') return 0;
    if (el.getAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab')) return 0;
    if (/btn|button|chip|tab|option|item|link/i.test(String(el.className || ''))) return 1;
    return 2;
  };
  const __pickBest = (cands) => {
    cands.sort((a, b) => (a.len - b.len) || (__clickableScore(a.el) - __clickableScore(b.el)));
    return cands[0];
  };
  /**
   * 文案规范化：去掉**全部空白**。
   *
   * 实测动因（快手达人广场，2026-09-15）：平台把按钮文案拆进子 span 并用 CSS 拉字距，
   * innerText 变成「确 认」「重 置」「查 询」，而元素的 ownText 干脆是空串——
   * 按 ownText 精确匹配一个都命中不了，点击直接报"找不到文案为「确认」的可点击元素"。
   * 规范化后按 innerText 匹配即可命中（见下面 ownText 为主、innerText 兜底的两级扫描）。
   */
  const __narrow = (s) => String(s == null ? '' : s).replace(/\\s+/g, '');
`

/**
 * 重试专用的 **JS 兜底点击**（不经过坐标）。
 *
 * 为什么需要（2026-10-14 真机定位）：受信任鼠标点击是"先算坐标 → 再发事件"，而两次之间页面还会
 * 继续排版——实测快手发票页的页签横条会随上方内容加载上下跳约 123px，于是**重试真点击可能次次落空**
 * （当天实测：连点 3 次仍失败）。JS 点击直接在页面里对元素派发 click，不经过坐标，天然免疫这种竞态。
 *
 * 为什么只当兜底、不当主路：合成 click 对某些"框架托管、只认真实输入"的控件不生效（实测微信邀约表单），
 * 所以第一次仍用受信任鼠标；只有"点了但页签没变成选中态"时，才用它与真实鼠标交替重试。
 * 成败仍由 `verifyActive` 判定，绝不用"点了就算成功"糊过去。
 *
 * @returns 兜底结果（供错误信息里如实说明用了哪条路、有没有找到元素）
 */
export async function jsClickByTextFallback(
  wc: Electron.WebContents, needle: string, deep: boolean, within?: { selector?: string }
): Promise<string> {
  const src = `(() => {
    ${deep ? ENUM_DEEP_FN : ''}
    const want = ${JSON.stringify(needle)};
    const sel = ${JSON.stringify(within?.selector ? String(within.selector) : null)};
    const pool = ${deep ? '__enumDeep()' : 'Array.from(document.querySelectorAll("*"))'};
    let roots = null;
    if (sel) {
      roots = pool.filter(el => { try { return el.matches(sel) } catch { return false } });
      if (!roots.length) return JSON.stringify({ ok: false, reason: 'SCOPE_NOT_FOUND' });
    }
    const own = (el) => String(el.innerText || '').replace(/\\s+/g, ' ').trim();
    const inScope = (el) => !roots || roots.some(root => root === el || root.contains(el));
    const hit = pool.find(el => own(el) === want && inScope(el) && el.getBoundingClientRect().width > 0);
    if (!hit) return JSON.stringify({ ok: false, reason: 'NOT_FOUND' });
    // 与"视图未挂载"分支同样的做法：点它自己与最多 3 层祖先（平台常把 handler 挂在父节点上）
    const chain = [];
    let n = hit;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) { try { n.click(); chain.push(n.tagName) } catch { chain.push('err') } }
    return JSON.stringify({ ok: true, chain: chain.join('>') });
  })()`
  try {
    const raw = await wc.executeJavaScript(src)
    const parsed = (() => { try { return JSON.parse(String(raw)) } catch { return null } })()
    if (!parsed) return 'JS 兜底：结果不可解析'
    return parsed.ok ? `JS 兜底：已点击（${parsed.chain}）` : `JS 兜底：${parsed.reason}`
  } catch (e) {
    return `JS 兜底：执行异常 ${String((e as Error)?.message || e).slice(0, 60)}`
  }
}

/**
 * 查找范围限定（clickByText / waitForText 的 within）。
 * 实测动机（抖店广场）：类目名同时出现在筛选 chip 与达人卡片的类目文案里，
 * "不限"在等级下拉里也有同名项——不限定范围就会点错目标，筛选静默失效。
 *
 * 返回的是**范围集合**而不是单个元素：`selector` 命中多个时要每个都算范围内。
 * 实测踩过（快手发票页签）：页签容器 `.ant-tabs-tab-btn` 有三个，旧实现只取
 * `querySelector` 的第一个——于是"在页签里找「处理中」"变成了"在第一个页签
 * （未开票账单）里找处理中"，必然找不到，报出误导性的"页面上找不到文案为「处理中」的可点击元素"。
 */
export const SCOPE_FN = `
  const __scopeRoots = (w, deep) => {
    if (!w) return null;
    /**
     * deep=true 时锚点也要在 ShadowRoot 里找（微信小店整页在 micro-app 的 ShadowRoot 里）。
     * 实测踩过：类目行的行标签文字在 ShadowRoot 内，而这里以前只用 document.querySelectorAll，
     * 于是「限定在带货类目那一行里点」永远拿不到范围 → 直接报 SCOPE_NOT_FOUND（真机复现）。
     * 非 deep 调用保持原样（document 级），行为零变化。
     */
    const pool = deep ? __enumDeep() : document.querySelectorAll('*');
    let roots = [];
    // selector 分支：非 deep 时**保持原来的 document.querySelectorAll(selector)**（行为零变化）；
    // 只有 deep 才在穿透 ShadowRoot 的元素池里按 matches 过滤。
    if (w.selector) roots = deep
      ? Array.from(pool).filter((el) => el.matches && el.matches(w.selector))
      : Array.from(document.querySelectorAll(w.selector));
    else {
      const cands = [];
      for (const el of pool) {
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        if (own === w.text || (own.includes(w.text) && own.length <= w.text.length + 12)) cands.push({ el, len: own.length });
      }
      if (cands.length) { cands.sort((a, b) => a.len - b.len); roots = [cands[0].el] }
    }
    if (!roots.length) return null;
    const climb = w.climb || 0;
    for (let i = 0; i < climb; i++) {
      roots = roots.map(r => r.parentElement).filter(Boolean);
      if (!roots.length) break;
    }
    return roots.length ? roots : null;
  };
  const __inScope = (roots, el) => !roots || roots.some(r => r.contains(el));
`

/**
 * 目标缺席判据（clickByText 的 absentText）：页面上是不是**明说了这件事做不了**。
 *
 * 实测动因（微信达人详情页，2026-09-15）：可邀约的达人显示「邀请带货」，
 * 不达合作门槛的显示「暂未到达合作门槛」——两者都表现为"找不到「邀请带货」"，
 * 但处置**相反**：前者多半是微应用没渲染出来（退避后重试同一位还能成），
 * 后者是这位达人天生不能邀约（重试一万次也一样，必须换下一位）。
 * 不区分就会出现"一直重试同一位 → 连续 N 次 → 整单失败、一位都没邀约"。
 *
 * 判据的松紧很关键：只认"**本身就在说这句话**"的元素（自有文本命中，或整段文本
 * 不比那句话长多少）。不设这条限制的话，任何祖先（直到整页容器）都会因为
 * "后代里有这句话"而命中，判据就退化成"页面上出现过这几个字"——太松，容易误判。
 */
export const ABSENT_FN = `
  const __absentHit = (el, at) => {
    if (!__visible(el)) return false;
    const narrowAt = __narrow(at);
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const it = __narrow(el.innerText);
    if (own.includes(at)) return narrowAt ? it.length <= narrowAt.length + 24 : true;
    return narrowAt.length > 0 && it.includes(narrowAt) && it.length <= narrowAt.length + 24;
  };
`

/**
 * 点完校验目标**真的被勾选**（clickByText 的 verifyChecked）。
 *
 * 为什么需要：有的平台把"筛选到底生效没有"**只**表达在控件自己的勾选态上。实测微信小店
 * 带货者广场「带货销售总额」（2026-10-02）：下拉里的区间是复选框，选完立即生效、浮层自己收起，
 * 而 DT 上的文案永远是指标名（不会变成所选区间），这一版页面也没有「已筛选」摘要——
 * 于是"点过了"与"筛上了"在页面上看不出任何区别。筛选静默失效意味着**把不该邀的达人放进名单**，
 * 属于发送类动作的前置条件，所以宁可在这里如实失败。
 *
 * 判据：按文案找到目标（限 within 范围内；exact/deep 与点击同一套规则），读它自身或所属 label 里的
 * checkbox.checked；轮询到勾选为止，超时按 code（默认 TASK_FILTER_NOT_APPLIED）失败。
 *
 * ⚠️ **不要求元素可见**：选项所在的浮层点完就收起了（DOM 还在，rect 变 0），
 * 用可见性当判据会把"已经选好了"误判成"没选上"（真机踩过）。
 */
export async function assertCheckedAfterClick(
  wc: Electron.WebContents,
  run: RunHandle,
  opts: {
    needle: string
    deep: boolean
    exact: boolean
    within?: { selector?: string; text?: string; climb?: number }
    timeoutMs: number
    code: string
    hint?: string
  }
): Promise<void> {
  const until = Date.now() + Math.max(3000, Math.min(opts.timeoutMs, 15000))
  let lastSeen = '页面上找不到该文案的控件'
  for (;;) {
    guardSignals(run)
    const raw = await wc.executeJavaScript(`(() => {
      ${opts.deep ? ENUM_DEEP_FN : ''}
      ${SCOPE_FN}
      const needle = ${JSON.stringify(opts.needle)};
      const narrow = (s) => String(s == null ? '' : s).replace(/\\s+/g, '');
      const exact = ${opts.exact ? 'true' : 'false'};
      const roots = ${JSON.stringify(opts.within || null)} ? __scopeRoots(${JSON.stringify(opts.within || null)}, ${opts.deep ? 'true' : 'false'}) : null;
      const scope = ${opts.deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
      const cands = [];
      for (const el of scope) {
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        if (exact ? narrow(own) !== narrow(needle) : !own.includes(needle)) continue;
        if (roots && !roots.some(r => r.contains(el))) continue;
        cands.push({ el, len: own.length });
      }
      if (!cands.length) return JSON.stringify({ found: false });
      cands.sort((a, b) => a.len - b.len);
      const hit = cands[0].el;
      const cb = (hit.querySelector && hit.querySelector('input[type=checkbox]')) ||
        (hit.closest && hit.closest('label') ? hit.closest('label').querySelector('input[type=checkbox]') : null);
      return JSON.stringify({ found: true, hasInput: !!cb, checked: !!(cb && cb.checked) });
    })()`).catch(() => JSON.stringify({ found: false }))
    const parsed = (() => { try { return JSON.parse(String(raw)) } catch { return { found: false } } })()
    if (parsed.checked) return
    lastSeen = !parsed.found ? '页面上找不到该文案的控件' : (parsed.hasInput ? '控件还在未勾选态' : '该文案附近没有复选框')
    if (Date.now() >= until) break
    await new Promise(r => setTimeout(r, 300))
  }
  const hint = opts.hint ? `——${opts.hint}` : ''
  throw new Error(`${opts.code}: 「${opts.needle}」点了但**没有生效**（${lastSeen}）${hint}`)
}

export async function findTextTarget(
  wc: Electron.WebContents, run: RunHandle, needle: string, deep: boolean, timeoutMs: number, label: string,
  within?: { selector?: string; text?: string; climb?: number },
  pick?: { roundIdx?: number; visited?: string[]; dedupNs?: string },
  /** 视图未挂载时是否允许降级为 JS 点击（见下方视口退化分支）。默认 false = 如实报 VIEW_DETACHED */
  allowJsWhenDetached = false,
  /**
   * "目标不存在，但页面上出现了这段替代文案"时的判据（见 StepInput 的 absentText）。
   * 命中时**立刻**返回 reason:'ABSENT'——不要等到超时：这两件事的处置完全相反
   * （页面没渲染出来 → 等一下/重试同一位；这位对象天生不可用 → 立刻换下一位）。
   */
  absentTexts?: string[],
  exact = false,
  /**
   * 已勾选就跳过（不点）。用途：平台会**记住上次填写**的复选组/级联项——
   * 批量邀请第 2 轮起抽屉里是带记忆的状态，照旧点一遍会把上一轮的勾选**取消掉**
   * （实测抖店抽屉：核心优势/权益/主营都会保留，重复点击等于反选）。
   */
  skipIfChecked = false,
  /**
   * 跳过"行文本里含这些文案"的候选（2026-10-04 加）。
   *
   * 用途：用户要求"7 天内邀过的达人不再重复邀约"。平台的硬拦截在**详情页**（按钮禁用），
   * 那要先花一次详情页访问；广场列表行又没有"已邀约"标记（真机实测：列表无标记、
   * 详情链接是 javascript:void(0)、拿不到 finderUsername），所以只能拿我们自己台账里的
   * 昵称清单，在这里**点「详情」之前**把那些行剔掉。
   * 全被剔掉时按 ALL_VISITED 处理 → 上层报 missingCode → 翻页继续找。
   */
  skipTexts?: string[],
  /** 命中后把"这一行的达人昵称"一并回传（用于写入邀约台账） */
  recordRowText = false
): Promise<{ ok: boolean; reason?: string; x?: number; y?: number; clickedText?: string; candidates?: number; coveredBy?: string; rowKey?: string; picked?: string; viaBlocker?: string; transport?: 'trusted-mouse' | 'js-fallback'; absentText?: string; disabledReason?: string; skipped?: 'checked'; rowNickname?: string; skippedInvited?: number }> {
  return withTimeout(() => wc.executeJavaScript(`(() => {
    ${deep ? ENUM_DEEP_FN : ''}
    ${VISIBLE_JS}
    ${SCOPE_FN}
    ${PICK_SORT_FN}
    ${ABSENT_FN}
    const needle = ${JSON.stringify(needle)};
    const within = ${JSON.stringify(within || null)};
    const absentTexts = ${JSON.stringify(absentTexts || [])};
    const roundIdx = ${pick && pick.roundIdx != null ? JSON.stringify(pick.roundIdx) : 'null'};
    const visited = new Set(${JSON.stringify((pick && pick.visited) || [])});
    const dedupNs = ${JSON.stringify((pick && pick.dedupNs) || '')};
    const skipTexts = ${JSON.stringify(skipTexts || [])};
    const recordRowText = ${recordRowText ? 'true' : 'false'};
    const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
    const roots = within ? __scopeRoots(within, ${deep ? 'true' : 'false'}) : null;
    if (within && !roots) return { ok: false, reason: 'SCOPE_NOT_FOUND' };
    const cands = [];
    // 两级匹配（顺序不能反）：
    //  ① 自有文本（最精确，"按钮自己的文字"）——既有平台的既有行为全靠它，先跑，保持零变化；
    //  ② 规范化后的 innerText（去空白的整段文本）——兜住"文案被拆进子 span + CSS 拉字距"的平台。
    //     实测快手：按钮 innerText 是「确 认」「批量邀约」，而 ownText 为空串，
    //     只做 ① 一个都命中不了。② 只在 ① 一无所获时启用，且限定"文本短"（≤ needle+12 个字符）
    //     并且是**可点元素或其祖先**，避免把大容器（整页文本凑巧含该词）当成目标点上去。
    const narrowNeedle = __narrow(needle);
    for (const el of scope) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (${exact} ? __narrow(own) !== narrowNeedle : !own.includes(needle)) continue;
      if (!__inScope(roots, el)) continue;
      if (!__visible(el)) continue;
      cands.push({ el, len: own.length });
    }
    if (!cands.length && narrowNeedle) {
      // ② 的扫描域：有范围限定就遍历范围内的元素，否则遍历整个文档
      const pool = []
      if (roots) for (const r of roots) { pool.push(r); for (const c of r.querySelectorAll('*')) pool.push(c) }
      else for (const el of scope) pool.push(el);
      for (const c of pool) {
        const tag = c.tagName;
        // 只认"本身就可能是那个控件"的标签：普通容器即使文本凑巧相同也不点（点了等于点空白）
        if (!(tag === 'BUTTON' || tag === 'A' || tag === 'LABEL' || tag === 'SPAN' ||
              (c.getAttribute && c.getAttribute('role') === 'button'))) continue;
        if (!__visible(c)) continue;
        if (__narrow(c.innerText) !== narrowNeedle) continue;
        cands.push({ el: c, len: narrowNeedle.length, viaText: true });
      }
    }
    if (!cands.length) {
      // 目标一个都没有时，先看页面上是不是**明说了这件事做不了**（absentTexts，见 ABSENT_FN）
      for (const at of absentTexts) {
        if ([...scope].some(el => __absentHit(el, at))) return { ok: false, reason: 'ABSENT', absentText: at };
      }
      return { ok: false, reason: 'NOT_FOUND' };
    }
    cands.sort((a, b) => (a.len - b.len) || (__clickableScore(a.el) - __clickableScore(b.el)));
    // 按"列表条目"（行容器文本）去重后取目标：
    //  - nth:'round'     → 第 roundIdx 条（0 起；条数不够 = 没有下一个候选）
    //  - nth:'unvisited' → 第一条本次运行还没点过的（微信广场每次加载都洗牌，靠"第几条"不能保证换人）；
    //                      本页全点过 = 该页取不出，调用方按 missingCode 报错后翻页重试
    let hit = cands[0].el;
    let picked = 'best';
    let rowKey = null;
    let skippedInvited = 0;
    if (roundIdx != null || dedupNs) {
      const rowOf = (el) => el.closest('tr, li, [data-row-key], [class*="card"], [class*="dorami"]') || el.parentElement || el;
      const keyOf = (el) => {
        const row = rowOf(el);
        return String((row && row.innerText) || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      };
      const seen = new Set();
      const entries = [];
      for (const c of cands) {
        const k = keyOf(c.el);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        entries.push({ el: c.el, key: k });
      }
      // 表格横向滚动时平台会复制一份"固定列镜像"，镜像里那个链接的**自身容器只有链接文字**
      // （实测微信广场：滚动区是 <tr>，镜像那份的容器文本就是"详情"两个字）。
      // 它不是一条独立候选——真行永远带着达人信息。不过滤掉的话会被当成"第 6 条"，
      // 于是同一页里对第一位达人重复邀约（实测踩过）。
      if (entries.length > 1) {
        const rich = entries.filter(e => e.key !== needle);
        if (rich.length) entries.length = 0, entries.push(...rich);
      }
      /**
       * 剔掉"近 7 天已邀过"的行（skipTexts = 本地台账里的昵称清单）。
       * 判定用**整行文本包含**：列表行里同时有昵称、类目、评分等，昵称是其中一段。
       * 全被剔掉 → 与"本页都点过"同义（这一页没有可邀的人了）→ 交给上层翻页。
       */
      let usable = entries;
      if (skipTexts.length) {
        usable = entries.filter(e => {
          const hitSkip = skipTexts.some(t => t && e.key.includes(t));
          if (hitSkip) skippedInvited++;
          return !hitSkip;
        });
        if (!usable.length) return { ok: false, reason: 'ALL_VISITED', skippedInvited, candidates: cands.length };
      }
      /** 这一行的达人昵称：优先取首列里的 .truncate（真机实测微信首列结构），否则取行文本第一段 */
      const nicknameOf = (el) => {
        const row = rowOf(el);
        const node = (row && row.querySelector ? (row.querySelector('td .truncate') || row.querySelector('.truncate')) : null);
        if (node) return String(node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
        const text = String((row && row.innerText) || '').replace(/\\s+/g, ' ').trim();
        return (text.split(' ')[0] || '').slice(0, 120);
      };
      if (roundIdx != null) {
        if (roundIdx >= usable.length) return { ok: false, reason: 'NOT_FOUND' };
        hit = usable[roundIdx].el;
        rowKey = dedupNs + ':' + usable[roundIdx].key;
        picked = 'round' + roundIdx;
      } else {
        const avail = usable.filter(e => !visited.has(dedupNs + ':' + e.key));
        // 有候选但全都处理过 → 与"一个候选都没有（列表还没渲染/真没了）"区分开：
        // 前者可以立刻判定该翻页，后者必须继续等（否则冷加载时会被误判成"本页取尽"而跳页）
        if (!avail.length) return { ok: false, reason: usable.length ? 'ALL_VISITED' : 'NOT_FOUND', skippedInvited, candidates: cands.length };
        hit = avail[0].el;
        rowKey = dedupNs + ':' + avail[0].key;
        picked = 'unvisited';
      }
      if (recordRowText) var rowNickname = nicknameOf(hit);
    } else if (recordRowText) {
      // 没走"按行取"的路径（单点，如翻页按钮）：也回传一下所在行文本，调用方自行判断
      var rowNickname = '';
    }
    // 已勾选就跳过：平台的"记住上次填写"会让重复点击变成**反选**，见 findTextTarget 的 skipIfChecked 说明。
    if (${skipIfChecked ? 'true' : 'false'}) {
      const cb = (hit.querySelector && hit.querySelector('input[type=checkbox]')) ||
        (hit.closest && hit.closest('label') ? hit.closest('label').querySelector('input[type=checkbox]') : null);
      if (cb && cb.checked) {
        return {
          ok: true, skipped: 'checked',
          clickedText: String(hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
          candidates: cands.length, picked, rowKey,
          rowNickname: (typeof rowNickname === 'string' ? rowNickname : undefined)
        };
      }
    }
    let dis = hit.disabled === true || hit.getAttribute('aria-disabled') === 'true';
    // 从**元素自身**开始查禁用类：平台普遍用 class 表达禁用（实测微信：「发送邀约」在字段齐备前
    // 是 weui-desktop-btn_disabled，没有 disabled 属性；末页的「下一页」同理）——
    // 只查父级会漏掉按钮自己，于是把"点不动的按钮"当成可点，点击静默无效（实测踩过）。
    let p = hit;
    for (let i = 0; i < 4 && p && !dis; i++, p = p.parentElement) {
      if (/disabled/i.test(String(p.className || ''))) dis = true;
    }
    if (dis) {
      // 禁用原因的浮层文案：平台普遍把"为什么不能点"放在按钮旁边的 popover 里
      // （实测微信达人详情页：已邀约的按钮带 weui-desktop-btn_disabled，
      //   悬浮说明是「你已经邀请过该达人，7天内不可再次发送带货邀约」）。
      // 读它是为了让日志说出**真实原因**，而不是一句含糊的"平台限制该操作"——
      // 排查时"已邀约"和"额度用完"是完全不同的处置。
      let why = '';
      try {
        let n = hit;
        for (let i = 0; i < 6 && n && !why; i++, n = n.parentElement) {
          const pop = n.querySelector && n.querySelector('.weui-desktop-popover, [class*="tooltip"], [role="tooltip"]');
          if (pop) why = String(pop.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        }
      } catch { /* 读不到原因不影响主流程 */ }
      return { ok: false, reason: 'DISABLED', disabledReason: why };
    }
    // 视口退化的兜底：页面文档视口塌成近 0 时（DOM <webview> 尚未注册 guest、被从文档里
    // 移除、或平台自己把内容区折叠），元素还在、也还有尺寸，但坐标全在视口外，
    // elementFromPoint 一律 null，受信任鼠标**物理上到不了**。
    // 实测（原生视图时代）：发票中心的采集任务在自己的弹层打开期间跑，页签切换全部报
    // TASK_TARGET_COVERED/unknown，一个方向都切不过去——不是页面点不到，是"视图没挂载"
    // 被误报成了"被遮挡"。DOM <webview> 之后弹层只靠 CSS 层级，不再摘除页面，
    // 这条兜底留给真正的视口塌陷。
    // 是否降级由步骤显式声明（allowJsWhenDetached）：JS 点击对**框架托管的按钮**可能无效
    // （微信邀约实测合成 click 不生效），所以不能全局兜底——没声明的步骤如实报 VIEW_DETACHED，
    // 由调用方立刻抛出，而不是白等到超时再给一句含糊的"找不到元素"。
    if (window.innerWidth < 50 || window.innerHeight < 50) {
      if (!${allowJsWhenDetached ? 'true' : 'false'}) {
        return { ok: false, reason: 'VIEW_DETACHED', coveredBy: window.innerWidth + 'x' + window.innerHeight };
      }
      const chain = [];
      let n = hit;
      for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
        try { n.click(); chain.push(n.tagName) } catch { chain.push('err') }
      }
      return {
        ok: true, x: 0, y: 0, transport: 'js-fallback',
        clickedText: String(hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        candidates: cands.length, picked, rowKey,
        rowNickname: (typeof rowNickname === 'string' ? rowNickname : undefined),
        viaBlocker: 'JS降级(' + chain.join('>') + ')'
      };
    }
    hit.scrollIntoView({ block: 'center' });
    const r = hit.getBoundingClientRect();
    // 真实鼠标点击要落在"没被遮挡"的点上：窗口较窄时平台页面会重叠（实测微信广场
    // 「美妆护肤」/「详情」整块被别的筛选块压住，按中心点会点在浮层上、点击静默失效）。
    // 在元素矩形内取多个采样点，用 elementFromPoint（穿 ShadowRoot）确认命中的是目标
    // 自身/其后代/同一 label；全被遮挡则如实报 COVERED（由调用方决定重试或失败）。
    const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner } return el };
    const labelEl = hit.closest('label') || hit.parentElement || hit;
    // 采样点**从中心开始**，再向两侧退。
    // 为什么不从左往右扫（改前是 0.12→0.88）：左侧 12% 处常常正好压在行内的**复选框**上——
    // 实测抖店抽屉「主营」多选级联（2026-09-22 真机）：点复选框只勾选、**不展开子列**，
    // 于是"点一级展开二级"这一步看着成功、下一级却怎么都找不到（TASK_SELECTOR_CHANGED）；
    // 而点条目中部（文字区）才会展开。中心点也是人点这类条目的自然落点，对按钮/页签同样安全。
    const xs = [0.5, 0.3, 0.7, 0.12, 0.88].map(f => Math.round(r.left + r.width * f));
    const ys = [0.5, 0.25, 0.75].map(f => Math.round(r.top + r.height * f));
    for (const x of xs) {
      for (const y of ys) {
        const at = deepAt(x, y);
        if (at && (at === hit || hit.contains(at) || at.contains(hit) || labelEl.contains(at) || at.contains(labelEl))) {
          return { ok: true, x, y, clickedText: String(hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), candidates: cands.length, picked, rowKey, skippedInvited, rowNickname: (typeof rowNickname === 'string' ? rowNickname : undefined) };
        }
      }
    }
    const blocker = deepAt(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    // 遮挡者若是"同一行/同一卡片里的可点链接"（平台常把整卡做成 <a> 覆盖住里面的按钮），
    // 点它就是用户实际会做的事（实测微信广场「详情」被 A.w-full text-right 盖住）；限定同一行内才点。
    const rowOf = (el) => el.closest('tr, li, [data-row-key], [class*="card"], [class*="dorami"]') || el.parentElement;
    if (blocker) {
      let anc = blocker;
      for (let i = 0; i < 4 && anc; i++, anc = anc.parentElement) {
        const tag = anc.tagName;
        const interactive = tag === 'A' || tag === 'BUTTON' || tag === 'LABEL' || anc.getAttribute('role') === 'button';
        if (interactive && rowOf(anc) === rowOf(hit)) {
          return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickedText: String(hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), candidates: cands.length, viaBlocker: tag, picked, rowKey, rowNickname: (typeof rowNickname === 'string' ? rowNickname : undefined) };
        }
      }
      // 固定列副本：表格比视口宽时平台把右侧「操作」列复制成 position:fixed 的镜像
      // （实测微信广场 .weui-desktop-table__right-shadow 里那份「详情」压住了滚动区那份）。
      // 两份是同一个链接、同一行，但分属不同 <tr>，上面的同行判定认不出来——
      // 这里按"自身文本完全相同"认定是同一目标，直接点这个点到手的位置（落点就是它）。
      const ownOf = (el) => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      let same = blocker;
      for (let i = 0; i < 4 && same; i++, same = same.parentElement) {
        const tag = same.tagName;
        const interactive = tag === 'A' || tag === 'BUTTON' || tag === 'LABEL' || same.getAttribute('role') === 'button';
        if (interactive && ownOf(same) === ownOf(hit)) {
          return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickedText: String(same.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), candidates: cands.length, viaBlocker: tag + '(同文本副本)', picked, rowKey, rowNickname: (typeof rowNickname === 'string' ? rowNickname : undefined) };
        }
      }
    }
    // 元素整块在视口外 ≠ 被别的元素遮挡：这两件事的原因与处置完全不同。
    // 实测（2026-09-15 快手达人邀约）：平台的级联弹层靠 rAF 计算定位；页面被节流时
    // （窗口被遮挡 → Chromium 降频/停摆 rAF）弹层永远停在初始的 -9999,-9999，
    // 子类「纸品湿巾」的矩形完全落在视口外，elementFromPoint 一律 null。
    // 此前这里统一报「被 unknown 遮挡——请把店铺窗口拉宽一些」，把人往"窗口太窄"上引，
    // 而实际与宽度无关（加到 1320 也一样，实测）。这里如实分开说。
    // 注意：这段是**注入页面的脚本**（在模板字面量里），字符串拼接不能用模板字面量。
    const outsideViewport = r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight
    if (outsideViewport) {
      return {
        ok: false, reason: 'OUT_OF_VIEWPORT',
        coveredBy: '元素在视口外（矩形 ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + '×' + Math.round(r.height) + '；视口 ' + innerWidth + '×' + innerHeight + '）'
      };
    }
    return { ok: false, reason: 'COVERED', coveredBy: blocker ? blocker.tagName + '.' + String(blocker.className || '').slice(0, 40) : 'unknown' };
  })()`), run, timeoutMs, label)
}

/** 在 (x,y) 发受信任鼠标点击（走浏览器输入管线，页面收到 isTrusted 事件） */
export function realClick(wc: Electron.WebContents, x: number, y: number): void {
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

/**
 * 落点点击：正常走受信任鼠标；`transport === 'js-fallback'` 表示视图当时没挂载
 * （见 findTextTarget 里的视口退化分支）——那种情况下点击**已经由 JS 多级点击完成**，
 * 这里不能再发鼠标事件：坐标此时毫无意义，硬发只会点到视口外的随机位置。
 */
export function performHitClick(
  wc: Electron.WebContents,
  hit: { x?: number; y?: number; transport?: 'trusted-mouse' | 'js-fallback' }
): void {
  if (hit.transport === 'js-fallback') return
  realClick(wc, hit.x!, hit.y!)
}

/**
 * 需要真实落点的步骤在开跑前先确认页面视口是真实的。
 *
 * 为什么必须显式查：视口塌成近 0 时（guest 未注册/被移出文档）getBoundingClientRect
 * 仍然返回（可能已经塌缩的）数值——于是坐标点击会"看起来发出去了、实际什么都没点到"，
 * 直到若干步之后才以别的错误码失败，根因完全看不出来。宁可这里立刻如实报出。
 */
export async function assertViewMounted(wc: Electron.WebContents, label: string): Promise<void> {
  const vp = await wc.executeJavaScript('({ w: innerWidth, h: innerHeight })').catch(() => null)
  if (vp && (vp.w < 50 || vp.h < 50)) {
    throw new Error(`TASK_VIEW_DETACHED: ${label} 需要真实落点，但页面视口塌陷（${vp.w}×${vp.h}）——店铺 webview 可能尚未注册或被移出文档，请重新打开店铺页面后重试`)
  }
}

/**
 * 跟随新标签页（点击后平台用 window.open 打开目标页时使用）。
 *
 * 真店实测（微信小店达人广场「详情」）：点击不改变当前页地址，而是在店铺窗口里
 * **新开一个标签页**——店铺窗口的弹窗策略是"开成新标签页并切到前台"（window-manager
 * createTab 的 setWindowOpenHandler）。引擎此前只认运行标签页，于是后面的
 * waitForPage（urlIncludes: finder-detail）永远等不到，整轮就在超时中失败。
 *
 * 这里在点击前记下已有标签页、点击后等新标签页出现，把本次运行切到新标签页，
 * 旧的运行标签页关掉（不关的话每个候选都留一个，几十轮下来堆满窗口）。
 * 只做"跟随"，不做断言：地址是否真的是目标页由后面紧跟的 waitForPage 校验。
 */
export async function followOpenedTab(
  run: RunHandle, beforeIds: Set<string>, urlIncludes: string | undefined, timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  const fresh = () => getStoreTabs(run.storeId).filter(t => !beforeIds.has(t.id))
  for (;;) {
    guardSignals(run)
    const opened = fresh()
    // 优先取地址匹配的那个；没有匹配的（新标签页还在 about:blank / 先开壳后跳转）就取第一个新的
    const picked = (urlIncludes ? opened.find(t => String(t.url || '').includes(urlIncludes)) : null) || opened[0]
    if (picked) return picked.id
    if (Date.now() >= deadline) return null
    await new Promise(r => setTimeout(r, 250))
  }
}

/**
 * 受信任文本写入：真实点击聚焦 → Ctrl+A 全选 → Delete → insertText（IME 同管线）→ 回读校验。
 * 微信表单不吃合成 input 事件（实测：原生 setter + dispatchEvent 后计数器/按钮状态不动），
 * 所以 setInput 的 JS 写入路径对它无效，必须走这里。
 * 校验不过如实抛 TASK_INPUT_NOT_APPLIED——绝不假装写入成功。
 */
/** 读回输入框当前值（contentEditable 读 textContent，其余读 value）；元素不在返回 null */
export async function readFieldValue(wc: Electron.WebContents, sel: string): Promise<string | null> {
  try {
    return await wc.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      return el.isContentEditable ? String(el.textContent || '') : String(el.value == null ? '' : el.value);
    })()`) as string | null
  } catch {
    return null
  }
}

/**
 * "写入是否真的生效"的判据（setInput / fillDraft / aiGenerate 共用）。
 *
 * 存在意义：注入脚本 return true 只说明 setter 调用没抛异常，**不代表框架接收了值**——
 * 平台把输入框换成只读态、被框架重置、元素在 ShadowRoot 里换了实例，都会让写入静默失效，
 * 而失败要等跑到"发送"那一步才以平台拦截的形式暴露（此时前面几轮可能已真发出去）。
 *
 * 判据刻意宽松（避免把平台的正常归一化误判成失败）：
 *   · 归一化（去空白/压缩空白）后全等 → 通过；
 *   · 页面值非空且是期望的前缀（maxlength 截断）→ 通过；
 *   · 页面值包含期望（平台包了一层标记/换行）→ 通过。
 * 只有"页面里根本不是这段文本"才失败，并且报错只说长度不说内容（§4.5 不落表单原文）。
 */
export function assertWriteApplied(applied: string | null, expected: string, label: string): void {
  const norm = (s: string) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  const a = norm(applied ?? '')
  const e = norm(expected)
  if (!expected.length) return
  if (applied == null) throw new Error(`TASK_INPUT_NOT_APPLIED: ${label} 写入后目标元素已不在页面上（${expected.length} 字未确认）`)
  if (a === e) return
  if (a && e.startsWith(a)) return
  if (a && a.includes(e)) return
  throw new Error(`TASK_INPUT_NOT_APPLIED: ${label} 写入未生效（期望 ${expected.length} 字，页面实际 ${a.length} 字）`)
}

export async function trustedWrite(
  wc: Electron.WebContents, run: RunHandle, sel: string, deep: boolean, text: string, timeoutMs: number, label: string
): Promise<void> {
  const findEl = deep
    ? `(() => { ${ENUM_DEEP_FN} return __enumDeep().find(el => { try { return el.matches(${JSON.stringify(sel)}) } catch { return false } }) || null })()`
    : `(document.querySelector(${JSON.stringify(sel)}))`
  const located = await withTimeout(() => wc.executeJavaScript(`(() => {
    const el = ${findEl};
    if (!el) return { ok: false, reason: 'NOT_FOUND' };
    ${VISIBLE_JS}
    if (!__visible(el)) return { ok: false, reason: 'INVISIBLE' };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: 'ZERO_RECT' };
    return { ok: true, x: Math.round(r.left + Math.min(r.width / 2, Math.max(r.width - 6, 1))), y: Math.round(r.top + r.height / 2) };
  })()`), run, timeoutMs, `${label} 定位`)
  if (!located || !located.ok) {
    throw new Error(`TASK_SELECTOR_CHANGED: ${label} 目标不可用（${located && located.reason || 'UNKNOWN'}）${sel}`)
  }
  guardSignals(run)

  // 受信任输入**必须**有真实落点：视图被摘（弹层遮挡）时页面视口是 0×0，
  // 坐标点击与键盘事件都到不了页面。这里提前如实失败，别让它点两轮再来一句含糊的
  // "写入未生效"——否则排查时看不出根因是"视图没挂载"。
  await assertViewMounted(wc, label)

  // 同内容重写是幂等的，允许一次整体重试吸收偶发竞态（忙机焦点/输入管线滞后）
  let lastDiag = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    // 点击后必须等焦点真正落到目标上再发键盘事件：忙时点击的聚焦会慢于后续按键，
    // Ctrl+A/Delete 会打到上一个字段、insertText 落空（实测复现过）。轮询确认，兜底 JS focus。
    // 注意 ShadowRoot 内的元素要看 getRootNode().activeElement——document.activeElement
    // 只会返回 shadow 宿主，永远不相等（微信整页在 shadow 里，实测踩过）。
    let focused = 'no'
    for (let i = 0; i < 3 && focused !== 'yes'; i++) {
      realClick(wc, located.x, located.y)
      await new Promise(r => setTimeout(r, 220))
      guardSignals(run)
      focused = await wc.executeJavaScript(`(() => {
        const el = ${findEl};
        if (!el) return 'GONE';
        const root = el.getRootNode ? el.getRootNode() : null;
        const active = (root && root.activeElement) || document.activeElement;
        return active === el ? 'yes' : 'no';
      })()`).catch(() => 'ERR')
    }
    if (focused !== 'yes') {
      const jsFocused = await wc.executeJavaScript(`(() => {
        const el = ${findEl};
        if (!el) return false;
        el.focus();
        const root = el.getRootNode ? el.getRootNode() : null;
        const active = (root && root.activeElement) || document.activeElement;
        return active === el;
      })()`).catch(() => false)
      if (!jsFocused) throw new Error(`TASK_SELECTOR_CHANGED: ${label} 无法聚焦写入目标 ${sel}`)
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' })
    // Electron 30 的类型标注是 void，实际会 resolve boolean；只对明确的 false 判失败
    const inserted = await wc.insertText(text) as unknown
    if (inserted === false) {
      throw new Error(`TASK_INPUT_NOT_APPLIED: ${label} insertText 未被接受（目标可能不可编辑）${sel}`)
    }
    await new Promise(r => setTimeout(r, 200))
    const chk = await withTimeout(() => wc.executeJavaScript(`(() => {
      const el = ${findEl};
      if (!el) return JSON.stringify({ val: null, focused: false });
      const root = el.getRootNode ? el.getRootNode() : null;
      const active = (root && root.activeElement) || document.activeElement;
      return JSON.stringify({ val: el.isContentEditable ? String(el.textContent || '') : String(el.value ?? ''), focused: active === el, activeTag: active ? active.tagName + (active.id ? '#' + active.id : '') : 'none' });
    })()`), run, timeoutMs, `${label} 回读`).then(s => JSON.parse(s)).catch(() => ({ val: null, focused: false, activeTag: 'ERR' }))
    if (chk.val === text) { guardSignals(run); return }
    lastDiag = `页面值 ${String(chk.val ?? '').length} 字（前20:${String(chk.val ?? '').slice(0, 20).replace(/\s+/g, ' ')}）焦点=${chk.focused ? '在目标' : '在 ' + (chk.activeTag || '?')} 期望 ${text.length} 字`
    logMain('warn', `[task-runner] ${label} 写入校验未过（第 ${attempt + 1} 次）：${lastDiag}`)
  }
  throw new Error(`TASK_INPUT_NOT_APPLIED: ${label} 写入未生效（${lastDiag}）`)
}
