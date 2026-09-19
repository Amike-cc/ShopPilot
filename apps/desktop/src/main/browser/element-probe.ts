/**
 * 网页元素定位信息采集 - 店铺页面右键「元素定位信息」用
 *
 * 【为什么需要它】
 * 任务引擎的每一步都依赖"档案里的选择器/文案锚点"（见 packages/shared/src/constants/*），
 * 而这些常量全靠**真机实测**得来：平台类名普遍带构建哈希，写死等于猜测，所以取锚点这件事
 * 必须能在页面上现场做。此前只能开 DevTools 手动翻 DOM，本模块把这一步变成一次右键。
 *
 * 【为什么单独成文件、且脚本是纯字符串】
 * ① 脚本要 `executeJavaScript` 注入页面，属于"注入脚本"，与 injected-scripts.ts 同类；
 * ② 单测需要能校验它**语法可解析**（注入脚本写成模板字面量时，内部再写反引号会被外层吃掉，
 *    这类错误只有构建期才暴露，运行时表现成"步骤报各种怪错"——见 tests/unit/injected-script-syntax.test.ts）；
 * ③ 采集逻辑与菜单模板分离，菜单模板仍是纯函数、可单测。
 *
 * 【采集什么，为什么是这些】
 * 任务档案真正用得上的是三层锚点，按"平台改版后的存活率"从高到低：
 *   1. 文案（自有文本）：平台对外的稳定表达，改版时最先保住的往往就是它 —— 引擎的
 *      clickByText / readLabelValue 正是以文案为锚（理由见 task-runner 里 readLabelValue 的注释）；
 *   2. 稳定属性：data-* / name / aria-label / placeholder / type 等，平台为了自动化测试
 *      或无障碍通常保留；
 *   3. CSS 路径：最后手段，类名可能是哈希（本仓库对此的既定态度是"宁可如实失败，也别猜"）。
 * 所以采集结果**同时给出这三层**，并显式标注类名里是否疑似构建哈希，让取锚点的人一眼看出
 * 哪一层能用、哪一层不能。
 */

/**
 * 疑似构建哈希的类名判定。
 *
 * 【为什么不能简单用"含数字"当判据】真机实测（微信小店资质管理页）发现：现代平台大量使用
 * Tailwind 之类的原子化 CSS，类名天生带数字与方括号（`h-[44px]` / `pl-[28px]` / `text-2xl`），
 * 它们**不是**构建哈希，却会被"含数字"规则全部误报。误报的代价不是"多提示一句"——
 * 而是这个警告整体失去可信度：用户连着看到几次假警报后，真正危险的 `css-1x2y3z` 也不会被当回事。
 *
 * 所以只认**真正的随机串特征**（哈希的本质是"人不可读的随机标识"，而非"含数字"）：
 *   ① 过长（>20 字符）——正常语义类名不会这么长；
 *   ② 短前缀 + 长随机串（`css-1x2y3z`、`btn_a1b2c3`）——CSS-in-JS / CSS Modules 的典型形态；
 *   ③ 纯随机串（`a1b2c3d4`）。
 *
 * 另外把"需要转义才能写进选择器"的类名（含 `[` `]` `:` `/`）单列出来：它们不是哈希，
 * 但直接拼进 CSS 选择器会失效，属于"可用但要小心"，与"别用"是两回事。
 */
