# Fast CI entry: typecheck -> unit tests -> build (no GUI, no packaging).
# Usage: powershell -ExecutionPolicy Bypass -File tools\ci\verify.ps1
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 parses BOM-less UTF-8 as ANSI.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
$results = [ordered]@{}

function Run-Step($name, $cmd) {
  Write-Host ""
  Write-Host "===== STEP: $name ====="
  & cmd /c "$cmd 2>&1" | ForEach-Object { Write-Host $_ }
  $code = $LASTEXITCODE
  $results[$name] = $code
  Write-Host "===== STEP ${name} EXIT=${code} ====="
}

# Order matters: deterministic signals first (typecheck -> tests typecheck -> lint -> unit suite
# -> real electron-vite build), and the network-dependent audit gate LAST. It used to sit before
# vitest/build: a registry blip made audit exit 1, the script aborted, and unit tests/build never
# ran - the PR showed one red check with no way to tell "code broken" from "network flaky".
Run-Step 'typecheck' 'pnpm.cmd typecheck'
if ($results['typecheck'] -ne 0) { Write-Host 'TYPECHECK_FAILED - abort'; exit 1 }

# The root tsconfig.json only includes apps/packages src, so type errors inside tests/**
# stay hidden; tsconfig.test.json closes that hole as its own gate (added 2026-10-19).
Run-Step 'typecheck-tests' 'pnpm.cmd typecheck:tests'
if ($results['typecheck-tests'] -ne 0) { Write-Host 'TYPECHECK_TESTS_FAILED - abort'; exit 1 }

# lint was never wired into CI before: `packages/shared` has no-explicit-any promoted to
# error, and that guard only works if somebody actually runs eslint. Errors fail the gate.
# Legacy warnings are capped by lint:ci's --max-warnings (measured value, tighten only):
# a new warning fails the gate instead of silently joining an invisible backlog.
Run-Step 'lint' 'pnpm.cmd lint:ci'
if ($results['lint'] -ne 0) { Write-Host 'LINT_FAILED - abort'; exit 1 }

Run-Step 'vitest' 'pnpm.cmd exec vitest run'
if ($results['vitest'] -ne 0) { Write-Host 'VITEST_FAILED - abort'; exit 1 }

Run-Step 'build' 'pnpm.cmd build'

# 依赖安全门禁（2026-10-15 审查 P0-3）：high/critical 的 advisory 必须已修复或命中
# .github/audit-allowlist.json 的带到期日豁免；moderate/low 只汇总不阻断。
# 需要网络（读 npm registry）。
# It runs LAST on purpose: it is the only non-hermetic step, so a registry flake must not
# swallow the deterministic logs above. No early exit here either - the SUMMARY below prints
# the full table and still exits 1 through CI_FAILED (gate strength unchanged).
Run-Step 'audit' 'node tools\ci\audit-gate.mjs'

Write-Host ""
Write-Host "===== SUMMARY ====="
$failed = @()
foreach ($k in $results.Keys) {
  Write-Host ("{0,-16} exit={1}" -f $k, $results[$k])
  if ($results[$k] -ne 0) { $failed += $k }
}
if ($failed.Count -gt 0) { Write-Host ("CI_FAILED: " + ($failed -join ',')); exit 1 }
Write-Host 'CI_ALL_PASSED'
exit 0
