const fs = require('fs')
const line = JSON.stringify({
  ts: new Date().toISOString(),
  event: 'note',
  detail: '用户要求重启应用（20:46），微信登录 Cookie 为会话级、随进程丢失；此后若出现 KICKED 属客户端丢失，不是服务端踢人。会话二起始 20:40:43。'
})
fs.appendFileSync('wx-invite-test/login-probe.jsonl', line + '\n')
console.log('已记录说明行:', line.slice(0, 60) + '…')
