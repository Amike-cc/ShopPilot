@echo off
setlocal
set SHOPILOT_CDP_PORT=9251
cd /d D:\code\电商浏览器
node wx-invite-test\accept-flow.js %1
endlocal
