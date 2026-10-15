# Packaged smoke (review P0-3, 2026-10-15): electron-builder --dir packaging + packaged native module smoke.
# No GUI required: the smoke runs Electron in ELECTRON_RUN_AS_NODE mode.
# Usage: powershell -ExecutionPolicy Bypass -File tools\ci\package-smoke.ps1
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 parses BOM-less UTF-8 as ANSI.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

Write-Host ""
Write-Host "===== STEP: dist:dir (package only, no installer) ====="
& cmd /c "pnpm.cmd run dist:dir 2>&1" | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Write-Host 'PACKAGE_FAILED'; exit 1 }

Write-Host ""
Write-Host "===== STEP: packaged native smoke ====="
# ELECTRON_RUN_AS_NODE: run the packaged better-sqlite3 under the Electron runtime to prove
# the native ABI matches and the dependency was actually collected into the package.
$electronExe = "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) { Write-Host "ELECTRON_BINARY_MISSING: $electronExe"; exit 1 }
$env:ELECTRON_RUN_AS_NODE = '1'
try {
  & $electronExe "tools\ci\packaged-native-smoke.js" "release\win-unpacked"
} finally {
  Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}
if ($LASTEXITCODE -ne 0) { Write-Host 'NATIVE_SMOKE_FAILED'; exit 1 }

Write-Host ""
Write-Host 'PACKAGE_SMOKE_PASSED'
exit 0
