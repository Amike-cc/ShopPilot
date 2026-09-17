/**
 * 只读盘点：各平台已采集的发票数据里，到底有没有出现"店铺自己的主体/营业执照"信息。
 * 不改任何数据。用法：node wx-invite-test/dump-invoice-entity-columns.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

const db = new DatabaseSync(path.join(process.env.APPDATA, 'shopilot', 'shopilot.db'))
const stores = db.prepare('SELECT id, name, platform FROM stores WHERE deleted_at IS NULL ORDER BY platform').all()
const snaps = db.prepare(`
  SELECT store_id, metric, value_json FROM (
    SELECT store_id, metric, value_json, ROW_NUMBER() OVER (PARTITION BY store_id, metric ORDER BY rowid DESC) rn
    FROM store_snapshots WHERE metric LIKE 'invoice.%'
  ) WHERE rn = 1
`).all()

const KEY = /主体|抬头|税号|公司|企业|名称|商家/
for (const s of stores) {
  console.log(`\n=== ${s.platform} / ${s.name}`)
  const mine = snaps.filter(x => x.store_id === s.id)
  if (!mine.length) { console.log('  （该店还没有发票快照）'); continue }
  for (const r of mine) {
    let v
    try { v = JSON.parse(r.value_json) } catch { v = r.value_json }
    if (!Array.isArray(v)) { console.log(`  ${r.metric} [卡片] = ${String(v).slice(0, 60)}`); continue }
    const head = (v[0] || []).map(x => String(x ?? '').trim())
    const idx = head.map((h, i) => (KEY.test(h) ? i : -1)).filter(i => i >= 0)
    if (!idx.length) { console.log(`  ${r.metric} — 无主体类列（表头: ${head.join(' | ')}）`); continue }
    const vals = new Set()
    for (const row of v.slice(1)) for (const i of idx) if (row && row[i]) vals.add(String(row[i]).trim())
    console.log(`  ${r.metric} 主体类列【${idx.map(i => head[i]).join(' / ')}】出现值: ${[...vals].slice(0, 8).join(' ｜ ') || '(空)'}`)
  }
}
db.close()
