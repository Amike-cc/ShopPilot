/**
 * 打印微信小店「达人邀约」任务的实际步骤（由 shared 的真实构造器生成，不手写）。
 * 用法：node wx-invite-test/dump-invite-steps.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'

function ensureBundle() {
  const out = path.resolve('wx-invite-test/.tmp/probe-entry.mjs')
  const entry = path.resolve('wx-invite-test/probe-entry.ts')
  const dir = fs.readdirSync(path.resolve('node_modules/.pnpm')).find(n => n.startsWith('esbuild@'))
  const bin = path.resolve('node_modules/.pnpm', dir, 'node_modules/esbuild/bin/esbuild')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const res = spawnSync(process.execPath, [bin, entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`], { stdio: 'ignore' })
  if (res.status !== 0) throw new Error('打包失败')
}

const short = (value, max = 120) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > max ? s.slice(0, max) + '…' : s
}

ensureBundle()
const { buildInviteTaskPayload, inviteProfileFor, normalizeInviteTaskConfig, inviteTaskIssues, ASSIST_LOOP_MAX_ROUNDS, ASSIST_DEFAULT_MAX_INVITES } = await import('./.tmp/probe-entry.mjs')

const profile = inviteProfileFor('微信小店')
const config = normalizeInviteTaskConfig('assist-form', {
  contact: '刘涛', wechat: 'jiaoe988', phone: '15057937334',
  productIds: ['10000687986563'],
  script: '您好，我们是店铺方，想邀请您合作带货：专属高佣 + 免费寄样。',
  scriptMode: 'ai',
  // 「带货销售总额」只在「全部带货者」下提供，所以示例用全部带货者
  finderType: '全部带货者',
  finderCategories: ['母婴'],
  finderSalesTiers: ['￥10万-20万'],
  finderOtherFilters: ['有联系方式'],
  maxInvites: 10,
  // 台账里的"近 7 天已邀"昵称：应体现在「详情」步骤的 skipTexts 上
  recentlyInvited: ['恩妹阅读', '郑奶奶科学育儿']
})
const issues = inviteTaskIssues({ profile, config })
if (issues.length) console.log('（示例配置的校验结果，应为空）', JSON.stringify(issues))
const payload = buildInviteTaskPayload({ profile, storeId: STORE, squareUrl: SQUARE, config })
if (!payload) { console.error('构造失败:', JSON.stringify(issues)); process.exit(1) }

console.log('任务名:', payload.name)
console.log('店铺:', payload.storeScope)
console.log('顶层步骤:', payload.steps.map(s => s.type).join(' → '))
console.log('')
const loop = payload.steps.find(s => s.type === 'loop')
console.log('=== loop 参数 ===')
console.log('maxRounds      :', loop.input.maxRounds, `（面板「本次最多邀约 N 位」；上限 ${ASSIST_LOOP_MAX_ROUNDS}，默认 ${ASSIST_DEFAULT_MAX_INVITES}）`)
console.log('stopOn         :', JSON.stringify(loop.input.stopOn))
console.log('onCode         :', JSON.stringify((loop.input.onCode || []).map(r => ({ code: r.code, limit: r.limit, restart: !!r.restart, advance: !!r.advance, steps: r.steps.map(s => s.type) }))))
console.log('')
console.log('=== 每轮步骤（共 ' + loop.input.steps.length + ' 步） ===')
loop.input.steps.forEach((step, i) => {
  const input = step.input || {}
  const parts = Object.entries(input).map(([k, v]) => `${k}=${short(v, 90)}`).join(' ')
  console.log(`${String(i + 1).padStart(2)}. ${step.type.padEnd(14)} ${parts}`)
})
