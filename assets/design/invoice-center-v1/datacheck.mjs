/**
 * 原型数据自检（临时脚本）：校验原型里「待开票条数 / 可开金额 / 无需操作 / 未解析 / 逾期」
 * 这些会直接决定界面上数字的量，是否与设计稿文案一致。
 * 做法：把原型 HTML 里第 1~3 节（数据 + 纯函数，无 DOM 依赖）取出来在本进程求值，再断言。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(HERE, 'invoice-center-prototype.html'), 'utf8')
const start = html.indexOf('const PLATFORM')
const marker = html.indexOf('   4. 渲染')
if (start < 0 || marker < 0) { console.error('EXTRACT_FAILED'); process.exit(1) }
/* 从「4. 渲染」往前退到它那条注释块的开头，避免切出半个 /* 注释 */
const block = html.slice(start, html.lastIndexOf('/*', marker))

const api = new Function(block + `
  ; recompute();
  return { entityStats, ROWS, STORES, STORE_ENTITIES: ENTITIES,
           parseAmount, amountText, fmt, deadlineState, visibleRows, STATE };
`)()

const { entityStats, ROWS, STORES, STORE_ENTITIES, parseAmount } = api
const st = entityStats()
const checks = []
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })

const A = st.get('ALL')
eq('ALL 待开票条数', A.count, 17)
eq('ALL 可开金额', A.amount, 2026.4)
eq('ALL 无需操作条数', A.history, 40)
eq('ALL 金额未解析', A.unparsed, 1)
eq('ALL 店铺数', A.stores, 5)
eq('ALL 有票待开店铺', A.activeStores, 4)
eq('ALL 已逾期', A.late, 1)
/* 三日内到期：拼多多 1 条（10-16）+ 快手 2 条（10-17，同一账单月份的阈值生效时间相同） */
eq('ALL 三日内到期', A.soon, 3)
eq('全部主体名', STORE_ENTITIES[0].label, '全部主体')

const YJ = st.get('91310115MA1H8N2X3B')
eq('上海云锦 条数', YJ.count, 8); eq('上海云锦 金额', YJ.amount, 842.1); eq('上海云锦 店铺', YJ.stores, 2)
const YQ = st.get('91330100MA2XXXXX1A')
eq('杭州云栖 条数', YQ.count, 4); eq('杭州云栖 金额', YQ.amount, 807.7); eq('杭州云栖 店铺', YQ.stores, 2)
const NONE = st.get('__none__')
eq('未填写 条数', NONE.count, 5); eq('未填写 金额', NONE.amount, 376.6); eq('未填写 店铺', NONE.stores, 1)

/* 主体拆分之和必须回到「全部」——分账表能不能对上账就看这条 */
eq('主体条数之和 = 全部', YJ.count + YQ.count + NONE.count, A.count)
eq('主体金额之和 = 全部', Math.round((YJ.amount + YQ.amount + NONE.amount) * 100) / 100, A.amount)
eq('有待办店铺之和 = 全部', YJ.activeStores + YQ.activeStores + NONE.activeStores, A.activeStores)

/* 金额解析：整串是金额才算，其余一律 null（与 packages/shared/src/invoice-amount.ts 同规则） */
eq('解析 ¥14.89', parseAmount('¥14.89'), 14.89)
eq('解析 421.40', parseAmount('421.40'), 421.4)
eq('解析 千分位', parseAmount('1,234.50'), 1234.5)
eq('解析 — 为 null', parseAmount('—'), null)
eq('解析 空为 null', parseAmount(''), null)
eq('解析「2 笔订单」为 null', parseAmount('2 笔订单'), null)

/* 只有快手小店实测了主体信息页 */
const supported = STORES.filter(s => s.entitySupported).map(s => s.platform)
eq('主体可读平台', supported, ['快手小店'])

let bad = 0
for (const c of checks) {
  if (!c.ok) { bad++; console.log(`FAIL  ${c.name}  got=${JSON.stringify(c.got)}  want=${JSON.stringify(c.want)}`) }
}
console.log(bad ? `${bad} / ${checks.length} CHECKS FAILED` : `ALL ${checks.length} DATA CHECKS PASSED`)
console.log(`方向数：` + STORES.map(s => `${s.name}=${s.sections.length}`).join(' '))
console.log(`每店待开票：` + ROWS.map(r => `${r.name}=${r.pendingCount}条/${r.hasPendingAmount ? '¥' + r.pendingAmount.toFixed(2) : '—'}`).join(' '))
process.exit(bad ? 1 : 0)
