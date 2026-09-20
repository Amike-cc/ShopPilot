/**
 * 文本目标查找器 - 从 task-runner.ts 提取的大型函数
 * 负责在页面中定位包含特定文本的可见元素
 */

import type { WebContents } from 'electron'
import { VISIBLE_JS, PICK_SORT_FN, SCOPE_FN, ABSENT_FN } from './injected-scripts'

export interface TextTargetOptions {
  /** 查找范围限定 */
  within?: { selector?: string; text?: string; climb?: number }
  /** 按行去重与选择 */
  pick?: { roundIdx?: number; visited?: string[]; dedupNs?: string }
  /** 视图未挂载时是否允许降级为 JS 点击 */
  allowJsWhenDetached?: boolean
  /** 目标不存在但页面上出现这些替代文案时的判据 */
  absentTexts?: string[]
}

export interface TextTargetResult {
  ok: boolean
  reason?: string
  x?: number
  y?: number
  clickedText?: string
  candidates?: number
  coveredBy?: string
  rowKey?: string
  picked?: string
  viaBlocker?: string
  transport?: 'trusted-mouse' | 'js-fallback'
  absentText?: string
  disabledReason?: string
}

/**
 * 生成查找文本目标的注入脚本
 */
export function generateTextTargetScript(
  needle: string,
  deep: boolean,
  options: TextTargetOptions = {}
): string {
  const { within, pick, allowJsWhenDetached = false, absentTexts = [] } = options

  return `(() => {
    ${deep ? 'const __enumDeep = () => { const out = []; const walk = (r) => { for (const el of r.querySelectorAll("*")) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; };' : ''}
    ${VISIBLE_JS}
    ${SCOPE_FN}
    ${PICK_SORT_FN}
    ${ABSENT_FN}
    
    const needle = ${JSON.stringify(needle)};
    const within = ${JSON.stringify(within || null)};
    const absentTexts = ${JSON.stringify(absentTexts)};
    const roundIdx = ${pick && pick.roundIdx != null ? JSON.stringify(pick.roundIdx) : 'null'};
    const visited = new Set(${JSON.stringify((pick && pick.visited) || [])});
    const dedupNs = ${JSON.stringify((pick && pick.dedupNs) || '')};
    const scope = ${deep ? '__enumDeep()' : 'document.querySelectorAll("*")'};
    const roots = within ? __scopeRoots(within) : null;
    
    if (within && !roots) return { ok: false, reason: 'SCOPE_NOT_FOUND' };
    
    const cands = [];
    const narrowNeedle = __narrow(needle);
    
    // 第一级匹配：自有文本精确匹配
    for (const el of scope) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (!own.includes(needle)) continue;
      if (!__inScope(roots, el)) continue;
      if (!__visible(el)) continue;
      cands.push({ el, len: own.length });
    }
    
    // 第二级匹配：规范化后的 innerText（去空白）
    if (!cands.length && narrowNeedle) {
      const pool = [];
      if (roots) for (const r of roots) { pool.push(r); for (const c of r.querySelectorAll('*')) pool.push(c); }
      else for (const el of scope) pool.push(el);
      
      for (const c of pool) {
        const tag = c.tagName;
        if (!(tag === 'BUTTON' || tag === 'A' || tag === 'LABEL' || tag === 'SPAN' ||
              (c.getAttribute && c.getAttribute('role') === 'button'))) continue;
        if (!__visible(c)) continue;
        if (__narrow(c.innerText) !== narrowNeedle) continue;
        cands.push({ el: c, len: narrowNeedle.length, viaText: true });
      }
    }
    
    // 目标不存在时检查 absentTexts
    if (!cands.length) {
      for (const at of absentTexts) {
        if ([...scope].some(el => __absentHit(el, at))) return { ok: false, reason: 'ABSENT', absentText: at };
      }
      return { ok: false, reason: 'NOT_FOUND' };
    }
    
    cands.sort((a, b) => (a.len - b.len) || (__clickableScore(a.el) - __clickableScore(b.el)));
    
    // 按行去重与选择
    let hit = cands[0].el;
    let picked = 'best';
    let rowKey = null;
    
    if (roundIdx != null || (visited.size >= 0 && dedupNs)) {
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
      
      // 过滤表格固定列镜像
      if (entries.length > 1) {
        const rich = entries.filter(e => e.key !== needle);
        if (rich.length) entries.length = 0, entries.push(...rich);
      }
      
      if (roundIdx != null) {
        if (roundIdx >= entries.length) return { ok: false, reason: 'NOT_FOUND' };
        hit = entries[roundIdx].el;
        rowKey = dedupNs + ':' + entries[roundIdx].key;
        picked = 'round' + roundIdx;
      } else {
        const avail = entries.filter(e => !visited.has(dedupNs + ':' + e.key));
        if (!avail.length) return { ok: false, reason: entries.length ? 'ALL_VISITED' : 'NOT_FOUND' };
        hit = avail[0].el;
        rowKey = dedupNs + ':' + avail[0].key;
        picked = 'unvisited';
      }
    }
    
    // 检查禁用状态
    let dis = hit.disabled === true || hit.getAttribute('aria-disabled') === 'true';
    let p = hit;
    for (let i = 0; i < 4 && p && !dis; i++, p = p.parentElement) {
      if (/disabled/i.test(String(p.className || ''))) dis = true;
    }
    
    if (dis) {
      let why = '';
      try {
        let n = hit;
        for (let i = 0; i < 6 && n && !why; i++, n = n.parentElement) {
          const pop = n.querySelector && n.querySelector('.weui-desktop-popover, [class*="tooltip"], [role="tooltip"]');
          if (pop) why = String(pop.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
        }
      } catch { }
      return { ok: false, reason: 'DISABLED', disabledReason: why };
    }
    
    // 视图摘除检测与降级
    if (window.innerWidth < 50 || window.innerHeight < 50) {
      if (!${allowJsWhenDetached}) {
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
        viaBlocker: 'JS降级(' + chain.join('>') + ')'
      };
    }
    
    hit.scrollIntoView({ block: 'center' });
    const r = hit.getBoundingClientRect();
    
    // 多点采样检测遮挡
    const deepAt = (x, y) => {
      let el = document.elementFromPoint(x, y);
      while (el && el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      return el;
    };
    
    const labelEl = hit.closest('label') || hit.parentElement || hit;
    const xs = [0.12, 0.3, 0.5, 0.7, 0.88].map(f => Math.round(r.left + r.width * f));
    const ys = [0.5, 0.25, 0.75].map(f => Math.round(r.top + r.height * f));
    
    for (const x of xs) {
      for (const y of ys) {
        const at = deepAt(x, y);
        if (at && (at === hit || hit.contains(at) || at.contains(hit) || labelEl.contains(at) || at.contains(labelEl))) {
          return {
            ok: true, x, y,
            clickedText: String(hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
            candidates: cands.length, picked, rowKey
          };
        }
      }
    }
    
    const blocker = deepAt(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    
    // 检查遮挡者是否为同行可点元素
    const rowOf = (el) => el.closest('tr, li, [data-row-key], [class*="card"], [class*="dorami"]') || el.parentElement;
    if (blocker) {
      let anc = blocker;
      for (let i = 0; i < 4 && anc; i++, anc = anc.parentElement) {
        const tag = anc.tagName;
        const interactive = tag === 'A' || tag === 'BUTTON' || tag === 'LABEL' || anc.getAttribute('role') === 'button';
        if (interactive && rowOf(anc) === rowOf(hit)) {
          return {
            ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
            clickedText: String(hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
            candidates: cands.length, viaBlocker: tag, picked, rowKey
          };
        }
      }
      
      // 检查固定列副本
      const ownOf = (el) => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      let same = blocker;
      for (let i = 0; i < 4 && same; i++, same = same.parentElement) {
        const tag = same.tagName;
        const interactive = tag === 'A' || tag === 'BUTTON' || tag === 'LABEL' || same.getAttribute('role') === 'button';
        if (interactive && ownOf(same) === ownOf(hit)) {
          return {
            ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
            clickedText: String(same.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
            candidates: cands.length, viaBlocker: tag + '(同文本副本)', picked, rowKey
          };
        }
      }
    }
    
    // 检查元素是否在视口外
    const outsideViewport = r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
    if (outsideViewport) {
      return {
        ok: false, reason: 'OUT_OF_VIEWPORT',
        coveredBy: '元素在视口外（矩形 ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + 
                    Math.round(r.width) + '×' + Math.round(r.height) + '；视口 ' + innerWidth + '×' + innerHeight + '）'
      };
    }
    
    return {
      ok: false, reason: 'COVERED',
      coveredBy: blocker ? blocker.tagName + '.' + String(blocker.className || '').slice(0, 40) : 'unknown'
    };
  })()`
}

/**
 * 在页面中查找包含特定文本的可见目标
 */
export async function findTextTarget(
  wc: WebContents,
  needle: string,
  deep: boolean,
  timeoutMs: number,
  label: string,
  options: TextTargetOptions = {}
): Promise<TextTargetResult> {
  const script = generateTextTargetScript(needle, deep, options)
  
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`TASK_TIMEOUT: ${label} 超过 ${timeoutMs}ms`)), timeoutMs)
  })
  
  try {
    const result = await Promise.race([
      wc.executeJavaScript(script),
      timeout
    ]) as TextTargetResult
    
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}
