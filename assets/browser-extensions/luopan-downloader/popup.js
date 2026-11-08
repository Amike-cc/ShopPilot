function activeTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    cb(tabs && tabs[0]);
  });
}

function send(type, cb) {
  activeTab(function (tab) {
    if (!tab || !tab.id) return cb && cb(null);
    chrome.tabs.sendMessage(tab.id, { type: type }, function (resp) {
      void chrome.runtime.lastError;
      cb && cb(resp);
    });
  });
}

function refresh() {
  send('LP_STATS', function (resp) {
    document.getElementById('products').textContent = resp ? resp.products : '未连接';
    document.getElementById('videos').textContent = resp ? resp.videos : '-';

    const sub = document.getElementById('sub');
    const lab = document.getElementById('labP');
    if (resp && resp.mode === 'detail') {
      sub.textContent = '竞品详情 / 视频分析';
      lab.textContent = '当前商品';
    } else if (resp && resp.mode === 'rank') {
      sub.textContent = '商品榜单 / 短视频榜';
      lab.textContent = '已抓取商品';
    } else {
      sub.textContent = 'compass.jinritemai.com';
      lab.textContent = '已抓取商品';
    }
  });
  chrome.storage.local.get({ lpStat: { done: 0, failed: 0 } }, function (cfg) {
    document.getElementById('done').textContent = cfg.lpStat.done || 0;
    document.getElementById('fail').textContent = cfg.lpStat.failed || 0;
  });
}

document.getElementById('reload').addEventListener('click', function () {
  send('LP_RELOAD', function () {
    setTimeout(refresh, 600);
  });
});

refresh();
