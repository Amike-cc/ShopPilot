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
  // 罗盘接口改版检测（2026-11-08 实测）：play_url / video_id 全空、仅 video_ref 引用键
  let rankRevision = '';

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
   * v2.3.0 起桥只负责「装响应拦截 hook」，不再承担主动请求：
   * 罗盘接口强校验 a_bogus/msToken 签名（页面请求库自动附加），
   * 插件裸 fetch 只能拿到「st=0 但空数据」或风控拒绝——这就是「获取不到链接」的根因。
   * 数据一律来自页面响应推送（__lp:'data'）。 */
  const diag = { lastError: '', at: 0, note: '' };

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
      // 主动请求通道（保留，当前主流程不依赖）
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
    let videos = 0, withPlay = 0;
    for (const prod of list) {
      const p = prod.product_info || {};
      const vids = prod.video_list || [];
      for (const v of vids) {
        videos++;
        if (v.video_play_url) withPlay++;
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
    // 改版判定：页面给了视频，但播放地址一条都没有 → 罗盘已把地址换成 video_ref 引用键
    if (videos > 0 && withPlay === 0) {
      rankRevision = '罗盘已改版：榜单接口不再直接下发播放地址（实测 2026-11-08：play_url 全空、video_id 置空、只发 video_ref 引用键）。插件暂无法取到下载链接，复制链接同样受影响；需要适配新版换链接口后恢复。';
    } else if (videos > 0) {
      rankRevision = '';
    }
    return out;
  }

  /** 页面响应推送（fetch.js）→ 只增不删：页面翻页时每页 10 条陆续到达 */
  function applyRankRows(rows) {
    let added = 0;
    for (const it of rows || []) {
      if (!items.has(it.videoId)) added++;
      items.set(it.videoId, it);
    }
    if ((rows || []).length) {
      lastError = '';
      renderErrorChip(null);
      injectRowButtons();
      enqueueResolve(rows);
    } else if (rankRevision) {
      renderErrorChip(rankRevision);
    }
    return (rows || []).length;
  }

  /**
   * 后台预解析缓存（ref → 抖音 videoId）：数据一到就解析，
   * 用户点「复制链接」时直接取缓存——复制回到用户手势窗口内的同步路径，最稳。
   * 失败不自动重试（entity_by_ref 有配额 remaining_cnt）。
   */
  const refCache = new Map();
  let resolveQueue = [];
  let resolveActive = 0;
  function enqueueResolve(rows) {
    for (const it of rows || []) {
      if (!it || !it.ref || refCache.has(it.ref)) continue;
      if (resolveQueue.some(function (q) { return q.ref === it.ref; })) continue;
      resolveQueue.push(it);
    }
    kickResolve();
  }
  function kickResolve() {
    while (resolveActive < RESOLVE_CONCURRENCY && resolveQueue.length) {
      const it = resolveQueue.shift();
      resolveActive++;
      resolveVideoEntity(it.ref).then(function (r) {
        if (r.videoId) refCache.set(it.ref, r.videoId);
      }).catch(function () {}).then(function () {
        resolveActive--;
        kickResolve();
      });
    }
  }

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

  /** 榜单等待提示：进入榜单页 12 秒仍无数据 → 引导用户切到「短视频榜」标签页 */
  function startRankHintTimer() {
    setTimeout(function () {
      if (mode === 'rank' && items.size === 0 && !loading) {
        renderErrorChip(rankRevision || '罗盘下载：未收到榜单数据。请点开上方「短视频榜」标签页（总榜没有带货视频列）——插件自动跟随页面真实请求，翻页/筛选都会同步');
      }
    }, 12000);
  }

  /* ================= 模式二：竞品详情 · 视频分析 ================= */
  function parseDetailItem(it, seq) {
    const b = (it && it.base_info) || {};
    const v = b.video_base_info || {};
    const a = v.author_info || {};
    const id = String(v.video_id || '');
    if (!id || !v.video_url) return null;
    return {
      videoId: id,
      playUrl: v.video_url,
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

  /** 进入竞品详情页：重置 UI，然后等页面响应推送；12 秒没数据就引导用户 */
  function loadDetail() {
    detailLoading = true;
    detailMeta = { begin: '', end: '', done: false, error: '' };
    detailVideos = [];
    clearDetailRowButtons();
    renderDetailBar();

    setTimeout(function () {
      detailLoading = false;
      if (mode !== 'detail') return;
      if (detailVideos.length === 0) {
        detailMeta.done = true;
        renderDetailBar();
        renderErrorChip('罗盘下载：未收到竞品视频数据。请打开「视频分析」标签页并翻一页（插件自动跟随页面真实请求）');
      }
    }, 12000);
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
    watchPageKeyword();
    startRankHintTimer();
  }

  /**
   * 主通道（v2.3.1）：后台 webRequest 捕获页面自己发出的「带签名完整 URL」，
   * 这里轮询取最新一条，经页面桥原样重放——URL 不变 = 签名不变。
   * 页面翻页/筛选/搜索会产生新 URL，自动跟随；URL 没变就不重放。
   */
  let lastRankUrl = '';
  let lastDetailUrl = '';
  function pollPageUrls() {
    setInterval(async function () {
      if (mode !== 'rank' && mode !== 'detail') return;
      let resp = null;
      try {
        resp = await new Promise(function (resolve) {
          chrome.runtime.sendMessage({ type: 'LP_GET_URLS' }, function (r) {
            void chrome.runtime.lastError;
            resolve(r || null);
          });
        });
      } catch (e) {
        diag.note = 'getUrls-throw: ' + String((e && e.message) || e);
        persistDiag();
        return;
      }
      if (!resp || !resp.ok) {
        diag.note = 'getUrls-empty';
        persistDiag();
        return;
      }
      diag.note = 'urls: rank=' + (resp.rank ? 'yes' : 'no') + ' detail=' + (resp.detail ? 'yes' : 'no') + ' mode=' + mode;
      persistDiag();

      if (mode === 'rank' && resp.rank && resp.rank !== lastRankUrl) {
        lastRankUrl = resp.rank;
        try {
          const json = await pageFetch(resp.rank);
          const n = applyRankRows(parseRank(json));
          diag.note = 'replayed rank rows=' + n;
          persistDiag();
        } catch (e) {
          noteError(String((e && e.message) || e));
          diag.note = 'replay-failed: ' + String((e && e.message) || e).slice(0, 120);
          persistDiag();
          renderErrorChip('罗盘下载：重放页面请求失败 ' + String((e && e.message) || e).slice(0, 80));
        }
      }

      if (mode === 'detail' && resp.detail && resp.detail !== lastDetailUrl) {
        lastDetailUrl = resp.detail;
        try {
          const json = await pageFetch(resp.detail);
          const n = applyDetailRows(json);
          diag.note = 'replayed detail rows=' + n;
          persistDiag();
        } catch (e) {
          noteError(String((e && e.message) || e));
          diag.note = 'detail-replay-failed: ' + String((e && e.message) || e).slice(0, 120);
          persistDiag();
          detailMeta.error = String((e && e.message) || e);
          renderDetailBar();
        }
      }
    }, 2500);
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
      // 站内切换到别的竞品时，URL 变了但路由没刷新，这里补一次重置（数据仍由页面推送）
      const pid = urlParam('product_id') || '';
      if (pid && pid !== detailPid) { startDetail(); }
      try { injectDetailBar(); } catch (e) {}
      try { injectDetailRowButtons(); } catch (e) {}
    }
  }

  function boot() {
    tick();
    setInterval(tick, 1800);
    pollPageUrls();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
