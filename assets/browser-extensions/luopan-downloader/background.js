/**
 * background service worker（ShopPilot / Electron 适配版）
 *
 * 与 Chrome 原版的差异——Electron 不支持 chrome.downloads 和 chrome.action：
 *   1. 下载改为「后台 fetch 视频流 → 按 1MiB 分块发给内容脚本 → 页面内 <a download> 触发」。
 *      最终由 ShopPilot 的下载管理器落盘（每家店铺独立下载目录 + 店铺名前缀，应用内下载面板可查）；
 *      所以扩展侧的 done 统计只代表"已交给页面触发"，真正的完成/失败以应用下载面板为准。
 *   2. 工具栏徽标不可用，进度只保留在 chrome.storage.local（lpStat），面板按钮文案照常提示。
 *   3. 竞品详情页 flow_more 参数记录逻辑与原版一致。
 */
const CONCURRENCY = 3;

let queue = [];
let active = 0;
let stat = { total: 0, done: 0, failed: 0 };

/* ---------------- 竞品详情：记录页面真实参数 ---------------- */
const detailParams = new Map();   // tabId -> params

/* 启动自检（2026-11-08）：把「SW 活着、哪些 API 在」写进 storage，popup 可见。
 * 之前如果这里的顶层代码抛错，整个 SW 直接死掉，onMessage 一个都收不到——
 * 症状是"插件像没装一样"，且不留任何痕迹。 */
try {
  chrome.storage.local.set({
    lpDiagSw: {
      sw: true,
      webRequest: !!(chrome.webRequest && chrome.webRequest.onBeforeRequest),
      tabs: !!chrome.tabs,
      storage: !!chrome.storage,
      at: Date.now()
    }
  });
} catch (e) {}

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  // 带签名 URL 环形缓存（2026-11-08 v2.3.1）：罗盘接口强校验 a_bogus/msToken，
  // 插件自己拼参数拿不到数据；页面自己的请求带完整签名——把它原样回放给页面桥即可。
  // URL 不变 = 签名不变，短时间内重放有效；页面翻页/筛选会产生新 URL，取最新一条。
  const seenUrls = { rank: [], detail: [] };
  function recordUrl(kind, url) {
    const arr = seenUrls[kind];
    if (!arr.length || arr[0] !== url) {
      arr.unshift(url);
      if (arr.length > 20) arr.pop();
    }
    try {
      chrome.storage.local.set({ lpUrlSeen: { kind: kind, at: Date.now(), urlPrefix: String(url).slice(0, 90) } });
    } catch (e) {}
  }

  chrome.webRequest.onBeforeRequest.addListener(
    function (d) {
      try {
        if (d.tabId < 0) return;
        recordUrl('rank', d.url);
      } catch (e) {}
    },
    { urls: ['https://compass.jinritemai.com/compass_api/shop/product/product_rank/video_bring_good*'] },
    []
  );

  chrome.webRequest.onBeforeRequest.addListener(
    function (d) {
      try {
        if (d.tabId < 0) return;
        recordUrl('detail', d.url);
        const u = new URL(d.url);
        if (u.pathname.indexOf('/compete_product_detail/flow_source/flow_more') < 0) return;
        const q = u.searchParams;
        if (q.get('source_entrance') !== 'video') return;
        // 插件自己的请求用 page_size=100，页面自己的是 10，只记录页面的
        const ps = parseInt(q.get('page_size') || '0', 10);
        if (ps >= 100) return;

        detailParams.set(d.tabId, {
          product_id: q.get('product_id') || '',
          saleType: q.get('saleType') || '0',
          date_type: q.get('date_type') || '21',
          begin_date: q.get('begin_date') || '',
          end_date: q.get('end_date') || '',
          activity_id: q.get('activity_id') || '',
          index_selected: q.get('index_selected') || '',
          sort_field: q.get('sort_field') || 'pay_amt',
          is_asc: q.get('is_asc') || 'false',
          ts: Date.now()
        });

        if (detailParams.size > 60) {
          const oldest = detailParams.keys().next().value;
          detailParams.delete(oldest);
        }
      } catch (e) {}
    },
    { urls: ['https://compass.jinritemai.com/compass_api/shop/product/compete_product_detail/*'] },
    []
  );

  // 内容脚本轮询：把最近一次带签名的完整 URL 给它（rank/detail 各一条）
  try {
    const prevOnMessage = chrome.runtime.onMessage;
    prevOnMessage.addListener(function (msg, sender, reply) {
      if (msg && msg.type === 'LP_GET_URLS') {
        reply({ ok: true, rank: seenUrls.rank[0] || '', detail: seenUrls.detail[0] || '' });
      }
    });
  } catch (e) {}
}

