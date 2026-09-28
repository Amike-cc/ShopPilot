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

# Order matters: typecheck first (cheapest, catches contract drift), then lint, then the
# unit suite, then the real electron-vite build (the only check that compiles .vue files
# and proves the main/preload bundles still build).
Run-Step 'typecheck' 'pnpm.cmd typecheck'
if ($results['typecheck'] -ne 0) { Write-Host 'TYPECHECK_FAILED - abort'; exit 1 }

# lint was never wired into CI before: `packages/shared` has no-explicit-any promoted to
# error, and that guard only works if somebody actually runs eslint. Errors fail the gate;
# warnings stay informational (there are ~1000 legacy warnings - don't let them mask a red).
Run-Step 'lint' 'pnpm.cmd lint'
if ($results['lint'] -ne 0) { Write-Host 'LINT_FAILED - abort'; exit 1 }

Run-Step 'vitest' 'pnpm.cmd exec vitest run'
if ($results['vitest'] -ne 0) { Write-Host 'VITEST_FAILED - abort'; exit 1 }

Run-Step 'build' 'pnpm.cmd build'

Write-Host ""
Write-Host "===== SUMMARY ====="
$failed = @()
foreach ($k in $results.Keys) {
  Write-Host ("{0,-12} exit={1}" -f $k, $results[$k])
  if ($results[$k] -ne 0) { $failed += $k }
}
if ($failed.Count -gt 0) { Write-Host ("CI_FAILED: " + ($failed -join ',')); exit 1 }
Write-Host 'CI_ALL_PASSED'
exit 0
