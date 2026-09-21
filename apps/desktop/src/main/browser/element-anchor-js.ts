/**
 * 注入页面的「锚点提取」公共片段 —— 右键采集（element-probe）与编排器拾取（element-picker）共用。
 *
 * 【为什么必须共用一份】
 * 两处都要回答同一个问题："这个元素的稳定锚点是什么"（CSS 路径 / 自有文案 / 是否在 ShadowRoot 内）。
 * 各写一份的直接后果是**同一个元素、两个入口给出不同的选择器**——用户右键看到的是
 * `.ant-table-row > td:nth-of-type(2)`，点「拾取」填进去的却是另一条，然后任务跑不通，
 * 而两处代码各自看起来都对。这类漂移没有任何编译期信号，只能靠共用一份来根除。
 *
 * 【为什么是字符串而不是普通模块】
 * 这些代码要 `executeJavaScript` 注入页面，必须能在页面上下文里当 JS 解析。
 * 写法上有两条硬约束（都是踩过的坑）：
 *   ① 不能在外层模板字面量里再写反引号——外层会先吃掉，直接语法错（见 injected-script-syntax.test.ts）；
 *   ② 只能字符串拼接，不能用页面里不存在的构建期变量。
 *
 * 纯字符串还有一个好处：单测可以把它抠出来 `new Function` 真跑一遍，
 * 而不是只断言"字符串里包含某些字"。
 */

/**
 * 类名判定：把"疑似构建哈希""需要转义的原子类名""语义化类名"分开。
 *
 * 区分哈希与 Tailwind 原子类名的理由见 element-probe.ts 的详细注释：
 * 早期"含数字即哈希"的规则把 `h-[44px]` 也判成哈希，假警报让整个警告失去可信度。
 */
export const HASHY_CLASS_JS = `
  const __hashyClass = (cls) => {
    const parts = String(cls || '').split(/\\s+/).filter(Boolean);
    const isHashy = (p) => {
      const digits = (p.match(/[0-9]/g) || []).length;
      if (p.length > 20 && !/[-_]/.test(p)) return true;
      if (/^[a-z]{1,5}[-_][a-z0-9]{5,}$/i.test(p) && digits >= 2) return true;
      if (/^[a-z0-9]{8,}$/i.test(p) && digits >= 2) return true;
      return false;
    };
    const needsEscape = (p) => /[\\[\\]:\\/]/.test(p);
    const hashy = [], escape = [], stable = [];
    for (const p of parts) {
      if (isHashy(p)) hashy.push(p);
      else if (needsEscape(p)) escape.push(p);
      else stable.push(p);
    }
    return { hashy, escape, stable };
  };
`

/**
 * CSS 路径生成：优先用 id，其次稳定类名，再退回 :nth-of-type。
 *
 * 哈希类名与需转义的原子类名**一律跳过**——写进选择器等于埋雷或直接失效。
 */
export const CSS_PATH_JS = `
  const __cssPath = (e) => {
    const segs = [];
    let n = e;
    for (let i = 0; i < 8 && n && n.nodeType === 1; i++) {
      let seg = n.tagName.toLowerCase();
      const idAttr = n.getAttribute && n.getAttribute('id');
      if (idAttr && !/[0-9]{4,}/.test(idAttr)) { segs.unshift(seg + '#' + idAttr); break; }
      const st = __hashyClass(n.className).stable;
      if (st.length) seg += '.' + st.slice(0, 2).join('.');
      const parent = n.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === n.tagName);
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      }
      segs.unshift(seg);
      n = parent;
    }
    return segs.join(' > ');
  };
`

/** 文本工具：自有文本（排除子元素文本）与空白归一 */
export const TEXT_HELPERS_JS = `
  const __norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const __ownText = (e) => __norm([...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(''));
`

/**
 * 穿透开放 ShadowRoot，取最内层真实元素。
 *
 * 微信小店的页面在 micro-app 的 ShadowRoot 里，不穿透只能拿到宿主元素，
 * 拿到的锚点在引擎侧（deep: true）对不上。
 */
export const SHADOW_PIERCE_JS = `
  const __pierce = (x, y) => {
    let el = document.elementFromPoint(x, y);
    if (!el) return null;
    for (let i = 0; i < 12; i++) {
      if (!el.shadowRoot) break;
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
`

/**
 * 从落点元素向上收敛到"最像可操作目标"的那个。
 *
 * 任务引擎点的是按钮/链接/输入框，而落点往往是它外面那层 padding 包裹 div。
 * 不收敛的话，采集到的锚点指向一个没有事件的 div，点击步骤必然无效——
 * 而且用户从高亮框上还看不出问题（外框和内框常常差不多大）。
 */
export const CONVERGE_TARGET_JS = `
  const __converge = (el) => {
    const INTERACTIVE = ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL'];
    let target = el;
    for (let i = 0, n = el; i < 6 && n; i++, n = n.parentElement) {
      const role = n.getAttribute && n.getAttribute('role');
      if (INTERACTIVE.indexOf(n.tagName) >= 0 || role === 'button' || role === 'tab' || role === 'link') {
        target = n;
        break;
      }
    }
    return target;
  };
`

/** 上面全部片段拼成一个可直接嵌进注入脚本的块 */
export const ANCHOR_HELPERS_JS = [
  HASHY_CLASS_JS,
  CSS_PATH_JS,
  TEXT_HELPERS_JS,
  SHADOW_PIERCE_JS,
  CONVERGE_TARGET_JS
].join('\n')
