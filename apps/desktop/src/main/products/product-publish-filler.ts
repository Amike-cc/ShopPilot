/**
 * 发布字段代填（L1）+ **逐字段写后回读**（方案 §7.3）
 *
 * 三条纪律，全部来自仓库里已经验证过的做法（`task-runner` 的 setInput/fillDraft）：
 *   ① 给 React 受控输入框赋值必须走**原生 setter** + 派发 `input`/`change`，直接 `el.value = x` 会被框架覆盖回去；
 *   ② **写后必须回读**：静默失效要在这一步就失败，而不是等平台在提交时以"未填写"拦下来；
 *   ③ 只碰**实测过锚点**的字段，其余一律留给人工 —— 宁可少填，也不在别人的商品页上乱写。
 *
 * 本模块**没有任何点击按钮的代码**：只做"定位输入框 → 赋值 → 回读"。提交永远由人来点。
 */

import type { WebContents } from 'electron'
import type { ProductProfile } from '@shared/constants/product'
import { logMain } from '../services/logger'

/** 微信小店发布页实测的字段锚点（placeholder / 类型），登记在发布档案里的那几条。 */
export interface PublishFillAnchor {
  field: string
  label: string
  /** 按 placeholder 精确定位 */
  placeholder?: string
  /** placeholder 包含匹配（用于"商品名称与关键字"这种带尾巴的） */
  placeholderContains?: string
  /** 该字段要求商品只有一个规格才敢填（多规格是逐行表格，形状不同） */
  singleVariantOnly?: boolean
  /** 实测备注（写给后来的人看：这个锚点是在哪种页面上测到的） */
  note?: string
}

/**
 * 读**页面上当前**的字段值（方案 §7.5 第 2 类回读：用户实际填了什么）。
 *
 * 与 `fillPublishFields` 共用同一套锚点与穿透 ShadowRoot 的查询 ——
 * "能填哪个字段"和"能读哪个字段"必须是同一份锚点，否则会出现
 * "填进去了但读不出来"或反过来（那两件事都发生过了）。
 *
 * 只读：不改任何东西、不点任何按钮。
 */
export async function readPublishPageFieldValues(input: {
  wc: WebContents
  anchors: PublishFillAnchor[]
}): Promise<{ values: Record<string, string | null>; found: string[]; missing: string[] }> {
  const empty = { values: {} as Record<string, string | null>, found: [] as string[], missing: [] as string[] }
  if (input.wc.isDestroyed()) return empty
  const spec = input.anchors.map(anchor => ({
    field: anchor.field,
    placeholder: anchor.placeholder ?? null,
    contains: anchor.placeholderContains ?? null
  }))
  const code = `(() => {
    ${SHADOW_HELPERS}
    const inputs = __inputs();
    const out = {};
    for (const item of ${JSON.stringify(spec)}) {
      const hit = item.placeholder
        ? inputs.find(el => (el.getAttribute('placeholder') || '').trim() === item.placeholder)
        : inputs.find(el => (el.getAttribute('placeholder') || '').includes(item.contains));
      out[item.field] = hit ? String(hit.value == null ? '' : hit.value) : null;
    }
    return JSON.stringify(out);
  })()`
  try {
    const raw = await input.wc.executeJavaScript(code, false)
    if (typeof raw !== 'string') return empty
    const parsed = JSON.parse(raw) as Record<string, string | null>
    const found: string[] = []
    const missing: string[] = []
    for (const [field, value] of Object.entries(parsed)) {
      if (value === null) missing.push(field)
      else found.push(field)
    }
    return { values: parsed, found, missing }
  } catch (error) {
    logMain('warn', `[product-publish] 读页面字段失败：${String((error as Error)?.message || error).slice(0, 140)}`)
    return empty
  }
}

