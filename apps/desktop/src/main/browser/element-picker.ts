/**
 * 「拾取元素」—— 在店铺页面上直接点一下，把锚点填回编排器的参数框。
 *
 * 【为什么需要它（这是自定义任务最大的摩擦点）】
 * 用不出来的功能等于没有。自定义任务要求用户填选择器，而选择器只能从页面上"看"出来：
 * 此前唯一的手段是右键「元素定位信息」→ 读剪贴板 → 手动粘进参数框。这条路径有两个硬伤：
 *   ① 新建任务对话框一打开，店铺页面的原生视图就被摘除了（WebContentsView 永远画在 HTML 之上，
 *      不摘除弹窗会被盖住），所以**没法边建任务边取元素**——必须先采完、再建，来回切换；
 *   ② 剪贴板只有一个格子，中间复制了别的东西就丢了。
 * 结果是用户在两个界面之间来回跑，还得自己判断"粘哪一行"。这个模块把整件事变成一次点击。
 *
 * 【交互设计：为什么是"对话框让位 + 页面内提示"，而不是并排显示】
 * 原生视图与 HTML 弹层无法同时显示（层级决定，见 window-manager 的 setBrowserViewsObscured），
 * 所以拾取期间对话框必须暂时收起。用户此时看到的只有页面，提示语**只能画在页面里**
 * ——渲染层的浮层同样会被原生视图盖住，这是这个功能不能用普通 toast 的原因。
 *
 * 【安全属性：拾取期间绝不触发平台动作】
 * 用一个铺满视口的透明遮罩接管所有指针事件，页面**根本收不到**点击。这不是顺手为之：
 * 拾取时用户点的往往正是「确认发送」「提交」这类不可逆按钮，一旦事件穿透到页面，
 * 就等于让用户在自己不知情的情况下真的点了它。遮罩 + 捕获阶段拦截是硬要求。
 */
import { ANCHOR_HELPERS_JS } from './element-anchor-js'
import type { PickMode } from '@shared/element-pick'

// 结果结构与描述文案放在 @shared/element-pick（IPC 两端共用一份），这里只做转发，
// 让主进程内部继续从本模块引，不必每处都改 import 路径。
export type { ElementPickResult, PickMode } from '@shared/element-pick'
export { describePickResult } from '@shared/element-pick'

/**
 * 生成拾取脚本。返回的 Promise 在用户点击元素（或取消/超时）时 resolve。
 *
 * `executeJavaScript` 会 await 这个 Promise，所以主进程侧调用一次即可拿到结果，
 * 不需要轮询。
 */
