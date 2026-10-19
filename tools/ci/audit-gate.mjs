#!/usr/bin/env node
/**
 * 依赖安全门禁（审查报告 P0-3，2026-10-15）
 *
 * 规则：
 *   · 跑 `pnpm audit --json`，解析全部 advisories；
 *   · high / critical 必须逐条命中 `.github/audit-allowlist.json` 的已批准条目（带理由 + 到期日），
 *     否则退出非零并打印待处理清单；
 *   · moderate / low 只汇总打印，不阻断（避免噪音淹没红线）；
 *   · allowlist 中已不再命中的条目只提示"可清理"，不算失败。
 *
 * 用法：node tools/ci/audit-gate.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
process.chdir(root)

const ALLOWLIST_PATH = resolve(root, '.github', 'audit-allowlist.json')
const BLOCKING = new Set(['high', 'critical'])

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return { allow: [] }
  try {
    const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
    return { allow: Array.isArray(parsed.allow) ? parsed.allow : [] }
  } catch (error) {
    console.error(`[audit-gate] allowlist 解析失败：${error.message}`)
    process.exit(1)
  }
}

/** 单次 `pnpm audit` 的墙钟上限：registry 挂起（不报错也不返回）时不能无限占着 CI job。 */
const AUDIT_TIMEOUT_MS = 120_000

function runAudit() {
  const bin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const res = spawnSync(bin, ['audit', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: AUDIT_TIMEOUT_MS,
    shell: process.platform === 'win32'
  })
  const stdout = res.stdout || ''
  const stderr = res.stderr || ''

  // 先区分"没跑成"（网络/执行）与"跑成了且有未豁免漏洞"（下面的 ADVISORY 分支）：
  // 两类都必须是退出码 1（绝不静默跳过），但日志标记不同，CI 上一眼能看出该找网络还是找依赖。
  if (res.error) {
    const timedOut = res.error.code === 'ETIMEDOUT' || res.signal === 'SIGTERM'
    if (timedOut) {
      console.error(`[audit-gate] FAILED (NETWORK/TRANSPORT)：pnpm audit 超过 ${AUDIT_TIMEOUT_MS / 1000}s 未返回（registry 挂起/网络不通），已终止`)
    } else {
      console.error(`[audit-gate] FAILED (NETWORK/TRANSPORT)：pnpm audit 无法执行：${res.error.code || ''} ${res.error.message}`)
    }
    if (stderr.trim() || stdout.trim()) console.error((stderr || stdout).slice(0, 2000))
    process.exit(1)
  }

  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    // pnpm audit 在发现漏洞时也会输出完整 JSON 到 stdout；解析失败说明是网络/执行错误
    // （断网、代理 5xx、registry 限流、pnpm 自身报错），不是"发现了漏洞"。
    console.error('[audit-gate] FAILED (NETWORK/TRANSPORT)：无法解析 pnpm audit 输出（网络或执行失败）')
    console.error((stderr || stdout || '').slice(0, 2000))
    process.exit(1)
  }

  // pnpm audit 执行失败时**也会输出合法 JSON**：{"error":{"code":"ECONNREFUSED",...}}（2026-10-19 实跑复现）。
  // 旧写法直接 `report.advisories || {}`，于是"registry 不可达"会被当成"0 条漏洞"静默 PASS ——
  // 正是本仓库明令禁止的假成功。下面把"没跑成"与"输出格式不认识"都明确归类为
  // NETWORK/TRANSPORT 失败（退出码仍为 1，绝不静默跳过）。
  if (report && typeof report === 'object' && report.error) {
    console.error(
      `[audit-gate] FAILED (NETWORK/TRANSPORT)：pnpm audit 返回错误：${report.error.code || ''} ${report.error.message || ''}`
    )
    process.exit(1)
  }
  if (!report || typeof report !== 'object' || typeof report.advisories !== 'object' || report.advisories === null) {
    console.error('[audit-gate] FAILED (NETWORK/TRANSPORT)：pnpm audit 输出缺少 advisories 字段，无法判定（格式不认识或 audit 未真正执行）')
    console.error(stdout.slice(0, 2000))
    process.exit(1)
  }

  return report
}

function main() {
  const allowlist = loadAllowlist()
  const allowByGhsa = new Map(
    allowlist.allow
      .filter((entry) => entry && entry.ghsa)
      .map((entry) => [entry.ghsa, entry])
  )

  const report = runAudit()
  const advisories = Object.values(report.advisories || {})
  const counts = { critical: 0, high: 0, moderate: 0, low: 0 }
  const blocking = []
  const usedAllowlistGhsa = new Set()

  for (const adv of advisories) {
    const severity = adv.severity
    if (counts[severity] !== undefined) counts[severity] += 1
    if (!BLOCKING.has(severity)) continue
    const ghsa = adv.github_advisory_id || adv.url || `advisory-${adv.id}`
    const entry = allowByGhsa.get(ghsa)
    if (entry) {
      const expired = entry.expires && Date.parse(entry.expires) < Date.now()
      if (!expired) {
        usedAllowlistGhsa.add(ghsa)
        continue
      }
      blocking.push({ ...adv, ghsa, reason: `allowlist 条目已于 ${entry.expires} 到期` })
      continue
    }
    blocking.push({ ...adv, ghsa })
  }

  const total = counts.critical + counts.high + counts.moderate + counts.low
  console.log(
    `[audit-gate] ${total} 条 advisory：critical=${counts.critical} high=${counts.high} moderate=${counts.moderate} low=${counts.low}`
  )

  const stale = allowlist.allow.filter((entry) => entry?.ghsa && !usedAllowlistGhsa.has(entry.ghsa))
  if (stale.length) {
    console.log(`[audit-gate] 提示：allowlist 中 ${stale.length} 条已不再命中（可清理）：${stale.map((e) => e.ghsa).join(', ')}`)
  }

  if (blocking.length === 0) {
    console.log('[audit-gate] PASS：high/critical 均已修复或已批准豁免')
    process.exit(0)
  }

  console.error(`[audit-gate] FAILED (ADVISORY)：${blocking.length} 条 high/critical 未处理：`)
  for (const adv of blocking) {
    console.error(
      `  · [${adv.severity}] ${adv.module_name} ${adv.vulnerable_versions} → 修复版本 ${adv.patched_versions}` +
        ` (${adv.ghsa}) ${adv.title}${adv.reason ? ` — ${adv.reason}` : ''}`
    )
  }
  console.error('  处置：升级依赖，或在 .github/audit-allowlist.json 增加带理由和到期日的豁免。')
  process.exit(1)
}

main()
