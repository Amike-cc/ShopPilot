/**
 * 查店铺分区的磁盘落盘情况：Cookies 库是否存在、有多少行、是否含 marker；
 * 以及快照文件能否用主进程解密（间接验证 safeStorage 可用）。
 */
const fs = await import('fs')
const path = await import('path')
const os = await import('os')
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const userData = path.join(process.env.APPDATA, 'shopilot')

console.log('userData:', userData)
console.log('stores 下:'); 
const storesDir = path.join(userData, 'stores')
if (fs.existsSync(storesDir)) for (const d of fs.readdirSync(storesDir)) console.log('  ', d)

// 分区目录通常叫 "Partitions/<part>" 或 "Session Storage"
for (const cand of [
  path.join(userData, 'Partitions', `store_${STORE}`),
  path.join(userData, 'Partitions', STORE),
  path.join(userData, 'stores', STORE)
]) {
  if (fs.existsSync(cand)) {
    console.log('\n目录存在:', cand)
    for (const f of fs.readdirSync(cand)) {
      const p = path.join(cand, f)
      try { console.log('   ', f, fs.statSync(p).size + 'B') } catch { console.log('   ', f) }
    }
    // Network 子目录里通常有 Cookies
    const net = path.join(cand, 'Network')
    if (fs.existsSync(net)) {
      console.log('   Network/:')
      for (const f of fs.readdirSync(net)) {
        const p = path.join(net, f)
        console.log('     ', f, (() => { try { return fs.statSync(p).size + 'B' } catch { return '' } })())
      }
    }
  }
}
// 全盘找 Cookies 库
console.log('\n搜索 Cookies 库:')
const hits = []
const walk = (d, depth) => {
  if (depth > 5) return
  let ents = []
  try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, depth + 1)
    else if (/^Cookies(-journal)?$/.test(e.name)) hits.push({ p, size: (() => { try { return fs.statSync(p).size } catch { return 0 } })() })
  }
}
walk(userData, 0)
for (const h of hits.slice(0, 20)) console.log('  ', h.size + 'B', h.p)
if (!hits.length) console.log('  （一个都没找到）')
console.log('\n快照文件:')
const snap = path.join(userData, 'stores', STORE, 'session-cookies.enc')
console.log('  ', snap, fs.existsSync(snap) ? fs.statSync(snap).size + 'B' : '(不存在)')
