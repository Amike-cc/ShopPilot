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
  const { token, user } = getToken()
  console.log(`token ok (user=${user}, len=${token.length})`)

  const base = `https://api.github.com/repos/${OWNER}/${REPO}`
  const repo = await api(base, token)
  console.log(`repo ${repo.full_name} private=${repo.private}`)

  const notes = fs.readFileSync(path.join(ROOT, 'docs', 'RELEASE_NOTES.md'), 'utf8')
  const name = `ShopPilot ${VERSION} (INTERNAL_BUILD)`
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
    const res = await fetch(`${uploadBase}?name=${encodeURIComponent(a.name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'shopilot-publish-release',
        'Content-Type': a.ct
      },
      body: buf
    })
    if (!res.ok) throw new Error(`upload ${a.name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    const j = await res.json()
    console.log(`uploaded ${a.name} (${j.size} B) → ${j.browser_download_url}`)
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
