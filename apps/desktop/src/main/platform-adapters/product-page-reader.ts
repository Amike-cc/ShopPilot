/**
 * 商品列表页读取器（商品管理方案 §5.3）
 *
 * 纯"读页面"的一层：把档案（`ProductProfile`）翻译成一段页面脚本，读回**表头 + 数据行原文**，
 * 不做任何业务映射（映射在 `@shared/product-rules` 的 `mapProductRows` 里，那份是纯函数、有单测）。
 *
 * 三条都来自 2026-09-30 真机勘察（docs/product-profiles.md §1）：
 *   · 微信小店整页在 `<micro-app>` 的 ShadowRoot 内 → 必须穿透 shadowRoot 找表格；
 *     并且**不能用 `document.body.innerText` 取"共 N 条"**（实测那里只有 160 字）——要逐元素看自有文本；
 *   · 抖店 `<tbody>` 前两行是 0 高度占位行 → 空行一律跳过；
 *   · 拼多多的数据表没有 `<th>`（index 策略），所以"找表"不能要求必须有表头。
 *
 * 只读语义：这里只会导航、点击「下一页」这类翻页控件，**不点击任何有副作用的按钮**。
 */

import type { ProductProfile } from '@shared/constants/product'
import { logMain } from '../services/logger'
import type { PageHandle } from './sales-metrics-page-reader'

export interface ProductTableRead {
  ok: boolean
  /** 失败原因：TABLE_NOT_FOUND / ERR */
  reason?: string
  headers: string[]
  rows: string[][]
  /** 页面上的"共 N 条/件"（读不到为 null） */
  total: number | null
  /** 「下一页」是否可用（不可用 = 已经是最后一页） */
  nextEnabled: boolean
  /**
   * 排障用：页面上每张可见表各有多少表头/数据行。
   * 读到 0 行时靠它区分"选错了表"与"这家店确实 0 个商品"（不含页面正文，可安全进日志）。
   */
  diagnostics?: Array<{ th: number; rows: number }>
}

/** 页面脚本里复用的工具：穿透 shadowRoot、只取自有文本、可见性判断放在文本筛之后（性能）。 */
function pageHelpers(deep: boolean): string {
  return `
  const __deep = ${deep ? 'true' : 'false'};
  const __roots = () => { const rs = [document]; if (!__deep) return rs; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot) } return rs };
  const __q = (sel) => { const out = []; for (const r of __roots()) { try { for (const el of r.querySelectorAll(sel)) out.push(el) } catch {} } return out };
  const __own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/[\\u200b-\\u200f\\ufeff]/g, '').replace(/\\s+/g, ' ').trim() };
  const __clean = (s) => String(s == null ? '' : s).replace(/[\\u200b-\\u200f\\ufeff]/g, '').replace(/\\s+/g, ' ').trim();
  const __vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
`
}

function script(profile: ProductProfile, body: string): string {
  return `(() => { const PROFILE = ${JSON.stringify(profile)}; ${pageHelpers(profile.deep === true)} ${body} })()`
}

/**
 * 读一屏商品表格。
 *
 * 选表规则（**按实测修正过**，2026-09-30 四平台验收）：
 *   ① 先按**非空数据行数**选表 —— 而不是按表头数。
 *      为什么：快手商家后台与拼多多都是**表头表与数据表分开**的两张表
 *      （表头表 10 列 0 行、数据表 0 列 N 行）；按表头选会选中那张空表，
 *      结果是"同步成功但拉到 0 件"，而页面上明明有商品。
 *   ② 选中表没有 `<th>` 时，**跨表取表头**（取表头最多的那张表的 ths），
 *      这样 header 策略的平台（快手）仍能按表头文案对齐列；index 策略的平台（拼多多）忽略表头。
 *   ③ 顺带跳过 0 高度占位行（抖店实测 <tbody> 前两行是空的）。
 */
