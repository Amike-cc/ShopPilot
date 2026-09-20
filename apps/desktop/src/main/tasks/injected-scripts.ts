/**
 * 注入脚本常量 - 提取自 task-runner.ts
 * 这些脚本以字符串形式注入到页面中执行
 */

/**
 * 元素可见性判据
 * 导出供单测复用同一份源码
 */
export const VISIBLE_JS = `
  const __visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
`

/**
 * 候选排序：按"自身文本最短"（最具体的那个），长度相同的再优先"看起来可点的标签"
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
  const __narrow = (s) => String(s == null ? '' : s).replace(/\\s+/g, '');
`

/**
 * 查找范围限定（clickByText / waitForText 的 within）
 */
export const SCOPE_FN = `
  const __scopeRoots = (w) => {
    if (!w) return null;
    let roots = [];
    if (w.selector) roots = Array.from(document.querySelectorAll(w.selector));
    else {
      const cands = [];
      for (const el of document.querySelectorAll('*')) {
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
 * 目标缺席判据（clickByText 的 absentText）
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
 * 枚举主文档与所有开放 ShadowRoot 的元素
 */
export const ENUM_DEEP_FN = `
  const __enumDeep = () => {
    const out = [];
    const walk = (r) => {
      for (const el of r.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  }
`