export function buildElementPickerScript(mode: PickMode, timeoutMs = 120000): string {
  return `(() => {
    ${ANCHOR_HELPERS_JS}
    const BANNER_ID = '__shopilot_pick_banner__';
    const OUTLINE_ID = '__shopilot_pick_outline__';
    const MASK_ID = '__shopilot_pick_mask__';
    const MODE = ${JSON.stringify(mode)};
    const TIMEOUT = ${Number(timeoutMs)};

    // 清掉上一次的残留（连点两次不会叠一堆遮罩）
    for (const id of [BANNER_ID, OUTLINE_ID, MASK_ID]) {
      const old = document.getElementById(id);
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }

    return new Promise((resolve) => {
      let settled = false;

      // ---- 遮罩：接管全部指针事件，页面收不到任何点击（见文件头"安全属性"） ----
      const mask = document.createElement('div');
      mask.id = MASK_ID;
      mask.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;' +
        'background:rgba(22,119,255,0.06);cursor:crosshair;';

      // ---- 提示条：必须在页面内画（渲染层浮层会被原生视图盖住） ----
      const banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;' +
        'background:#1677ff;color:#fff;font:13px/1.6 -apple-system,Segoe UI,sans-serif;' +
        'padding:8px 16px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.28);' +
        'pointer-events:none;white-space:nowrap;text-align:center;';
      banner.textContent = (MODE === 'text'
        ? '拾取文案：点要操作的元素（取其文字）'
        : '拾取选择器：点要操作的元素') + ' · 按 Esc 取消';

      const outline = document.createElement('div');
      outline.id = OUTLINE_ID;
      outline.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;' +
        'border:2px solid #1677ff;background:rgba(22,119,255,0.14);box-sizing:border-box;' +
        'display:none;';

      const label = document.createElement('div');
      label.style.cssText = 'position:absolute;left:0;top:-22px;background:#1677ff;color:#fff;' +
        'font:12px/18px -apple-system,Segoe UI,sans-serif;padding:2px 6px;border-radius:3px;white-space:nowrap;';
      outline.appendChild(label);

      const cleanup = () => {
        for (const id of [BANNER_ID, OUTLINE_ID, MASK_ID]) {
          const el = document.getElementById(id);
          if (el && el.parentNode) el.parentNode.removeChild(el);
        }
        window.removeEventListener('keydown', onKey, true);
      };

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(payload);
      };

      // ---- 命中：遮罩临时让开一下，用 elementFromPoint 拿真实元素 ----
      const hitAt = (x, y) => {
        mask.style.pointerEvents = 'none';
        const raw = __pierce(x, y);
        mask.style.pointerEvents = 'auto';
        if (!raw) return null;
        return { raw, target: __converge(raw) };
      };

      const describe = (hit) => {
        const t = hit.target;
        const ownText = __ownText(t);
        const innerText = __norm(t.innerText);
        const rect = t.getBoundingClientRect();
        const name = (ownText || (innerText.length <= 40 ? innerText : '') || '').slice(0, 24);
        return {
          rect,
          label: t.tagName.toLowerCase() + (name ? ' · ' + name : '')
        };
      };

      const onMove = (ev) => {
        const x = ev.clientX, y = ev.clientY;
        const hit = hitAt(x, y);
        if (!hit) return;
        const d = describe(hit);
        outline.style.display = 'block';
        outline.style.left = Math.round(d.rect.left) + 'px';
        outline.style.top = Math.round(d.rect.top) + 'px';
        outline.style.width = Math.round(d.rect.width) + 'px';
        outline.style.height = Math.round(d.rect.height) + 'px';
        label.textContent = d.label;
      };

      const buildResult = (hit) => {
        const t = hit.target;
        const ownText = __ownText(t);
        const innerText = __norm(t.innerText);
        const textAnchor = ownText || (innerText.length <= 40 ? innerText : '');
        const cls = __hashyClass(t.className);

        // 所在行（表格行 / 列表项）：给 within 用。行文本截断到 200 字再过 IPC：
        // 整表行 innerText 可能上万字，不过 IPC 又大又没用（within 上限 60 字，
        // 编辑器侧超长直接拒填）。与 element-probe 的 rowText.slice(0, 200) 对齐。
        let row = t;
        for (let i = 0, n = t; i < 8 && n; i++, n = n.parentElement) {
          if (/^(TR|LI)$/.test(n.tagName) || (n.getAttribute && n.getAttribute('data-row-key'))) { row = n; break; }
        }

        return {
          ok: true,
          selector: __cssPath(t),
          text: textAnchor,
          tag: t.tagName.toLowerCase(),
          inShadowRoot: !!(hit.raw.getRootNode && hit.raw.getRootNode() !== document),
          rowSelector: row === t ? '' : __cssPath(row),
          rowText: row === t ? '' : __norm(row.innerText).slice(0, 200),
          hashyClasses: cls.hashy,
          stableClasses: cls.stable,
          url: String(location.href)
        };
      };

      const onClick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        const hit = hitAt(ev.clientX, ev.clientY);
        if (!hit) { finish({ ok: false, reason: 'NO_ELEMENT_AT_POINT' }); return; }
        finish(buildResult(hit));
      };

      const onKey = (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          ev.stopImmediatePropagation();
          finish({ ok: false, cancelled: true });
        }
      };

      // 超时兜底：用户走开时不能把主进程的 IPC 调用永久挂住
      const timer = setTimeout(() => finish({ ok: false, reason: 'PICK_TIMEOUT' }), TIMEOUT);

      mask.addEventListener('mousemove', onMove);
      mask.addEventListener('click', onClick, true);
      mask.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); }, true);
      mask.addEventListener('mouseup', (ev) => { ev.preventDefault(); ev.stopPropagation(); }, true);
      window.addEventListener('keydown', onKey, true);

      document.documentElement.appendChild(mask);
      document.documentElement.appendChild(outline);
      document.documentElement.appendChild(banner);
    });
  })()`
}
