/**
 * 页面上下文执行器（通过 <script> 注入，运行在页面 world）
 * 作用：用页面自己的 fetch 调用罗盘接口，规避隔离世界的风控差异
 * 结果通过 window.postMessage 回传给 content script
 */
(function () {
  'use strict';
  if (window.__lpFetcher) return;
  window.__lpFetcher = 'v1';

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__lp !== 'req') return;

    const reply = function (payload) {
      payload.__lp = 'res';
      payload.id = d.id;
      try { window.postMessage(payload, '*'); } catch (err) {}
    };

    try {
      fetch(d.url, {
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*' }
      }).then(function (r) {
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
})();
