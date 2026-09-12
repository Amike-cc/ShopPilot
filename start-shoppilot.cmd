@echo off
cd /d "%~dp0"
start "ShopPilot" "node_modules\electron\dist\electron.exe" .
exit
