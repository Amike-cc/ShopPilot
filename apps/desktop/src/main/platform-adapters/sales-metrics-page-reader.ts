/**
 * 经营数据页面读取原语（只读 + 一次受信任点击 + 导航）。
 *
 * 为什么单独一份而不是复用 task-runner：Adapter 会被单测直接 import，
 * 而 task-runner 会把整个任务引擎（含 electron 运行时依赖）拉进依赖图，
 * 纯 Node 下加载会失败。这里只保留**读**需要的最小片段。
 *
 * 与 task-runner 的 `readLabelValue` / `clickByText` 是同一套算法，锚点也同一口径：
 *   · 以**实测的标签文案**定位，不用带构建哈希的类名（快手 kpro-data / 微信 weui 实测如此）；
 *   · 找到标签后向上找"文本只比标签多一小段"的最近祖先，多出来的那段就是值；
 *   · 值长度超过上限视为爬到容器层级 → 如实失败，而不是读一个错的数字回来。
 *
 * 所有注入脚本都是纯计算表达式，不写页面全局、不改页面状态；唯一的页面动作是
 * `clickText`（点周期控件）与 `navigate`（去已登记的经营数据页）。
 */

const ENUM_DEEP_FN = `
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

const VISIBLE_JS = `
  const __visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
`

/**
 * 候选排序：先按"自身文本最短"，长度相同的优先"看起来可点的标签"。
 * 与 task-runner 的 `__clickableScore` 同一判据：容器元素常和内部按钮拥有同样的文本，
 * 只按长度排会先命中容器，点容器是个空操作。
 */
const PICK_SORT_JS = `
  const __clickableScore = (el) => {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'LABEL' || tag === 'SELECT') return 0;
    if (el.getAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab')) return 0;
    if (/btn|button|chip|tab|option|item|link/i.test(String(el.className || ''))) return 1;
    return 2;
  };
  const __narrow = (s) => String(s == null ? '' : s).replace(/\\s+/g, '');
`

export interface LabelReadAttempt {
  ok: boolean
  /** 读到的原始文本（未解析成数字）；只在 ok 时有意义 */
  raw?: string
  /** 失败原因：NOT_FOUND / NO_VALUE_SIBLING / VALUE_TOO_LONG / ERR / TIMEOUT */
  reason?: string
  cardText?: string
}

export interface PageHandle {
  isDestroyed(): boolean
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  getURL(): string
  isLoading(): boolean
  loadURL(url: string): Promise<unknown>
  sendInputEvent(event: unknown): void
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { const handle = setTimeout(resolve, ms); if (typeof handle.unref === 'function') handle.unref() })
}

/**
 * 单次尝试：找标签 → 取该标签对应的**值**。
 *
 * 真机实测（2026-09-28）两种真实卡片结构都被这一版覆盖：
 *   · 抖店首页：「成交金额 >」与「0」是兄弟节点，卡片里还有「较昨日 持平」对比行；
 *   · 微信小店：「成交金额 ¥0 昨日¥29.7」在同一个卡片里，对比行紧跟在值后面。
 * 旧实现（task-runner 的 readLabelValue 启发式）把标签所在层"多出来的那段文本"整段当值，
 * 于是拿到的是「>0较昨日 持平」「¥0 昨日¥29.7」这种带对比行的串，解析必然失败——
 * 结果就是**页面上明明写着 0，系统却报"页面没有数值"**。
 *
 * 所以值分两级取：
 *   1. 从标签往上逐层找祖先，在每层里取"文档序在标签之后、自身文本是纯数值"的第一个可见元素
 *      （最紧的那层先命中，避免爬到整页后拿错区块的数字）；
 *   2. 一层都取不到才回退到"向上找多出一小段"的旧启发式（保持对旧结构的兼容）。
 *
 * 隐私与安全：两级都只返回一个短字符串（值），不返回卡片全文。
 */
const PURE_NUMBER_JS = `
  const __pureNumber = (s) => /^[¥￥$]?\\s*-?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:万|亿)?$/.test(String(s == null ? '' : s).trim());
