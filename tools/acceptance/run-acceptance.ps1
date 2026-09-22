# Acceptance pipeline: dist -> unit tests -> update chain -> M1/M2/M3/sec/M4 -> manifest
# Usage: powershell -ExecutionPolicy Bypass -File tools\acceptance\run-acceptance.ps1
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 parses BOM-less UTF-8 as ANSI.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
$results = [ordered]@{}

function Kill-ShopPilot {
  Get-Process -Name 'ShopPilot' -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }
  Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'D:\code\*' } | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }
  Start-Sleep -Seconds 2
}

function Run-Step($name, $cmd) {
  Write-Host ""
  Write-Host "===== STEP: $name ====="
  Kill-ShopPilot
  & cmd /c "$cmd 2>&1" | ForEach-Object { Write-Host $_ }
  $code = $LASTEXITCODE
  $results[$name] = $code
  Write-Host "===== STEP ${name} EXIT=${code} ====="
}

Run-Step 'dist' 'pnpm.cmd dist'
if ($results['dist'] -ne 0) { Write-Host 'DIST_FAILED - abort (suites need packaged output)'; exit 1 }
if (-not (Test-Path 'release\latest.yml')) { Write-Host 'LATEST_YML_MISSING - abort (publish config not effective)'; exit 1 }
Write-Host 'latest.yml OK:'
Get-Content 'release\latest.yml' | ForEach-Object { Write-Host "  $_" }

Run-Step 'vitest' 'pnpm.cmd exec vitest run'
if ($results['vitest'] -ne 0) { Write-Host 'VITEST_FAILED - abort'; exit 1 }

Run-Step 'update-runner' 'node tools/release/update-runner.js'
Run-Step 'm1' 'node tools/acceptance/m1-runner.js'
Run-Step 'm2-stage1' 'node tools/acceptance/m2-runner.js stage1'
Run-Step 'm2-stage2' 'node tools/acceptance/m2-runner.js stage2'
Run-Step 'm3' 'node tools/acceptance/m3-runner.js'
Run-Step 'sec' 'node tools/acceptance/sec-runner.js'
Run-Step 'm4-full' 'node tools/acceptance/m4-runner.js'
Run-Step 'custom-local' 'node tools/acceptance/custom-task-local-verify.js'
Run-Step 'invite-live-log' 'node tools/acceptance/invite-live-log-verify.js'
Run-Step 'manifest' 'node tools/release/release-manifest.js'
Kill-ShopPilot

Write-Host ""
Write-Host "===== SUMMARY ====="
$failed = @()
foreach ($k in $results.Keys) {
  Write-Host ("{0,-16} exit={1}" -f $k, $results[$k])
  if ($results[$k] -ne 0) { $failed += $k }
}
if ($failed.Count -gt 0) { Write-Host ("ACCEPTANCE_FAILED: " + ($failed -join ',')); exit 1 }
Write-Host 'ACCEPTANCE_ALL_PASSED'
exit 0
