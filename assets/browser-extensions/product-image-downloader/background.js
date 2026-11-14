/**
 * 商品图片下载器 · background service worker
 *
 * 内容脚本优先自己在页面里 fetch（图片 CDN 带 Access-Control-Allow-Origin: *），
 * 失败时（CDN 收回 CORS / 页面策略变化）走这里：扩展上下文 fetch 不受页面 CORS 限制，
 * 拿回 base64 交给内容脚本组装 Blob，再由页面 <a download> 交给 ShopPilot 下载管理器落盘。
 *
 * 注意：不申请 downloads 权限（应用安全边界硬阻断），也不走 chrome.downloads。
 */
const MAX_BYTES = 20 * 1024 * 1024;

function bytesToB64(bytes) {
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || msg.type !== 'IMGDL_FETCH') return;
  const url = String(msg.url || '');
  if (!/^https:\/\//i.test(url)) {
    reply({ ok: false, error: '只支持 https 图片地址' });
    return false;
  }

  (async function () {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error('图片超过 20MB');
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) throw new Error('文件为空');
    if (buf.byteLength > MAX_BYTES) throw new Error('图片超过 20MB');
    reply({
      ok: true,
      b64: bytesToB64(new Uint8Array(buf)),
      mime: res.headers.get('content-type') || ''
    });
  })().catch(function (error) {
    reply({ ok: false, error: String((error && error.message) || error).slice(0, 160) });
  });

  // 异步 reply：必须返回 true 保持消息通道
  return true;
});
