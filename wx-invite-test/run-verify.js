/** 以 9251 端口环境运行 accept-flow（绕开 cmd/bash 设 env 的编码问题） */
const { spawnSync } = require('child_process')
const mode = process.argv[2] || 'approve'
const r = spawnSync(process.execPath, ['wx-invite-test/accept-flow.js', mode], {
  env: { ...process.env, SHOPILOT_CDP_PORT: '9251' },
  stdio: 'inherit'
})
process.exit(r.status ?? 1)
