/**
 * content script
 * 按 URL 分流两种模式：
 *   rank   —— /shop/chance/product-rank         商品榜单 → 每行视频下方注入按钮
 *   detail —— /shop/chance/rank-product/detail  竞品详情 → 视频分析表格上方注入批量按钮
 *
 * 数据来源（v2.3.0，2026-11-08）：fetch.js 在页面世界 hook fetch/XHR，把罗盘页面
 * 自己发出的接口响应推过来（__lp:'data'）。不再自己拼参数调接口——罗盘现在强校验
 * a_bogus/msToken 签名（页面请求库自动附加），裸 fetch 只能拿到「成功但空」。
 */
(function () {
  'use strict';

  if (window.__lpLoaded) return;
  window.__lpLoaded = true;

  // 第一优先级：document_start 就把响应拦截装进页面世界，赶在页面首批请求之前
  injectFetcher();

  /* ---------------- 状态 ---------------- */
  let mode = '';
  let rankBooted = false;
  let detailBooted = false;
  let detailPid = '';

  // rank
  const items = new Map();       // videoId -> item（页面推送逐页累积，只增不删）
  let loading = false;
  let lastError = '';

  // detail
  let detailVideos = [];
  let detailMeta = { begin: '', end: '', done: false, error: '' };
  let detailLoading = false;

  /* ---------------- 通用工具 ---------------- */

  function urlParam(name) {
    try {
      return new URL(location.href).searchParams.get(name) || '';
    } catch (e) {
      return '';
    }
  }

  function sanitize(s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').replace(/\s+/g, ' ').trim();
  }

  function flash(btn, text) {
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = text;
    clearTimeout(btn.__lpTimer);
    btn.__lpTimer = setTimeout(function () {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }, 1800);
  }

  /** 抓取失败的可见提示。此前失败是静默的——用户只看到"没有按钮"，不知道为什么。 */
  function renderErrorChip(text) {
    try {
      let chip = document.querySelector('.lp-errchip');
      if (!text) { if (chip) chip.remove(); return; }
      if (!chip) {
        chip = document.createElement('div');
        chip.className = 'lp-errchip';
        (document.body || document.documentElement).appendChild(chip);
      }
      chip.textContent = String(text).slice(0, 200);
    } catch (e) {}
  }

  function copyText(text, cb) {
    function recordCopyErr(msg) {
      // 保留首因：fallback 会覆盖 page-clipboard 的错误，排查时要看第一条
      if (copyText.__recorded) return;
      copyText.__recorded = true;
      try { chrome.storage.local.set({ lpCopyErr: String(msg).slice(0, 140) }); } catch (e) {}
    }
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { recordCopyErr('exec-throw: ' + String((e && e.message) || e)); }
      if (!ok) recordCopyErr('exec-false focus=' + document.hasFocus());
      ta.remove();
      cb && cb(ok);
    }
    // 优先页面世界剪贴板（罗盘 origin 已被应用授权 clipboard-sanitized-write）
    const bridgeId = 'c' + Date.now() + Math.random().toString(36).slice(2, 6);
    let bridged = false;
    function onBridge(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__lp !== 'res' || d.id !== bridgeId) return;
      bridged = true;
      window.removeEventListener('message', onBridge);
      if (d.ok) { cb && cb(true); return; }
      recordCopyErr('page-clipboard: ' + String(d.error || '').slice(0, 80));
      fallback();
    }
    window.addEventListener('message', onBridge);
    window.postMessage({ __lp: 'req', id: bridgeId, clipboard: text }, '*');
    setTimeout(function () {
      if (bridged) return;
      window.removeEventListener('message', onBridge);
      recordCopyErr('page-clipboard-timeout');
      fallback();
    }, 3000);
  }

  /* ---------------- 页面世界桥（fetch.js 注入） ----------------
   * v2.7.0 主通道：经页面桥**主动请求**罗盘接口。2026-11-09 实测：
   * 页面世界的 window.fetch 就是罗盘自己的签名包装器（rG，自动附加 a_bogus/msToken），
   * 桥转发的请求天然带签名——榜单/详情/换链三个接口重放全部拿到完整数据。
   * 旧「hook 推送」架构依赖 document_start 时序竞态（页面 bundle 抢先捕获原生引用就全盲），
   * 时灵时不灵；推送通道保留作补充（页面翻页/筛选时的新数据自动跟随）。 */
  const diag = { lastError: '', at: 0, note: '' };

  /** 分页请求间的小停顿，减轻服务端压力 */
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function persistDiag() {
    try {
      diag.at = Date.now();
      chrome.storage.local.set({ lpDiagCs: { lastError: diag.lastError, note: String(diag.note || ''), at: diag.at } });
    } catch (e) {}
  }

  function noteError(message) {
    diag.lastError = String(message || '');
    persistDiag();
  }

  /**
   * 页面世界引导（inline 同步注入源码）：
   * 装响应拦截 hook 必须赶在页面 bundle 之前——<script src> 是**异步加载**的，
   * 页面代码可能抢先捕获原生 fetch/XHR 引用，hook 就永远拦不到（v2.3.1 实测踩坑：
   * __lpFetcher 有值但 hook 没生效，按钮永远不出现）。
   * 用 function.toString() 拼成内联脚本，document_start 同步执行。
   * 若页面 CSP 拦内联 → 退回 src 注入（真 Chrome 走这条路）。
   */
  function lpPageWorldBootstrap() {
    try {
      if (document.documentElement.dataset.lpHook === '1') return;
      window.__lpFetcher = 'v2';
      // 抢先绑定原生剪贴板写入：罗盘 bundle 稍后会把 clipboard.writeText 换成自己的
      // 签名函数（实测经它写入必抛 "reading 'url'"）——document_start 时它还没动手，
      // 这里 bind 住的是真原生引用，桥写入走它即可绕开反复制。
      try {
        window.__lpNativeClipWrite = (navigator.clipboard && navigator.clipboard.writeText)
          ? navigator.clipboard.writeText.bind(navigator.clipboard)
          : null;
      } catch (e0) { window.__lpNativeClipWrite = null; }
      function post(payload) {
        payload.__lp = 'data';
        try { window.postMessage(payload, '*'); } catch (err) {}
      }
      function pickKind(url) {
        const s = String(url || '');
        if (s.indexOf('/compass_api/shop/product/product_rank/video_bring_good') >= 0) return 'rank';
        if (s.indexOf('/compass_api/shop/product/compete_product_detail/flow_source/flow_more') >= 0) return 'detail';
        return '';
      }
      // 主动请求通道 + 剪贴板写入通道
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
          // 剪贴板写入走页面世界，两道保险：
          // ① 原生 writeText 引用（document_start 抢先绑定，绕开罗盘的反复制 hook）；
          // ② execCommand 经典路径（罗盘没 hook 它；真实用户点击自带 activation + 焦点）。
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
      function safeWrap(obj, prop, wrapper) {
        try { obj[prop] = wrapper; return; } catch (e) {}
        try { Object.defineProperty(obj, prop, { value: wrapper, writable: true, configurable: true }); } catch (e2) {}
      }
      const origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        safeWrap(window, 'fetch', function (input) {
          const kind = pickKind((input && input.url) || input);
          const p = origFetch.apply(this, arguments);
          if (kind) {
            p.then(function (r) {
              try { r.clone().json().then(function (j) { post({ kind: kind, data: j }); }).catch(function () {}); } catch (e) {}
            }).catch(function () {});
          }
          return p;
        });
      }
      const XHR = window.XMLHttpRequest;
      if (XHR && XHR.prototype && XHR.prototype.open) {
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        safeWrap(XHR.prototype, 'open', function (method, url) {
          try { this.__lpKind = pickKind(url); } catch (e) { this.__lpKind = ''; }
          return origOpen.apply(this, arguments);
        });
        safeWrap(XHR.prototype, 'send', function () {
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
        });
      }
      document.documentElement.dataset.lpHook = '1';
    } catch (e) {
      try { document.documentElement.dataset.lpHookErr = String((e && e.message) || e).slice(0, 100); } catch (e2) {}
    }
  }

  function injectFetcher() {
    return new Promise(function (resolve) {
      try {
        // 内联同步注入：执行完立刻能查标记
        const s = document.createElement('script');
        s.textContent = '(' + lpPageWorldBootstrap.toString() + ')();';
        (document.head || document.documentElement).appendChild(s);
        if (document.documentElement.dataset.lpHook === '1') {
          resolve({ ok: true, reason: 'inline' });
          return;
        }
        // 内联被页面 CSP 拦 → 退回 src 注入
        if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.getURL !== 'function') {
          resolve({ ok: false, reason: 'inline 被拦且 runtime.getURL 不可用' });
          return;
        }
        const s2 = document.createElement('script');
        s2.src = chrome.runtime.getURL('fetch.js');
        s2.onload = function () {
          s2.remove();
          setTimeout(function () {
            resolve({ ok: document.documentElement.dataset.lpHook === '1', reason: 'src' });
          }, 300);
        };
        s2.onerror = function () {
          s2.remove();
          resolve({ ok: false, reason: 'inline 与 src 注入均失败' });
        };
        (document.head || document.documentElement).appendChild(s2);
      } catch (e) {
        resolve({ ok: false, reason: String((e && e.message) || e) });
      }
    });
  }

  /** 经页面世界桥原样重放一条「带签名的完整 URL」：URL 不变 = 签名不变 */
  function pageFetch(url, opts) {
    return new Promise(function (resolve, reject) {
      const id = 'f' + Date.now() + Math.random().toString(36).slice(2, 6);
      let done = false;

      function onMsg(e) {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.__lp !== 'res' || d.id !== id) return;
        done = true;
        window.removeEventListener('message', onMsg);
        d.ok ? resolve(d.data) : reject(new Error(d.error || 'request failed'));
      }

      window.addEventListener('message', onMsg);
      window.postMessage({ __lp: 'req', id: id, url: url, opts: opts || null }, '*');

      setTimeout(function () {
        if (done) return;
        window.removeEventListener('message', onMsg);
        reject(new Error('请求超时'));
      }, 20000);
    });
  }

  /* ---------------- 链接解析与下载（v2.5.0） ---------------- */
  const ENTITY_API = '/compass_api/shop/common/market/entity_by_ref';
  const RESOLVE_CONCURRENCY = 3;

  /**
   * video_ref → { videoId, playUrl }（POST entity_by_ref）。
   * 走页面桥：罗盘自己的 fetch 包装器会在调用时自动附加 a_bogus/msToken 签名。
   * 注意 remaining_cnt：接口有配额，解析失败要如实报，不要静默重试打光配额。
   */
  async function resolveVideoEntity(ref) {
    const json = await pageFetch(`${location.origin}${ENTITY_API}`, {
      method: 'POST',
      body: JSON.stringify({ ref: String(ref || ''), access_type: 1, _lid: String(Date.now()) })
    });
    if (!json || json.st !== 0) throw new Error((json && json.msg) || ('st=' + (json && json.st)));
    const video = (json.entity && json.entity.video) || {};
    const videoId = String(video.video_id || '');
    const playUrl = String(video.play_url || '');
    if (!videoId && !playUrl) throw new Error('换链结果为空');
    return { videoId: videoId, playUrl: playUrl, remainingCnt: json.remaining_cnt };
  }

  /** 并发解析一批视频的真实链接；onProgress(done, total) 用于按钮进度 */
  async function resolveVideoLinks(list, onProgress) {
    const valid = (list || []).filter(function (it) { return it && it.ref; });
    const results = new Array(valid.length);
    let idx = 0;
    let done = 0;
    let failed = 0;
    async function worker() {
      while (idx < valid.length) {
        const i = idx++;
        try {
          results[i] = await resolveVideoEntity(valid[i].ref);
          if (results[i].videoId) refCache.set(valid[i].ref, results[i].videoId);
        } catch (e) {
          results[i] = { error: String((e && e.message) || e) };
          failed++;
        }
        done++;
        if (onProgress) onProgress(done, valid.length, failed);
      }
    }
    const workers = [];
    for (let w = 0; w < Math.min(RESOLVE_CONCURRENCY, valid.length); w++) workers.push(worker());
    await Promise.all(workers);
    return { results: results, valid: valid, failed: failed };
  }

  function buildName(it) {
    const seq = it.rank
      ? String(it.rank).padStart(3, '0')
      : (it.seq ? String(it.seq).padStart(3, '0') : '');
    const parts = [
      seq,
      sanitize(it.author).slice(0, 16),
      sanitize(it.title).slice(0, 30),
      it.videoId
    ].filter(Boolean);
    return `${it.folder || '罗盘带货视频'}/${parts.join('_')}.mp4`;
  }

  async function downloadVideos(list, btn) {
    const valid = (list || []).filter(function (it) { return it && it.videoId && (it.playUrl || it.ref); });
    if (!valid.length) { flash(btn, '无可下载'); return; }
    flash(btn, '解析链接…');
    const resolved = await resolveVideoLinks(valid, function (done, total) {
      flash(btn, `解析链接 ${done}/${total}…`);
    });
    const jobs = [];
    for (let i = 0; i < resolved.valid.length; i++) {
      const it = resolved.valid[i];
      const r = resolved.results[i];
      if (r && r.playUrl) jobs.push({ url: r.playUrl, filename: buildName(it) });
    }
    if (!jobs.length) { flash(btn, `解析失败（${resolved.failed}）`); return; }
    flash(btn, `提交 ${jobs.length} 个…`);
    chrome.runtime.sendMessage({ type: 'LP_DOWNLOAD', jobs: jobs }, function (resp) {
      void chrome.runtime.lastError;
      flash(btn, resp && resp.ok ? `已提交 ${jobs.length} 个` : '提交失败');
    });
  }

  /* ================= 模式一：商品榜单 ================= */
  /**
   * 数据来源（2026-11-08 v2.3.0）：不再自己拼参数调接口。
   * 罗盘现在强校验 a_bogus/msToken 签名（由页面请求库在发请求时自动附加），
   * 插件裸 fetch 只会拿到「st=0 但空数据」或风控拒绝——这就是「获取不到链接」的根因。
   * 现在改为拦截页面自己的请求响应（fetch.js 推送 __lp:'data'）：
   * 页面翻页、筛选、搜索都自动跟随，签名天然正确。
   */
  function parseRank(json) {
    const out = [];
    const list = (json && json.data && json.data.data_result) || [];
    for (const prod of list) {
      const p = prod.product_info || {};
      const vids = prod.video_list || [];
      for (const v of vids) {
        // v2.5.0：罗盘改版后 video_id / video_play_url 全空，只发 video_ref 引用键。
        // 条目以 video_ref 兜底保住按钮渲染；真实链接在复制/下载时用 ref 解析（entity_by_ref）。
        const id = String(v.video_id || v.video_ref || '');
        if (!id) continue;
        out.push({
          videoId: id,
          ref: String(v.video_ref || ''),
          playUrl: v.video_play_url || '',
          title: String(v.video_name || '').replace(/\s+/g, ' ').trim(),
          author: v.author_name || '',
          publishTs: v.publish_ts || 0,
          productId: String(p.id || ''),
          productName: p.name || '',
          rank: p.rank || 0,
          price: p.price_bin || ''
        });
      }
    }
    return out;
  }

  /* ---------------- 主动拉取（v2.7.0 主通道） ----------------
   * 经页面桥重放接口 = 调用罗盘自己的签名包装器，签名自动附加（2026-11-09 实测三接口全通）。
   * 不再依赖 hook 时序竞态；页面推送通道保留作补充。 */
  const RANK_API = '/compass_api/shop/product/product_rank/video_bring_good';
  const DETAIL_API = '/compass_api/shop/product/compete_product_detail/flow_source/flow_more';
  const RANK_PAGE_SIZE = 10;     // 榜单接口把 page_size 卡在 10
  const RANK_MAX_PAGE = 20;      // 10 × 20 = 200 条
  const DETAIL_PAGE_SIZE = 10;   // 改版后实测 10 可用（100 未验证，不用赌）
  const DETAIL_MAX_PAGE = 50;    // 上限 500 条
  const DEFAULT_CFG = {
    industry_id: '4',
    category_id: '1000003282,1000009114',
    brand_type: '-1',
    price_bin: '不限',
    date_type: '21'
  };

  /** 近 7 天（截止昨天）——罗盘默认区间 */
  function dateRange() {
    const end = new Date();
    end.setDate(end.getDate() - 1);
    const begin = new Date(end);
    begin.setDate(begin.getDate() - 6);
    const f = function (d) {
      const p = function (n) { return n < 10 ? '0' + n : '' + n; };
      return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} 00:00:00`;
    };
    return { begin_date: f(begin), end_date: f(end) };
  }

  /** 页面头部展示的日期区间（如 2026/11/02 - 2026/11/08）优先，保证与用户所见一致 */
  function readPageDateRange() {
    try {
      const m = (document.body.innerText || '').match(/(\d{4}\/\d{2}\/\d{2})\s*-\s*(\d{4}\/\d{2}\/\d{2})/);
      if (m) return { begin_date: m[1] + ' 00:00:00', end_date: m[2] + ' 00:00:00' };
    } catch (e) {}
    return null;
  }

  /** 详情页 URL 自带的 date_value=起始秒,结束秒 */
  function urlDateRange() {
    const raw = urlParam('date_value');
    if (!raw) return null;
    const parts = raw.split(',');
    if (parts.length < 2) return null;
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    if (!a || !b) return null;
    const f = function (ts) {
      const d = new Date(ts * 1000);
      const p = function (n) { return n < 10 ? '0' + n : '' + n; };
      return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} 00:00:00`;
    };
    return { begin_date: f(a), end_date: f(b) };
  }

  async function fetchRankPage(no, params) {
    const qs = new URLSearchParams(Object.assign({}, params, {
      page_no: String(no),
      page_size: String(RANK_PAGE_SIZE),
      rank_data_type: '1',
      activity_id: ''
    })).toString();
    const json = await pageFetch(`${location.origin}${RANK_API}?${qs}`);
    if (!json || json.st !== 0) throw new Error((json && json.msg) || ('st=' + (json && json.st)));
    return parseRank(json);
  }

  async function loadRankAll() {
    if (loading) return;
    loading = true;
    lastError = '';
    try {
      const ready = await injectFetcher();
      if (!ready.ok) throw new Error('页面桥初始化失败（' + ready.reason + '）');
      const dr = readPageDateRange() || dateRange();
      const kw = readPageKeyword();
      const params = Object.assign({}, DEFAULT_CFG, dr, { search_info: kw || '' });
      let emptyStreak = 0;
      for (let p = 1; p <= RANK_MAX_PAGE; p++) {
        let rows = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { rows = await fetchRankPage(p, params); break; }
          catch (err) { lastError = String((err && err.message) || err); if (!attempt) await sleep(1200); }
        }
        if (rows === null) break;
        applyRankRows(rows);
        emptyStreak = rows.length ? 0 : emptyStreak + 1;
        if (emptyStreak >= 2) break;          // 连续两页没有有效视频行，后面基本也不会有
        if (rows.length < RANK_PAGE_SIZE) break;
        await sleep(300);
      }
    } finally {
      loading = false;
    }
    if (!items.size) {
      renderErrorChip('罗盘下载：抓取失败' + (lastError ? '：' + lastError : '') + '（请确认已登录罗盘；点插件弹窗「重新抓取」重试）');
    } else {
      renderErrorChip(null);
    }
  }

  async function fetchDetailPage(pid, dr, pageNo) {
    const q = new URLSearchParams({
      product_id: pid,
      saleType: '0',
      source_entrance: 'video',
      date_type: urlParam('date_type') || '21',
      begin_date: dr.begin_date,
      end_date: dr.end_date,
      activity_id: urlParam('activity_id') || '',
      index_selected: 'pay_amt,pay_ucnt,dh_product_click_ratio_uv,pay_cnt,pay_combo_cnt',
      page_size: String(DETAIL_PAGE_SIZE),
      page_no: String(pageNo),
      sort_field: urlParam('sort_field') || 'pay_amt',
      is_asc: urlParam('is_asc') || 'false'
    });
    const json = await pageFetch(`${location.origin}${DETAIL_API}?${q.toString()}`);
    if (!json || json.st !== 0) throw new Error((json && json.msg) || ('st=' + (json && json.st)));
    return json;
  }

  /** 数据入库（主动拉取与页面推送共用）→ 只增不删，保证按钮不中途消失 */
  function applyRankRows(rows) {
    let added = 0;
    for (const it of rows || []) {
      if (!items.has(it.videoId)) added++;
      items.set(it.videoId, it);
    }
    if (added) {
      lastError = '';
      renderErrorChip(null);
      injectRowButtons();
    }
    return added;
  }

  /** ref → 抖音 videoId 的按需缓存：复制/下载解析成功后写入，后续点击直接命中 */
  const refCache = new Map();

  function groups() {
    const map = new Map();
    for (const it of items.values()) {
      const key = it.productId || ('single_' + it.videoId);
      let g = map.get(key);
      if (!g) {
        g = { pid: key, rank: it.rank || 0, productName: it.productName || '', videos: [] };
        map.set(key, g);
      }
      g.videos.push(it);
    }
    const arr = Array.from(map.values());
    arr.sort(function (a, b) { return (a.rank || 9999) - (b.rank || 9999); });
    return arr;
  }

  function injectRowButtons() {
    const gs = groups();
    if (!gs.length) return;

    const rows = document.querySelectorAll('tr.aurora-table-row');
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i];

      // 必须是「带货短视频」单元格：里面有 2 张以上缩略图
      let cell = null;
      let best = 0;
      const tds = tr.querySelectorAll('td');
      for (let k = 0; k < tds.length; k++) {
        const n = tds[k].querySelectorAll('img').length;
        if (n >= 2 && n > best) { best = n; cell = tds[k]; }
      }
      if (!cell) continue;

      const text = tr.innerText || '';
      const g = gs.find(function (x) {
        return x.productName && text.indexOf(x.productName) >= 0;
      }) || gs.find(function (x) {
        return x.productName && x.productName.length > 10 &&
          text.indexOf(x.productName.slice(0, 10)) >= 0;
      });
      if (!g) continue;

      // 已有按钮：商品对得上就留着，对不上（搜索结果换行）就重挂，避免复制到错的商品
      const old = tr.querySelector('.lp-rowbtns');
      if (old) {
        if (old.dataset.gpid === g.pid) continue;
        old.remove();
      }

      const box = document.createElement('div');
      box.className = 'lp-rowbtns';
      box.dataset.gpid = g.pid;

      const cBtn = document.createElement('button');
      cBtn.type = 'button';
      cBtn.dataset.rowact = 'copy';
      cBtn.dataset.gpid = g.pid;
      cBtn.textContent = '复制链接';

      const dBtn = document.createElement('button');
      dBtn.type = 'button';
      dBtn.className = 'lp-rowdl';
      dBtn.dataset.rowact = 'dl';
      dBtn.dataset.gpid = g.pid;
      dBtn.textContent = '批量下载';

      box.appendChild(cBtn);
      box.appendChild(dBtn);
      cell.appendChild(box);
    }
  }

  async function copyProductLinks(g, btn) {
    const videos = g.videos.filter(function (v) { return v && v.videoId && (v.ref || v.playUrl); });
    if (!videos.length) { flash(btn, '无可复制'); return; }

    // 优先走预解析缓存：同步取值，复制发生在用户手势窗口内（最稳）
    const cachedLines = [];
    const missRefs = [];
    for (const v of videos) {
      if (!v.ref) { cachedLines.push('https://www.douyin.com/video/' + v.videoId); continue; }
      const id = refCache.get(v.ref);
      if (id) cachedLines.push('https://www.douyin.com/video/' + id);
      else missRefs.push(v);
    }
    if (!missRefs.length) {
      try { chrome.storage.local.set({ lpLastCopy: cachedLines.join('\n') }); } catch (e) {}
      copyText(cachedLines.join('\n'), function (ok) {
        flash(btn, ok ? `已复制 ${cachedLines.length} 条` : '复制失败（页面需保持前台焦点）');
      });
      return;
    }

    // 缓存未就绪（点得太快）：现解析，失败如实报
    flash(btn, '解析链接…');
    const resolved = await resolveVideoLinks(missRefs.concat([]), function (done, total) {
      flash(btn, `解析链接 ${done}/${total}…`);
    });
    const lines = cachedLines.slice();
    for (let i = 0; i < resolved.valid.length; i++) {
      const v = resolved.valid[i];
      const r = resolved.results[i];
      if (r && r.videoId) lines.push('https://www.douyin.com/video/' + r.videoId);
    }
    if (!lines.length) { flash(btn, `解析失败（${resolved.failed}）`); return; }
    try { chrome.storage.local.set({ lpLastCopy: lines.join('\n') }); } catch (e) {}
    copyText(lines.join('\n'), function (ok) {
      flash(btn, ok ? `已复制 ${lines.length} 条` + (resolved.failed ? `（${resolved.failed} 条失败）` : '') : '复制失败（页面需保持前台焦点）');
    });
  }

  /* ---------------- 搜索框诊断（仅榜单） ----------------
   * 搜索/筛选由罗盘页面自己重新请求，fetch.js 拦到新响应后数据自动跟随；
   * 这里只剩诊断属性（data-lp-kw），不再触发主动抓取。 */
  function readPageKeyword() {
    try {
      const inputs = document.querySelectorAll('input[placeholder]');
      for (let i = 0; i < inputs.length; i++) {
        const el = inputs[i];
        const ph = el.getAttribute('placeholder') || '';
        if (ph.indexOf('可搜索所选条件') >= 0) return (el.value || '').trim();
      }
    } catch (e) {}
    return null;
  }

  function watchPageKeyword() {
    setInterval(function () {
      if (mode !== 'rank') return;
      try {
        document.documentElement.setAttribute('data-lp-kw',
          'kw=' + (readPageKeyword() || '') + ';loading=' + loading + ';items=' + items.size);
      } catch (e) {}
    }, 1500);
  }

  /** 榜单兜底提示：主动拉取完成后仍无数据才显示（正常情况下按钮会先出现） */
  function startRankHintTimer() {
    setTimeout(function () {
      if (mode === 'rank' && items.size === 0 && !loading) {
        renderErrorChip('罗盘下载：未获取到榜单数据' + (lastError ? '：' + lastError : '') + '。请确认已登录罗盘，或点插件弹窗「重新抓取」重试');
      }
    }, 12000);
  }

  /* ================= 模式二：竞品详情 · 视频分析 ================= */
  function parseDetailItem(it, seq) {
    const b = (it && it.base_info) || {};
    const v = b.video_base_info || {};
    const a = v.author_info || {};
    // v2.7.0：详情接口改版后 video_id / video_url 全空（video_url 键整个消失），只有 video_ref
    // 引用键——以 ref 兜底，真实链接在复制/下载时解析（entity_by_ref，页面桥自动签名）。
    const id = String(v.video_id || v.video_ref || '');
    if (!id) return null;
    return {
      videoId: id,
      ref: String(v.video_ref || ''),
      playUrl: String(v.video_url || ''),
      title: String(v.video_title || '').replace(/\s+/g, ' ').trim(),
      author: a.author_nick_name || '',
      publishTs: v.publish_time || 0,
      seq: seq,
      folder: '罗盘竞品视频'
    };
  }

  /**
   * 竞品详情的数据来源（v2.3.0）：与榜单一样走页面响应推送（fetch.js 拦截 flow_more）。
   * 用户切筛选/翻页时罗盘自己会重发请求（带完整签名），推送自动到达，这里不再主动拉取。
   */
  function applyDetailRows(json) {
    const arr = Array.isArray(json)
      ? json
      : ((json && json.data && json.data.data_result) || (Array.isArray(json && json.data) ? json.data : []));
    const base = detailVideos.length;
    let added = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = parseDetailItem(arr[i], base + i + 1);
      if (v && !detailVideos.some(function (x) { return x.videoId === v.videoId; })) {
        detailVideos.push(v);
        added++;
      }
    }
    if (added) {
      detailMeta.error = '';
      detailMeta.done = true;
      renderDetailBar();
      injectDetailRowButtons();
      renderErrorChip(null);
    }
    return added;
  }

  /**
   * 进入竞品详情页（v2.7.0）：重置 UI 后**主动**经页面桥分页拉取 flow_more
   * （签名由页面世界的罗盘包装器自动附加，实测 st=0 + 10 行）。页面推送仍作为补充来源。
   */
  function loadDetail() {
    detailLoading = true;
    detailMeta = { begin: '', end: '', done: false, error: '' };
    detailVideos = [];
    clearDetailRowButtons();
    renderDetailBar();

    (async function () {
      const pid = urlParam('product_id') || '';
      try {
        if (!pid) throw new Error('URL 缺少 product_id');
        const dr = urlDateRange() || readPageDateRange() || dateRange();
        detailMeta.begin = dr.begin_date;
        detailMeta.end = dr.end_date;
        const ready = await injectFetcher();
        if (!ready.ok) throw new Error('页面桥初始化失败（' + ready.reason + '）');

        for (let p = 1; p <= DETAIL_MAX_PAGE; p++) {
          const json = await fetchDetailPage(pid, dr, p);
          const added = applyDetailRows(json);
          renderDetailBar();
          if (!added) break;                 // 空页=到底
          if (added < DETAIL_PAGE_SIZE) break;
          await sleep(300);
        }
        detailMeta.error = '';
      } catch (err) {
        detailMeta.error = String((err && err.message) || err);
      } finally {
        detailLoading = false;
        detailMeta.done = true;
        renderDetailBar();
        injectDetailRowButtons();
        if (!detailVideos.length) {
          renderErrorChip('罗盘下载：竞品视频抓取失败' + (detailMeta.error ? '：' + detailMeta.error : '') + '（打开「视频分析」标签页翻一页可重试）');
        } else {
          renderErrorChip(null);
        }
      }
    })();
  }

  /** 当前激活的主标签面板（商品概览 / 视频分析 …）的容器 */
  function activePanelHost() {
    const names = ['商品概览', '直播分析', '视频分析', '商品卡分析'];
    const tabs = document.querySelectorAll('[role=tab]');
    for (let i = 0; i < tabs.length; i++) {
      const txt = (tabs[i].textContent || '').trim();
      if (names.indexOf(txt) < 0) continue;
      const id = tabs[i].getAttribute('aria-controls');
      const panel = id ? document.getElementById(id) : null;
      if (panel && panel.parentElement) return { host: panel.parentElement, anchor: panel };
    }
    return null;
  }

  function findVideoTable() {
    const ths = document.querySelectorAll('th');
    for (let i = 0; i < ths.length; i++) {
      const t = (ths[i].innerText || '').replace(/\s+/g, '');
      if (t.indexOf('短视频信息') >= 0) {
        const tw = ths[i].closest('div.aurora-table');
        if (tw) return tw;
      }
    }
    return null;
  }

  /** 发布时间戳 -> 页面上的 "MM/DD HH:mm" */
  function fmtPub(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 用行内文本（标题 / 发布时间）反查是哪条视频 */
  function matchDetailRow(text) {
    if (!text) return null;
    let hit = detailVideos.find(function (v) {
      return v.title && v.title.length > 8 && text.indexOf(v.title) >= 0;
    });
    if (hit) return hit;
    hit = detailVideos.find(function (v) {
      return v.title && v.title.length > 12 && text.indexOf(v.title.slice(0, 12)) >= 0;
    });
    if (hit) return hit;
    return detailVideos.find(function (v) {
      const t = fmtPub(v.publishTs);
      return t && text.indexOf(t) >= 0;
    }) || null;
  }

  /** 清掉旧的逐行按钮（数据刷新后要重建） */
  function clearDetailRowButtons() {
    const old = document.querySelectorAll('.lp-drowbtns');
    for (let i = 0; i < old.length; i++) old[i].remove();
  }

  /** 表格每行注入「复制链接 / 下载」 */
  function injectDetailRowButtons() {
    if (!detailVideos.length || detailLoading) return;
    const rows = document.querySelectorAll('tr.aurora-table-row');
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i];
      if (tr.querySelector('.lp-drowbtns')) continue;
      const td = tr.querySelector('td');
      if (!td) continue;

      const v = matchDetailRow(tr.innerText || '');
      if (!v) continue;

      const box = document.createElement('div');
      box.className = 'lp-drowbtns';

      const cBtn = document.createElement('button');
      cBtn.type = 'button';
      cBtn.dataset.drowact = 'copy';
      cBtn.dataset.vid = v.videoId;
      cBtn.textContent = '复制链接';

      const dBtn = document.createElement('button');
      dBtn.type = 'button';
      dBtn.className = 'lp-drowdl';
      dBtn.dataset.drowact = 'dl';
      dBtn.dataset.vid = v.videoId;
      dBtn.textContent = '下载';

      box.appendChild(cBtn);
      box.appendChild(dBtn);
      td.appendChild(box);
    }
  }

  function fmtRange(begin, end) {
    function short(s) {
      const m = String(s || '').match(/(\d{4})\/(\d{2})\/(\d{2})/);
      return m ? `${m[2]}/${m[3]}` : '';
    }
    const b = short(begin);
    const e = short(end);
    if (b && e) return b === e ? b : `${b}–${e}`;
    return b || e || '';
  }

  /** 站点顶部固定导航的高度，吸顶时要把工具条压到它下面 */
  function stickyTop() {
    try {
      const els = document.querySelectorAll('div[class*=headerWrapper], header');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if ((s.position === 'fixed' || s.position === 'sticky') &&
            r.width > window.innerWidth * 0.8 &&
            r.top <= 1 && r.height > 20 && r.height < 200) {
          return Math.round(r.height);
        }
      }
    } catch (e) {}
    return 0;
  }

  function renderDetailBar() {
    const bar = document.querySelector('.lp-dbar');
    if (!bar) return;
    const info = bar.querySelector('.lp-dinfo');
    if (!info) return;

    bar.style.top = stickyTop() + 'px';

    const range = fmtRange(detailMeta.begin, detailMeta.end);
    let text;
    if (detailLoading) {
      text = `抓取中 · 已收 ${detailVideos.length} 条`;
    } else if (detailMeta.error) {
      text = `抓取失败：${detailMeta.error}`;
    } else if (!detailVideos.length) {
      text = detailMeta.done ? '未抓到视频' : '准备抓取…';
    } else {
      text = `${detailVideos.length} 条视频` + (range ? ` · ${range}` : '');
    }
    info.textContent = text;
    info.title = text;

    const copyBtn = bar.querySelector('[data-dact="copy"]');
    const dlBtn = bar.querySelector('[data-dact="dl"]');
    const dis = !detailVideos.length;
    if (copyBtn) copyBtn.disabled = dis;
    if (dlBtn) dlBtn.disabled = dis;

    if (detailLoading) {
      bar.classList.add('lp-dbar-busy');
    } else {
      bar.classList.remove('lp-dbar-busy');
    }
  }

  function injectDetailBar() {
    // 有视频分析表格 → 贴在表格上方；否则贴到当前标签面板顶部（任何标签页都能用）
    const tw = findVideoTable();
    let host = null;
    let anchor = null;

    if (tw && tw.parentElement) {
      host = tw.parentElement;
      anchor = tw;
    } else {
      const p = activePanelHost();
      if (!p) return;
      host = p.host;
      anchor = p.anchor;
    }

    let bar = document.querySelector('.lp-dbar');
    if (bar && bar.parentElement !== host) {
      bar.remove();
      bar = null;
    }

    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'lp-dbar';

      const info = document.createElement('span');
      info.className = 'lp-dinfo';
      info.textContent = '视频分析';

      const spacer = document.createElement('span');
      spacer.className = 'lp-dspacer';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'lp-dbtn';
      copyBtn.dataset.dact = 'copy';
      copyBtn.textContent = '批量复制';

      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'lp-dbtn lp-dbtn-main';
      dlBtn.dataset.dact = 'dl';
      dlBtn.textContent = '批量下载';

      bar.appendChild(info);
      bar.appendChild(spacer);
      bar.appendChild(copyBtn);
      bar.appendChild(dlBtn);
      try {
        host.insertBefore(bar, anchor && anchor.parentElement === host ? anchor : host.firstChild);
      } catch (e) {
        host.insertBefore(bar, host.firstChild);
      }
    }
    renderDetailBar();
  }

  async function detailCopy(btn) {
    if (!detailVideos.length) { flash(btn, '暂无数据'); return; }
    const hasRef = detailVideos.some(function (v) { return v.ref; });
    if (!hasRef) {
      // detail 响应结构未适配 ref 时，如实告知无法解析
      flash(btn, '暂无可用链接');
      return;
    }
    flash(btn, '解析链接…');
    const resolved = await resolveVideoLinks(detailVideos, function (done, total) {
      flash(btn, `解析链接 ${done}/${total}…`);
    });
    const lines = [];
    for (let i = 0; i < resolved.valid.length; i++) {
      const r = resolved.results[i];
      if (r && r.videoId) lines.push('https://www.douyin.com/video/' + r.videoId);
    }
    if (!lines.length) { flash(btn, `解析失败（${resolved.failed}）`); return; }
    try { chrome.storage.local.set({ lpLastCopy: lines.join('\n') }); } catch (e) {}
    copyText(lines.join('\n'), function (ok) {
      flash(btn, ok ? `已复制 ${lines.length} 条` + (resolved.failed ? `（${resolved.failed} 条失败）` : '') : '复制失败');
    });
  }

  /* ---------------- 点击（页面拦截冒泡，必须捕获阶段） ---------------- */
  window.addEventListener('click', function (ev) {
    const t = ev.target;
    if (!t || !t.closest) return;

    const dbtn = t.closest('[data-dact]');
    if (dbtn) {
      ev.preventDefault();
      ev.stopPropagation();
      if (dbtn.dataset.dact === 'copy') detailCopy(dbtn);
      else if (dbtn.dataset.dact === 'dl') downloadVideos(detailVideos, dbtn);
      return;
    }

    const rbtn = t.closest('[data-drowact]');
    if (rbtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const v = detailVideos.find(function (x) { return x.videoId === rbtn.dataset.vid; });
      if (!v) return;
      if (rbtn.dataset.drowact === 'copy') {
        copyText('https://www.douyin.com/video/' + v.videoId, function (ok) {
          flash(rbtn, ok ? '已复制' : '复制失败');
        });
      } else {
        downloadVideos([v], rbtn);
      }
      return;
    }

    const btn = t.closest('[data-rowact]');
    if (!btn) return;

    ev.preventDefault();
    ev.stopPropagation();

    const g = groups().find(function (x) { return x.pid === btn.dataset.gpid; });
    if (!g) return;
    if (btn.dataset.rowact === 'copy') copyProductLinks(g, btn);
    else if (btn.dataset.rowact === 'dl') downloadVideos(g.videos, btn);
  }, true);

  /* ---------------- 外部指令（popup / 后台下载分块） ---------------- */

  /**
   * ShopPilot / Electron 适配：没有 chrome.downloads，后台把视频流按 1MiB 分块
   * 发到这里，攒齐后用 Blob + <a download> 触发下载——最终由应用的下载管理器落盘。
   * 同时兼容原版 Chrome（原版走 chrome.downloads，不会发这两种消息）。
   */
  const lpChunks = {};   // id -> { parts: Uint8Array[], received: number }
  function lpB64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (!msg || !msg.type) return;
    if (msg.type === 'LP_CHUNK') {
      try {
        const buf = lpChunks[msg.id] || (lpChunks[msg.id] = { parts: [], received: 0 });
        const bytes = lpB64ToBytes(String(msg.b64 || ''));
        buf.parts[msg.seq] = bytes;
        buf.received += bytes.length;
        if (buf.received > 400 * 1024 * 1024) { delete lpChunks[msg.id]; reply({ ok: false, error: '文件超过 400MB 上限' }); return; }
        reply({ ok: true });
      } catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
      return;
    }
    if (msg.type === 'LP_SAVE') {
      try {
        const buf = lpChunks[msg.id];
        if (!buf) { reply({ ok: false, error: '分块缺失（页面可能刚刷新，请重试）' }); return; }
        delete lpChunks[msg.id];
        const parts = [];
        for (let i = 0; i < buf.parts.length; i++) { if (buf.parts[i]) parts.push(buf.parts[i]); }
        const blob = new Blob(parts, { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = String(msg.filename || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'video.mp4';
        a.style.display = 'none';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        // 10 分钟后再回收：大文件时应用的下载器可能还在读这个 blob
        setTimeout(function () {
          try { a.remove(); } catch (e) {}
          try { URL.revokeObjectURL(url); } catch (e) {}
        }, 10 * 60 * 1000);
        reply({ ok: true });
      } catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
      return;
    }
    if (msg.type === 'LP_RELOAD') {
      // v2.3.0：数据跟随页面自身请求，所以「重新抓取」= 刷新页面（页面会重新发带签名的请求）
      location.reload();
      reply({ ok: true });
    } else if (msg.type === 'LP_STATS') {
      if (mode === 'detail') {
        reply({
          ok: true,
          mode: 'detail',
          products: detailVideos.length ? 1 : 0,
          videos: detailVideos.length,
          error: detailMeta.error
        });
      } else {
        const gs = groups();
        const vids = gs.reduce(function (n, g) { return n + g.videos.length; }, 0);
        reply({ ok: true, mode: 'rank', products: gs.length, videos: vids, error: lastError });
      }
    }
  });

  /* ---------------- 页面响应推送（fetch.js 主通道，v2.3.0） ----------------
   * 罗盘接口强校验 a_bogus/msToken 签名，插件自己发请求拿不到数据（「获取不到链接」根因）；
   * fetch.js 在页面世界 hook fetch/XHR，把页面自己的请求响应原样推过来——
   * 签名、分页、筛选全部天然正确。 */
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__lp !== 'data' || !d.kind) return;
    try {
      if (d.kind === 'rank') {
        applyRankRows(parseRank(d.data));
      } else if (d.kind === 'detail') {
        applyDetailRows(d.data);
      }
    } catch (err) {}
  });

  /* ---------------- 模式调度 ---------------- */
  function detectMode() {
    const p = location.pathname;
    if (p.indexOf('/chance/rank-product/detail') >= 0) return 'detail';
    if (p.indexOf('/chance/product-rank') >= 0) return 'rank';
    return '';
  }

  function startRank() {
    loadRankAll();          // v2.7.0：主动经页面桥拉取（不再等页面推送）
    watchPageKeyword();
    startRankHintTimer();
  }

  function startDetail() {
    const pid = urlParam('product_id') || '';
    if (detailBooted && pid === detailPid) return;
    detailBooted = true;
    detailPid = pid;
    loadDetail();
  }

  function tick() {
    const m = detectMode();
    if (m !== mode) {
      mode = m;
      if (m === 'rank' && !rankBooted) { rankBooted = true; startRank(); }
      if (m === 'detail') startDetail();
    }

    if (mode === 'rank') {
      try { injectRowButtons(); } catch (e) {}
    } else if (mode === 'detail') {
      // 站内切换到别的竞品时，URL 变了但路由没刷新，这里补一次重置（重新主动拉取）
      const pid = urlParam('product_id') || '';
      if (pid && pid !== detailPid) { startDetail(); }
      try { injectDetailBar(); } catch (e) {}
      try { injectDetailRowButtons(); } catch (e) {}
    }
  }

  function boot() {
    tick();
    setInterval(tick, 1800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