const HASHY_CLASS_JS = `
  const __hashyClass = (cls) => {
    const parts = String(cls || '').split(/\\s+/).filter(Boolean);
    const isHashy = (p) => {
      const digits = (p.match(/[0-9]/g) || []).length;
      // ① 超长且**无分隔符**：人写的长类名一定有 - / _ 分隔（BEM 尤甚），
      //    连成一片的长串才是随机标识。Tailwind 的 h-[44px] 带 -，不会走到这里。
      if (p.length > 20 && !/[-_]/.test(p)) return true;
      // ② 前缀 + 随机串（css-1x2y3z / btn_a1b2c3）：CSS-in-JS 与 CSS Modules 的典型形态。
      //    要求随机段含 ≥2 位数字——这条把 icon-arrow2 / card-3 这类"带一位数字的语义类名"挡在外面。
      //    注意随机串是**字母数字混合**（styled-components 用 [a-z0-9]、emotion 用 base36），
      //    不能只认十六进制：真机样本 css-1x2y3z 含 x/y/z，只认 [0-9a-f] 会漏判。
      if (/^[a-z]{1,5}[-_][a-z0-9]{5,}$/i.test(p) && digits >= 2) return true;
      // ③ 纯随机串（a1b2c3d4）
      if (/^[a-z0-9]{8,}$/i.test(p) && digits >= 2) return true;
      return false;
    };
    // 含这些字符的类名写进 CSS 选择器必须转义，标出来但不算哈希
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
 * 生成"高亮 + 采集元素信息"的注入脚本。
 *
 * 高亮是**必要**的：右键落点与"最终被采集的元素"往往不是同一个（页面里到处是
 * 透明的覆盖层与包裹 div），不把选中的那个框出来，用户无法判断工具是否选对了目标。
 * 高亮用 fixed 定位的遮罩 + 说明标签，2.5 秒后自动移除，不污染页面。
 *
 * 返回结构（字段名即契约，单测与菜单提示都依赖）：
 *   ok: false + reason  —— 未命中可描述元素
 *   ok: true  + 各层锚点与"推荐写法"
 */
export function generateElementProbeScript(): string {
  return `(() => {
    ${HASHY_CLASS_JS}
    const OUTLINE_ID = '__shopilot_probe_outline__';

    // 清掉上一次的残留（连点多次不会叠一堆遮罩）
    const old = document.getElementById(OUTLINE_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);

    // 取右键落点处的**最具体**元素。
    // 用 elementFromPoint 而不是事件坐标做算术：页面里的浮层、iframe 边界、
    // transform 都会让坐标换算失真，交给浏览器命中测试最可靠。
    const px = __PROBE_X__, py = __PROBE_Y__;
    let el = document.elementFromPoint(px, py);
    if (!el) return { ok: false, reason: 'NO_ELEMENT_AT_POINT' };

    // 穿透开放 ShadowRoot（微信小店的页面在 micro-app 的 ShadowRoot 里，不穿透只能拿到宿主）
    for (let i = 0; i < 12; i++) {
      if (!el.shadowRoot) break;
      const inner = el.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === el) break;
      el = inner;
    }

    // 从落点元素向上收敛到"最像可操作目标"的那个：
    // 任务引擎点的是按钮/链接/输入框，而不是它外面那层 padding 包裹 div。
    const INTERACTIVE = ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL'];
    let target = el;
    for (let i = 0, n = el; i < 6 && n; i++, n = n.parentElement) {
      const tag = n.tagName;
      const role = n.getAttribute && n.getAttribute('role');
      if (INTERACTIVE.includes(tag) || role === 'button' || role === 'tab' || role === 'link') { target = n; break; }
    }

    const own = (e) => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();

    const rect = target.getBoundingClientRect();

    // ---- 第 1 层：文案锚点（引擎 clickByText / waitForText 的输入）----
    const ownText = norm(own(target));
    const fullText = norm(target.innerText);
    // 自有文本适合当锚点；若只有 innerText（文本都在子元素里），只能当"包含匹配"的参考
    const textAnchor = ownText || (fullText.length <= 40 ? fullText : '');

    // ---- 第 2 层：稳定属性 ----
    const attrs = {};
    for (const a of Array.from(target.attributes || [])) {
      if (/^(data-|name$|type$|placeholder$|aria-label$|aria-|title$|id$|href$|role$|value$)/.test(a.name)) {
        attrs[a.name] = String(a.value).slice(0, 200);
      }
    }

    // ---- 第 3 层：CSS 路径（最后手段）----
    const cls = __hashyClass(target.className);
    const cssPath = (e) => {
      const segs = [];
      let n = e;
      for (let i = 0; i < 8 && n && n.nodeType === 1; i++) {
        let seg = n.tagName.toLowerCase();
        const idAttr = n.getAttribute && n.getAttribute('id');
        if (idAttr && !/[0-9]{4,}/.test(idAttr)) { segs.unshift(seg + '#' + idAttr); break; }
        // 类名只取"看起来稳定"的那些（哈希类名写进选择器等于埋雷；
        // 含 [] : / 的原子类名同理跳过——它们需要转义，拼进去会直接失效）
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

    // ---- 定位容器：给 within 用（引擎的 within 需要"能唯一框住目标"的范围）----
    // 优先取语义行容器（表格行/列表项），这是"点这一行里的按钮"最常用的范围锚点
    let row = target;
    for (let i = 0, n = target; i < 8 && n; i++, n = n.parentElement) {
      if (/^(TR|LI)$/.test(n.tagName) || (n.getAttribute && n.getAttribute('data-row-key'))) { row = n; break; }
    }
    const rowText = row === target ? '' : norm(row.innerText).slice(0, 200);

    // ---- 高亮：把选中的元素框出来，否则用户不知道工具选的是哪一层 ----
    try {
      const box = document.createElement('div');
      box.id = OUTLINE_ID;
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
        'left:' + Math.round(rect.left) + 'px;top:' + Math.round(rect.top) + 'px;' +
        'width:' + Math.round(rect.width) + 'px;height:' + Math.round(rect.height) + 'px;' +
        'border:2px solid #1677ff;background:rgba(22,119,255,0.12);box-sizing:border-box;';
      const label = document.createElement('div');
      label.style.cssText = 'position:absolute;left:0;top:-22px;background:#1677ff;color:#fff;' +
        'font:12px/18px -apple-system,Segoe UI,sans-serif;padding:2px 6px;border-radius:3px;white-space:nowrap;';
      label.textContent = target.tagName.toLowerCase() + (textAnchor ? ' · ' + textAnchor.slice(0, 24) : '');
      box.appendChild(label);
      document.documentElement.appendChild(box);
      setTimeout(() => { try { box.remove() } catch (e) {} }, 2500);
    } catch (e) { /* 高亮失败不影响采集结果 */ }

    return {
      ok: true,
      tag: target.tagName.toLowerCase(),
      textAnchor,
      ownText,
      innerText: fullText.slice(0, 200),
      attrs,
      cssPath: cssPath(target),
      className: String(target.className || '').slice(0, 300),
      hashyClasses: cls.hashy,
      escapeClasses: cls.escape,
      stableClasses: cls.stable,
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      rowSelector: row === target ? '' : cssPath(row),
      rowText,
      inShadowRoot: !!el.getRootNode && el.getRootNode() !== document,
      url: String(location.href)
    };
  })()`
}

/** 采集结果（菜单提示与单测依赖这些字段名） */
export interface ElementProbeResult {
  ok: boolean
  reason?: string
  tag?: string
  textAnchor?: string
  ownText?: string
  innerText?: string
  attrs?: Record<string, string>
  cssPath?: string
  className?: string
  /** 疑似构建哈希的类名：**不要**写进选择器 */
  hashyClasses?: string[]
  /** 含 [] : / 等需转义字符的类名：可用但要转义，直接拼进选择器会失效 */
  escapeClasses?: string[]
  /** 语义化类名：可以放心用 */
  stableClasses?: string[]
  rect?: { x: number; y: number; w: number; h: number }
  rowSelector?: string
  rowText?: string
  inShadowRoot?: boolean
  url?: string
}

/** 把落点坐标填进脚本（坐标只能运行期知道，所以脚本按参数生成而不是常量） */
export function buildElementProbeScript(x: number, y: number): string {
  return generateElementProbeScript()
    .replace('__PROBE_X__', String(Math.round(x)))
    .replace('__PROBE_Y__', String(Math.round(y)))
}

/**
 * 把采集结果整理成**可读的、可直接抄进档案的**文本。
 *
 * 为什么要排版而不是 JSON.stringify：这个文本的用途是"人读了之后往
 * packages/shared/src/constants/*.ts 里抄锚点"，所以把三层按优先级排好、
 * 每层给出"引擎里对应的写法"，比一堆字段名有用得多。
 * 同时保留 JSON 尾巴，需要精细字段时仍可查。
 */
export function formatElementProbe(r: ElementProbeResult): string {
  if (!r.ok) {
    const why: Record<string, string> = {
      NO_ELEMENT_AT_POINT: '落点处没有元素（可能点在窗口空白或页面尚未加载完）'
    }
    return `未能采集元素：${why[r.reason || ''] || r.reason || '未知原因'}`
  }

  const lines: string[] = []
  lines.push(`元素：<${r.tag}>   ${r.rect ? `${r.rect.w}×${r.rect.h} @ ${r.rect.x},${r.rect.y}` : ''}`)
  if (r.inShadowRoot) lines.push('位置：在 ShadowRoot 内 → 引擎步骤需要加 deep: true')

  // 第 1 层：文案锚点（最稳）
  if (r.textAnchor) {
    lines.push('', '【1. 文案锚点（最稳，优先用它）】')
    lines.push(`  clickByText: { text: ${JSON.stringify(r.textAnchor)} }`)
  } else if (r.innerText) {
    lines.push('', '【1. 文案锚点】')
    lines.push('  该元素没有自有文本（文本都在子元素里）→ 直接用文案定位不可靠，')
    lines.push(`  只能用包含匹配的参考：${JSON.stringify(r.innerText.slice(0, 60))}`)
  } else {
    lines.push('', '【1. 文案锚点】无文本（多为图标按钮）→ 只能靠属性或 CSS 路径')
  }

  // 第 2 层：稳定属性
  const attrs = Object.entries(r.attrs || {})
  if (attrs.length) {
    lines.push('', '【2. 稳定属性（次选）】')
    for (const [k, v] of attrs) {
      lines.push(`  ${k}="${v}"`)
      if (k.startsWith('data-') || k === 'name' || k === 'aria-label') {
        lines.push(`    → waitForSelector: { selector: '[${k}="${v}"]' }`)
      }
    }
  }

  // 第 3 层：CSS 路径
  lines.push('', '【3. CSS 路径（最后手段）】')
  lines.push(`  ${r.cssPath}`)
  if (r.hashyClasses && r.hashyClasses.length) {
    lines.push(`  ⚠ 该类名疑似构建哈希，不要写进选择器：${r.hashyClasses.join(' ')}`)
    lines.push('    平台改版后哈希必变，写死等于埋雷——优先用上面两层')
  }
  if (r.escapeClasses && r.escapeClasses.length) {
    lines.push(`  ⚠ 这些类名含 [] : / 等字符，拼进选择器必须转义：${r.escapeClasses.join(' ')}`)
  }
  if (r.stableClasses && r.stableClasses.length) {
    lines.push(`  可用的语义化类名：${r.stableClasses.join(' ')}`)
  }

  // 范围锚点：within 用
  if (r.rowSelector) {
    lines.push('', '【定位范围（within 用）】')
    lines.push(`  所在行：${r.rowSelector}`)
    if (r.rowText) lines.push(`  行文本：${JSON.stringify(r.rowText.slice(0, 80))}`)
    lines.push('  行容器类名往往完全相同 → 用 { text: \'行标签\', climb: N } 上溯更稳')
  }

  lines.push('', '【原始数据】')
  lines.push(JSON.stringify(r))
  return lines.join('\n')
}
