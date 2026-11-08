/**
 * content script
 * 按 URL 分流两种模式：
 *   rank   —— /shop/chance/product-rank         商品榜单 → 每行视频下方注入按钮
 *   detail —— /shop/chance/rank-product/detail  竞品详情 → 视频分析表格上方注入批量按钮
 */
(function () {
  'use strict';

  if (window.__lpLoaded) return;
  window.__lpLoaded = true;

  /* ---------------- 接口 ---------------- */
  const RANK_API = '/compass_api/shop/product/product_rank/video_bring_good';
  const DETAIL_API = '/compass_api/shop/product/compete_product_detail/flow_source/flow_more';

  const RANK_PAGE_SIZE = 10;     // 榜单接口把 page_size 卡在 10
  const RANK_MAX_PAGE = 20;      // 10 × 20 = 200 条
  const DETAIL_PAGE_SIZE = 100;  // 竞品详情接口支持 100
  const DETAIL_MAX_PAGE = 20;    // 上限 2000 条

  const DEFAULT_CFG = {
    industry_id: '4',
    category_id: '1000003282,1000009114',
    brand_type: '-1',
    price_bin: '不限',
    date_type: '21'
  };

  /* ---------------- 状态 ---------------- */
  let mode = '';
  let rankBooted = false;
  let detailBooted = false;
  let detailPid = '';

  // rank
  let cfg = Object.assign({}, DEFAULT_CFG);
  const items = new Map();       // videoId -> item
  let loading = false;
  let loadGen = 0;               // 每次加载的代号，用来打断上一轮
  let lastError = '';

  // detail
  let detailVideos = [];
  let detailMeta = { begin: '', end: '', done: false, error: '' };
  let detailLoading = false;
  let detailLoadedKey = '';

  /* ---------------- 通用工具 ---------------- */
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

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
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      cb && cb(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { cb && cb(true); })
        .catch(fallback);
    } else fallback();
  }

  /* ---------------- 日期：近 7 天（截止昨天） ---------------- */
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

  /* ---------------- 页面上下文请求通道 ---------------- */
  /**
   * 2026-11-08 修复「获取不到链接」：
   * 原实现只有一条路——注入页面世界的 fetch.js（依赖 chrome-extension:// 的
   * web_accessible_resources）。Electron 官方支持的 manifest 键清单里**没有**
   * web_accessible_resources，注入的 <script> 加载不到资源，而原实现在这种情况下
   * **静默返回**（loadRankAll 里 if (!ready) return），于是面板永远是 0 条、不报错。
   *
   * 现在的策略：
   *   1. 页面世界桥仍先试（兼容真 Chrome 与「页面环境有风控差异」的场景）；
   *   2. 桥不可用 / 超时 → 自动回退到 content script 直连同源接口（带 Cookie）；
   *   3. 两条路的状态与最近一次错误写进 chrome.storage.local（lpDiagCs），popup 可见。
   */
  const diag = { bridge: 'unknown', lastError: '', at: 0 };

  function persistDiag() {
    try {
      diag.at = Date.now();
      chrome.storage.local.set({ lpDiagCs: { bridge: diag.bridge, lastError: diag.lastError, at: diag.at } });
    } catch (e) {}
  }

  function noteError(message) {
    diag.lastError = String(message || '');
    persistDiag();
    renderErrorChip();
  }

  function injectFetcher() {
    return new Promise(function (resolve) {
      if (window.__lpFetcher) return resolve({ ok: true, reason: 'already' });
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.getURL !== 'function') {
        return resolve({ ok: false, reason: 'runtime.getURL 不可用' });
      }
      try {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('fetch.js');
        s.onload = function () { s.remove(); resolve({ ok: true, reason: 'injected' }); };
        s.onerror = function () {
          s.remove();
          resolve({ ok: false, reason: 'fetch.js 资源加载被拦（本环境不支持 web_accessible_resources）' });
        };
        (document.head || document.documentElement).appendChild(s);
      } catch (e) {
        resolve({ ok: false, reason: String((e && e.message) || e) });
      }
    });
  }

  function pageFetch(url) {
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
      window.postMessage({ __lp: 'req', id: id, url: url }, '*');

      setTimeout(function () {
        if (done) return;
        window.removeEventListener('message', onMsg);
        reject(new Error('请求超时'));
      }, 20000);
    });
  }

  /** content script 直连同源接口：与页面同源、带 Cookie，页面 CSP 不约束扩展的请求 */
  async function isoFetchJson(url) {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  /**
   * 统一入口：桥优先、直连兜底。
   * 桥「注入失败」或「连续超时」后标记 failed，后续请求不再等 20 秒。
   * 站点返回的业务错误（HTTP 200 但 st!=0、HTTP 4xx/5xx）不算桥故障，不回退。
   */
  async function apiFetch(url) {
    if (diag.bridge !== 'failed') {
      const ready = await injectFetcher();
      if (ready.ok) {
        try {
          const json = await pageFetch(url);
          if (diag.bridge !== 'ok') { diag.bridge = 'ok'; persistDiag(); renderErrorChip(); }
          return json;
        } catch (err) {
          const msg = String((err && err.message) || err);
          if (msg.indexOf('超时') < 0) throw err;   // 桥通了但接口报错：如实抛出
          diag.bridge = 'failed';                   // 桥超时：本次起改走直连
        }
      } else {
        diag.bridge = 'failed';
        diag.bridgeReason = ready.reason;
      }
    }
    const json = await isoFetchJson(url);
    if (diag.bridge !== 'direct') { diag.bridge = 'direct'; persistDiag(); renderErrorChip(); }
    return json;
  }

  /* ---------------- 下载 ---------------- */
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

  function downloadVideos(list, btn) {
    const valid = (list || []).filter(function (it) { return it && it.videoId && it.playUrl; });
    if (!valid.length) { flash(btn, '无可下载'); return; }
    const jobs = valid.map(function (it) {
      return { url: it.playUrl, filename: buildName(it) };
    });
    flash(btn, `提交 ${jobs.length} 个…`);
    chrome.runtime.sendMessage({ type: 'LP_DOWNLOAD', jobs: jobs }, function (resp) {
      void chrome.runtime.lastError;
      flash(btn, resp && resp.ok ? `已提交 ${jobs.length} 个` : '提交失败');
    });
  }

  /* ================= 模式一：商品榜单 ================= */
  function parseRank(json) {
    const out = [];
    const list = (json && json.data && json.data.data_result) || [];
    for (const prod of list) {
      const p = prod.product_info || {};
      const vids = prod.video_list || [];
      for (const v of vids) {
        const id = String(v.video_id || '');
        if (!id || !v.video_play_url) continue;
        out.push({
          videoId: id,
          playUrl: v.video_play_url,
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

  async function fetchRankPage(no) {
    const params = Object.assign({}, cfg, dateRange(), {
      page_no: String(no),
      page_size: String(RANK_PAGE_SIZE),
      rank_data_type: '1',
      activity_id: ''
    });
    if (!params.search_info) params.search_info = '';

    const qs = new URLSearchParams(params).toString();
    const json = await apiFetch(`${location.origin}${RANK_API}?${qs}`);
    if (!json || json.st !== 0) {
      throw new Error((json && json.msg) || ('st=' + (json && json.st)));
    }
    return parseRank(json);
  }

  /**
   * 拉取榜单数据。
   * 关键点：每次调用都领一个代号 gen，旧循环发现代号变了就自己退出，
   * 这样搜索时能立刻打断上一轮 20 页的抓取，不用干等。
   * 结果先攒在 pending 里，按页逐步替换 items，绝不先清空（会瞬间掉按钮）。
   */
  async function loadRankAll() {
    const gen = ++loadGen;
    loading = true;
    lastError = '';

    // 无关键词 = 全量，结果可整体替换；有关键词 = 只增补，避免把已有数据冲掉
    const fullMode = !String(cfg.search_info || '').trim();

    const pending = new Map();
    for (let p = 1; p <= RANK_MAX_PAGE; p++) {
      if (gen !== loadGen) return;

      let rows = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (gen !== loadGen) return;
        try {
          rows = await fetchRankPage(p);
          break;
        } catch (err) {
          lastError = String((err && err.message) || err);
          noteError(lastError);
          renderErrorChip('罗盘下载：抓取失败 ' + lastError + (attempt < 2 ? '（重试中…）' : ''));
          if (attempt < 2) await sleep(2500 * (attempt + 1));
        }
      }
      if (gen !== loadGen) return;
      if (rows === null) break;

      for (const it of rows) {
        if (!pending.has(it.videoId)) pending.set(it.videoId, it);
      }
      lastError = '';

      // 攒到一页就上一页：首页 10 个商品正好是屏幕上那 10 行，按钮立刻能用
      applyRankRows(pending, fullMode);

      if (!rows.length) break;
      if (rows.length < RANK_PAGE_SIZE) break;
    }

    if (gen !== loadGen) return;
    applyRankRows(pending, fullMode);
    loading = false;
    if (!items.size && lastError) {
      renderErrorChip('罗盘下载：抓取失败 ' + lastError + '（检查是否已登录罗盘，或点插件弹窗「重新抓取」）');
    } else {
      renderErrorChip(null);
    }
    injectRowButtons();
  }

  /** fullMode 整体替换；搜索模式只补不删，保证按钮不会中途消失 */
  function applyRankRows(pending, fullMode) {
    if (fullMode) {
      items.clear();
      for (const [k, v] of pending) items.set(k, v);
    } else {
      for (const [k, v] of pending) {
        if (!items.has(k)) items.set(k, v);
      }
    }
    injectRowButtons();
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

  function copyProductLinks(g, btn) {
    const text = g.videos
      .map(function (v) { return 'https://www.douyin.com/video/' + v.videoId; })
      .join('\n');
    copyText(text, function (ok) {
      flash(btn, ok ? `已复制 ${g.videos.length} 条` : '复制失败');
    });
  }

  /* ---------------- 跟随页面搜索框（仅榜单） ---------------- */
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
    let last = readPageKeyword();
    let candidate = null;

    setInterval(function () {
      if (mode !== 'rank') return;
      const kw = readPageKeyword();
      if (kw === null) return;

      try {
        document.documentElement.setAttribute('data-lp-kw',
          'seen=' + kw + ';last=' + (last || '') + ';cfg=' + (cfg.search_info || '') +
          ';cand=' + (candidate || '') + ';loading=' + loading + ';items=' + items.size);
      } catch (e) {}

      if (kw === last) { candidate = null; return; }
      if (kw !== candidate) { candidate = kw; return; }   // 连续两轮相同才触发

      last = kw;
      candidate = null;
      if (kw === (cfg.search_info || '')) return;

      cfg.search_info = kw;
      loadRankAll();      // 领新代号，旧的那轮会自动退出
    }, 1500);
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

  async function fetchDetailPage(params, pageNo) {
    const q = new URLSearchParams({
      product_id: params.product_id,
      saleType: params.saleType || '0',
      source_entrance: 'video',
      date_type: params.date_type || '21',
      end_date: params.end_date,
      begin_date: params.begin_date,
      activity_id: params.activity_id || '',
      index_selected: params.index_selected || 'pay_amt,pay_ucnt,dh_product_click_ratio_uv,pay_cnt,pay_combo_cnt',
      page_size: String(DETAIL_PAGE_SIZE),
      page_no: String(pageNo),
      sort_field: params.sort_field || 'pay_amt',
      is_asc: params.is_asc || 'false'
    });

    const json = await apiFetch(`${location.origin}${DETAIL_API}?${q.toString()}`);
    if (!json || json.st !== 0) {
      throw new Error((json && json.msg) || ('st=' + (json && json.st)));
    }
    const arr = Array.isArray(json.data)
      ? json.data
      : ((json.data && json.data.data_result) || []);

    const base = detailVideos.length;
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const v = parseDetailItem(arr[i], base + i + 1);
      if (v) out.push(v);
    }
    return out;
  }

  /** 优先用页面自己发出的请求参数（后台 webRequest 捕获），保证时间区间一致 */
  function askBgParams() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'LP_DETAIL_PARAMS', productId: urlParam('product_id') },
          function (resp) {
            void chrome.runtime.lastError;
            resolve((resp && resp.params) || null);
          });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /** URL 上带的 date_value=起始秒,结束秒，比默认近 7 天更准 */
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

  async function resolveDetailParams() {
    const pid = urlParam('product_id') || '';
    const cap = await askBgParams();
    if (cap && cap.begin_date && cap.end_date && (!pid || !cap.product_id || cap.product_id === pid)) {
      return cap;
    }
    const dr = urlDateRange() || dateRange();
    return {
      product_id: pid,
      saleType: '0',
      date_type: urlParam('date_type') || '21',
      begin_date: dr.begin_date,
      end_date: dr.end_date,
      activity_id: ''
    };
  }

  /** 按给定参数把所有分页拉完，返回是否拿到数据 */
  async function fetchDetailAll(params) {
    for (let p = 1; p <= DETAIL_MAX_PAGE; p++) {
      let rows = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rows = await fetchDetailPage(params, p);
          break;
        } catch (err) {
          detailMeta.error = String((err && err.message) || err);
          if (attempt < 2) await sleep(2000 * (attempt + 1));
        }
      }
      if (rows === null) return false;
      if (!rows.length) break;

      for (const r of rows) detailVideos.push(r);
      detailMeta.error = '';
      renderDetailBar();
      if (rows.length < DETAIL_PAGE_SIZE) break;
      await sleep(350);
    }
    return detailVideos.length > 0;
  }

  async function loadDetail() {
    if (detailLoading) return;
    detailLoading = true;
    detailMeta = { begin: '', end: '', done: false, error: '' };
    detailVideos = [];
    clearDetailRowButtons();
    renderDetailBar();

    // 优先用页面自己的筛选参数（保证时间区间一致）
    let params = await resolveDetailParams();
    detailMeta.begin = params.begin_date || '';
    detailMeta.end = params.end_date || '';
    detailLoadedKey = filterKey(params);

    let ok = await fetchDetailAll(params);

    // 捕获到的参数可能已过期（例如换了商品），失败则退回默认近 7 天
    if (!ok && detailMeta.error) {
      const dr = dateRange();
      params = {
        product_id: params.product_id || urlParam('product_id') || '',
        saleType: '0',
        date_type: '21',
        begin_date: dr.begin_date,
        end_date: dr.end_date,
        activity_id: ''
      };
      detailMeta.begin = params.begin_date;
      detailMeta.end = params.end_date;
      detailLoadedKey = filterKey(params);
      detailVideos = [];
      await fetchDetailAll(params);
    }

    detailLoading = false;
    detailMeta.done = true;
    renderDetailBar();
    injectDetailRowButtons();
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

  function detailCopy(btn) {
    if (!detailVideos.length) { flash(btn, '暂无数据'); return; }
    const text = detailVideos
      .map(function (v) { return 'https://www.douyin.com/video/' + v.videoId; })
      .join('\n');
    copyText(text, function (ok) {
      flash(btn, ok ? `已复制 ${detailVideos.length} 条` : '复制失败');
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
      if (mode === 'detail') loadDetail();
      else { loadRankAll(); }
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

  /* ---------------- 模式调度 ---------------- */
  function detectMode() {
    const p = location.pathname;
    if (p.indexOf('/chance/rank-product/detail') >= 0) return 'detail';
    if (p.indexOf('/chance/product-rank') >= 0) return 'rank';
    return '';
  }

  function startRank() {
    const wait = document.readyState === 'complete' ? 5000 : 7000;
    setTimeout(loadRankAll, wait);
    watchPageKeyword();
  }

  function startDetail() {
    const pid = urlParam('product_id') || '';
    if (detailBooted && pid === detailPid) return;
    detailBooted = true;
    detailPid = pid;
    const wait = document.readyState === 'complete' ? 3500 : 5000;
    setTimeout(loadDetail, wait);
  }

  /** 页面切换时间区间/商品后，后台会捕获到新参数，这里跟着重抓 */
  function filterKey(p) {
    return [p.product_id || '', p.date_type || '', p.begin_date || '', p.end_date || '', p.saleType || ''].join('|');
  }

  function watchDetailFilter() {
    setInterval(async function () {
      if (mode !== 'detail' || detailLoading) return;
      const pid = urlParam('product_id') || '';
      const cap = await askBgParams();
      if (!cap) return;
      if (pid && cap.product_id && cap.product_id !== pid) return;
      const k = filterKey(cap);
      if (k && k !== detailLoadedKey) loadDetail();
    }, 3000);
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
      // 站内切换到别的竞品时，URL 变了但路由没刷新，这里补一次重抓
      const pid = urlParam('product_id') || '';
      if (pid && pid !== detailPid) { startDetail(); }
      try { injectDetailBar(); } catch (e) {}
      try { injectDetailRowButtons(); } catch (e) {}
    }
  }

  function boot() {
    tick();
    setInterval(tick, 1800);
    watchDetailFilter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
