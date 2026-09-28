/**
 * publish-release.js — 发布 GitHub Release 并上传更新产物（§21 发布流水线）
 *
 * 凭据：复用本机 Git Credential Manager 中 github.com 的 token（git credential fill），
 * 不落盘、不打印。幂等：同 tag 已存在则复用并 PATCH 说明，同名资产先删后传。
 *
 * 用法：node publish-release.js
 * 产物：release/ShopPilot-Setup-<ver>.exe + .blockmap + latest.yml（electron-updater 需要）
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const OWNER = 'Amike-cc'
const REPO = 'ShopPilot'
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const TAG = `v${VERSION}`
// 预发布版本（如 0.1.1-beta.1）：electron-builder 按首个预发布段命名通道文件（beta.yml），
// GitHub Release 标记 prerelease=true，stable 通道的客户端不会看到（allowPrerelease=false）
const PRERELEASE = VERSION.includes('-')
const CHANNEL = PRERELEASE ? VERSION.split('-')[1].split('.')[0] : 'latest'
const YML_NAME = `${CHANNEL}.yml`
const REL_DIR = path.join(ROOT, 'release')
const ASSETS = [
  { name: `ShopPilot-Setup-${VERSION}.exe`, ct: 'application/octet-stream' },
  { name: `ShopPilot-Setup-${VERSION}.exe.blockmap`, ct: 'application/octet-stream' },
  { name: YML_NAME, ct: 'text/yaml' }
]

function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git credential fill 失败: ' + String(r.stderr || '').slice(0, 200))
  const m = /^password=(.+)$/m.exec(r.stdout || '')
  const u = /^username=(.+)$/m.exec(r.stdout || '')
  if (!m || !m[1].trim()) throw new Error('凭据管理器中没有 github.com 的 token（先完成一次 git push/fetch 授权）')
  return { token: m[1].trim(), user: u ? u[1].trim() : '?' }
}

/**
 * 发布前的**可溯源门禁**：工作区不干净就拒绝发布。
 *
 * 为什么要有这道闸：2026-09-28 审查实测——v0.4.48 是在 263 个未提交改动的工作区上构建并
 * 发布出去的，而清单里没有任何 git 信息，于是"线上这台机器跑的是哪份代码"事后无法确定，
 * 出事故无法二分/回放。发布物必须能对应到一个 commit。
 *
 * 逃生口：确实需要从脏工作区发版时显式设 `SHOPILOT_ALLOW_DIRTY_RELEASE=1`——
 * 让"我知道我在发一份无法溯源的包"变成一个要动手输入的判断，而不是默认发生的事。
 */
function assertCleanWorktree() {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    return r.status === 0 ? String(r.stdout || '').trim() : ''
  }
  const rev = git(['rev-parse', 'HEAD'])
  if (!rev) {
    console.error('发布中止：拿不到 git HEAD（不是 git 仓库？）——发布物必须可溯源到一个 commit。')
    process.exit(1)
  }
  const dirty = git(['status', '--porcelain'])
  const dirtyFiles = dirty ? dirty.split(/\r?\n/).filter(Boolean).length : 0
  if (dirtyFiles === 0) {
    console.log(`可溯源检查：工作区干净，发布物对应 ${rev.slice(0, 12)}`)
    return
  }
  if (process.env.SHOPILOT_ALLOW_DIRTY_RELEASE === '1') {
    console.warn(`警告：工作区有 ${dirtyFiles} 个未提交改动，已按 SHOPILOT_ALLOW_DIRTY_RELEASE=1 继续——本次发布物无法对应到单个 commit。`)
    return
  }
  console.error(`发布中止：工作区有 ${dirtyFiles} 个未提交改动，发布物将无法对应到某个 commit。`)
  console.error('先提交（或 git stash），或确认要发不可溯源的包时设 SHOPILOT_ALLOW_DIRTY_RELEASE=1 重跑。')
  process.exit(1)
}