/** 已实测的锚点（2026-09-30，微信小店发布页 /shop/goods/entry）。 */
export const WECHAT_FILL_ANCHORS: PublishFillAnchor[] = [
  {
    field: 'title', label: '标题', placeholderContains: '商品名称',
    note: '新增商品页实测可填（写入后回读一致）'
  },
  {
    field: 'subtitle', label: '短标题', placeholderContains: '商品短标题',
    // ⚠️ 2026-09-30 更正：之前预检把副标题标成"该平台不支持"，那是**没实测就下的结论**。
    // 实测发布页有 `请输入商品短标题`，所以这里真的能填。
    note: '实测 placeholder「请输入商品短标题」'
  },
  {
    field: 'price', label: '价格', placeholder: '填写售卖价', singleVariantOnly: true,
    // 实测（2026-09-30）：`填写售卖价` 是在**编辑既有商品**的页面上测到的；
    // 新增商品页要先有「规格」才会出现价格/库存区块 —— 所以这一步会如实报"页面上还没有这个字段"，
    // 而不是假装填上了。下一轮要做的是"先建规格再填价"，属于结构性动作，单独评估。
    note: '新增商品页需先有规格才出现该字段（本轮不代填，如实报出）'
  },
  {
    field: 'stock', label: '库存', placeholder: '输入库存', singleVariantOnly: true,
    note: '同上：新增商品页需先有规格才出现该字段'
  }
]

/**
 * 注入脚本共用的**穿透 ShadowRoot**的查询辅助。
 *
 * ⚠️ 这是踩过的坑（2026-09-30）：发布表单整页在 ShadowRoot 里，
 * 用普通 `document.querySelectorAll('input')` **一个字段都找不到** ——
 * 表现为"等了 31 秒表单始终没渲染出来"，其实是查的方式不对。
 * 详情页读取器（`readProductDetail`）一直用的是穿透版，所以它能读到；
 * 代填这边一开始漏了，白排查了一轮。
 */
const SHADOW_HELPERS = `
  const __cap = 8000;
  const __roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= __cap) break } return rs };
  const __q = (sel) => { const out = []; for (const r of __roots()) { try { for (const el of r.querySelectorAll(sel)) { out.push(el); if (out.length >= 4000) return out } } catch {} } return out };
  const __vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
  const __inputs = () => __q('input,textarea').filter(__vis);
`

/** 等发布表单**真的渲染出来**。
 *
 * 为什么必须等：实测（2026-09-30）新标签页刚打开时 URL 已经到位，但表单还没渲染
 * （`商品名称` 输入框、`input[type=file]` 都是 0 个）——此时去填必然"找不到字段"。
 * **URL 到位 ≠ DOM 就绪**，这是两件事，必须分开判。
 *
 * 判据用"实测过的那几个锚点里**至少有一个**出现"，不用固定 sleep：
 * 页面快就快，慢就等到超时，并且**如实说明等到了什么**。
 */
export async function waitForPublishForm(input: {
  wc: WebContents
  anchors: PublishFillAnchor[]
  timeoutMs?: number
}): Promise<{ ready: boolean; found: string[]; waitedMs: number }> {
  const timeoutMs = input.timeoutMs ?? 30_000
  const started = Date.now()
  let found: string[] = []
  while (Date.now() - started < timeoutMs) {
    if (input.wc.isDestroyed()) return { ready: false, found, waitedMs: Date.now() - started }
    found = await probeAnchors(input.wc, input.anchors)
    if (found.length > 0) return { ready: true, found, waitedMs: Date.now() - started }
    await new Promise(resolve => { const handle = setTimeout(resolve, 800); if (typeof handle.unref === 'function') handle.unref() })
  }
  return { ready: false, found, waitedMs: Date.now() - started }
}

