# Acceptance pipeline: dist -> unit tests -> update chain -> M1/M2/M3/sec/M4 -> manifest
# Usage: powershell -ExecutionPolicy Bypass -File tools\acceptance\run-acceptance.ps1
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 parses BOM-less UTF-8 as ANSI.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
$results = [ordered]@{}

function Kill-ShopPilot {
  # Stop-Process 只结束主 PID，Chromium 的 GPU/renderer 子进程可能继续持有
  # exe 或 userData 锁，导致下一套验收连到旧端口或把自定义任务卡在旧页面。
  # 只匹配本工作区构建出来的进程，再按进程树结束，避免触碰用户的其他实例。
  $rootPrefix = ($repoRoot -replace '\\', '/')
  $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $name = [string]$_.Name
    $exe = ([string]$_.ExecutablePath -replace '\\', '/')
    $cmd = ([string]$_.CommandLine -replace '\\', '/')
    ($name -eq 'ShopPilot.exe' -or $name -eq 'electron.exe') -and
      (($exe -like "$rootPrefix/release/*") -or ($cmd -like "*$rootPrefix*") -or ($cmd -like '*electron-vite*'))
  }
  foreach ($p in $targets) {
    try { & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null } catch {}
  }
  for ($i = 0; $i -lt 40; $i++) {
    $alive = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $name = [string]$_.Name
      $exe = ([string]$_.ExecutablePath -replace '\\', '/')
      $cmd = ([string]$_.CommandLine -replace '\\', '/')
      ($name -eq 'ShopPilot.exe' -or $name -eq 'electron.exe') -and
        (($exe -like "$rootPrefix/release/*") -or ($cmd -like "*$rootPrefix*") -or ($cmd -like '*electron-vite*'))
    }
    if (-not $alive) { break }
    # Chromium 子进程有时脱离 Electron 的 Windows 进程树；只杀首个 PID
    # 会留下 renderer/GPU 继续锁住 win-unpacked。每轮对当前快照逐 PID
    # 强制结束，直到工作区进程确实清空，再进入下一套件。
    foreach ($p in @($alive)) {
      try { & taskkill.exe /PID $p.ProcessId /F 2>$null | Out-Null } catch {}
    }
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Milliseconds 500
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
# Agent suites were previously manual-only (audit P2-G): they cover the Job state machine,
# tool/skill/plugin gates, memory governance and the packaged app, so they belong here.
Run-Step 'agent-cdp' 'node tools/acceptance/agent-cdp-runner.js'
Run-Step 'agent-domain-cdp' 'node tools/acceptance/agent-domain-cdp-verify.js'
Run-Step 'agent-memory-resilience' 'node tools/acceptance/agent-memory-resilience-verify.js'
Run-Step 'packaged-agent-smoke' 'node tools/acceptance/packaged-agent-smoke.js'
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
