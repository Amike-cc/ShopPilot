/**
 * 页面上下文执行器（通过 <script> 注入，运行在页面 world）
 *
 * 两个职责：
 *  1. req/res 通道（主通道）：content script 经此重放罗盘接口。页面世界的 window.fetch
 *     就是罗盘自己的签名包装器（自动附加 a_bogus/msToken），重放请求天然带签名；
 *     同一通道也承载剪贴板写入（绕开罗盘对 clipboard.writeText 的反复制替换）。
 *  2. 响应拦截（补充通道）：hook 页面的 fetch + XHR，把页面自己发出的
 *       · product_rank/video_bring_good   （榜单）
 *       · compete_product_detail/flow_more（竞品详情）
 *     响应体 postMessage 给内容脚本。页面 bundle 可能保存原生引用绕过 hook，
 *     所以这条通道只作补充，不承担主流程。
 */
(function () {
  'use strict';
  // 只有「桥已装好」才跳过；内联注入半途失败时本文件仍要接手，不能只看 __lpFetcher
  if (window.__lpFetcher && document.documentElement.dataset.lpHook === '1') return;
  window.__lpFetcher = 'v2';
  // 抢先绑定原生剪贴板写入（罗盘稍后会把 clipboard.writeText 换成自己的签名函数）
  try {
    window.__lpNativeClipWrite = (navigator.clipboard && navigator.clipboard.writeText)
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : null;
  } catch (e0) { window.__lpNativeClipWrite = null; }

  function post(payload) {
    payload.__lp = 'data';
    try { window.postMessage(payload, '*'); } catch (err) {}
  }

  /* ---- ① 主动请求通道（原样保留） ---- */
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__lp !== 'req') return;

    const reply = function (payload) {
      payload.__lp = 'res';
      payload.id = d.id;
      try { window.postMessage(payload, '*'); } catch (err) {}
    };
    if (d.clipboard) {
      // 剪贴板写入走页面世界，两道保险：原生 writeText 引用 + execCommand 经典路径
      const text = String(d.clipboard);
      const done = function (ok, err) { ok ? reply({ ok: true }) : reply({ ok: false, error: String(err || '') }); };
      const viaExec = function () {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
          ta.setAttribute('readonly', '');
          document.body.appendChild(ta);
          ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
          let ok = false;
          try { ok = document.execCommand('copy'); } catch (e) {}
          ta.remove();
          if (ok) done(true); else done(false, 'page execCommand 失败');
        } catch (e) { done(false, String((e && e.message) || e)); }
      };
      const write = window.__lpNativeClipWrite ||
        ((navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText.bind(navigator.clipboard) : null);
      if (write) {
        write(text).then(function () { done(true); }).catch(function () { viaExec(); });
      } else viaExec();
      return;
    }

    try {
      const init = { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } };
      if (d.opts) {
        if (d.opts.method) init.method = d.opts.method;
        if (d.opts.body) { init.body = d.opts.body; init.headers['content-type'] = 'application/json'; }
      }
      fetch(d.url, init).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        reply({ ok: true, data: j });
      }).catch(function (err) {
        reply({ ok: false, error: String((err && err.message) || err) });
      });
    } catch (err) {
      reply({ ok: false, error: String(err) });
    }
  });

  /* ---- ② 响应拦截（主通道） ---- */
  function pickKind(url) {
    const s = String(url || '');
    if (s.indexOf('/compass_api/shop/product/product_rank/video_bring_good') >= 0) return 'rank';
    if (s.indexOf('/compass_api/shop/product/compete_product_detail/flow_source/flow_more') >= 0) return 'detail';
    return '';
  }

  // fetch：包装后原样转发，命中目标接口就把响应体推给内容脚本
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input) {
      const kind = pickKind((input && input.url) || input);
      const p = origFetch.apply(this, arguments);
      if (kind) {
        p.then(function (r) {
          try {
            r.clone().json().then(function (j) { post({ kind: kind, data: j }); }).catch(function () {});
          } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  // XHR：罗盘部分模块走 XHR
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && XHR.prototype.open) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__lpKind = pickKind(url); } catch (e) { this.__lpKind = ''; }
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const self = this;
      if (self.__lpKind) {
        self.addEventListener('load', function () {
          try {
            const j = JSON.parse(self.responseText);
            if (j) post({ kind: self.__lpKind, data: j });
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }
  // 与 content.js 内联注入同一份逻辑的文件版（src 兜底路径）：装完 hook 打标记
  document.documentElement.dataset.lpHook = '1';
})();