export async function readProductTable(wc: PageHandle, profile: ProductProfile): Promise<ProductTableRead> {
  if (wc.isDestroyed()) return { ok: false, reason: 'ERR', headers: [], rows: [], total: null, nextEnabled: false }
  const code = script(profile, `
    const tables = [];
    for (const t of __q('table')) {
      if (!__vis(t)) continue;
      const ths = [...t.querySelectorAll('th')].map(x => __clean(x.innerText));
      const rows = [];
      for (const tr of [...t.querySelectorAll('tbody tr')]) {
        const cells = [...tr.children].map(td => __clean(td.innerText));
        if (!cells.length) continue;
        if (cells.every(c => !c)) continue;          // 抖店实测：0 高度占位行
        rows.push(cells);
      }
      tables.push({ ths, rows });
    }
    if (!tables.length) return JSON.stringify({ ok: false, reason: 'TABLE_NOT_FOUND' });

    // ① 按非空数据行选表；行数相同再比表头数
    let best = tables[0];
    for (const t of tables) {
      if (t.rows.length > best.rows.length) best = t;
      else if (t.rows.length === best.rows.length && t.ths.filter(Boolean).length > best.ths.filter(Boolean).length) best = t;
    }
    // ② 选中表没有表头 → 跨表取表头最多的那张（快手/拼多多实测形态）
    let headers = best.ths;
    if (!headers.filter(Boolean).length) {
      let richest = null;
      for (const t of tables) {
        const n = t.ths.filter(Boolean).length;
        if (n > 0 && (!richest || n > richest.ths.filter(Boolean).length)) richest = t;
      }
      if (richest) headers = richest.ths;
    }

    // 总数：逐元素看**自有文本**（微信小店整页在 shadow 里，body.innerText 取不到）
    let total = null;
    for (const el of __q('div,span,li,p')) {
      if (el.children.length > 2) continue;
      const own = __own(el);
      if (!own || own.length > 16) continue;
      const m = own.match(/共\\s*(\\d+)\\s*[条件个]/);
      if (!m) continue;
      total = Number(m[1]);
      break;
    }

    // 下一页是否可用
    let nextEnabled = false;
    if (PROFILE.pagination === 'nextText' && PROFILE.nextPageText) {
      for (const el of __q('button,a,div,span,li')) {
        if (el.children.length > 2) continue;
        if (__clean(el.textContent) !== PROFILE.nextPageText) continue;
        if (!__vis(el)) continue;
        const cls = String(el.className || '');
        const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
        const disabledAttr = el.hasAttribute('disabled') || (el.closest && !!el.closest('[disabled]'));
        nextEnabled = !ariaDisabled && !disabledAttr && !/disabled|is-disabled/i.test(cls);
        break;
      }
    }

    // 诊断：读到 0 行时，把"页面上到底有几张表、各有多少行"带回去（排障用，不含页面正文）
    const diagnostics = tables.map(t => ({ th: t.ths.filter(Boolean).length, rows: t.rows.length }));
    return JSON.stringify({ ok: true, headers, rows: best.rows, total, nextEnabled, diagnostics });
  `)
  try {
    const raw = await wc.executeJavaScript(code, false)
    if (typeof raw === 'string') return { ...(JSON.parse(raw) as ProductTableRead) }
    if (raw && typeof raw === 'object') return raw as ProductTableRead
    return { ok: false, reason: 'ERR', headers: [], rows: [], total: null, nextEnabled: false }
  } catch {
    return { ok: false, reason: 'ERR', headers: [], rows: [], total: null, nextEnabled: false }
  }
}

/**
 * 等列表页**可用**：地址/标题出现 urlMarker，**而且商品表格真的渲染出来了**。
 *
 * 为什么不能只看 urlMarker：真机验收 2026-09-30 实测踩到——微信小店的 urlMarker「商品列表」
 * 就是页面标题，SPA 一换标题就命中，而表格要晚几百毫秒到几秒才渲染；
 * 只看标题会读到空表，然后被误报成「平台改版」。**"标题对了"不等于"能读了"**。
 */