function persistStat() {
  try { chrome.storage.local.set({ lpStat: stat }); } catch (e) {}
}

function next() {
  while (active < CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    active++;
    submit(job);
  }
}

function bytesToB64(bytes) {
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

/** 带应答的发送：内容脚本回 ok:true 才算这块送达（提供背压，页签关了立刻失败）。 */
function sendChunk(tabId, payload) {
  return new Promise(function (resolve, reject) {
    try {
      chrome.tabs.sendMessage(tabId, payload, function (resp) {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message || '发送失败'));
        if (!resp || resp.ok !== true) return reject(new Error((resp && resp.error) || '内容脚本拒收'));
        resolve();
      });
    } catch (e) { reject(e); }
  });
}

function submit(job) {
  let finished = false;
  const done = function (ok, err) {
    if (finished) return;
    finished = true;
    active--;
    if (ok) stat.done++;
    else {
      stat.failed++;
      console.warn('[罗盘下载] 失败:', job.filename, err || '');
    }
    persistStat();
    next();
  };

  (async function () {
    if (!job.tabId) throw new Error('找不到来源标签页（下载必须在罗盘页面里发起）');
    const id = 'dl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const name = String(job.filename || '').split(/[\\/]/).pop().replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'video.mp4';

    // 视频直链是签名 URL：fetch 走扩展自己的上下文（host_permissions 内不受 CORS 限制），
    // 不带 Cookie（签名 URL 不需要，也避免把店铺 Cookie 扩散给 CDN）。
    const res = await fetch(job.url, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status + '（直链可能已过期，请重新抓取）');

    if (!res.body || !res.body.getReader) {
      const buf = await res.arrayBuffer();
      await sendChunk(job.tabId, { type: 'LP_CHUNK', id: id, seq: 0, b64: bytesToB64(new Uint8Array(buf)) });
      await sendChunk(job.tabId, { type: 'LP_SAVE', id: id, filename: name });
      return;
    }
    const reader = res.body.getReader();
    let seq = 0;
    for (;;) {
      const rd = await reader.read();
      if (rd.done) break;
      if (rd.value && rd.value.length) {
        await sendChunk(job.tabId, { type: 'LP_CHUNK', id: id, seq: seq, b64: bytesToB64(rd.value) });
        seq++;
      }
    }
    if (seq === 0) throw new Error('文件为空');
    await sendChunk(job.tabId, { type: 'LP_SAVE', id: id, filename: name });
  })().then(function () { done(true); }).catch(function (e) { done(false, e && e.message); });
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || !msg.type) return;

  if (msg.type === 'LP_DETAIL_PARAMS') {
    const tabId = sender && sender.tab && sender.tab.id;
    const p = tabId != null ? detailParams.get(tabId) : null;
    reply({ ok: true, params: p || null });
    return;
  }

  if (msg.type !== 'LP_DOWNLOAD') return;

  const tabId = sender && sender.tab && sender.tab.id;
  const jobs = (msg.jobs || []).filter(function (j) {
    return j && j.url && /^https?:\/\//.test(j.url);
  }).map(function (j) {
    return { url: j.url, filename: j.filename, tabId: tabId };
  });
  if (!jobs.length) {
    reply({ ok: false, error: 'empty' });
    return;
  }

  stat = { total: stat.total + jobs.length, done: stat.done, failed: stat.failed };
  queue = queue.concat(jobs);
  persistStat();
  next();

  reply({ ok: true, queued: jobs.length });
});
