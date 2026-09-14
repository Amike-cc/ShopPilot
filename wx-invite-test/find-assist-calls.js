const fs = require('fs')
const L = fs.readFileSync('tests/unit/invite.test.ts', 'utf8').split(/\r?\n/)
L.forEach((l, i) => { if (/buildAssistSteps\(/.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 130)) })
