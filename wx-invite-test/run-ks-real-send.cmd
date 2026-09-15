@echo off
REM 真实发送模式（只发一批）：先恢复窗口，再跑彩排脚本（不替换发送步骤）
powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\win-restore.ps1
set KS_REAL_SEND=1
node wx-invite-test\rehearse-ks3.mjs