/** 数一数页面上已经能找到几个锚点字段（只读探测，不改任何东西）。 */
async function probeAnchors(wc: WebContents, anchors: PublishFillAnchor[]): Promise<string[]> {
  const spec = anchors.map(anchor => ({ field: anchor.field, placeholder: anchor.placeholder ?? null, contains: anchor.placeholderContains ?? null }))
  const code = `(() => {
    ${SHADOW_HELPERS}
    const inputs = __inputs();
    const found = [];
    for (const item of ${JSON.stringify(spec)}) {
      const hit = item.placeholder
        ? inputs.find(el => (el.getAttribute('placeholder') || '').trim() === item.placeholder)
        : inputs.find(el => (el.getAttribute('placeholder') || '').includes(item.contains));
      if (hit) found.push(item.field);
    }
    return JSON.stringify(found);
  })()`
  try {
    const raw = await wc.executeJavaScript(code, false)
    return typeof raw === 'string' ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export interface FillOutcome {
  field: string
  label: string
  ok: boolean
  /** 写进去的值（截断显示用） */
  written: string | null
  /** 回读到的值 */
  readBack: string | null
  reason: string | null
}

/**
 * 代填一批字段。
 *
 * `values` 里没有的字段不填；`singleVariantOnly` 的字段在**多规格**时跳过（如实说明原因）。
 */
export async function fillPublishFields(input: {
  wc: WebContents
  profile: ProductProfile | null
  anchors: PublishFillAnchor[]
  values: Record<string, string | null>
  variantCount: number
}): Promise<FillOutcome[]> {
  const results: FillOutcome[] = []
  for (const anchor of input.anchors) {
    const value = input.values[anchor.field]
    if (value == null || value === '') {
      results.push({ field: anchor.field, label: anchor.label, ok: false, written: null, readBack: null, reason: '本地没有这个值，未填' })
      continue
    }
    if (anchor.singleVariantOnly && input.variantCount > 1) {
      results.push({
        field: anchor.field, label: anchor.label, ok: false, written: null, readBack: null,
        reason: `本地是 ${input.variantCount} 个规格，该字段在页面上是逐规格的表格行，本轮不代填（避免把同一个值写到所有规格上）`
      })
      continue
    }
    const outcome = await fillOne(input.wc, anchor, value)
    results.push(outcome)
  }
  logMain('info', `[product-publish] 代填完成 成功=${results.filter(r => r.ok).length}/${results.length}（未点击任何按钮）`)
  return results
}

/** 填一个字段：原生 setter 赋值 → 派发事件 → **回读比对**。 */
async function fillOne(wc: WebContents, anchor: PublishFillAnchor, value: string): Promise<FillOutcome> {
  if (wc.isDestroyed()) {
    return { field: anchor.field, label: anchor.label, ok: false, written: null, readBack: null, reason: '页面已关闭' }
  }
  const code = `(() => {
    ${SHADOW_HELPERS}
    const pick = () => {
      const inputs = __inputs();
      if (${JSON.stringify(anchor.placeholder ?? null)}) {
        const exact = inputs.find(el => (el.getAttribute('placeholder') || '').trim() === ${JSON.stringify(anchor.placeholder)});
        if (exact) return exact;
      }
      if (${JSON.stringify(anchor.placeholderContains ?? null)}) {
        return inputs.find(el => (el.getAttribute('placeholder') || '').includes(${JSON.stringify(anchor.placeholderContains)})) || null;
      }
      return null;
    };
    const el = pick();
    if (!el) return JSON.stringify({ ok: false, reason: 'NOT_FOUND' });
    const text = ${JSON.stringify(value)};
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // 写后回读：**同一个元素**上读回来，静默失效要在这里就发现
    return JSON.stringify({ ok: true, readBack: String(el.value == null ? '' : el.value) });
  })()`

  try {
    const raw = await wc.executeJavaScript(code, false)
    const parsed = typeof raw === 'string' ? JSON.parse(raw) as { ok: boolean; readBack?: string; reason?: string } : null
    if (!parsed) {
      return { field: anchor.field, label: anchor.label, ok: false, written: value, readBack: null, reason: '页面没有返回结果' }
    }
    if (!parsed.ok) {
      // 消息在 **TypeScript 侧**拼（不要拼进注入脚本里：模板字符串 + JSON.stringify 混在一起
      // 极易写出语法错误，而注入脚本的报错只会给一句 "Script failed to execute"，很难查 —— 实测踩过）
      const reason = parsed.reason === 'NOT_FOUND'
        ? `页面上还没有这个字段${anchor.note ? `（${anchor.note}）` : ''}；也可能是页面没渲染完或平台改版`
        : (parsed.reason ?? '定位失败')
      return { field: anchor.field, label: anchor.label, ok: false, written: value, readBack: null, reason }
    }
    const readBack = String(parsed.readBack ?? '')
    // 回读必须**与写进去的一致**（数值类字段平台可能格式化，所以做去空白比较；
    // 不一致就是"写进去了但没生效"，如实报出来，不假装成功）
    const same = readBack.trim() === String(value).trim()
    return {
      field: anchor.field, label: anchor.label, ok: same, written: value, readBack,
      reason: same ? null : `写入后回读不一致（写的是「${String(value).slice(0, 20)}」，读回来是「${readBack.slice(0, 20)}」）`
    }
  } catch (error) {
    return {
      field: anchor.field, label: anchor.label, ok: false, written: value, readBack: null,
      reason: `脚本执行失败：${String((error as Error)?.message || error).slice(0, 120)}`
    }
  }
}
