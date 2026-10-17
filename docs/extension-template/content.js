/**
 * ShopPilot 自研插件模板（content script）。
 *
 * 这里只做三件安全的事：
 *   1. 在页面右下角放一个自己的徽章（不劫持平台原有 DOM）；
 *   2. 展示当前域名与页面标题，确认注入生效；
 *   3. 用 chrome.storage.local 记一次计数（每个店铺分区独立，互不串）。
 *
 * 不要在这里改 navigator / userAgent / Canvas / WebGL：那会和应用的指纹注入
 * 互相覆盖，店铺页的指纹一致性会被破坏（应用会在档案校验里报「未验证」）。
 */
;(() => {
  const HOST_ID = '__shopilot_my_extension__'
  if (document.getElementById(HOST_ID)) return

  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('data-shopilot-extension', 'my-first-extension')

  const badge = document.createElement('div')
  badge.className = 'shopilot-ext-badge'
  badge.textContent = '插件已注入'

  const detail = document.createElement('div')
  detail.className = 'shopilot-ext-detail'
  detail.textContent = `${location.hostname} · ${document.title.slice(0, 40)}`

  let open = false
  badge.addEventListener('click', () => {
    open = !open
    detail.classList.toggle('is-open', open)
    badge.textContent = open ? '插件已注入（点击收起）' : '插件已注入'
  })

  host.appendChild(badge)
  host.appendChild(detail)
  document.documentElement.appendChild(host)

  // chrome.storage.local 在 Electron 里按 Session（即按店铺）隔离。
  try {
    chrome.storage.local.get({ visits: 0 }, current => {
      const visits = Number(current && current.visits ? current.visits : 0) + 1
      chrome.storage.local.set({ visits })
      const line = document.createElement('div')
      line.className = 'shopilot-ext-detail is-open'
      line.textContent = `本店铺第 ${visits} 次注入`
      host.appendChild(line)
    })
  } catch {
    // storage 不可用时不影响注入本身
  }
})()
