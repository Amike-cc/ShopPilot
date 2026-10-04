/**
 * 为「真机实测探针」准备一份**独立 userData**（不动正在运行的那个应用实例）。
 *
 * 为什么需要它：开发态的 electron-vite dev 会持续拉起应用，直接杀掉再带调试端口重启会与
 * 另一条在途工作的开发进程打架。Electron 的单实例锁按 userData 目录计算，所以拿一份
 * 复制的 profile（含店铺 partition 的 Cookie + 数据库快照）另起一个实例，既能拿到 CDP，
 * 又不影响原实例。
 *
 * 用法（必须用 Electron 自带的 node 运行时，better-sqlite3 是按 Electron ABI 编译的）：
 *   $env:ELECTRON_RUN_AS_NODE=1; node_modules\electron\dist\electron.exe wx-invite-test\prep-probe-profile.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(process.env.APPDATA || '', 'shopilot')
const DST = process.argv[2] || path.resolve('.probe-wx-profile')
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SKIP_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary', 'GrShaderCache', 'GraphiteDawnCache'])

function copyTree(from, to) {
  let files = 0
  let bytes = 0
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const s = path.join(src, entry.name)
      const d = path.join(dst, entry.name)
      if (entry.isDirectory()) walk(s, d)
      else if (entry.isFile()) {
        try {
          fs.copyFileSync(s, d)
          files++
          bytes += fs.statSync(d).size
        } catch (err) {
          console.log(`  ! 跳过 ${entry.name}: ${err.code}`)
        }
      }
    }
  }
  walk(from, to)
  return { files, bytes }
}

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`找不到应用 userData：${SRC}`)
  fs.rmSync(DST, { recursive: true, force: true })
  fs.mkdirSync(DST, { recursive: true })

  for (const name of ['Local State', 'Preferences']) {
    const p = path.join(SRC, name)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(DST, name))
  }

  // 店铺自己的 Cookie 分区（persist:store_<id> → Partitions/store_store_<id>）
  //
  // ⚠️ 2026-10-04 修：以前只复制 `SHOPILOT_WX_STORE` 那一个店铺的分区，
  // 于是探针里其它店铺（快手小店等）全是**未登录**态——第一次做快手审计就被
  // `login.kwaixiaodian.com` 挡回来，白跑一轮。默认复制**全部分区**；
  // 需要只挑几个时用 SHOPILOT_PROBE_STORES=id1,id2。
  const partsRoot = path.join(SRC, 'Partitions')
  const wanted = (process.env.SHOPILOT_PROBE_STORES || '').split(',').map(s => s.trim()).filter(Boolean)
  const partDirs = fs.existsSync(partsRoot)
    ? fs.readdirSync(partsRoot, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('store_')).map(d => d.name)
    : []
  const chosen = wanted.length
    ? partDirs.filter(name => wanted.some(w => name === `store_${w}`))
    : partDirs
  if (!chosen.length) throw new Error(`找不到任何店铺分区：${partsRoot}`)
  console.log(`[1] 复制店铺分区 ${chosen.length} 个…`)
  for (const name of chosen) {
    const r = copyTree(path.join(partsRoot, name), path.join(DST, 'Partitions', name))
    console.log('   ', name, JSON.stringify(r))
  }

  // 会话快照（session-cookies.enc）等店铺私有文件
  const storeFrom = path.join(SRC, 'stores', STORE)
  if (fs.existsSync(storeFrom)) {
    console.log('[2] 复制 stores/<storeId>…')
    console.log('   ', copyTree(storeFrom, path.join(DST, 'stores', STORE)))
  }

  // 数据库用 SQLite 在线备份（直接拷 db+wal 可能拿到半截事务）
  console.log('[3] 备份数据库（一致性快照）…')
  const Database = require('better-sqlite3')
  const db = new Database(path.join(SRC, 'shopilot.db'), { readonly: true })
  await db.backup(path.join(DST, 'shopilot.db'))
  const stores = db.prepare('SELECT id, platform FROM stores').all()
  db.close()
  console.log('    店铺:', stores.map(s => `${s.platform}:${s.id.slice(0, 12)}`).join(', '))

  console.log('[4] profile 就绪:', DST)
}

main().catch(err => { console.error('ERR', err.message); process.exit(1) })
