/**
 * 只读：读真实应用里某个店铺的达人邀约配置（面板存的那份）+ AI 配置摘要。
 * 用法：$env:ELECTRON_RUN_AS_NODE=1; node_modules\electron\dist\electron.exe wx-invite-test\read-real-invite-config.cjs
 */
const path = require('node:path')
const Database = require('better-sqlite3')

const db = new Database(path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db'), { readonly: true })
const storeId = process.argv[2] || 'store_4eb9b43cffeee0094041894a9f1f93bf'

const rows = db.prepare("select key, value_json, updated_at from app_settings where key like 'invite.%' or key like 'ai.%'").all()
const ts = v => (v ? new Date(Number(v)).toLocaleString('zh-CN', { hour12: false }) : '-')
for (const r of rows) {
  let value = r.value_json
  try {
    const parsed = JSON.parse(r.value_json)
    // 敏感字段不回显
    if (parsed && typeof parsed === 'object' && 'key' in parsed) parsed.key = '<redacted>'
    value = JSON.stringify(parsed)
  } catch { /* 原样 */ }
  console.log(`${r.key}  (${ts(r.updated_at)})  ${String(value).slice(0, 400)}`)
}
const mine = rows.find(r => r.key === `invite.config.store.${storeId}`)
if (mine) {
  const cfg = JSON.parse(mine.value_json)
  console.log('\n=== 该店铺邀约配置（面板字段） ===')
  console.log(JSON.stringify({
    contact: cfg.contact, wechat: cfg.wechat, phone: cfg.phone,
    scriptMode: cfg.scriptMode, scriptLen: String(cfg.script || '').length,
    productIds: cfg.productIds, finderType: cfg.finderType,
    finderCategories: cfg.finderCategories, finderSalesTiers: cfg.finderSalesTiers, finderOtherFilters: cfg.finderOtherFilters
  }, null, 1))
}
db.close()