async function api(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'shopilot-publish-release',
      Accept: 'application/vnd.github+json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    }
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url} :: ${text.slice(0, 400)}`)
  return data
}

;(async () => {
  for (const a of ASSETS) {
    if (!fs.existsSync(path.join(REL_DIR, a.name))) throw new Error(`缺少产物 ${a.name}，请先 pnpm dist`)
  }
  assertCleanWorktree()
  const { token, user } = getToken()
  console.log(`token ok (user=${user}, len=${token.length})`)

  const base = `https://api.github.com/repos/${OWNER}/${REPO}`
  const repo = await api(base, token)
  console.log(`repo ${repo.full_name} private=${repo.private}`)

  const notes = fs.readFileSync(path.join(ROOT, 'docs', 'RELEASE_NOTES.md'), 'utf8')
  // 构建标签以 release.json 为准（release-manifest.js 按 CSC_LINK/签名配置算出来的），
  // 这里不再写死 INTERNAL_BUILD —— 一旦真的配上签名，Release 标题还会继续显示 INTERNAL_BUILD，
  // 误导用户与运维（2026-09-28 审查确认的三处硬编码之一）。
  let buildLabel = 'INTERNAL_BUILD'
  try {
    const manifestPath = path.join(REL_DIR, 'release.json')
    if (fs.existsSync(manifestPath)) buildLabel = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).buildLabel || buildLabel
  } catch { /* 清单缺失/损坏 → 保守标记为内部构建 */ }
  const name = `ShopPilot ${VERSION} (${buildLabel})`
  let rel
  try {
    rel = await api(`${base}/releases`, token, {
      method: 'POST',
      body: JSON.stringify({ tag_name: TAG, name, body: notes, draft: false, prerelease: PRERELEASE, make_latest: PRERELEASE ? 'false' : 'true' })
    })
    console.log(`release created id=${rel.id} tag=${rel.tag_name}`)
  } catch (e) {
    console.log('create 失败（可能已存在同 tag）:', String(e.message).slice(0, 160))
    rel = await api(`${base}/releases/tags/${TAG}`, token)
    rel = await api(`${base}/releases/${rel.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name, body: notes, draft: false, prerelease: PRERELEASE, make_latest: PRERELEASE ? 'false' : 'true' })
    })
    console.log(`reuse release id=${rel.id} tag=${rel.tag_name}`)
  }

  for (const a of rel.assets || []) {
    if (ASSETS.some(x => x.name === a.name)) {
      await api(`${base}/releases/assets/${a.id}`, token, { method: 'DELETE' })
      console.log(`deleted old asset ${a.name}`)
    }
  }

  const uploadBase = String(rel.upload_url).split('{')[0]
  for (const a of ASSETS) {
    const buf = fs.readFileSync(path.join(REL_DIR, a.name))
    // 上传带重试：安装包 ~85MB，在经代理的网络（本机 DNS 指向虚拟网卡）上单次 POST 可能
    // 中途被切断（实测 `fetch failed` / `Post …: EOF`，而 API 域名其实完全可达）。
    // 没有重试时表现为"release 建好了但资产一个都没传"，客户端永远收不到更新——
    // 而脚本自身只留下一行 fetch failed，很容易被当成代码问题查半天。
    let lastErr = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${uploadBase}?name=${encodeURIComponent(a.name)}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'shopilot-publish-release',
            'Content-Type': a.ct
          },
          body: buf
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
        const j = await res.json()
        console.log(`uploaded ${a.name} (${j.size} B) → ${j.browser_download_url}`)
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        console.log(`upload ${a.name} 第 ${attempt} 次失败：${String(e && e.message || e)}`)
        if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt))
      }
    }
    if (lastErr) throw new Error(`upload ${a.name} 重试 3 次仍失败: ${String(lastErr.message || lastErr)}`)
  }

  const final = await api(`${base}/releases/${rel.id}`, token)
  console.log(JSON.stringify({
    url: final.html_url,
    tag: final.tag_name,
    prerelease: final.prerelease,
    channelFile: YML_NAME,
    assets: final.assets.map(a => ({ name: a.name, size: a.size }))
  }, null, 2))
  console.log('GH_RELEASE_PUBLISHED')
})().catch(e => { console.error('PUBLISH_FAILED:', String(e && e.message || e)); process.exit(1) })