`

async function attemptReadLabel(wc: PageHandle, label: string, deep: boolean, maxValueLen: number): Promise<LabelReadAttempt> {
  const script = `(() => {
    ${deep ? ENUM_DEEP_FN : ''}
    ${VISIBLE_JS}
    ${PURE_NUMBER_JS}
    const label = ${JSON.stringify(label)};
    const MAX = ${maxValueLen};
    const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
    const cands = [];
    for (const el of scope) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (!own.includes(label)) continue;
      if (!__visible(el)) continue;
      cands.push({ el, len: own.length });
    }
    if (!cands.length) return { ok: false, reason: 'NOT_FOUND' };
    cands.sort((a, b) => (a.len - b.len));
    const labelEl = cands[0].el;

    // 1) 值：从标签往上逐层找，取"标签之后"的第一个纯数值元素（最紧的那层先命中）
    let ancestor = labelEl;
    for (let level = 0; level < 6 && ancestor && ancestor !== document.body; level++) {
      ancestor = ancestor.parentElement;
      if (!ancestor) break;
      let passedLabel = false;
      for (const el of ancestor.querySelectorAll('*')) {
        if (el === labelEl) { passedLabel = true; continue; }
        if (el.contains(labelEl)) continue;
        if (!passedLabel) continue;
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        if (!own || !__pureNumber(own)) continue;
        if (!__visible(el)) continue;
        return { ok: true, value: own.slice(0, MAX), strategy: 'VALUE_ELEMENT' };
      }
    }

    // 2) 回退：向上找"文本只比标签多一小段"的最近祖先，多出来的那段就是值
    let node = labelEl;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      const txt = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (txt.length > label.length) {
        const value = txt.replace(label, '').trim();
        if (value && value.length <= MAX) return { ok: true, value, strategy: 'CARD_TEXT' };
        if (value && value.length > MAX) return { ok: false, reason: 'VALUE_TOO_LONG' };
      }
      node = node.parentElement;
    }
    return { ok: false, reason: 'NO_VALUE_SIBLING' };
  })()`
  const raw = await wc.executeJavaScript(script, true).catch(() => ({ ok: false, reason: 'ERR' }))
  if (raw && typeof raw === 'object' && (raw as { ok?: boolean }).ok === true) {
    return { ok: true, raw: String((raw as { value?: unknown }).value ?? '') }
  }
  const failure = raw as { reason?: string } | null
  return { ok: false, reason: failure?.reason || 'ERR' }
}

/**
 * 按标签文案读值（轮询到 deadline）。
 *
 * 轮询是必要的：周期切换后数值原地刷新，立刻读会命中旧值（实测快手踩过）。
 * `absentOk` 为真时"页面上没有这一行"算正常收尾（该店铺该指标没有入口），
 * 只豁免 NOT_FOUND；标签在但取不到值（NO_VALUE_SIBLING / VALUE_TOO_LONG）仍然如实失败。
 */
export async function readLabelValue(wc: PageHandle, options: {
  label: string
  deep?: boolean
  valueMaxLen?: number
  timeoutMs?: number
  pollMs?: number
}): Promise<LabelReadAttempt> {
  const deadline = Date.now() + Math.max(1000, options.timeoutMs ?? 15000)
  const pollMs = Math.max(100, options.pollMs ?? 400)
  let last: LabelReadAttempt = { ok: false, reason: 'ERR' }
  for (;;) {
    if (wc.isDestroyed()) return { ok: false, reason: 'ERR' }
    last = await attemptReadLabel(wc, options.label, !!options.deep, options.valueMaxLen ?? 40)
    if (last.ok) return last
    if (Date.now() >= deadline) return last.reason ? last : { ok: false, reason: 'TIMEOUT' }
    await delay(pollMs)
  }
}

/** 定位"文案为 text 的可见元素"的视口坐标（用于受信任点击）。找不到返回 null。 */
async function findTextPoint(wc: PageHandle, text: string, deep: boolean): Promise<{ x: number; y: number } | null> {
  const script = `(() => {
    ${deep ? ENUM_DEEP_FN : ''}
    ${VISIBLE_JS}
    ${PICK_SORT_JS}
    const want = __narrow(${JSON.stringify(text)});
    const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
    const cands = [];
    for (const el of scope) {
      // 先做**零布局成本**的筛选再查可见性。
      // 真机实测（2026-09-28）：这段循环在微信小店后台（上万个元素）里对每个元素调用
      // innerText/getBoundingClientRect，等于每轮强制一次样式与布局重算，脚本直接跑不完——
      // 表现是"页面上明明有「近7天」，却一直报点不到周期控件"。
      const own = __narrow([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(''));
      if (!own) continue;
      let rank = -1;
      if (own === want) rank = 0;
      else if (own.includes(want) && own.length <= want.length + 6) rank = 1;
      else {
        // textContent 不触发布局；仅对"文本几乎等于目标"的元素兜底，
        // 覆盖"文案被拆进子 span"的情况（快手实测）。
        const flat = String(el.textContent || '');
        if (flat.length <= want.length + 8 && __narrow(flat) === want) rank = 2;
      }
      if (rank < 0) continue;
      if (!__visible(el)) continue;
      cands.push({ el, rank, len: own.length, score: __clickableScore(el) });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => (a.rank - b.rank) || (a.len - b.len) || (a.score - b.score));
    const el = cands[0].el;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rank: cands[0].rank };
  })()`
  const raw = await wc.executeJavaScript(script, true).catch(() => null)
  if (!raw || typeof raw !== 'object') return null
  const point = raw as { x?: number; y?: number }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  return { x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) }
}

/** 受信任鼠标点击：走浏览器输入管线，页面收到 isTrusted 事件。 */
export function realClick(wc: PageHandle, x: number, y: number): void {
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

/**
 * 点一次"文案为 text"的控件（周期切换用）。
 *
 * 刻意不返回"点了就成功"：调用方要知道**有没有真的点到**——周期没切成功却按目标周期
 * 落库，就是把 7 天的数字当成今天的，比没有数字更糟。
 */
export async function clickText(wc: PageHandle, options: { text: string; deep?: boolean; timeoutMs?: number }): Promise<boolean> {
  const deadline = Date.now() + Math.max(1000, options.timeoutMs ?? 15000)
  for (;;) {
    if (wc.isDestroyed()) return false
    const point = await findTextPoint(wc, options.text, !!options.deep)
    if (point) { realClick(wc, point.x, point.y); return true }
    if (Date.now() >= deadline) return false
    await delay(400)
  }
}

/**
 * 读"周期控件当前是否处于选中态"。
 *
 * 为什么需要它：验证"周期真的切过去了"原来只有两条判据——值变了、或档案声明的
 * `periodAppliedText` 出现。这两条都建立在"点击会改变页面"的前提上，于是**页面本来就停在
 * 目标周期**时必然失败：点了「近7日」而页面早就是近7日，值不会变、文案也不会变 → 判
 * `PERIOD_NOT_APPLIED` 并且一个字段都不写。快手计划连续 9 次停采就是这个假阴性
 * （实测 2026-09-29：`settle` 之后页面保留上次选择，第二次点同一个页签是空操作）。
 *
 * 判据是"控件自己的外观与同组页签不同"：真机实测快手未选中 `color rgb(44,46,48) /
 * bg rgb(245,246,249)`、选中 `color rgb(50,107,251) / bg rgb(232,243,255)`；同一组的
 * 其他页签保持未选中配色。所以"目标页签的 文字色+背景色 与所有同组页签都不同"即视为选中。
 * 判不出来（找不到、没有同组页签）时如实返回 false——不能因为"看起来像"就放行。
 */
export interface PeriodControlState {
  found: boolean
  selected: boolean
  reason: 'SELECTED_BY_STYLE' | 'SAME_AS_SIBLINGS' | 'NO_SIBLING_TABS' | 'NOT_FOUND' | 'ERR'
  ownStyle: string | null
  siblingStyle: string | null
}

export async function readPeriodControlState(wc: PageHandle, options: { text: string; deep?: boolean; timeoutMs?: number }): Promise<PeriodControlState> {
  const deadline = Date.now() + Math.max(500, options.timeoutMs ?? 4000)
  let last: PeriodControlState = { found: false, selected: false, reason: 'NOT_FOUND', ownStyle: null, siblingStyle: null }
  for (;;) {
    if (wc.isDestroyed()) return { ...last, reason: 'ERR' }
    last = await attemptPeriodControlState(wc, options.text, !!options.deep)
    if (last.reason !== 'NOT_FOUND') return last
    if (Date.now() >= deadline) return last
    await delay(300)
  }
}

async function attemptPeriodControlState(wc: PageHandle, text: string, deep: boolean): Promise<PeriodControlState> {
  const script = `(() => {
    ${deep ? ENUM_DEEP_FN : ''}
    ${VISIBLE_JS}
    ${PICK_SORT_JS}
    const want = __narrow(${JSON.stringify(text)});
    // 同组页签的文案集合：只有认出"这一组是周期切换控件"才谈得上比较选中态
    const TAB_TEXTS = ['昨日', '昨天', '今天', '今日', '实时', '近7日', '近7天', '近30日', '近30天', '本周', '本月', '近90天'];
    const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
    const findTab = (target) => {
      const cands = [];
      for (const el of scope) {
        const raw = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
        // 只认"自身文本几乎就是页签文案"的元素：容器元素也含同样文字，但它们的文本会长得多
        const own2 = __narrow(raw);
        if (!own2) continue;
        let rank = -1;
        if (own2 === target) rank = 0;
        else if (own2.includes(target) && own2.length <= target.length + 6) rank = 1;
        if (rank < 0) continue;
        if (!__visible(el)) continue;
        cands.push({ el, rank, len: own2.length });
      }
      if (!cands.length) return null;
      cands.sort((a, b) => (a.rank - b.rank) || (a.len - b.len));
      return cands[0].el;
    };
    const styleOf = (el) => { const cs = getComputedStyle(el); return cs.color + '|' + cs.backgroundColor };
    const target = findTab(want);
    if (!target) return { found: false, selected: false, reason: 'NOT_FOUND', ownStyle: null, siblingStyle: null };
    // 同组页签：从目标向上最多两层，在该子树里找其它"周期类"短文案元素
    let group = target.parentElement;
    let siblings = [];
    for (let level = 0; level < 2 && group; level++) {
      siblings = [];
      for (const el of group.querySelectorAll('*')) {
        if (el === target || el.contains(target) || target.contains(el)) continue;
        const raw = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
        const own = __narrow(raw);
        if (!own || !TAB_TEXTS.includes(own)) continue;
        if (!__visible(el)) continue;
        siblings.push(el);
      }
      if (siblings.length) break;
      group = group.parentElement;
    }
    if (!siblings.length) return { found: true, selected: false, reason: 'NO_SIBLING_TABS', ownStyle: styleOf(target), siblingStyle: null };
    const mine = styleOf(target);
    const others = siblings.map(styleOf);
    const same = others.some(style => style === mine);
    return {
      found: true,
      selected: !same,
      reason: same ? 'SAME_AS_SIBLINGS' : 'SELECTED_BY_STYLE',
      ownStyle: mine,
      siblingStyle: others[0] || null
    };
  })()`
  const raw = await wc.executeJavaScript(script, true).catch(() => null)
  if (!raw || typeof raw !== 'object') return { found: false, selected: false, reason: 'ERR', ownStyle: null, siblingStyle: null }
  const state = raw as Partial<PeriodControlState>
  return {
    found: !!state.found,
    selected: !!state.selected,
    reason: (state.reason as PeriodControlState['reason']) || 'ERR',
    ownStyle: state.ownStyle ?? null,
    siblingStyle: state.siblingStyle ?? null
  }
}

/** 等 URL 包含指定片段（就绪判据）。 */
export async function waitForUrlMarker(wc: PageHandle, marker: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  for (;;) {
    if (wc.isDestroyed()) return false
    try { if (String(wc.getURL() || '').includes(marker)) return true } catch { return false }
    if (Date.now() >= deadline) return false
    await delay(400)
  }
}

export interface NavigationOutcome {
  ok: boolean
  /** Electron 的 net 错误码（ERR_NAME_NOT_RESOLVED / ERR_CONNECTION_TIMED_OUT…），拿不到时为 null */
  errorCode: string | null
  /** 已开始加载但超时未完成 */
  timedOut: boolean
}

/** 从 loadURL 的异常里取出稳定的 net 错误码；异常文案本身不外传（可能含完整 URL 与参数）。 */
export function navigationErrorCode(error: unknown): string | null {
  const match = /(ERR_[A-Z0-9_]+)/.exec(String((error as { message?: string })?.message || error || ''))
  return match ? match[1] : null
}

/**
 * 导航到已登记的经营数据页。只允许 http/https（与任务引擎同一门禁）。
 *
 * 失败必须带出原因码：旧实现只回一个 false，代价是用户看到"网络或页面不可用"这句
 * 什么都不是的话——真实探测里三个平台全都失败在导航上，却分不出是断网、DNS、证书
 * 还是被平台拦截（2026-09-28 真机实测踩到）。现在把 Electron 的错误码原样带出来。
 */
export async function navigateTo(wc: PageHandle, url: string, timeoutMs: number): Promise<NavigationOutcome> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, errorCode: 'ERR_INVALID_URL', timedOut: false }
  try {
    await wc.loadURL(url)
  } catch (error) {
    // 重定向链上的 ERR_ABORTED 属正常：继续等加载完成
    if (!/ERR_ABORTED/.test(String(error))) {
      return { ok: false, errorCode: navigationErrorCode(error) || 'ERR_LOAD_FAILED', timedOut: false }
    }
  }
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  for (;;) {
    if (wc.isDestroyed()) return { ok: false, errorCode: 'ERR_PAGE_DESTROYED', timedOut: false }
    let loading = false
    try { loading = wc.isLoading() } catch { return { ok: false, errorCode: 'ERR_PAGE_DESTROYED', timedOut: false } }
    if (!loading) return { ok: true, errorCode: null, timedOut: false }
    if (Date.now() >= deadline) return { ok: false, errorCode: 'ERR_LOAD_TIMEOUT', timedOut: true }
    await delay(400)
  }
}

export interface ParsedSalesValueOk { ok: true; value: number }
export interface ParsedSalesValueFail { ok: false; reason: string }
export type ParsedSalesValue = ParsedSalesValueOk | ParsedSalesValueFail

/**
 * 把页面文本解析成统一指标数值。
 *
 * 规则（写死在这里，避免各处各写一套）：
 *   · 空 / `-` / `--` / `—` / `暂无` → NO_VALUE（**不是 0**：平台没给数，我们就没有数）。
 *   · 去掉货币符号、千分位逗号、空白；`万`/`亿` 后缀按 10^4 / 10^8 换算（平台确实这么显示）。
 *   · 带 `%` 或其它未登记后缀 → UNSUPPORTED_UNIT，字段保持 null。
 *   · 金额单位元 → 分（四舍五入到整数分，绝不用浮点存金额）；计数单位件/单 → 整数。
 *   · 负数（平台可能是 -1 之类）→ NEGATIVE。
 */
export function parseSalesValue(text: string | null | undefined, unit: 'MINOR_CNY' | 'COUNT'): ParsedSalesValue {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return { ok: false, reason: 'NO_VALUE' }
  const cleaned = raw.replace(/[\s\u00a0]/g, '').replace(/[¥￥$]/g, '').replace(/,/g, '')
  if (!cleaned || /^[-—–]{1,2}$/.test(cleaned) || cleaned === '暂无' || cleaned === '--') return { ok: false, reason: 'NO_VALUE' }
  if (/%|％/.test(cleaned)) return { ok: false, reason: 'UNSUPPORTED_UNIT' }
  let multiplier = 1
  let digits = cleaned
  const scaleMatch = /^(.*?)(万|亿)(.*)$/.exec(cleaned)
  if (scaleMatch) {
    multiplier = scaleMatch[2] === '万' ? 10_000 : 100_000_000
    digits = `${scaleMatch[1]}${scaleMatch[3]}`
    if (scaleMatch[3] && !/^[+-]?$/.test(scaleMatch[3])) return { ok: false, reason: 'UNSUPPORTED_UNIT' }
  }
  // 允许结尾一个 `+`（平台用 "1000+" 表示"超过"）——这种是下界，不能当成精确值。
  if (/[+]/.test(digits)) return { ok: false, reason: 'APPROXIMATE_VALUE' }
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return { ok: false, reason: 'UNSUPPORTED_UNIT' }
  const numeric = Number(digits) * multiplier
  if (!Number.isFinite(numeric)) return { ok: false, reason: 'PARSE_FAILED' }
  if (numeric < 0) return { ok: false, reason: 'NEGATIVE' }
  const scaled = unit === 'MINOR_CNY' ? numeric * 100 : numeric
  if (!Number.isFinite(scaled)) return { ok: false, reason: 'PARSE_FAILED' }
  const rounded = Math.round(scaled)
  if (!Number.isSafeInteger(rounded)) return { ok: false, reason: 'OUT_OF_RANGE' }
  return { ok: true, value: rounded }
}