export async function waitForProductListReady(wc: PageHandle, profile: ProductProfile, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  const code = script(profile, `
    const marker = ${JSON.stringify(profile.urlMarker)};
    let text = String(document.title || '') + ' ';
    for (const el of __q('div,span,h1,h2')) { if (el.children.length > 2) continue; text += ' ' + __own(el); if (text.length > 4000) break }
    if (text.indexOf(marker) < 0) return false;
    // 表格必须已经可见（列容器都行：微信/抖店是 <table>，这里统一要求 table 可见）
    for (const t of __q('table')) { if (__vis(t)) return true }
    return false;
  `)
  for (;;) {
    if (wc.isDestroyed()) return false
    try {
      if (await wc.executeJavaScript(code, false) === true) return true
    } catch { /* 页面在导航中会抛，继续等 */ }
    if (Date.now() >= deadline) return false
    await delay(400)
  }
}

/** 点「下一页」。**只点翻页控件**，点不到就返回 false（上层据此收尾，不硬撑）。 */
export async function clickNextPage(wc: PageHandle, profile: ProductProfile): Promise<boolean> {
  if (!profile.nextPageText || wc.isDestroyed()) return false
  const code = script(profile, `
    const want = ${JSON.stringify(profile.nextPageText)};
    for (const el of __q('button,a,div,span,li')) {
      if (el.children.length > 2) continue;
      if (__clean(el.textContent) !== want) continue;
      if (!__vis(el)) continue;
      const cls = String(el.className || '');
      if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled') || /disabled|is-disabled/i.test(cls)) continue;
      el.click();
      return true;
    }
    return false;
  `)
  try {
    return await wc.executeJavaScript(code, true) === true
  } catch {
    return false
  }
}

/** 读列表页里的商品主图 URL（表格里通常只有缩略图，取 `img[src]`，过滤掉图标）。 */
export async function readProductImages(wc: PageHandle, profile: ProductProfile): Promise<string[]> {  if (wc.isDestroyed()) return []
  const code = script(profile, `
    const out = [];
    for (const el of __q('img')) {
      if (!__vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40) continue;                 // 图标不算商品图
      const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
      if (!src) continue;
      out.push(src.startsWith('//') ? 'https:' + src : src);
      if (out.length >= 20) break;
    }
    return JSON.stringify(out);
  `)
  try {
    const raw = await wc.executeJavaScript(code, false)
    if (typeof raw !== 'string') return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { const handle = setTimeout(resolve, ms); if (typeof handle.unref === 'function') handle.unref() })
}

export interface ProductDetailRead {
  ok: boolean
  reason?: string
  /** 商品图（按页面顺序，第一张通常是主图） */
  imageUrls: string[]
  /** 规格名（实测微信小店是「颜色」「尺码」） */
  specNames: string[]
  /**
   * 逐 SKU 数据（规格值 + 价格 + 库存 + 规格编码）。
   *
   * **只有在配对可靠时才有值**：规格值输入框与价格行**按 DOM 顺序一一对应**
   * （实测微信小店：4 个规格值 ↔ 4 行价格/库存，顺序一致）。两者数量不等时
   * 一律返回空数组 + `pairingNote` 说明 —— 宁可不写，也不把 A 的价格安到 B 头上。
   */
  skus: Array<{ spec: Array<{ name: string; value: string }>; priceMinor: number | null; stock: number | null; skuCode: string | null }>
  /** 配对情况的如实说明（界面直接显示） */
  pairingNote: string | null
  /** 详情页读到的其它字段（类目/短标题/品牌…），只用于展示与排障 */
  fields: Array<{ label: string; value: string }>
  title: string | null
}

/**
 * 读商品**详情页**：商品图 + 规格名。
 *
 * 为什么要单独一条路（2026-09-30 实测）：列表页每行只有一张缩略图，**微信实测是 SVG**
 * （本地化会按方案 §5.9 如实拒绝）；详情页有 10 张 **WebP** 商品图，那才是能用的来源。
 *
 * 取图口径：
 *   · 只取**看得见且够大**的（≥ 60px），跳过图标；
 *   · 微信实测图片地址带 `imageView2/1/w/124/h/124/format/webp` 处理参数 ——
 *     把 `w/124/h/124` 换成 `w/800/h/800` 就能拿到大图（平台自己的参数，不是我们猜的路径）。
 */
export async function readProductDetail(wc: PageHandle, profile: ProductProfile): Promise<ProductDetailRead> {
  const empty: ProductDetailRead = { ok: false, imageUrls: [], specNames: [], skus: [], pairingNote: null, fields: [], title: null }
  if (wc.isDestroyed()) return { ...empty, reason: 'ERR' }
  const code = script(profile, `
    const urls = [];
    for (const el of __q('img')) {
      if (!__vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;      // 跳过图标
      let src = el.getAttribute('src') || el.getAttribute('data-src') || '';
      if (!src) continue;
      if (src.startsWith('//')) src = 'https:' + src;
      // 把平台自己的缩略参数换成大图参数（微信实测形态：imageView2/1/w/124/h/124/format/webp）
      src = src.replace(/\\/w\\/\\d+\\/h\\/\\d+/, '/w/800/h/800');
      if (urls.indexOf(src) < 0) urls.push(src);
      if (urls.length >= 30) break;
    }

    // 规格名：详情页里「规格名」下拉的当前值（微信实测锚点：颜色 / 尺码）
    const specNames = [];
    for (const el of __q('span,div')) {
      if (el.children.length > 2) continue;
      const own = __own(el);
      if (!own || own.length > 8) continue;
      const cls = String(el.className || '');
      if (cls.indexOf('dropdown__value') < 0) continue;
      if (!__vis(el)) continue;
      if (specNames.indexOf(own) < 0) specNames.push(own);
      if (specNames.length >= 6) break;
    }

    // 其它字段：占位符 → 当前值（详情页的输入框就是"字段名 + 值"，实测可读）
    const fields = [];
    for (const el of __q('input,textarea')) {
      if (!__vis(el)) continue;
      const type = String(el.getAttribute('type') || el.tagName.toLowerCase());
      if (type === 'hidden' || type === 'file') continue;
      const label = __clean(el.getAttribute('placeholder'));
      const value = __clean(el.value);
      if (!label && !value) continue;
      fields.push({ label: label.slice(0, 30), value: value.slice(0, 60) });
      if (fields.length >= 20) break;
    }

    let title = null;
    for (const el of __q('input')) {
      const ph = __clean(el.getAttribute('placeholder'));
      if (ph.indexOf('商品名称') < 0) continue;
      title = __clean(el.value) || null;
      break;
    }

    // 规格值：placeholder 形如「请输入<规格名>」（实测微信小店是「请输入尺码」），值就是规格值。
    //
    // ⚠️ 难点：**商品属性**也用「请输入」前缀（实测 请输入规格 / 请输入功能 / 请输入类型），
    // 只按前缀过滤会把属性当规格值（实测踩到：规格值 7 个 vs 价格行 4 行，永远配不上对）；
    // 按"规格名下拉的当前值"筛也不行 —— 那个下拉抓到的是属性下拉（实测拿到 规格/功能/类型）。
    //
    // 用**页面自报的结构**来定：逐 SKU 的价格行数就是 SKU 数，**哪一组的条数恰好等于价格行数，
    // 哪一组才是规格值**。多组都等长或有零组等长时一律不配对（fail-closed，见下面的 pairingNote）。
    // 这与之前 EMPTY_TABLE 的对账思路一致：判据用页面自己给的数字，不用启发式。
    const groups = {};
    for (const el of __q('input')) {
      if (!__vis(el)) continue;
      const ph = __clean(el.getAttribute('placeholder'));
      if (ph.indexOf('请输入') !== 0) continue;
      const name = ph.slice(3);
      if (/商品名称|短标题|条形码|成分|编码/.test(name)) continue;
      const value = __clean(el.value);
      if (!value) continue;                                  // 空行是"新增规格值"的待填位
      if (!groups[name]) groups[name] = [];
      groups[name].push({ name, value });
      if (groups[name].length >= 200) break;
    }

    // 逐 SKU 行：价格 / 库存 / 规格编码（实测占位符：输入售卖价格 / 输入库存 / 输入规格编码）
    const priceEls = [], stockEls = [], codeEls = [];
    for (const el of __q('input')) {
      if (!__vis(el)) continue;
      const ph = __clean(el.getAttribute('placeholder'));
      if (ph === '输入售卖价格') priceEls.push(el);
      else if (ph === '输入库存') stockEls.push(el);
      else if (/规格编码|SKU编码/.test(ph)) codeEls.push(el);
    }
    const skuRows = priceEls.map((el, i) => ({
      priceText: __clean(el.value),
      stockText: stockEls[i] ? __clean(stockEls[i].value) : '',
      skuCode: codeEls[i] ? __clean(codeEls[i].value) : ''
    }));

    // 选出"条数恰好等于价格行数"的那一组作为规格值
    const priceCount = skuRows.length;
    const candidates = Object.keys(groups);
    const matched = priceCount > 0 ? candidates.filter(n => groups[n].length === priceCount) : [];
    const specValues = matched.length === 1 ? groups[matched[0]] : [];

    // 配对：**只在数量相等且唯一匹配时**按 DOM 顺序一一对应；否则如实说明、不猜
    const skus = [];
    let pairingNote = null;
    const groupSummary = candidates.map(n => n + '(' + groups[n].length + ')').join('、') || '无';
    if (specValues.length === 0 && skuRows.length === 0) {
      pairingNote = '详情页没有规格值也没有逐 SKU 价格行（可能是单规格商品）';
    } else if (priceCount === 0) {
      pairingNote = '没有读到逐 SKU 价格行（候选规格值组：' + groupSummary + '），本次不写 SKU 映射';
    } else if (matched.length === 0) {
      pairingNote = '没有哪一组规格值的条数等于价格行数 ' + priceCount + '（候选：' + groupSummary + '），无法可靠配对（本次不写 SKU 映射）';
    } else if (matched.length > 1) {
      pairingNote = '有 ' + matched.length + ' 组规格值都是 ' + priceCount + ' 条，分不清哪组是规格（候选：' + groupSummary + '），本次不写 SKU 映射';
    } else {
      for (let i = 0; i < specValues.length; i++) {
        const row = skuRows[i];
        const price = parseFloat(row.priceText);
        const stock = parseInt(row.stockText, 10);
        skus.push({
          spec: [{ name: specValues[i].name, value: specValues[i].value }],
          priceMinor: Number.isFinite(price) && price >= 0 ? Math.round(price * 100) : null,
          stock: Number.isFinite(stock) && stock >= 0 ? stock : null,
          skuCode: row.skuCode || null
        });
      }
    }

    // ⚠️ 变量名不能叫 specNames：上面已经用 const 声明过 specNames（规格名下拉的当前值），
    // 再声明一次会让整段注入脚本 SyntaxError —— 而 SyntaxError 会被 catch 吞成"页面没读到"，
    // 表现为怎么等都是 DETAIL_EMPTY（2026-09-30 实际踩到，排查了很久）。所以另起名字。
    const specNamesFromValues = [];
    for (const item of specValues) if (specNamesFromValues.indexOf(item.name) < 0) specNamesFromValues.push(item.name);

    return JSON.stringify({ ok: urls.length > 0 || specNamesFromValues.length > 0, imageUrls: urls,
                            specNames: specNamesFromValues, skus, pairingNote, fields, title });
  `)
  try {
    const raw = await wc.executeJavaScript(code, false)
    if (typeof raw === 'string') return { ...empty, ...(JSON.parse(raw) as ProductDetailRead) }
    return empty
  } catch (error) {
    // **不要静默吞**：注入脚本一旦 SyntaxError，这里会是唯一能看到原因的地方
    logMain('warn', `[product-detail] 详情页脚本执行失败：${String((error as Error)?.message || error).slice(0, 200)}`)
    return { ...empty, reason: 'SCRIPT_ERROR' }
  }
}
